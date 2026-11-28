import type { CollectionConfig, PayloadRequest } from 'payload'

import { isGenericDomain, isPublicSuffix, normalizeDomain } from './domains.js'
import { vetoed } from './veto.js'
import { hiddenOwnRows } from './view.js'
import { asInternal, exactlyTrue, idOf, isInternal, levelIn, needTransaction, refuse, signedIn } from './helpers.js'
import {
  EVENTS,
  MEMBERS,
  ORGANIZATIONS,
  type AuditEvent,
  type EventName,
  type Level,
  type Organization,
  type OrganizationArgs,
  type OrganizationStatus,
  type OrganizationsOptions,
  type Resolved,
} from './types.js'

export const STATUSES: OrganizationStatus[] = ['pending', 'active', 'closed']
const NAME_MAX = 200
const NOTES_MAX = 2000
const DOMAINS_MAX = 50
/** A ROR id is a 0, six characters from Crockford's base 32 (no i, l, o or u), then two digits. */
const ROR = /^0[0-9a-hjkmnp-tv-z]{6}[0-9]{2}$/

export const orgOf = (doc: Record<string, unknown>): Organization => ({
  id: doc.id as string | number | undefined,
  name: doc.name as string,
  kind: doc.kind as string,
  status: doc.status as OrganizationStatus,
  rorId: typeof doc.rorId === 'string' && doc.rorId ? doc.rorId : null,
  domains: Array.isArray(doc.domains) ? (doc.domains as unknown[]).filter((d): d is string => typeof d === 'string') : [],
  createdBy: idOf(doc.createdBy),
})

/** A bare, lowercase ROR id from a bare id or a ror.org link, or null. */
export function normalizeRor(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const m = input.trim().toLowerCase().replace(/^https?:\/\/ror\.org\//, '')
  return ROR.test(m) ? m : null
}

/** Every event one change amounts to: a status change, a change of ROR id or domains, and a rename or notes change can all happen at once. */
export const eventsFor = (before: Organization, next: Organization, notesChanged: boolean): EventName[] => {
  const out: EventName[] = []
  if (next.status !== before.status) out.push(next.status === 'active' ? (before.status === 'closed' ? 'reopen' : 'activate') : 'close')
  if (next.rorId !== before.rorId || !same(next.domains, before.domains)) out.push('change-domains')
  if (next.name !== before.name || notesChanged) out.push('update')
  return out
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((d, i) => d === b[i])

export async function emit(req: PayloadRequest, hook: ((e: AuditEvent) => void | Promise<void>) | undefined, e: Omit<AuditEvent, 'req'>, mustPass: boolean) {
  if (!hook) return
  try {
    await hook({ ...e, req })
  } catch (error) {
    if (mustPass) throw refuse('This change can’t be recorded right now, so it wasn’t made.')
    req.payload.logger.error(`organizations: the ${e.event} audit hook failed: ${(error as Error).message}`)
  }
}

/** One history row, written in the same transaction, so a change without its record is rolled back. */
export async function note(
  req: PayloadRequest,
  row: {
    organization: string | number
    event: EventName
    memberId?: string | number | null
    level?: string | null
    previousLevel?: string | null
    status?: string | null
    previousStatus?: string | null
    rorId?: string | null
    previousRorId?: string | null
    domains?: string[]
    previousDomains?: string[]
  },
) {
  await req.payload.create({
    collection: EVENTS as never,
    data: { ...row, memberId: row.memberId === null || row.memberId === undefined ? null : String(row.memberId), by: idOf(req.user) } as never,
    overrideAccess: true,
    req,
  })
}

/** Whether the asker made this organization, or has accepted a place in it at any time, even if they have since left. Nobody approves their own. */
export async function involved(req: PayloadRequest, id: string | number, createdBy: unknown) {
  const me = idOf(req.user)
  if (me === null) return false
  if (String(idOf(createdBy)) === String(me)) return true
  const rows = await req.payload.count({
    collection: MEMBERS as never,
    // Only rows the person accepted at some point count, removed ones too, so leaving doesn't undo it. An invitation they never accepted doesn't, or a coordinator could invite every approver and lock them all out.
    where: { and: [{ organization: { equals: id } }, { user: { equals: me } }, { acceptedAt: { not_equals: null } }] } as never,
    overrideAccess: true,
    req,
  })
  return rows.totalDocs > 0
}

/** Bulk changes commit a document whose later hook threw, so the plugin's collections only change one document at a time. */
export const noBulk = ({ operation, args }: { operation: string; args: unknown }) => {
  const a = args as { where?: unknown; id?: unknown }
  if ((operation === 'update' || operation === 'delete') && a.where !== undefined && a.where !== null && (a.id === undefined || a.id === null)) throw refuse('Change one document at a time. Bulk changes aren’t allowed here.')
  return args as never
}

export function organizationsCollection(s: Resolved, opts: OrganizationsOptions): CollectionConfig {
  const by = (req: PayloadRequest) => idOf(req.user)

  const ask = async (fn: ((a: OrganizationArgs) => boolean | Promise<boolean>) | undefined, req: PayloadRequest, organization: Partial<Organization>, data: OrganizationArgs['data'], id?: string | number) => {
    const user = signedIn(req, s)
    if (!user || !fn) return false
    try {
      const actorLevel = id === undefined ? null : await levelIn(req, id)
      return await exactlyTrue(() => fn({ req, user, id, organization, data, actorLevel }))
    } catch {
      return false
    }
  }

  /** Domains already on the organization stay, even if the host has since marked one generic, so renames and closing keep working. Only added ones are checked. */
  const cleanDomains = (raw: unknown, existing: string[] = []): string[] => {
    const list = Array.isArray(raw) ? raw : []
    const out: string[] = []
    for (const item of list) {
      const d = normalizeDomain(typeof item === 'object' && item !== null ? (item as { domain?: unknown }).domain : item)
      if (!d) throw refuse('One of the domains isn’t a valid domain.')
      if (!existing.includes(d)) {
        if (isGenericDomain(d, s.genericDomains)) throw refuse('A public mail, school or internet provider domain can’t be put on an organization.')
        if (isPublicSuffix(d)) throw refuse('A public suffix such as co.uk or github.io can’t be put on an organization.')
      }
      if (!out.includes(d)) out.push(d)
    }
    if (out.length > DOMAINS_MAX) throw refuse(`An organization can list at most ${DOMAINS_MAX} domains.`)
    return out.sort()
  }

  const cleanName = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) throw refuse('An organization needs a name.')
    if (value.trim().length > NAME_MAX) throw refuse(`A name can be at most ${NAME_MAX} characters.`)
    return value.trim()
  }

  return {
    slug: ORGANIZATIONS,
    // No Payload edit-lock rows for these documents; the plugin's own checks handle two changes at once.
    lockDocuments: false,
    labels: { singular: 'Organization', plural: 'Organizations' },
    admin: {
      group: opts.adminGroup ?? 'Organizations',
      useAsTitle: 'name',
      defaultColumns: ['name', 'kind', 'status', 'rorId'],
      description: 'Places people work or belong. A new one is pending until it is approved. Organizations are never deleted; close them instead.',
    },
    access: {
      create: ({ req }) => !!signedIn(req, s),
      update: ({ req, id }) => id !== undefined && id !== null && !!signedIn(req, s),
      delete: () => false,
      read: async ({ req }) => {
        const user = signedIn(req, s)
        if (!user) return false
        try {
          if (opts.canRead && (await exactlyTrue(() => opts.canRead!({ req, user })))) return true
          const mine = await req.payload.find({
            collection: MEMBERS as never,
            where: { and: [{ user: { equals: user.id } }, { status: { in: ['invited', 'active'] } }] } as never,
            pagination: false,
            depth: 0,
            overrideAccess: true,
            req,
          })
          // An invitation never accepted shows its organization only to someone the veto would let accept it, so it can't carry a message to an account the site refuses.
          const hidden = new Set((await hiddenOwnRows(req, s, opts, user.id)).map(String))
          const visible = (mine.docs as unknown as { id: unknown; organization: unknown }[]).filter((r) => !hidden.has(String(r.id)))
          const ids = [...new Set(visible.map((r) => idOf(r.organization)).filter((x): x is string | number => x !== null))]
          return ids.length ? { id: { in: ids } } : false
        } catch {
          return false
        }
      },
    },
    fields: [
      { name: 'name', type: 'text', required: true, maxLength: NAME_MAX, index: true },
      {
        name: 'kind',
        type: 'select',
        required: true,
        index: true,
        options: s.kinds.map((k) => ({ label: k.label ?? k.value, value: k.value })),
        admin: { description: 'Set when the organization is made and fixed after, because host rules can depend on it.' },
      },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'pending',
        index: true,
        options: [
          { label: 'Pending', value: 'pending' },
          { label: 'Active', value: 'active' },
          { label: 'Closed', value: 'closed' },
        ],
        admin: { description: 'Always starts pending. Only an approver makes it active or closes it. A pending or closed organization gives its people nothing.' },
      },
      {
        name: 'rorId',
        type: 'text',
        unique: true,
        index: true,
        maxLength: 40,
        admin: { description: 'The bare ROR id, such as 02mhbdp94, set by an approver. A link to ror.org is accepted and shortened.' },
      },
      {
        name: 'domains',
        type: 'text',
        hasMany: true,
        maxRows: DOMAINS_MAX,
        maxLength: 253,
        admin: { description: 'Email domains that suggest this organization. A suggestion only; it never adds anyone. Set by an approver. Public mail, school and internet provider domains are refused.' },
      },
      {
        name: 'privateNotes',
        type: 'textarea',
        maxLength: NOTES_MAX,
        admin: { description: 'For staff only. Members of the organization never see this.' },
        access: {
          read: async ({ req, id }) => {
            const user = signedIn(req, s)
            return !!user && !!opts.canSeePrivate && (await exactlyTrue(() => opts.canSeePrivate!({ req, user, organizationId: id })))
          },
          create: async ({ req }) => {
            const user = signedIn(req, s)
            return !!user && !!opts.canSeePrivate && (await exactlyTrue(() => opts.canSeePrivate!({ req, user })))
          },
          update: async ({ req, id }) => {
            const user = signedIn(req, s)
            return !!user && !!opts.canSeePrivate && (await exactlyTrue(() => opts.canSeePrivate!({ req, user, organizationId: id })))
          },
        },
      },
      { name: 'createdBy', type: 'relationship', relationTo: s.users, admin: { readOnly: true } },
      // Every Coordinator change writes this first, inside its transaction, so two changes at once can't both pass the last-Coordinator check.
      { name: 'lock', type: 'number', hidden: true, admin: { disabled: true }, access: { create: () => false, update: () => false } },
    ],
    hooks: {
      beforeOperation: [noBulk],
      // Nothing is ever deleted, not even by server code that skips access.
      beforeDelete: [
        () => {
          throw refuse('Organizations are never deleted. Close them instead.')
        },
      ],
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          await needTransaction(req, s)
          const user = signedIn(req, s)
          if (req.user && !user) throw refuse('Only a signed-in user can change organizations.')
          const trusted = !req.user || isInternal(req)

          if (operation === 'create') {
            const name = cleanName(data.name)
            if (!s.kinds.some((k) => k.value === data.kind)) throw refuse('Unknown kind of organization.')
            const wanted = { name, kind: data.kind as string, status: 'pending' as const, rorId: normalizeRor(data.rorId), domains: cleanDomains(data.domains) }
            if (!trusted && !(await ask(opts.canCreate, req, wanted, wanted))) throw refuse('You can’t add an organization.')
            // Domains and a ROR id widen who an organization suggests, so only an approver who didn't make it sets them, and a pending one has none until then. The maker made it, so only server code keeps them.
            const approver = trusted
            data.name = name
            data.status = 'pending'
            data.createdBy = by(req)
            data.lock = 0
            data.rorId = approver && wanted.rorId ? wanted.rorId : undefined
            data.domains = approver ? wanted.domains : []
            if (data.rorId === undefined) delete data.rorId
            if (!trusted && 'privateNotes' in data && typeof data.privateNotes === 'string') data.privateNotes = data.privateNotes.slice(0, NOTES_MAX)
            await emit(req, opts.audit?.before, { event: 'create', phase: 'before', organization: { ...wanted, createdBy: by(req) }, by: by(req) }, true)
            return data
          }

          // An update.
          const before = orgOf(originalDoc)
          const id = originalDoc.id as string | number
          if ('kind' in data && data.kind !== before.kind) throw refuse('An organization’s kind can’t be changed.')
          if ('createdBy' in data && String(idOf(data.createdBy) ?? '') !== String(before.createdBy ?? '')) throw refuse('Who made an organization can’t be changed.')
          if (!isInternal(req)) delete data.lock
          const sent = { ...(data as Record<string, unknown>) }
          const next = {
            ...before,
            name: 'name' in sent ? cleanName(sent.name) : before.name,
            status: ('status' in sent ? sent.status : before.status) as OrganizationStatus,
            // Payload hands over the whole document, so an absent or undefined value means unchanged. Only an explicit null or blank clears.
            rorId: sent.rorId === undefined ? before.rorId : sent.rorId === null || sent.rorId === '' ? null : normalizeRor(sent.rorId),
            domains: 'domains' in sent ? cleanDomains(sent.domains, before.domains) : before.domains,
          }
          if (sent.rorId !== undefined && sent.rorId !== null && sent.rorId !== '' && next.rorId === null) throw refuse('That isn’t a ROR id.')
          if (!STATUSES.includes(next.status)) throw refuse('Unknown status.')
          const nameChanged = next.name !== before.name
          const notesChanged = 'privateNotes' in sent && sent.privateNotes !== (originalDoc.privateNotes ?? undefined) && sent.privateNotes !== (originalDoc.privateNotes ?? null)
          const widened = next.rorId !== before.rorId || !same(next.domains, before.domains)
          const statusChanged = next.status !== before.status
          if (!nameChanged && !notesChanged && !widened && !statusChanged) return data
          if (before.status === 'closed' && !statusChanged) throw refuse('A closed organization can’t be changed. Reopen it first.')
          const args = { ...next, id }
          const patch = { ...next }
          if (!trusted) {
            if ((nameChanged || notesChanged) && !(await ask(opts.canUpdate, req, before, patch, id))) throw refuse('You can’t change this organization.')
            if (widened || statusChanged) {
              if (!(await ask(opts.canApprove, req, before, patch, id))) throw refuse('Only an approver can do that.')
              // Nobody approves, reopens or widens an organization they made or belong to. Closing only takes access away, so anyone the host allows may close, which keeps the safety lever out of reach of no approver.
              const onlyClosing = statusChanged && next.status === 'closed' && !widened
              if (!onlyClosing && (await involved(req, id, before.createdBy))) throw refuse('You can’t approve an organization you made or belong to.')
            }
          }
          if (statusChanged) {
            const ok = (before.status === 'pending' && (next.status === 'active' || next.status === 'closed')) || (before.status === 'active' && next.status === 'closed') || (before.status === 'closed' && next.status === 'active')
            if (!ok) throw refuse('That status change isn’t allowed.')
          }
          if (nameChanged) data.name = next.name
          if (sent.rorId !== undefined) {
            if (next.rorId === null && before.rorId !== null) throw refuse('A ROR id can be replaced but not cleared.')
            if (next.rorId === null) delete data.rorId
            else data.rorId = next.rorId
          }
          if ('domains' in sent) data.domains = next.domains
          const found = eventsFor(before, next, notesChanged)
          for (const event of found) await emit(req, opts.audit?.before, { event, phase: 'before', organization: args, previous: before, by: by(req) }, true)
          if (notesChanged) req.context[`organizations:${String(id)}`] = { notes: true }
          return data
        },
      ],
      afterChange: [
        async ({ doc, previousDoc, operation, req }) => {
          const organization = orgOf(doc)
          const id = doc.id as string | number
          if (operation === 'create') {
            await note(req, { organization: id, event: 'create', status: 'pending', rorId: organization.rorId, domains: organization.domains })
            // The maker is the first Coordinator, awaiting approval. An organization made with nobody in it waits to be claimed.
            const maker = signedIn(req, s)
            if (maker && !isInternal(req) && !(await ask(opts.canPrecreate, req, organization, organization))) {
              await asInternal(req, () =>
                req.payload.create({ collection: MEMBERS as never, data: { organization: id, user: maker.id, level: 'coordinator' } as never, overrideAccess: true, req }),
              )
            }
            await emit(req, opts.audit?.after, { event: 'create', phase: 'after', organization, by: by(req) }, false)
            return doc
          }
          if (!previousDoc) return doc
          const before = orgOf(previousDoc)
          const key = `organizations:${String(id)}`
          const flags = req.context?.[key] as { notes?: boolean } | undefined
          if (flags) delete req.context[key]
          const found = eventsFor(before, organization, flags?.notes === true)
          for (const event of found) {
            const status = event === 'activate' || event === 'close' || event === 'reopen'
            const widened = event === 'change-domains'
            await note(req, {
              organization: id,
              event,
              ...(status ? { status: organization.status, previousStatus: before.status } : {}),
              ...(widened ? { rorId: organization.rorId, previousRorId: before.rorId, domains: organization.domains, previousDomains: before.domains } : {}),
            })
          }
          // A reopened organization asks the veto again about everyone in it, because it brings their access back.
          if (found.includes('reopen')) {
            const rows = await req.payload.find({
              collection: MEMBERS as never,
              // Only people already active: an invited person is checked when they accept, so reopening never shows who the veto covers.
              where: { and: [{ organization: { equals: id } }, { status: { equals: 'active' } }] } as never,
              pagination: false,
              depth: 0,
              overrideAccess: true,
              req,
            })
            for (const row of rows.docs as unknown as { id: string | number; user: unknown; level: Level }[]) {
              try {
                await vetoed(opts, s.users, req, { ...organization, id }, idOf(row.user) as string | number, row.level, 'reopen')
              } catch {
                await asInternal(req, () => req.payload.update({ collection: MEMBERS as never, id: row.id, data: { status: 'removed' } as never, overrideAccess: true, req }))
              }
            }
          }
          for (const event of found) await emit(req, opts.audit?.after, { event, phase: 'after', organization, previous: before, by: by(req) }, false)
          return doc
        },
      ],
    },
  }
}

export { asInternal }
