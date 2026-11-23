import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Payload } from 'payload'

import { organizationField, organizations, type AuditEvent } from '../src/index.js'

/**
 * A made-up site: users (staff approve things, one is flagged `minor`), a second sign-in collection `admins`, and
 * places that point at an organization through the picker. The host's rules are small functions that tests can swap
 * through `answers`.
 */
export const PW = 'correct-horse-battery'
export type U = { id: string | number }
export const state: { payload: Payload; mongo: MongoMemoryReplSet } = {} as never
export const log: string[] = []
export const seen: { id?: unknown; data?: unknown; member?: unknown; organization?: unknown; user?: unknown }[] = []
export const answers: Record<string, ((...a: never[]) => unknown) | undefined> = {}

const staff = (user: unknown) => (user as { staff?: boolean }).staff === true
const pick = (name: string, fallback: (a: never) => unknown) => (a: never) => (answers[name] ? answers[name]!(a) : fallback(a))

export async function start() {
  state.mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: state.mongo.getUri('organizations'), ensureIndexes: true }),
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [
          { name: 'staff', type: 'checkbox' },
          { name: 'minor', type: 'checkbox' },
        ],
      },
      { slug: 'admins', auth: true, fields: [] },
      { slug: 'places', fields: [{ name: 'title', type: 'text' }, organizationField({ name: 'organization' }), organizationField({ name: 'lab', kinds: ['lab'] })] },
    ],
    plugins: [
      organizations({
        kinds: [{ value: 'zoo' }, { value: 'lab' }, { value: 'university', label: 'University' }, { value: 'business' }],
        rorRequiredKinds: ['university'],
        genericDomains: ['*.sample-isp.test', 'extra-mail.example'],
        canCreate: pick('canCreate', () => true) as never,
        canPrecreate: pick('canPrecreate', ({ user }: { user: unknown }) => staff(user)) as never,
        canUpdate: pick('canUpdate', ({ user, actorLevel }: { user: unknown; actorLevel: string | null }) => staff(user) || actorLevel === 'coordinator') as never,
        canApprove: pick('canApprove', ({ user }: { user: unknown }) => staff(user)) as never,
        canInvite: ((a: { user: unknown; actorLevel: string | null; member: { level?: string }; id?: unknown; data?: unknown }) => {
          seen.push({ id: a.id, data: a.data, member: a.member })
          if (answers.canInvite) return answers.canInvite(a as never)
          return staff(a.user) || a.actorLevel === 'coordinator' || (a.actorLevel === 'member' && a.member.level === 'viewer')
        }) as never,
        canChangeLevel: ((a: { user: unknown; actorLevel: string | null; id?: unknown; data?: unknown; member?: unknown }) => {
          seen.push({ id: a.id, data: a.data, member: a.member })
          if (answers.canChangeLevel) return answers.canChangeLevel(a as never)
          return staff(a.user) || a.actorLevel === 'coordinator'
        }) as never,
        canSeePrivate: pick('canSeePrivate', ({ user }: { user: unknown }) => staff(user)) as never,
        canRead: pick('canRead', ({ user }: { user: unknown }) => staff(user)) as never,
        refuseMember: ({ subject, action, organization, userId }) => {
          seen.push({ organization, user: userId })
          log.push(`veto:${action}`)
          if (answers.refuse) return answers.refuse(undefined as never) as string | null
          return (subject as { minor?: boolean }).minor ? 'Not available for this account.' : null
        },
        audit: {
          before: (e: AuditEvent) => {
            if (answers.beforeAudit) answers.beforeAudit(e as never)
            log.push(`before:${e.event}`)
          },
          after: (e: AuditEvent) => {
            if (answers.afterAudit) answers.afterAudit(e as never)
            log.push(`after:${e.event}`)
          },
        },
      }),
    ],
  })
  state.payload = await getPayload({ config })
  return state.payload
}

export async function stop() {
  await state.payload?.db?.destroy?.()
  await state.mongo?.stop()
}

type Raw = { collections: Record<string, { deleteMany: (f: object) => Promise<unknown> }> }
/** The plugin's collections can't be deleted through Payload, so each test empties its own database directly. */
export async function wipe() {
  const { payload } = state
  for (const c of ['organization-events', 'organization-members', 'organizations', 'places']) await (payload.db as unknown as Raw).collections[c]!.deleteMany({})
  for (const c of ['users', 'admins']) await payload.delete({ collection: c as never, where: { id: { exists: true } }, overrideAccess: true })
}

export const as = (user: U, collection = 'users') => ({ ...user, collection }) as never
export const make = (email: string, extra: Record<string, unknown> = {}, collection = 'users') =>
  state.payload.create({ collection: collection as never, data: { email, password: PW, ...extra } as never }) as unknown as Promise<U>
export const refused = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export const propose = (user: U | null, data: Record<string, unknown> = {}) =>
  state.payload.create({ collection: 'organizations' as never, data: { name: 'Made-up Zoo', kind: 'zoo', ...data } as never, user: user ? as(user) : undefined, overrideAccess: false }) as unknown as Promise<{ id: string | number; status: string }>
export const orgRow = (id: unknown) => state.payload.findByID({ collection: 'organizations' as never, id: id as never, overrideAccess: true }) as unknown as Promise<Record<string, any>>
export const editOrg = (user: U | null, id: unknown, data: Record<string, unknown>) =>
  state.payload.update({ collection: 'organizations' as never, id: id as never, data: data as never, user: user ? as(user) : undefined, overrideAccess: false }) as unknown as Promise<Record<string, any>>
export const invite = (user: U | null, organization: unknown, data: Record<string, unknown>) =>
  state.payload.create({ collection: 'organization-members' as never, data: { organization, ...data } as never, user: user ? as(user) : undefined, overrideAccess: false }) as unknown as Promise<Record<string, any>>
export const change = (user: U | null, id: unknown, data: Record<string, unknown>) =>
  state.payload.update({ collection: 'organization-members' as never, id: id as never, data: data as never, user: user ? as(user) : undefined, overrideAccess: false }) as unknown as Promise<Record<string, any>>
export const rows = (where: Record<string, unknown> = {}) => state.payload.find({ collection: 'organization-members' as never, where: where as never, pagination: false, overrideAccess: true })
export const rowOf = async (org: unknown, u: U) => {
  const found = await rows({ and: [{ organization: { equals: org } }, { user: { equals: u.id } }] })
  return found.docs[0] as unknown as { id: string | number; level: string; status: string }
}
export const events = async () =>
  (await state.payload.find({ collection: 'organization-events' as never, sort: 'createdAt', pagination: false, overrideAccess: true })).docs as unknown as { event: string; level?: string; previousLevel?: string; status?: string; previousStatus?: string; memberId?: string }[]

/** A live organization: `maker` proposes it, `approver` approves its first Coordinator. */
export async function liveOrg(maker: U, approver: U, data: Record<string, unknown> = {}) {
  const org = await propose(maker, data)
  await change(approver, (await rowOf(org.id, maker)).id, { status: 'active' })
  return org
}
/** Invite then accept, so a person is active at a level. */
export async function join(org: unknown, by: U, u: U, level: string) {
  await invite(by, org, { user: u.id, level })
  const r = await rowOf(org, u)
  await change(u, r.id, { status: 'active' })
  return r
}

export const token = async (email: string) => (await state.payload.login({ collection: 'users', data: { email, password: PW } })).token as string
export const call = async (path: string, init: { method: string; token?: string; body?: unknown }) => {
  const res = await handleEndpoints({
    config: state.payload.config,
    request: new Request(`http://localhost/api${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json', ...(init.token ? { Authorization: `JWT ${init.token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}
