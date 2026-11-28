import type { Access, CollectionConfig, PayloadRequest, Where } from 'payload'

import { emit, involved, noBulk, note, orgOf } from './organizations.js'
import { asInternal, claim, exactlyTrue, heldBy, idOf, isInternal, levelIn, levelOf, needTransaction, refuse, signedIn, readLimit } from './helpers.js'
import { GENERAL, loadOrganization, vetoed } from './veto.js'
import { forgetHidden, hiddenOwnRows, hidesOwnRow, inQuiet, inVeto, neverAccepted, quietly } from './view.js'
import { EVENTS, LEVELS, MEMBERS, ORGANIZATIONS, RANK, type Level, type MemberArgs, type Membership, type MemberStatus, type OrganizationsOptions, type Resolved } from './types.js'

const LIVE: MemberStatus[] = ['invited', 'active']
const STATUS: MemberStatus[] = ['invited', 'active', 'removed']

const normalize = (doc: Record<string, unknown>): Membership => ({
  id: doc.id as string | number | undefined,
  organization: idOf(doc.organization) as string | number,
  user: idOf(doc.user) as string | number,
  level: doc.level as Level,
  status: doc.status as MemberStatus,
  invitedBy: idOf(doc.invitedBy),
  acceptedAt: (doc.acceptedAt as string | null | undefined) ?? null,
  removedAt: (doc.removedAt as string | null | undefined) ?? null,
  removedBy: idOf(doc.removedBy),
  pendingLevel: levelOf(doc.pendingLevel),
})

/** Ids as plain values, whatever shape the client or server code sent them in. */
const plain = (data: Record<string, unknown> | undefined): Partial<Membership> => {
  const d = { ...(data ?? {}) } as Record<string, unknown>
  for (const f of ['organization', 'user', 'invitedBy', 'removedBy']) if (f in d) d[f] = idOf(d[f])
  return d as Partial<Membership>
}

export function membersCollection(s: Resolved, opts: OrganizationsOptions): CollectionConfig {
  const by = (req: PayloadRequest) => idOf(req.user)

  const ask = async (fn: ((a: MemberArgs) => boolean | Promise<boolean>) | undefined, req: PayloadRequest, member: Partial<Membership>, extra: { id?: string | number; data?: Partial<Membership>; to?: Level } = {}) => {
    const user = signedIn(req, s)
    if (!user || !fn) return false
    try {
      const organization = await loadOrganization(req, member.organization, orgOf)
      if (!organization) return false
      const actorLevel = await levelIn(req, organization.id).catch(() => null)
      return await exactlyTrue(() => fn({ req, user, organization, id: extra.id, member, data: extra.data ?? member, actorLevel, to: extra.to }))
    } catch {
      return false
    }
  }

  /** Whether an approver (the host's `canApprove`) allows this, asked about the organization as it stands. */
  const approves = async (req: PayloadRequest, id: string | number, level: Level) => {
    const user = signedIn(req, s)
    if (!user || !opts.canApprove) return false
    try {
      const organization = await loadOrganization(req, id, orgOf)
      if (!organization) return false
      const actorLevel = await levelIn(req, id).catch(() => null)
      return await exactlyTrue(() => opts.canApprove!({ req, user, id, organization, data: (level === 'coordinator' ? { status: 'active' } : {}) as never, actorLevel }))
    } catch {
      return false
    }
  }

  /**
   * Takes the organization's lock and checks that a Coordinator is left once this one goes. Writing the organization
   * first means two Coordinators leaving or demoting each other at once collide, and one of them is turned back.
   */
  async function keepACoordinator(req: PayloadRequest, organization: string | number, leaving: string | number) {
    try {
      const fresh = (await req.payload.findByID({ collection: ORGANIZATIONS as never, id: organization, depth: 0, overrideAccess: true, req })) as unknown as { lock?: number }
      await asInternal(req, () => req.payload.update({ collection: ORGANIZATIONS as never, id: organization, data: { lock: (fresh.lock ?? 0) + 1 } as never, overrideAccess: true, req }))
      const others = await req.payload.find({
        collection: MEMBERS as never,
        where: { and: [{ organization: { equals: organization } }, { status: { equals: 'active' } }, { level: { equals: 'coordinator' } }, { id: { not_equals: leaving } }] },
        limit: 1,
        pagination: false,
        depth: 0,
        overrideAccess: true,
        req,
      })
      if (!others.docs.length) throw refuse('An organization always keeps a Coordinator. Make someone else a Coordinator first.')
    } catch (error) {
      if ((error as { isPublic?: boolean }).isPublic) throw error
      throw refuse('This organization is changing right now. Try again in a moment.')
    }
  }

  const read: Access = async ({ req }) => {
    const user = signedIn(req, s)
    if (!user) return false
    try {
      if (opts.canRead && (await exactlyTrue(() => opts.canRead!({ req, user })))) return true
      const held = await heldBy(req)
      const staffed = held.filter((h) => h.level === 'coordinator').map((h) => h.organization)
      const joined = held.map((h) => h.organization)
      // Their own rows, except an invitation never accepted that the veto would refuse: its organization, inviter and remover stay hidden from that account.
      const hidden = await hiddenOwnRows(req, s, opts, user.id)
      const own = hidden.length ? { and: [{ user: { equals: user.id } }, { id: { not_in: hidden } }] } : { user: { equals: user.id } }
      // A Coordinator sees every row in their organizations. Anyone else sees the Coordinators, and their own row.
      return {
        or: [
          own,
          ...(staffed.length ? [{ organization: { in: staffed } }] : []),
          ...(joined.length ? [{ and: [{ organization: { in: joined } }, { level: { equals: 'coordinator' } }, { status: { equals: 'active' } }] }] : []),
        ],
      } as unknown as Where
    } catch {
      return false
    }
  }

  /** Rows a request is writing for their own person while the details are hidden. Those writes answer with no document. */
  const unseen = new WeakMap<object, Set<string>>()

  /**
   * The one write to a row its writer can't read: answering their own invitation while its details are hidden. Only a status of removed (decline) or active (accept) sent on its own.
   * Both change the row or are refused, and neither answers with the row. A host that replaced the read rule gets no exception.
   */
  const ownAnswer = async (req: PayloadRequest, user: string | number, data: unknown): Promise<Where | null> => {
    if (typeof data !== 'object' || data === null) return null
    const keys = Object.keys(data)
    const status = (data as { status?: unknown }).status
    if (keys.length !== 1 || keys[0] !== 'status' || (status !== 'removed' && status !== 'active')) return null
    if ((req.payload.collections as unknown as Record<string, { config: { access: { read?: unknown } } }>)[MEMBERS]?.config.access.read !== read) return null
    try {
      const hidden = await hiddenOwnRows(req, s, opts, user)
      return hidden.length ? { and: [{ user: { equals: user } }, { id: { in: hidden } }, { status: { equals: 'invited' } }] } : null
    } catch {
      return null
    }
  }

  return {
    slug: MEMBERS,
    // No Payload edit-lock rows for these documents; the plugin's own checks handle two changes at once.
    lockDocuments: false,
    labels: { singular: 'Organization member', plural: 'Organization members' },
    admin: {
      group: opts.adminGroup ?? 'Organizations',
      useAsTitle: 'level',
      defaultColumns: ['organization', 'user', 'level', 'status'],
      description: 'Who is in which organization, and at what level. Leave by setting the status to Removed; rows are never deleted, so the record stays.',
    },
    access: {
      create: ({ req }) => !!signedIn(req, s),
      update: async ({ req, id, data }) => {
        const user = signedIn(req, s)
        if (!user || id === undefined || id === null) return false
        const readable = await readLimit(MEMBERS, read, req, id)
        const answer = await ownAnswer(req, user.id, data)
        if (readable === true || !answer) return readable
        return readable ? { or: [readable, answer] } : answer
      },
      delete: () => false,
      read,
    },
    fields: [
      { name: 'organization', type: 'relationship', relationTo: ORGANIZATIONS, required: true, index: true },
      { name: 'user', type: 'relationship', relationTo: s.users, required: true, index: true },
      { name: 'level', type: 'select', required: true, index: true, options: [{ label: 'Coordinator', value: 'coordinator' }, { label: 'Member', value: 'member' }, { label: 'Viewer', value: 'viewer' }] },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'invited',
        index: true,
        options: [
          { label: 'Invited', value: 'invited' },
          { label: 'Active', value: 'active' },
          { label: 'Removed', value: 'removed' },
        ],
        admin: { description: 'An invited person gets nothing until they accept (or, in a pending organization, until an approver activates them). Removed is final: invite again to bring them back.' },
      },
      { name: 'invitedBy', type: 'relationship', relationTo: s.users, admin: { readOnly: true } },
      { name: 'acceptedAt', type: 'date', admin: { readOnly: true } },
      { name: 'removedAt', type: 'date', admin: { readOnly: true } },
      { name: 'removedBy', type: 'relationship', relationTo: s.users, admin: { readOnly: true } },
      {
        name: 'pendingLevel',
        type: 'select',
        options: [{ label: 'Coordinator', value: 'coordinator' }, { label: 'Member', value: 'member' }, { label: 'Viewer', value: 'viewer' }],
        admin: { readOnly: true, description: 'A promotion offered to this person. It takes effect when they accept it. Set through the level, never directly.' },
      },
      // Makes a second live membership for the same organization and person fail in the database, not just in a check.
      { name: 'liveKey', type: 'text', unique: true, index: true, hidden: true, admin: { disabled: true } },
    ],
    hooks: {
      beforeOperation: [noBulk],
      afterOperation: [
        ({ operation, result, req }) => {
          const id = (result as { id?: unknown } | null | undefined)?.id
          if (operation === 'updateByID' && id !== undefined && unseen.get(req)?.delete(String(id))) return null as never
          return result
        },
      ],
      beforeDelete: [
        () => {
          throw refuse('Memberships are never deleted. Set the status to Removed.')
        },
      ],
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          await needTransaction(req, s)
          const now = new Date().toISOString()
          const me = signedIn(req, s)
          if (req.user && !me) throw refuse('Only a signed-in user can change memberships.')
          const trusted = !req.user || isInternal(req)

          if (operation === 'create') {
            const d = plain(data)
            // The host's rule comes first, so someone who may not invite learns nothing about the organization, not even that it exists or is closed.
            if (!trusted && !(await ask(opts.canInvite, req, d, { data: d }))) throw refuse('You can’t invite people to this organization.')
            const organization = await loadOrganization(req, d.organization, orgOf)
            if (!organization) throw refuse('Unknown organization.')
            if (organization.status === 'closed') throw refuse('This organization is closed.')
            // Refusals about the person all read the same as a refused invitation, so an inviter can't tell a missing account, an invited minor or a member they can't see apart.
            const cannot = () => refuse('You can’t invite people to this organization.')
            const userId = idOf(d.user)
            if (userId === null) throw cannot()
            const level = levelOf(d.level)
            if (!level) throw refuse('Unknown level.')
            data.organization = organization.id
            data.user = userId
            data.status = 'invited'
            data.acceptedAt = null
            data.removedAt = null
            data.removedBy = null
            if (me) data.invitedBy = me.id
            else delete data.invitedBy
            const dup = await req.payload.find({
              collection: MEMBERS as never,
              where: { and: [{ organization: { equals: organization.id } }, { user: { equals: userId } }, { status: { in: LIVE } }] },
              limit: 1,
              pagination: false,
              depth: 0,
              overrideAccess: true,
              req,
            })
            if (dup.docs.length) {
              // Say so plainly only to someone who can already see that row.
              if (trusted) throw refuse('That person is already in this organization.')
              const seen = await req.payload.find({ collection: MEMBERS as never, where: { id: { equals: dup.docs[0]!.id } } as never, limit: 1, pagination: false, depth: 0, overrideAccess: false, req }).catch(() => null)
              throw seen?.docs.length ? refuse('That person is already in this organization.') : cannot()
            }
            const subject = await req.payload.count({ collection: s.users as never, where: { id: { equals: userId } } as never, overrideAccess: true, req }).catch(() => null)
            if (!subject?.totalDocs) throw trusted ? refuse('Unknown person.') : cannot()
            // The veto runs when the person accepts, so an inviter sees the same answer for every account. It is asked now only when the person invites themselves (the maker of an organization) or server code does, where nobody else can read the answer.
            if (trusted || (me !== null && String(me.id) === String(userId))) await vetoed(opts, s.users, req, organization, userId, level, 'invite')
            // The database's unique index on this key is what stops two requests at once.
            data.liveKey = JSON.stringify([organization.id, userId])
            await emit(req, opts.audit?.before, { event: 'invite', phase: 'before', organization, membership: normalize(data), by: by(req) }, true)
            return data
          }

          // An update. Every refusal and the veto come first. The row's write lock is taken only once the change is allowed, right before it is written,
          // so a refused change never touches the row and how it ends can't show who the veto covers.
          const changed = await (async () => {
            // Organization, person and who invited never change; only level and status do.
            const before = normalize(originalDoc)
            const sent = plain(data)
            for (const f of ['organization', 'user', 'invitedBy'] as const) {
              if (f in sent && String(sent[f] ?? '') !== String(before[f] ?? '')) throw refuse('Only the level and status can be changed.')
            }
            for (const f of ['liveKey', 'acceptedAt', 'removedAt', 'removedBy']) delete data[f]
            // A pending promotion changes only through the level paths below. Sending it back unchanged is fine; sending null cancels it.
            const wanted = 'pendingLevel' in data ? (data.pendingLevel as unknown) : undefined
            delete data.pendingLevel
            const held = before.pendingLevel ?? null
            if (wanted !== undefined && wanted !== null && wanted !== '' && wanted !== held) throw refuse('Only the level and status can be changed.')
            const cancelling = held !== null && (wanted === null || wanted === '')
            const level = levelOf(sent.level ?? before.level)
            if (!level) throw refuse('Unknown level.')
            const status = (sent.status ?? before.status) as MemberStatus
            if (!STATUS.includes(status)) throw refuse('Unknown status.')
            const levelChanged = level !== before.level
            const statusChanged = status !== before.status
            const asker = by(req)
            const self = me !== null && String(me.id) === String(before.user)
            const ctx = { id: before.id, data: sent }
            // Settled before the write: accepting makes the row readable, but a write to a row that was hidden still answers with nothing.
            if (me && self && !isInternal(req)) {
              const marked = unseen.get(req) ?? new Set<string>()
              unseen.set(req, marked)
              marked.delete(String(before.id))
              if (neverAccepted(before) && (await hiddenOwnRows(req, s, opts, me.id)).map(String).includes(String(before.id))) marked.add(String(before.id))
            }
            if (!levelChanged && !statusChanged && !cancelling) {
              // A save that changes nothing still answers with the row, so it takes the person or someone the host lets change it.
              if (!trusted && !self && !(await ask(opts.canChangeLevel, req, before, { ...ctx, to: before.level })) && !(await ask(opts.canRemove, req, before, ctx))) throw refuse('You can’t change this person’s level.')
              return data
            }
            if (before.status === 'removed') throw refuse('A removed member is final. Invite them again.')
            if (statusChanged && !(before.status === 'invited' && (status === 'active' || status === 'removed')) && !(before.status === 'active' && status === 'removed'))
              throw refuse('That status change isn’t allowed.')
            const organization = await loadOrganization(req, before.organization, orgOf)
            if (!organization) throw refuse('Unknown organization.')

            if (status === 'removed') {
              if (!trusted && !self && !(await ask(opts.canRemove ?? opts.canChangeLevel, req, before, ctx))) throw refuse('You can’t remove this person.')
              if (before.status === 'active' && before.level === 'coordinator') await keepACoordinator(req, organization.id, before.id as string | number)
              data.liveKey = `ended:${String(originalDoc.id)}`
              data.removedAt = now
              data.removedBy = asker
              data.pendingLevel = null
              await emit(req, opts.audit?.before, { event: 'remove', phase: 'before', organization, membership: { ...before, status }, previous: before, by: asker }, true)
              return data
            }

            if (organization.status === 'closed') throw refuse('This organization is closed.')
            if (cancelling && !levelChanged && !statusChanged) {
              // The person declines, or someone who may change levels withdraws the offer.
              if (!trusted && !self && !(await ask(opts.canChangeLevel, req, before, { ...ctx, to: before.level }))) throw refuse('You can’t change this person’s level.')
              data.pendingLevel = null
              await emit(req, opts.audit?.before, { event: 'cancel-level', phase: 'before', organization, membership: { ...before, pendingLevel: null }, previous: before, by: asker }, true)
              return data
            }
            if (levelChanged) {
              const promotion = RANK[level] > RANK[before.level]
              if (!trusted && self && before.status === 'active' && held === level) {
                // The person accepts a promotion offered to them. This is the only place the veto is asked about a level for someone else's offer, and the answer goes to them alone.
                await vetoed(opts, s.users, req, organization, before.user, level, 'change-level')
                data.pendingLevel = null
                await emit(req, opts.audit?.before, { event: 'change-level', phase: 'before', organization, membership: { ...before, level, pendingLevel: null, status }, previous: before, by: asker }, true)
              } else {
                if (!trusted) {
                  if (self && promotion) throw refuse('Nobody raises their own level.')
                  if (!(await ask(opts.canChangeLevel, req, before, { ...ctx, to: level }))) throw refuse('You can’t change this person’s level.')
                  // Asking the veto about someone who hasn't accepted would tell the asker who it covers. Invite them again at the new level; the veto runs when they accept.
                  if (before.status === 'invited') throw refuse('A level can’t be changed until the person accepts. Invite them again at the new level.')
                }
                if (promotion && !trusted) {
                  // Every promotion is only offered. The veto runs when the person accepts, so the one who promotes sees the same answer, rows and history for every account.
                  data.level = before.level
                  data.pendingLevel = level
                  await emit(req, opts.audit?.before, { event: 'offer-level', phase: 'before', organization, membership: { ...before, pendingLevel: level }, previous: before, by: asker }, true)
                } else {
                  if (before.status === 'active' && before.level === 'coordinator' && level !== 'coordinator') await keepACoordinator(req, organization.id, before.id as string | number)
                  // Server code sees the veto's reason on a promotion. A demotion only takes access away, so the veto isn't asked.
                  if (promotion) await vetoed(opts, s.users, req, organization, before.user, level, 'change-level')
                  data.pendingLevel = null
                  await emit(req, opts.audit?.before, { event: 'change-level', phase: 'before', organization, membership: { ...before, level, pendingLevel: null, status }, previous: before, by: asker }, true)
                }
              }
            }
            if (statusChanged) {
              // Activating a person: they accept their own invitation. In a pending organization an approver does it instead, and never for themselves.
              const pending = organization.status === 'pending'
              if (!trusted) {
                if (pending) {
                  if (self) throw refuse('Nobody approves themselves.')
                  if (!(await approves(req, organization.id, level))) throw refuse('Only an approver can activate someone in a pending organization.')
                  // Nobody activates someone in an organization they made or belong to, or they could approve it through a second account.
                  if (await involved(req, organization.id, organization.createdBy)) throw refuse('You can’t approve an organization you made or belong to.')
                } else if (!self) throw refuse('A person accepts their own invitation.')
              }
              data.acceptedAt = now
              await vetoed(opts, s.users, req, organization, before.user, level, pending ? 'approve' : 'accept')
              await emit(req, opts.audit?.before, { event: pending ? 'approve' : 'accept', phase: 'before', organization, membership: { ...before, level, status }, previous: before, by: asker }, true)
            }
            return data
          })()
          // A withdraw and an accept at the same moment end in one success and one plain refusal.
          await claim(req, MEMBERS, originalDoc.id)
          return changed
        },
        // Runs last, once a write is allowed, so the document it returns is checked against the rows as they will be.
        ({ data, req }) => {
          forgetHidden(req)
          return data
        },
      ],
      afterRead: [
        // One rule for every document this collection returns, from finds, populating, REST, GraphQL and writes alike:
        // a person's own invitation that the veto would refuse goes back without its organization, inviter or remover.
        async ({ doc, req }) => {
          if (!req.user || isInternal(req) || inQuiet()) return doc
          const user = signedIn(req, s)
          if (!user) return doc
          const strip = () => {
            const { organization: _o, invitedBy: _i, removedBy: _r, ...rest } = doc as Record<string, unknown>
            return rest
          }
          const id = (doc as { id?: string | number }).id
          if (id === undefined || id === null) return strip()
          try {
            let stored: Record<string, unknown> | null = null
            const value = async (name: string) => {
              if (name in doc) return (doc as Record<string, unknown>)[name]
              stored ??= (await quietly(() => req.payload.findByID({ collection: MEMBERS as never, id, depth: 0, overrideAccess: true, req }))) as unknown as Record<string, unknown>
              return stored[name]
            }
            if (String(idOf(await value('user'))) !== String(user.id)) return doc
            // A read the veto makes during a quiet check gets the same answer the check would give while it waits: hidden.
            if (inVeto()) return neverAccepted({ status: await value('status'), acceptedAt: await value('acceptedAt') }) ? strip() : doc
            if (!(await hidesOwnRow(req, s, opts, user.id, id))) return doc
            // Managers and Coordinators of the organization keep what they see.
            if (opts.canRead && (await exactlyTrue(() => opts.canRead!({ req, user })))) return doc
            const organization = idOf(await value('organization'))
            if ((await quietly(() => heldBy(req))).some((h) => h.level === 'coordinator' && String(h.organization) === String(organization))) return doc
          } catch {
            // Can't tell, so hide.
          }
          return strip()
        },
      ],
      afterChange: [
        async ({ doc, previousDoc, operation, req }) => {
          const membership = normalize(doc)
          const asker = by(req)
          const organization = await loadOrganization(req, membership.organization, orgOf)
          if (!organization) return doc
          const row = { organization: organization.id, memberId: membership.user, level: membership.level, status: membership.status }
          if (operation === 'create') {
            await note(req, { ...row, event: 'invite' })
            await emit(req, opts.audit?.after, { event: 'invite', phase: 'after', organization, membership, by: asker }, false)
            return doc
          }
          if (!previousDoc) return doc
          const previous = normalize(previousDoc)
          const prev = { previousLevel: previous.level, previousStatus: previous.status }
          if (previous.status !== membership.status) {
            if (membership.status === 'removed') {
              await note(req, { ...row, ...prev, event: 'remove' })
              await emit(req, opts.audit?.after, { event: 'remove', phase: 'after', organization, membership, previous, by: asker }, false)
            } else {
              const approval = organization.status === 'pending'
              await note(req, { ...row, ...prev, event: approval ? 'approve' : 'accept' })
              // Approving the first Coordinator of a pending organization is what makes it active.
              if (approval && membership.level === 'coordinator') {
                await asInternal(req, () => req.payload.update({ collection: ORGANIZATIONS as never, id: organization.id, data: { status: 'active' } as never, overrideAccess: true, req }))
              }
              await emit(req, opts.audit?.after, { event: approval ? 'approve' : 'accept', phase: 'after', organization, membership, previous, by: asker }, false)
            }
          }
          if (previous.level === membership.level && previous.status === membership.status && previous.pendingLevel !== membership.pendingLevel) {
            if (membership.pendingLevel) {
              await note(req, { ...row, level: membership.pendingLevel, previousLevel: membership.level, event: 'offer-level' })
              await emit(req, opts.audit?.after, { event: 'offer-level', phase: 'after', organization, membership, previous, by: asker }, false)
            } else {
              await note(req, { ...row, event: 'cancel-level' })
              await emit(req, opts.audit?.after, { event: 'cancel-level', phase: 'after', organization, membership, previous, by: asker }, false)
            }
          }
          if (previous.level !== membership.level && membership.status !== 'removed') {
            if (previous.status === membership.status) await note(req, { ...row, ...prev, event: 'change-level' })
            await emit(req, opts.audit?.after, { event: 'change-level', phase: 'after', organization, membership, previous, by: asker }, false)
          }
          return doc
        },
      ],
    },
  }
}

/** The append-only history: one row per change to an organization or its people. Never edited, never deleted. */
export function eventsCollection(s: Resolved, opts: OrganizationsOptions): CollectionConfig {
  const stop = (what: string) => () => {
    throw refuse(`The history can’t be ${what}.`)
  }
  return {
    slug: EVENTS,
    lockDocuments: false,
    labels: { singular: 'Organization event', plural: 'Organization events' },
    admin: { group: opts.adminGroup ?? 'Organizations', defaultColumns: ['organization', 'event', 'memberId', 'createdAt'], description: 'What changed in each organization, and who changed it. Append-only.' },
    access: {
      create: () => false,
      update: () => false,
      delete: () => false,
      read: async ({ req }) => {
        try {
          const user = signedIn(req, s)
          if (!user) return false
          if (opts.canRead && (await exactlyTrue(() => opts.canRead!({ req, user })))) return true
          const ids = (await heldBy(req)).filter((h) => h.level === 'coordinator').map((h) => h.organization)
          return ids.length ? { organization: { in: ids } } : false
        } catch {
          return false
        }
      },
    },
    fields: [
      { name: 'organization', type: 'relationship', relationTo: ORGANIZATIONS, required: true, index: true },
      { name: 'event', type: 'select', required: true, options: ['create', 'activate', 'close', 'reopen', 'change-domains', 'update', 'invite', 'accept', 'approve', 'change-level', 'offer-level', 'cancel-level', 'remove'] },
      { name: 'memberId', type: 'text', maxLength: 100 },
      { name: 'level', type: 'text', maxLength: 40 },
      { name: 'previousLevel', type: 'text', maxLength: 40 },
      { name: 'status', type: 'text', maxLength: 40 },
      { name: 'previousStatus', type: 'text', maxLength: 40 },
      { name: 'rorId', type: 'text', maxLength: 40 },
      { name: 'previousRorId', type: 'text', maxLength: 40 },
      { name: 'domains', type: 'text', hasMany: true },
      { name: 'previousDomains', type: 'text', hasMany: true },
      { name: 'by', type: 'relationship', relationTo: s.users },
    ],
    hooks: {
      beforeOperation: [noBulk],
      beforeDelete: [stop('deleted')],
      beforeChange: [
        async ({ operation, data, req }) => {
          await needTransaction(req, s)
          if (operation !== 'create') throw refuse('The history can’t be edited.')
          return data
        },
      ],
    },
  }
}

export { GENERAL, LEVELS }
