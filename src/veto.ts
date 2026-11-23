import type { PayloadRequest } from 'payload'

import { idOf, refuse } from './helpers.js'
import { MEMBERS, ORGANIZATIONS, type Level, type Organization, type RefuseArgs, type RefuseMember } from './types.js'

export const GENERAL = 'This person can’t be added to this organization.'

/** Loads an organization with plain ids, or null. */
export async function loadOrganization(req: PayloadRequest, id: unknown, orgOf: (d: Record<string, unknown>) => Organization) {
  const oid = idOf(id)
  if (oid === null) return null
  const doc = (await req.payload.findByID({ collection: ORGANIZATIONS as never, id: oid, depth: 0, overrideAccess: true, req }).catch(() => null)) as Record<string, unknown> | null
  return doc ? ({ ...orgOf(doc), id: doc.id as string | number } as Organization & { id: string | number }) : null
}

/** The host's veto. Only `null` or nothing goes ahead. Anything else, including a throw, refuses. */
export async function vetoed(opts: { refuseMember: RefuseMember | false }, users: string, req: PayloadRequest, organization: Organization & { id: string | number }, userId: string | number, level: Level, action: RefuseArgs['action']) {
  if (opts.refuseMember === false) return
  // Only a function or exactly false is a valid setting; anything else that got past the config check refuses.
  if (typeof opts.refuseMember !== 'function') throw refuse(GENERAL)
  const subject = await req.payload.findByID({ collection: users as never, id: userId, depth: 0, overrideAccess: true, req }).catch(() => null)
  if (!subject) throw refuse(GENERAL)
  let why: unknown
  try {
    why = await opts.refuseMember({ req, organization, subject: subject as never, userId, level, action })
  } catch {
    throw refuse(GENERAL)
  }
  if (why === null || why === undefined) return
  throw refuse(typeof why === 'string' && why.trim() ? why : GENERAL)
}

export { MEMBERS }
