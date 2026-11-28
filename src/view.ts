import { AsyncLocalStorage } from 'node:async_hooks'

import type { PayloadRequest } from 'payload'

import { levelOf } from './helpers.js'
import { orgOf } from './organizations.js'
import { loadOrganization } from './veto.js'
import { MEMBERS, type OrganizationsOptions, type Resolved } from './types.js'

/** How long a quiet check waits for the host's veto before it hides the details. */
export const PREVIEW_MS = 2000

/** Set while the veto runs for a quiet check, so a read the veto makes itself is answered as hidden and can't loop. */
const inside = new AsyncLocalStorage<true>()
/** Set while the plugin looks rows up for these checks. Those results never leave the plugin, so the returned-document check skips them and can't wait on itself. */
const quiet = new AsyncLocalStorage<true>()
/** Whether the plugin is looking rows up for its own checks. */
export const inQuiet = () => quiet.getStore() === true
/** Whether the host's veto is running for a quiet check. */
export const inVeto = () => inside.getStore() === true
/** Runs a lookup whose results stay inside the plugin. */
export const quietly = <T>(fn: () => Promise<T>): Promise<T> => quiet.run(true, fn)
/** One answer per row for each request, so every read in a request (populating included) agrees. */
const answered = new WeakMap<object, Map<string, Promise<boolean>>>()

type Row = { id: string | number; organization: unknown; level: unknown; status: unknown; acceptedAt?: unknown }

/** Waits for the veto's answer, or gives up after PREVIEW_MS. Only a clear allow (null or nothing) counts. */
async function allowedInTime(run: () => unknown): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), PREVIEW_MS)
    timer.unref?.()
  })
  try {
    const why = await Promise.race([Promise.resolve().then(run), late])
    return why === null || why === undefined
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether the person reading may see the details of one of their own rows that they never accepted: the organization,
 * who invited them and who removed them. It asks the host's veto the same question accepting would ask (action
 * `accept`, or `approve` in a pending organization, at the row's level), with `preview: true`. Anything but a clear allow
 * hides them: a refusal, a throw, a late answer, a missing user or organization, or a read the veto makes itself.
 */
function mayView(req: PayloadRequest, s: Resolved, opts: OrganizationsOptions, userId: string | number, row: Row): Promise<boolean> {
  if (inside.getStore()) return Promise.resolve(false)
  let mine = answered.get(req)
  if (!mine) answered.set(req, (mine = new Map()))
  const key = JSON.stringify([String(userId), String(row.id)])
  const have = mine.get(key)
  if (have) return have
  const asked = (async () => {
    const veto = opts.refuseMember
    if (veto === false) return true
    if (typeof veto !== 'function') return false
    const level = levelOf(row.level)
    if (!level) return false
    const organization = await quietly(() => loadOrganization(req, row.organization, orgOf))
    if (!organization) return false
    const subject = (await quietly(() => req.payload.findByID({ collection: s.users as never, id: userId, depth: 0, overrideAccess: true, req })).catch(() => null)) as (Record<string, unknown> & { id: string | number }) | null
    if (!subject) return false
    const action = organization.status === 'pending' ? 'approve' : 'accept'
    return allowedInTime(() => inside.run(true, () => veto({ req, organization, subject, userId, level, action, preview: true })))
  })().catch(() => false)
  mine.set(key, asked)
  return asked
}

/** A row that is not active and was never accepted. */
export const neverAccepted = (r: { status?: unknown; acceptedAt?: unknown }) => r.status !== 'active' && (r.acceptedAt === null || r.acceptedAt === undefined || r.acceptedAt === '')

/**
 * The reader's own rows that they never accepted and may not see the details of. A row they accepted at some point
 * (or that is active) was checked by the veto then, so it shows as before. Throws on a read error, which the access
 * functions turn into no access.
 */
export async function hiddenOwnRows(req: PayloadRequest, s: Resolved, opts: OrganizationsOptions, userId: string | number): Promise<(string | number)[]> {
  const found = await quietly(() =>
    req.payload.find({
      collection: MEMBERS as never,
      where: { and: [{ user: { equals: userId } }, { status: { in: ['invited', 'removed'] } }] } as never,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      req,
    }),
  )
  const unaccepted = (found.docs as unknown as Row[]).filter(neverAccepted)
  const answers = await Promise.all(unaccepted.map((r) => mayView(req, s, opts, userId, r)))
  return unaccepted.filter((_, i) => !answers[i]).map((r) => r.id)
}

/** The hidden rows per reader for each request, for the returned-document check. A write to a membership clears it. */
const hiddenNow = new WeakMap<object, Map<string, Promise<Set<string>>>>()

/** Forgets the hidden rows worked out so far in this request, so a document returned after a write is checked afresh. */
export function forgetHidden(req: PayloadRequest) {
  hiddenNow.delete(req)
}

/**
 * Whether a membership document about to go back to its own person should lose its details (organization, inviter,
 * remover). This runs on every document the collection returns, from reads and writes alike, so a write answers with
 * no more than a read would. Throws on a read error, which the caller turns into hiding.
 */
export async function hidesOwnRow(req: PayloadRequest, s: Resolved, opts: OrganizationsOptions, userId: string | number, rowId: string | number): Promise<boolean> {
  let mine = hiddenNow.get(req)
  if (!mine) hiddenNow.set(req, (mine = new Map()))
  const key = String(userId)
  let set = mine.get(key)
  if (!set) {
    set = hiddenOwnRows(req, s, opts, userId).then((ids) => new Set(ids.map(String)))
    mine.set(key, set)
    set.catch(() => mine!.delete(key))
  }
  return (await set).has(String(rowId))
}
