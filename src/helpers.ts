import { type Access, APIError, type PayloadRequest, type Where } from 'payload'

import { type Level, MEMBERS, ORGANIZATIONS, RANK, type Resolved } from './types.js'

export const refuse = (message: string) => new APIError(message, 403, undefined, true)
/** A missing transaction is refused with the shape review tools recognize: a 403 whose data is exactly `{ refusal: 'transactions-required' }`. */
export const noTransaction = () => new APIError('This change needs a transaction, so it wasn’t made.', 403, { refusal: 'transactions-required' }, true)

/** Only an exact `true` passes. A throw, a rejection or any other answer is a no. */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/**
 * Server code can pass `disableTransaction`, and an adapter can start answering with no transaction after start-up.
 * Either way the write is refused, because it must be atomic with its lock and history rows.
 */
export async function needTransaction(req: PayloadRequest, s: Resolved) {
  if (s.needsTransactions && !(await req.transactionID)) throw noTransaction()
}

/**
 * True only for the database's write-conflict error (MongoDB code 112, `WriteConflict`), also when it is wrapped as a cause.
 * The `TransientTransactionError` label and the message text are not enough on their own: other faults carry them too, and mapping those would hide them.
 */
export const isConflict = (error: unknown, depth = 0): boolean => {
  const x = error as { code?: unknown; codeName?: unknown; cause?: unknown; errorResponse?: unknown } | null
  if (!x || typeof x !== 'object' || depth > 5) return false
  if (x.code === 112 || x.codeName === 'WriteConflict') return true
  return isConflict(x.cause, depth + 1) || isConflict(x.errorResponse, depth + 1)
}

/**
 * Writes the row once to hold its lock for this transaction. When two changes meet on the same row at once, the second
 * gets a plain refusal here and not a database error halfway through the save.
 */
export async function claim(req: PayloadRequest, collection: string, id: unknown) {
  try {
    await req.payload.db.updateOne({ collection: collection as never, id: id as never, data: {} as never, req, returning: false } as never)
  } catch (error) {
    if (isConflict(error)) throw refuse('This was just changed by someone else. Check it and try again.')
    throw error
  }
}

/** The id of a document given as a document, an id, or nothing. */
export const idOf = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return idOf((value as { id?: unknown }).id)
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

export function settings(req: Pick<PayloadRequest, 'payload'>): Resolved {
  const s = (req.payload.config.custom as { organizations?: Resolved } | undefined)?.organizations
  if (!s) throw new Error('payload-plugin-organizations is not installed')
  return s
}

export const levelOf = (value: unknown): Level | null => (value === 'coordinator' || value === 'member' || value === 'viewer' ? value : null)

/** The signed-in user, only if they come from the users collection. A user of any other collection is nobody here. */
export const signedIn = (req: PayloadRequest, s: Resolved) => {
  const user = req.user as ({ id: string | number; collection?: string } & Record<string, unknown>) | null
  return user && user.collection === s.users && idOf(user) !== null ? user : null
}

/** Internal writes the plugin makes itself, such as the first Coordinator row or the lock. Marked per request, only for the call. */
const internal = new Map<object, number>()
export const isInternal = (req: object) => (internal.get(req) ?? 0) > 0
export async function asInternal<T>(req: object, fn: () => Promise<T>): Promise<T> {
  internal.set(req, (internal.get(req) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    const n = (internal.get(req) ?? 1) - 1
    if (n <= 0) internal.delete(req)
    else internal.set(req, n)
  }
}

export type Held = { id: string | number; organization: string | number; level: Level }

/** The active memberships the signed-in user holds in active organizations. Throws on a read error. */
export async function heldBy(req: PayloadRequest, options: { organization?: string | number } = {}): Promise<Held[]> {
  const s = settings(req)
  const user = signedIn(req, s)
  if (!user) return []
  const and: object[] = [{ status: { equals: 'active' } }, { user: { equals: user.id } }]
  if (options.organization !== undefined) and.push({ organization: { equals: options.organization } })
  const rows = await req.payload.find({ collection: MEMBERS as never, where: { and } as never, pagination: false, depth: 0, overrideAccess: true, req })
  const ids = [...new Set((rows.docs as unknown as { organization: unknown }[]).map((r) => idOf(r.organization)).filter((x): x is string | number => x !== null))]
  if (!ids.length) return []
  const live = await req.payload.find({ collection: ORGANIZATIONS as never, where: { and: [{ id: { in: ids } }, { status: { equals: 'active' } }] } as never, pagination: false, depth: 0, overrideAccess: true, req })
  const open = new Set((live.docs as unknown as { id: string | number }[]).map((o) => String(o.id)))
  const out: Held[] = []
  for (const r of rows.docs as unknown as { id: string | number; organization: unknown; level: unknown }[]) {
    const organization = idOf(r.organization)
    const level = levelOf(r.level)
    if (organization !== null && level && open.has(String(organization))) out.push({ id: r.id, organization, level })
  }
  return out
}

/**
 * The highest level the signed-in user holds in one organization, or null. An invited, removed or signed-out person has
 * none, and neither does anyone in a pending or closed organization. Throws on a read error; wrap it in your own access
 * functions so an error means no.
 */
export async function levelIn(req: PayloadRequest, organization: string | number): Promise<Level | null> {
  const rows = await heldBy(req, { organization })
  return rows.reduce<Level | null>((best, r) => (best === null || RANK[r.level] > RANK[best] ? r.level : best), null)
}

/** The organizations the signed-in user is active in, each with their highest level, optionally at least `atLeast`. Throws on a read error. */
export async function organizationsOf(req: PayloadRequest, options: { atLeast?: Level } = {}): Promise<{ id: string | number; level: Level }[]> {
  const best = new Map<string, { id: string | number; level: Level }>()
  for (const r of await heldBy(req)) {
    const key = String(r.organization)
    const have = best.get(key)
    if (!have || RANK[r.level] > RANK[have.level]) best.set(key, { id: r.organization, level: r.level })
  }
  const need = options.atLeast ? RANK[options.atLeast] : 0
  return [...best.values()].filter((o) => RANK[o.level] >= need)
}

const limit = async (rule: Access, req: PayloadRequest, id: string | number): Promise<boolean | Where> => {
  try {
    const result: unknown = await rule({ req, id })
    if (result === true) return true
    return typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as Where) : false
  } catch {
    return false
  }
}

/** A write answers with the document, so writing one takes reading it too: by the plugin's own rule and by the rule the collection ends up with, in case the host changed it. Anything unclear is a no. */
export async function readLimit(slug: string, own: Access, req: PayloadRequest, id: string | number): Promise<boolean | Where> {
  const configured = (req.payload.collections as unknown as Record<string, { config: { access: { read?: Access } } } | undefined>)[slug]?.config.access.read
  const first = await limit(own, req, id)
  if (first === false || !configured) return false
  if (configured === own) return first
  const second = await limit(configured, req, id)
  if (second === false) return false
  if (first === true) return second
  return second === true ? first : { and: [first, second] }
}
