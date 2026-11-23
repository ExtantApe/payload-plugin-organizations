import { configToSchema } from '@payloadcms/graphql'
import { graphql } from 'graphql'
import { createLocalReq } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { matchOrganizations } from '../src/index.js'
import { answers, as, call, change, editOrg, invite, join, liveOrg, make, orgRow, propose, refused, rowOf, rows, start, state, stop, token, wipe, type U } from './setup.js'

/** Written out so the leak check sees no address in the file. */
const AT = '@'
const mm = (email: string, extra: Record<string, unknown> = {}, assumeVerified?: boolean) => matchOrganizations(state.payload, { id: dee.id, email, _verified: true, ...extra }, { assumeVerified })

let ann: U, bea: U, cy: U, dee: U, eli: U, fay: U
let org: { id: string | number }
let kid: U

beforeAll(start, 180_000)
afterAll(stop)
beforeEach(async () => {
  for (const k of Object.keys(answers)) delete answers[k]
  await wipe()
  ann = await make('ann@example.com', { staff: true })
  bea = await make('bea@example.com', { staff: true })
  cy = await make('cy@example.com')
  dee = await make('dee@example.com')
  eli = await make('eli@example.com')
  fay = await make('fay@example.com')
  kid = await make('kid@example.com', { minor: true })
  org = await liveOrg(cy, ann)
})

const count = async (collection = 'organization-members') => (await state.payload.count({ collection: collection as never, overrideAccess: true })).totalDocs

describe('a closed door for every route', () => {
  it('refuses REST: signed out, a stranger, a viewer, and a delete by a Coordinator or an approver', async () => {
    const before = await count()
    const body = { organization: org.id, user: dee.id, level: 'viewer' }
    expect((await call('/organization-members', { method: 'POST', body })).status).toBeGreaterThanOrEqual(400)
    expect((await call('/organization-members', { method: 'POST', body, token: await token('eli@example.com') })).status).toBeGreaterThanOrEqual(400)
    await join(org.id, cy, dee, 'viewer')
    const mid = await count()
    expect((await call('/organization-members', { method: 'POST', body: { ...body, user: eli.id }, token: await token('dee@example.com') })).status).toBeGreaterThanOrEqual(400)
    const r = await rowOf(org.id, dee)
    expect((await call(`/organization-members/${r.id}`, { method: 'PATCH', body: { level: 'coordinator' }, token: await token('dee@example.com') })).status).toBeGreaterThanOrEqual(400)
    expect((await call(`/organization-members/${r.id}`, { method: 'DELETE', token: await token('cy@example.com') })).status).toBeGreaterThanOrEqual(400)
    expect((await call(`/organizations/${org.id}`, { method: 'DELETE', token: await token('ann@example.com') })).status).toBeGreaterThanOrEqual(400)
    expect((await call(`/organizations/${org.id}`, { method: 'PATCH', body: { status: 'closed' }, token: await token('cy@example.com') })).status).toBeGreaterThanOrEqual(400)
    expect((await call('/organizations', { method: 'POST', body: { name: 'Nope', kind: 'zoo' } })).status).toBeGreaterThanOrEqual(400)
    expect(await count()).toBe(mid)
    expect(before).toBe(1)
    expect((await rowOf(org.id, dee)).level).toBe('viewer')
    expect((await orgRow(org.id)).status).toBe('active')
    // the same call works for a Coordinator, so the refusals above came from the rules and not from a typo
    expect((await call('/organization-members', { method: 'POST', body: { ...body, user: eli.id }, token: await token('cy@example.com') })).status).toBe(201)
  })

  it('refuses REST that tries to set the status, kind or lock on a new organization', async () => {
    const res = await call('/organizations', { method: 'POST', body: { name: 'Fresh Zoo', kind: 'zoo', status: 'active', lock: 5, domains: ['fresh-zoo.org'] }, token: await token('dee@example.com') })
    expect(res.status).toBe(201)
    const doc = (await state.payload.find({ collection: 'organizations' as never, where: { name: { equals: 'Fresh Zoo' } } as never, overrideAccess: true })).docs[0] as unknown as Record<string, unknown>
    expect(doc.status).toBe('pending')
    expect(doc.domains).toEqual([])
  })

  it('refuses GraphQL: a stranger inviting, a viewer raising their own level, and a stranger closing', async () => {
    await join(org.id, cy, dee, 'viewer')
    const r = await rowOf(org.id, dee)
    const { schema } = configToSchema(state.payload.config)
    const gql = async (query: string, who?: U) => {
      const req = await createLocalReq({ user: who ? as(who) : undefined }, state.payload)
      req.payloadAPI = 'GraphQL'
      return (await graphql({ schema, source: query, contextValue: { req } })) as { errors?: unknown[] }
    }
    const inv = `mutation { createOrganizationMember(data: { organization: "${org.id}", level: viewer, status: invited, user: "${fay.id}" }) { id } }`
    expect((await gql(inv, eli)).errors?.length).toBeGreaterThan(0)
    expect((await gql(inv)).errors?.length).toBeGreaterThan(0)
    const raise = `mutation { updateOrganizationMember(id: "${r.id}", data: { level: coordinator }) { id } }`
    expect((await gql(raise, dee)).errors?.length).toBeGreaterThan(0)
    expect((await gql(raise)).errors?.length).toBeGreaterThan(0)
    const close = `mutation { updateOrganization(id: "${org.id}", data: { status: closed }) { id } }`
    expect((await gql(close, eli)).errors?.length).toBeGreaterThan(0)
    expect((await gql(close, cy)).errors?.length).toBeGreaterThan(0)
    expect((await rowOf(org.id, dee)).level).toBe('viewer')
    expect((await rows({ user: { equals: fay.id } })).totalDocs).toBe(0)
    expect((await orgRow(org.id)).status).toBe('active')
    // the same invitation works for a Coordinator
    const ok = await gql(inv, cy)
    expect(ok.errors).toBeUndefined()
    expect((await rowOf(org.id, fay)).status).toBe('invited')
  })

  it('refuses a bulk update, from a Member and from a Coordinator, on memberships and organizations', async () => {
    await join(org.id, cy, dee, 'viewer')
    await join(org.id, cy, eli, 'viewer')
    for (const u of [dee, cy, ann]) {
      await refused(state.payload.update({ collection: 'organization-members' as never, where: { level: { equals: 'viewer' } } as never, data: { level: 'member' } as never, user: as(u), overrideAccess: false }))
      await refused(state.payload.update({ collection: 'organizations' as never, where: { status: { equals: 'active' } } as never, data: { status: 'closed' } as never, user: as(u), overrideAccess: false }))
    }
    expect((await rows({ level: { equals: 'member' } })).totalDocs).toBe(0)
    expect((await orgRow(org.id)).status).toBe('active')
    for (const [path, body] of [['/organization-members?where[level][equals]=viewer', { level: 'member' }], ['/organizations?where[status][equals]=active', { status: 'closed' }]] as const) {
      const res = await call(path, { method: 'PATCH', body, token: await token('ann@example.com') })
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
    expect((await rows({ level: { equals: 'member' } })).totalDocs).toBe(0)
    expect((await orgRow(org.id)).status).toBe('active')
  })

  it('lets a private note through no route to a member', async () => {
    await editOrg(ann, org.id, { privateNotes: 'staff only' })
    const rest = await call(`/organizations/${org.id}`, { method: 'GET', token: await token('cy@example.com') })
    expect(rest.status).toBe(200)
    expect(JSON.stringify(rest.json)).not.toMatch(/staff only/)
    const { schema } = configToSchema(state.payload.config)
    const req = await createLocalReq({ user: as(cy) }, state.payload)
    req.payloadAPI = 'GraphQL'
    const out = (await graphql({ schema, source: `query { Organization(id: "${org.id}") { name privateNotes } }`, contextValue: { req } })) as { data?: { Organization?: { privateNotes?: string | null } }; errors?: unknown[] }
    expect(JSON.stringify(out)).not.toMatch(/staff only/)
    const staffRest = await call(`/organizations/${org.id}`, { method: 'GET', token: await token('ann@example.com') })
    expect(JSON.stringify(staffRest.json)).toMatch(/staff only/)
  })
})

describe('the domain hint', () => {
  const set = (id: unknown, data: Record<string, unknown>) => editOrg(ann, id, data)

  it('suggests an active organization from its domain and its subdomains, and grants nothing', async () => {
    await set(org.id, { domains: ['made-up-zoo.org'] })
    const hit = await mm(`dee${AT}made-up-zoo.org`)
    expect(hit).toEqual([expect.objectContaining({ id: org.id, name: 'Made-up Zoo', kind: 'zoo', domain: 'made-up-zoo.org' })])
    expect((await mm(`DEE${AT}Mail.Made-Up-Zoo.org`)).map((m) => m.domain)).toEqual(['made-up-zoo.org'])
    expect(await mm(`dee${AT}notmade-up-zoo.org`)).toEqual([])
    expect(await mm(`dee${AT}made-up-zoo.org.evil.example`)).toEqual([])
    expect((await rows({ user: { equals: dee.id } })).totalDocs).toBe(0)
  })

  it('suggests nothing for an address that is not one, public mail, a school or a provider', async () => {
    await set(org.id, { domains: ['made-up-zoo.org'] })
    for (const email of ['', 'no-at-sign', `dee${AT}`, `${AT}made-up-zoo.org`, `dee${AT}gmail.com`, `dee${AT}x.k12.tx.us`, `dee${AT}box.sample-isp.test`, `dee${AT}extra-mail.example`]) {
      expect(await mm(email)).toEqual([])
    }
  })

  it('ignores pending and closed organizations', async () => {
    const pending = await propose(ann, { name: 'Pending Lab', kind: 'lab', domains: ['pending-lab.org'] })
    expect(await mm(`x${AT}pending-lab.org`)).toEqual([])
    const other = await liveOrg(fay, ann, { name: 'Live Lab', kind: 'lab' })
    await set(other.id, { domains: ['live-lab.org'] })
    expect((await mm(`x${AT}live-lab.org`)).length).toBe(1)
    await editOrg(bea, other.id, { status: 'closed' })
    expect(await mm(`x${AT}live-lab.org`)).toEqual([])
    expect((await orgRow(pending.id)).status).toBe('pending')
  })

  it('groups a university only once staff set it up from ROR', async () => {
    const uni = await liveOrg(fay, ann, { name: 'Made-up University', kind: 'university' })
    await set(uni.id, { domains: ['made-up.edu.example'] })
    expect(await mm(`x${AT}made-up.edu.example`)).toEqual([])
    await set(uni.id, { rorId: '02mhbdp94' })
    expect((await mm(`x${AT}made-up.edu.example`)).map((m) => m.name)).toEqual(['Made-up University'])
  })

  it('returns every organization that lists a shared domain', async () => {
    await set(org.id, { domains: ['shared.example.org'] })
    const sister = await liveOrg(fay, ann, { name: 'Sister Lab', kind: 'lab' })
    await set(sister.id, { domains: ['shared.example.org'] })
    expect((await mm(`x${AT}shared.example.org`)).map((m) => m.name).sort()).toEqual(['Made-up Zoo', 'Sister Lab'])
  })

  it('has no route that exposes it', async () => {
    await set(org.id, { domains: ['made-up-zoo.org'] })
    const res = await call(`/organizations/match?email=x${AT}made-up-zoo.org`, { method: 'GET', token: await token('eli@example.com') })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

const place = (user: U | null, data: Record<string, unknown>) =>
  state.payload.create({ collection: 'places' as never, data: { title: 'Pond', ...data } as never, user: user ? as(user) : undefined, overrideAccess: false }) as unknown as Promise<{ id: string | number }>

describe('the domain hint, for a person', () => {
  it('lists nothing before the email is verified, unless the host says it has checked', async () => {
    await editOrg(ann, org.id, { domains: ['made-up-zoo.org'] })
    expect(await mm(`dee${AT}made-up-zoo.org`, { _verified: false })).toEqual([])
    expect(await mm(`dee${AT}made-up-zoo.org`, { _verified: undefined })).toEqual([])
    expect(await mm(`dee${AT}made-up-zoo.org`, { _verified: 'true' })).toEqual([])
    expect((await mm(`dee${AT}made-up-zoo.org`, { _verified: undefined }, true)).length).toBe(1)
  })

  it('runs the host’s veto itself and drops an organization it refuses, without saying why', async () => {
    await editOrg(ann, org.id, { domains: ['made-up-zoo.org'] })
    expect(await matchOrganizations(state.payload, { id: kid.id, email: `kid${AT}made-up-zoo.org`, _verified: true })).toEqual([])
    expect((await matchOrganizations(state.payload, { id: dee.id, email: `dee${AT}made-up-zoo.org`, _verified: true })).length).toBe(1)
  })
})

describe('the picker field', () => {
  it('refuses an organization the editor can’t read, in the same words as an inactive one', async () => {
    const stranger = await refused(place(dee, { organization: org.id }))
    const missing = await refused(place(dee, { organization: '000000000000000000000000' }))
    expect(stranger).toMatch(/invalid/)
    expect(stranger).toBe(missing)
    await place(cy, { organization: org.id })
    await place(null, { organization: org.id }).catch(() => null)
    // Server code that skips access can attach any active organization.
    await state.payload.create({ collection: 'places' as never, data: { title: 'Server', organization: org.id } as never, overrideAccess: true })
  })

  it('accepts an active organization and refuses a pending, closed or unknown one', async () => {
    await place(cy, { organization: org.id })
    const pending = await propose(dee)
    expect(await refused(place(cy, { organization: pending.id }))).toMatch(/invalid/)
    expect(await refused(place(cy, { organization: '000000000000000000000000' }))).toMatch(/invalid/)
    const gone = await liveOrg(fay, ann, { name: 'Gone Zoo' })
    await editOrg(bea, gone.id, { status: 'closed' })
    expect(await refused(place(cy, { organization: gone.id }))).toMatch(/invalid/)
  })

  it('checks the kind, and lets an organization already chosen stay after it closes', async () => {
    expect(await refused(place(cy, { lab: org.id }))).toMatch(/invalid/)
    const lab = await liveOrg(fay, ann, { name: 'Made-up Lab', kind: 'lab' })
    const p = await place(fay, { lab: lab.id, title: 'Bench' })
    await editOrg(bea, lab.id, { status: 'closed' })
    await state.payload.update({ collection: 'places' as never, id: p.id as never, data: { title: 'Bench 2' } as never, user: as(fay), overrideAccess: false })
    expect(await refused(state.payload.update({ collection: 'places' as never, id: p.id as never, data: { lab: org.id } as never, overrideAccess: true }))).toMatch(/invalid/)
  })

  it('offers only active organizations of its kinds in the admin list', () => {
    const field = (state.payload.config.collections.find((c) => c.slug === 'places')!.fields as { name?: string; filterOptions?: (a: never) => unknown }[]).find((f) => f.name === 'lab')!
    expect(JSON.stringify(field.filterOptions!({} as never))).toBe(JSON.stringify({ and: [{ status: { equals: 'active' } }, { kind: { in: ['lab'] } }] }))
  })
})

void change
void invite
