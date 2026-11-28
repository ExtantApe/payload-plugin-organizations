import { configToSchema } from '@payloadcms/graphql'
import { graphql } from 'graphql'
import { createLocalReq, type Access } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { answers, as, call, change, editOrg, invite, join, liveOrg, make, orgRow, propose, refused, rowOf, rows, start, state, stop, token, wipe, type U } from './setup.js'

/** Writes carry the same limits as reads: nobody gets a document back from a write that they couldn't read. */

const LIVE_NAME = 'Made-up Reserve 7310'
const PENDING_NAME = 'Made-up Station 8842'
const MEMBERS = 'organization-members'
const ORGS = 'organizations'
type Id = string | number
let ann: U, cy: U, eli: U, mo: U, dee: U, kid: U, sam: U
let live: { id: Id }, pending: { id: Id }
const EMAIL = new Map<U, string>()

beforeAll(start, 180_000)
afterAll(stop)
beforeEach(async () => {
  for (const k of Object.keys(answers)) delete answers[k]
  await wipe()
  const who = async (email: string, extra: Record<string, unknown> = {}) => {
    const u = await make(email, extra)
    EMAIL.set(u, email)
    return u
  }
  ann = await who('ann@example.com', { staff: true })
  cy = await who('cy@example.com')
  eli = await who('eli@example.com')
  mo = await who('mo@example.com')
  dee = await who('dee@example.com')
  kid = await who('kid@example.com', { minor: true })
  sam = await who('sam@example.com')
  live = await liveOrg(cy, ann, { name: LIVE_NAME })
  await join(live.id, cy, mo, 'member')
  await invite(cy, live.id, { user: kid.id, level: 'viewer' })
  pending = await propose(sam, { name: PENDING_NAME })
})

type Answer = { status: 'ok' | 'refused'; body: unknown }
const settle = async (p: Promise<unknown>): Promise<Answer> => {
  try {
    return { status: 'ok', body: await p }
  } catch (e) {
    return { status: 'refused', body: (e as Error).message }
  }
}
const gqlRun = async (u: U, source: string): Promise<Answer> => {
  const { schema } = configToSchema(state.payload.config)
  const req = await createLocalReq({ user: as(u) }, state.payload)
  req.payloadAPI = 'GraphQL'
  const r = await graphql({ schema, source, contextValue: { req } })
  return { status: r.errors?.length ? 'refused' : 'ok', body: r }
}
const restRun = async (u: U, method: string, path: string, body?: unknown): Promise<Answer> => {
  const r = await call(path, { method, token: await token(EMAIL.get(u)!), body })
  return { status: r.status < 300 ? 'ok' : 'refused', body: r.json }
}

const literal = (d: Record<string, unknown>, enums: string[]) =>
  Object.entries(d)
    .map(([k, v]) => `${k}: ${enums.includes(k) ? v : JSON.stringify(v)}`)
    .join(', ')
const FIELDS = { [ORGS]: 'id name createdBy { id email }', [MEMBERS]: 'id level status user { id email } invitedBy { id email } organization { id name }' }
const MUTATION = { [ORGS]: 'Organization', [MEMBERS]: 'OrganizationMember' }
type Slug = keyof typeof MUTATION

/** The document a successful update answered with. */
const document = (path: string, a: Answer): unknown => {
  if (path.startsWith('REST')) return (a.body as { doc?: unknown }).doc
  if (path === 'GraphQL') return (a.body as { data?: { updateOrganizationMember?: unknown } }).data?.updateOrganizationMember
  return a.body
}

/** The update paths that can answer with a document. */
const updates = (u: U, slug: Slug, id: Id, data: Record<string, unknown>) =>
  [
    ...[0, 1, 2].map((depth) => [`Local depth ${depth}`, () => settle(state.payload.update({ collection: slug as never, id: id as never, data: { ...data } as never, user: as(u), overrideAccess: false, depth }))] as const),
    ...[0, 2].map((depth) => [`REST depth ${depth}`, () => restRun(u, 'PATCH', `/${slug}/${id}?depth=${depth}`, data)] as const),
    ['GraphQL', () => gqlRun(u, `mutation { update${MUTATION[slug]}(id: "${id}", data: { ${literal(data, ['status', 'level', 'kind'])} }) { ${FIELDS[slug]} } }`)] as const,
  ]

/** Every other write path that can answer with a document. */
const others = (u: U, slug: Slug, id: Id) =>
  [
    ['Local bulk update', () => settle(state.payload.update({ collection: slug as never, where: { id: { equals: id } } as never, data: {} as never, user: as(u), overrideAccess: false }))],
    ['REST bulk update', () => restRun(u, 'PATCH', `/${slug}?where[id][equals]=${id}&depth=2`, {})],
    ['Local delete', () => settle(state.payload.delete({ collection: slug as never, id: id as never, user: as(u), overrideAccess: false }))],
    ['REST delete', () => restRun(u, 'DELETE', `/${slug}/${id}?depth=2`)],
    ['Local bulk delete', () => settle(state.payload.delete({ collection: slug as never, where: { id: { equals: id } } as never, user: as(u), overrideAccess: false }))],
    ['REST bulk delete', () => restRun(u, 'DELETE', `/${slug}?where[id][equals]=${id}&depth=2`)],
    ['GraphQL delete', () => gqlRun(u, `mutation { delete${MUTATION[slug]}(id: "${id}") { id } }`)],
    ['Local duplicate', () => settle(state.payload.duplicate({ collection: slug as never, id: id as never, user: as(u), overrideAccess: false }))],
    ['Local create from an id', () => settle(state.payload.create({ collection: slug as never, duplicateFromID: id as never, data: {} as never, user: as(u), overrideAccess: false }))],
    ['REST duplicate', () => restRun(u, 'POST', `/${slug}/${id}/duplicate?depth=2`, {})],
    // GraphQL wants the required fields even when copying; without them the schema turns the call away before any access rule runs.
    ['GraphQL duplicate', () => gqlRun(u, `mutation { duplicate${MUTATION[slug]}(id: "${id}", data: { ${slug === ORGS ? 'name: "Made-up Copy", kind: zoo, status: pending' : `organization: "${live.id}", user: "${u.id}", level: viewer, status: invited`} }) { ${FIELDS[slug]} } }`)],
    ['REST restore version', () => restRun(u, 'POST', `/${slug}/versions/${id}?depth=2`, {})],
    ['REST unlock', () => restRun(u, 'POST', `/${slug}/unlock`, { id })],
  ] as const

/** The create paths for a membership. */
const creates = (u: U, organization: Id, user: Id, level: string) => {
  const data = { organization, user, level }
  return [
    ['Local', () => settle(state.payload.create({ collection: MEMBERS as never, data: { ...data } as never, user: as(u), overrideAccess: false, depth: 2 }))],
    ['REST', () => restRun(u, 'POST', `/${MEMBERS}?depth=2`, data)],
    ['GraphQL', () => gqlRun(u, `mutation { createOrganizationMember(data: { organization: "${organization}", user: "${user}", level: ${level}, status: invited }) { ${FIELDS[MEMBERS]} } }`)],
  ] as const
}

/** Strings that only a reader of these documents may get back. */
const secrets = (u: U) => [LIVE_NAME, PENDING_NAME, ...[cy, mo, sam].filter((x) => x !== u).map((x) => EMAIL.get(x)!), ...[cy, mo, sam].filter((x) => x !== u).map((x) => String(x.id))]
/** What a refused answer or a returned document gives away. */
const given = (u: U, a: Answer) => {
  const text = JSON.stringify(a.body) ?? ''
  return secrets(u).filter((x) => text.includes(x))
}
const stored = async () =>
  JSON.stringify([
    (await state.payload.find({ collection: ORGS as never, sort: 'id', depth: 0, pagination: false, overrideAccess: true })).docs,
    (await state.payload.find({ collection: MEMBERS as never, sort: 'id', depth: 0, pagination: false, overrideAccess: true })).docs,
  ])

/** The documents a stranger and a refused minor can't read, with a write that changes nothing and one that would. */
async function targets() {
  return [
    { what: 'approved organization', slug: ORGS as Slug, id: live.id, noop: { name: LIVE_NAME }, real: { name: 'Taken over' } },
    { what: 'pending organization', slug: ORGS as Slug, id: pending.id, noop: { status: 'pending' }, real: { status: 'active' } },
    { what: 'Coordinator row', slug: MEMBERS as Slug, id: (await rowOf(live.id, cy)).id, noop: { level: 'coordinator' }, real: { status: 'removed' } },
    { what: 'member row', slug: MEMBERS as Slug, id: (await rowOf(live.id, mo)).id, noop: { status: 'active' }, real: { status: 'removed' } },
    { what: 'pending row', slug: MEMBERS as Slug, id: (await rowOf(pending.id, sam)).id, noop: { level: 'coordinator' }, real: { status: 'active' } },
  ]
}

describe.each([
  ['a stranger', () => eli],
  ['a refused minor', () => kid],
])('%s', (_label, get) => {
  it('gets no document from an update, whether or not it changes anything', async () => {
    const u = get()
    const before = await stored()
    const bad: unknown[] = []
    for (const t of await targets()) {
      const sets: [string, Record<string, unknown>][] = [['empty', {}], ['no-op', t.noop], ['change', t.real]]
      for (const [kind, data] of sets) {
        // GraphQL needs a data object; an empty one is a valid no-op.
        for (const [path, run] of updates(u, t.slug, t.id, data)) {
          const a = await run()
          if (a.status !== 'refused' || given(u, a).length) bad.push([t.what, kind, path, a.status, given(u, a)])
        }
      }
    }
    expect(bad).toEqual([])
    expect(await stored()).toBe(before)
  }, 60_000)

  it('gets no document from any other write path', async () => {
    const u = get()
    const before = await stored()
    const bad: unknown[] = []
    for (const t of await targets()) {
      for (const [path, run] of others(u, t.slug, t.id)) {
        const a = await run()
        if (a.status !== 'refused' || given(u, a).length) bad.push([t.what, path, a.status, given(u, a)])
        // A GraphQL refusal has to come from the plugin's rules, with the call itself well formed.
        if (path.startsWith('GraphQL')) {
          const errors = (a.body as { errors?: { message: string; path?: unknown }[] }).errors ?? []
          if (!errors.length || errors.some((e) => !e.path)) bad.push([t.what, path, 'not run', errors.map((e) => e.message)])        }
      }
    }
    expect(bad).toEqual([])
    expect(await stored()).toBe(before)
  }, 60_000)

  it('gets no document by creating a row in someone else’s organization', async () => {
    const u = get()
    const before = await stored()
    const bad: unknown[] = []
    for (const organization of [live.id, pending.id]) {
      for (const user of [u.id, cy.id, mo.id, sam.id, dee.id]) {
        for (const [path, run] of creates(u, organization, user, 'coordinator')) {
          const a = await run()
          // Ids the caller sent themselves aren't news to them.
          const news = given(u, a).filter((x) => x !== String(user))
          if (a.status !== 'refused' || news.length) bad.push([organization, user, path, a.status, news])
        }
      }
    }
    expect(bad).toEqual([])
    expect(await stored()).toBe(before)
  }, 60_000)

  it('gets nothing from server code that runs with their access turned off', async () => {
    const u = get()
    const bad: unknown[] = []
    for (const t of await targets()) {
      for (const [kind, data] of [['empty', {}], ['no-op', t.noop]] as const) {
        const a = await settle(state.payload.update({ collection: t.slug as never, id: t.id as never, data: { ...data } as never, user: as(u), overrideAccess: true, depth: 1 }))
        if (a.status !== 'refused' || given(u, a).length) bad.push([t.what, kind, a.status, given(u, a)])
      }
    }
    expect(bad).toEqual([])
  })
})

describe('a refused minor and their own invitation', () => {
  const own = async () => (await rows({ and: [{ organization: { equals: live.id } }, { user: { equals: kid.id } }, { status: { equals: 'invited' } }] })).docs[0] as unknown as { id: Id }
  const hidden = (a: Answer) => [LIVE_NAME, String(cy.id), String(live.id), EMAIL.get(cy)!].filter((x) => (JSON.stringify(a.body) ?? '').includes(x))

  it('gets no document from a write that isn’t a plain decline or accept', async () => {
    const row = await own()
    const before = await stored()
    const bad: unknown[] = []
    const sets: Record<string, unknown>[] = [{}, { level: 'viewer' }, { status: 'invited' }, { level: 'coordinator' }, { status: 'removed', level: 'viewer' }]
    for (const data of sets) {
      for (const [path, run] of updates(kid, MEMBERS, row.id, data)) {
        const a = await run()
        if (a.status !== 'refused' || hidden(a).length) bad.push([data, path, a.status, hidden(a)])
      }
    }
    for (const [path, run] of others(kid, MEMBERS, row.id)) {
      const a = await run()
      if (a.status !== 'refused' || hidden(a).length) bad.push([path, a.status, hidden(a)])
    }
    expect(bad).toEqual([])
    expect(await stored()).toBe(before)
  }, 60_000)

  it('declines on every update path and gets no document back', async () => {
    for (let i = 0; i < 6; i++) {
      const row = await own()
      const [path, run] = updates(kid, MEMBERS, row.id, { status: 'removed' })[i]!
      const a = await run()
      expect([path, a.status, document(path, a)]).toEqual([path, 'ok', null])
      expect((await rows({ id: { equals: row.id } })).docs[0]).toMatchObject({ status: 'removed' })
      // Once declined, nothing more is written to it or answered with it.
      const again = await updates(kid, MEMBERS, row.id, { status: 'removed' })[i]![1]()
      expect([path, again.status, hidden(again)]).toEqual([path, 'refused', []])
      await invite(cy, live.id, { user: kid.id, level: 'viewer' })
    }
  }, 60_000)

  it('is refused at accept with the veto’s reason and no document', async () => {
    for (const [path, run] of updates(kid, MEMBERS, (await own()).id, { status: 'active' })) {
      const a = await run()
      expect([path, a.status, hidden(a)]).toEqual([path, 'refused', []])
      expect([path, JSON.stringify(a.body)]).toEqual([path, expect.stringContaining('Not available for this account')])
      if (path.startsWith('Local')) expect(typeof a.body).toBe('string')
      // REST answers with errors only, and GraphQL with a null result.
      if (path.startsWith('REST')) expect(Object.keys(a.body as object)).toEqual(['errors'])
      if (path === 'GraphQL') expect(Object.values((a.body as { data?: Record<string, unknown> }).data ?? {}).filter(Boolean)).toEqual([])
    }
    expect(await refused(change(kid, (await own()).id, { status: 'active' }))).toMatch(/Not available for this account/)
  })

  it('gets no document from a decline that server code runs as them', async () => {
    const row = await own()
    const wrote = await state.payload.update({ collection: MEMBERS as never, id: row.id as never, data: { status: 'removed' } as never, user: as(kid), overrideAccess: true })
    expect(wrote).toBeNull()
  })

  it('leaves the answer to someone else removing the row as it was', async () => {
    expect((await change(cy, (await own()).id, { status: 'removed' })).status).toBe('removed')
  })

  // The quiet check and the real one are separate questions to the host, so they can disagree.
  it('shows nothing when the quiet check says no and the real accept goes through', async () => {
    answers.refuse = ((a: { preview?: boolean }) => (a.preview ? 'No.' : null)) as never
    for (let i = 0; i < 6; i++) {
      await invite(cy, live.id, { user: dee.id, level: 'viewer' })
      const row = await rowOf(live.id, dee)
      const [path, run] = updates(dee, MEMBERS, row.id, { status: 'active' })[i]!
      const a = await run()
      expect([path, a.status, document(path, a), hidden(a)]).toEqual([path, 'ok', null, []])
      expect((await rows({ id: { equals: row.id } })).docs[0]).toMatchObject({ status: 'active' })
      await change(dee, row.id, { status: 'removed' })
      await (state.payload.db as unknown as { collections: Record<string, { deleteMany: (f: object) => Promise<unknown> }> }).collections[MEMBERS]!.deleteMany({ _id: row.id })
    }
  }, 60_000)

  it.each(['removed', 'active'])('is refused when anything is sent along with status %s', async (status) => {
    const row = await own()
    const before = await stored()
    const bad: unknown[] = []
    const extras: Record<string, unknown>[] = [
      { level: 'viewer' },
      { pendingLevel: null },
      { organization: live.id },
      { user: kid.id },
      { invitedBy: cy.id },
      { removedBy: kid.id },
      { acceptedAt: null },
      { liveKey: 'x' },
      { id: row.id },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
      { unknownField: 1 },
    ]
    for (const extra of extras) {
      const data = { status, ...extra }
      const a = await settle(state.payload.update({ collection: MEMBERS as never, id: row.id as never, data: { ...data } as never, user: as(kid), overrideAccess: false, depth: 2 }))
      const b = await restRun(kid, 'PATCH', `/${MEMBERS}/${row.id}?depth=2`, data)
      for (const [path, r] of [['Local', a], ['REST', b]] as const) if (r.status !== 'refused' || hidden(r).length) bad.push([extra, path, r.status, hidden(r)])
    }
    const undef = await settle(change(kid, row.id, { status, level: undefined }))
    expect(undef.status).toBe('refused')
    expect(bad).toEqual([])
    expect(await stored()).toBe(before)
  }, 60_000)

  it.each(['removed', 'active'])('can’t send status %s to anyone else’s row or to an organization', async (status) => {
    await invite(cy, live.id, { user: dee.id, level: 'viewer' })
    const other = await make('kid2@example.com', { minor: true })
    await invite(cy, live.id, { user: other.id, level: 'viewer' })
    const memberRows = [await rowOf(live.id, dee), await rowOf(live.id, other), await rowOf(live.id, cy), await rowOf(live.id, mo), await rowOf(pending.id, sam)].map((r) => [MEMBERS, r.id] as const)
    const before = await stored()
    for (const u of [kid, eli]) {
      for (const [slug, id] of [...memberRows, [ORGS, live.id] as const, [ORGS, pending.id] as const]) {
        for (const [path, run] of updates(u, slug, id, { status })) {
          const a = await run()
          expect([slug, id, path, a.status, given(u, a)]).toEqual([slug, id, path, 'refused', []])
        }
      }
    }
    expect(await stored()).toBe(before)
  }, 60_000)

  it('gets nothing back by sending status active to a declined row', async () => {
    const row = await own()
    await change(kid, row.id, { status: 'removed' })
    const before = await stored()
    for (const [path, run] of updates(kid, MEMBERS, row.id, { status: 'active' })) {
      const a = await run()
      expect([path, a.status, hidden(a)]).toEqual([path, 'refused', []])
    }
    expect(await stored()).toBe(before)
  })
})

describe('status active on a row that isn’t waiting for an answer', () => {
  it('returns no more than a read on a row that is already active, even once the veto refuses', async () => {
    const id = (await rowOf(live.id, mo)).id
    answers.refuse = () => 'No.'
    const shape = (d: unknown) => {
      const { updatedAt: _u, ...rest } = d as Record<string, unknown>
      return rest
    }
    const read = await state.payload.findByID({ collection: MEMBERS as never, id: id as never, user: as(mo), overrideAccess: false, depth: 1 })
    const wrote = await state.payload.update({ collection: MEMBERS as never, id: id as never, data: { status: 'active' } as never, user: as(mo), overrideAccess: false, depth: 1 })
    expect(shape(wrote)).toEqual(shape(read))
  })

  it('is refused on a row that was accepted and then removed', async () => {
    const id = (await rowOf(live.id, mo)).id
    await change(mo, id, { status: 'removed' })
    const before = await stored()
    for (const [path, run] of updates(mo, MEMBERS, id, { status: 'active' })) {
      const a = await run()
      expect([path, a.status]).toEqual([path, 'refused'])
      expect(JSON.stringify(a.body)).not.toContain(LIVE_NAME)
    }
    expect(await stored()).toBe(before)
  })
})

/** A write can't be read back by everyone who may make it, so a create answer must hold nothing they didn't send. */
describe('a create answer for someone who can’t read the result', () => {
  const STAMPS = ['id', 'createdAt', 'updatedAt']
  const filled = (d: unknown) => Object.fromEntries(Object.entries(d as Record<string, unknown>).filter(([k, v]) => !STAMPS.includes(k) && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)))
  const create = (u: U, collection: string, data: Record<string, unknown>) => state.payload.create({ collection: collection as never, data: data as never, user: as(u), overrideAccess: false, depth: 0 }) as unknown as Promise<Record<string, unknown>>
  const canRead = async (u: U, collection: string, id: unknown) => (await settle(state.payload.findByID({ collection: collection as never, id: id as never, user: as(u), overrideAccess: false }))).status === 'ok'

  it('a Member inviting a Viewer gets what they sent, their own id and the starting status', async () => {
    const made = await create(mo, MEMBERS, { organization: live.id, user: dee.id, level: 'viewer' })
    expect(await canRead(mo, MEMBERS, made.id)).toBe(false)
    expect(filled(made)).toEqual({ organization: live.id, user: dee.id, level: 'viewer', status: 'invited', invitedBy: mo.id })
  })

  it('the answer is the same whether or not the invited account is refused', async () => {
    const other = await make('kid2@example.com', { minor: true })
    const [a, b] = [await create(mo, MEMBERS, { organization: live.id, user: dee.id, level: 'viewer' }), await create(mo, MEMBERS, { organization: live.id, user: other.id, level: 'viewer' })]
    expect(Object.keys(filled(b))).toEqual(Object.keys(filled(a)))
    expect({ ...filled(b), user: dee.id }).toEqual(filled(a))
  })

  it.each([
    ['a stranger', async () => eli],
    ['a refused minor', async () => kid],
  ])('%s whom a host rule lets invite gets no details of an organization they can’t read, at any depth', async (_label, get) => {
    answers.canInvite = () => true
    const u = await get()
    expect(await canRead(u, ORGS, pending.id)).toBe(false)
    const targets = [dee, await make('new1@example.com'), await make('new2@example.com')]
    let i = 0
    for (const [path] of creates(u, pending.id, dee.id, 'viewer')) {
      const target = targets[i]!
      const a = await creates(u, pending.id, target.id, 'viewer')[i++]![1]()
      expect([path, a.status, a.status === 'ok' ? '' : JSON.stringify(a.body)]).toEqual([path, 'ok', ''])
      expect([path, given(u, a)]).toEqual([path, []])
    }
  })

  it('a stranger or refused minor who proposes an organization gets only their own proposal', async () => {
    for (const u of [eli, kid]) {
      const a = await settle(create(u, ORGS, { name: LIVE_NAME, kind: 'zoo', domains: ['taken.example'] }))
      if (a.status === 'refused') {
        expect(given(u, a)).toEqual([])
        continue
      }
      expect(filled(a.body)).toEqual({ name: LIVE_NAME, kind: 'zoo', status: 'pending', createdBy: u.id })
    }
  })

  it('someone who may only pre-create an organization gets only what they sent', async () => {
    answers.canPrecreate = () => true
    const made = await create(eli, ORGS, { name: 'Made-up Annex', kind: 'zoo' })
    expect(filled(made)).toEqual({ name: 'Made-up Annex', kind: 'zoo', status: 'pending', createdBy: eli.id })
  })
})

describe('people who may write still can', () => {
  const ok = async (u: U, slug: Slug, id: Id, data: Record<string, unknown>) => {
    for (const [path, run] of updates(u, slug, id, data)) {
      const a = await run()
      expect([path, a.status, a.status === 'ok' ? '' : JSON.stringify(a.body)]).toEqual([path, 'ok', ''])
    }
  }

  it('a Coordinator saves their organization and its rows, changed or not', async () => {
    await ok(cy, ORGS, live.id, {})
    await ok(cy, ORGS, live.id, { name: LIVE_NAME })
    await ok(cy, MEMBERS, (await rowOf(live.id, mo)).id, {})
    await ok(cy, MEMBERS, (await rowOf(live.id, kid)).id, { level: 'viewer' })
    expect((await editOrg(cy, live.id, { name: 'Made-up Reserve, renamed' })).name).toBe('Made-up Reserve, renamed')
    expect((await change(cy, (await rowOf(live.id, mo)).id, { level: 'viewer' })).level).toBe('viewer')
    expect((await change(cy, (await rowOf(live.id, kid)).id, { status: 'removed' })).status).toBe('removed')
  })

  it('staff approve a pending organization', async () => {
    await ok(ann, ORGS, pending.id, {})
    await ok(ann, MEMBERS, (await rowOf(pending.id, sam)).id, {})
    await change(ann, (await rowOf(pending.id, sam)).id, { status: 'active' })
    expect((await orgRow(pending.id)).status).toBe('active')
  })

  it('a person accepts, keeps their row and leaves', async () => {
    await invite(cy, live.id, { user: dee.id, level: 'viewer' })
    const id = (await rowOf(live.id, dee)).id
    await ok(dee, MEMBERS, id, {})
    expect((await change(dee, id, { status: 'active' })).status).toBe('active')
    await ok(dee, MEMBERS, id, { level: 'viewer' })
    expect((await change(dee, id, { status: 'removed' })).status).toBe('removed')
  })

  it('a person declines an invitation they can see', async () => {
    await invite(cy, live.id, { user: dee.id, level: 'viewer' })
    expect((await change(dee, (await rowOf(live.id, dee)).id, { status: 'removed' })).status).toBe('removed')
  })

  it('a reader who may change nothing gets no no-op write', async () => {
    // A member reads the organization and the Coordinator's row, and may change neither.
    for (const [slug, id] of [[ORGS, live.id], [MEMBERS, (await rowOf(live.id, cy)).id]] as const) {
      for (const [path, run] of updates(mo, slug, id, {})) expect([slug, path, (await run()).status]).toEqual([slug, path, 'refused'])
    }
  })

  it('a host rule that lets someone write doesn’t reach a document they can’t read', async () => {
    answers.canUpdate = () => true
    answers.canChangeLevel = () => true
    for (const t of await targets()) {
      for (const [path, run] of updates(eli, t.slug, t.id, {})) expect([t.what, path, (await run()).status]).toEqual([t.what, path, 'refused'])
    }
  })
})

describe('a host that changes read access', () => {
  const access = (slug: Slug) => (state.payload.collections as unknown as Record<string, { config: { access: { read: Access } } }>)[slug]!.config.access
  const withRead = async (slug: Slug, make: (own: Access) => Access, run: () => Promise<void>) => {
    const own = access(slug).read
    access(slug).read = make(own)
    try {
      await run()
    } finally {
      access(slug).read = own
    }
  }

  it.each([ORGS, MEMBERS] as Slug[])('wider read on %s opens no write', async (slug) => {
    const wider: ((own: Access) => Access)[] = [() => () => true, () => () => ({ id: { exists: true } })]
    for (const widen of wider) {
      await withRead(slug, widen, async () => {
        answers.canUpdate = () => true
        answers.canChangeLevel = () => true
        for (const t of (await targets()).filter((x) => x.slug === slug)) {
          for (const u of [eli, kid]) {
            for (const [path, run] of updates(u, t.slug, t.id, {})) expect([t.what, path, (await run()).status]).toEqual([t.what, path, 'refused'])
          }
        }
      })
    }
  }, 60_000)

  it.each([ORGS, MEMBERS] as Slug[])('narrower read on %s narrows writes too', async (slug) => {
    const id = slug === ORGS ? live.id : (await rowOf(live.id, cy)).id
    const narrower: Access[] = [
      () => false,
      () => ({ id: { equals: '000000000000000000000000' } }),
      () => {
        throw new Error('boom')
      },
      () => Promise.reject(new Error('boom')),
      (() => 'yes') as never,
    ]
    for (const read of narrower) {
      await withRead(slug, () => read, async () => {
        for (const [path, run] of updates(cy, slug, id, {})) expect([String(read), path, (await run()).status]).toEqual([String(read), path, 'refused'])
      })
    }
    // A host that adds a condition on top of the plugin's rule keeps both.
    await withRead(slug, (own) => async (args) => {
      const base = await own(args)
      return typeof base === 'object' ? { and: [base, { id: { equals: id } }] } : base
    }, async () => {
      for (const [path, run] of updates(cy, slug, id, {})) expect([path, (await run()).status]).toEqual([path, 'ok'])
      for (const [path, run] of updates(eli, slug, id, {})) expect([path, (await run()).status]).toEqual([path, 'refused'])
    })
  }, 60_000)

  it('a host read that shuts a person out also stops their hidden decline', async () => {
    const row = await rowOf(live.id, kid)
    for (const read of [() => false, () => ({ user: { not_equals: kid.id } })] as Access[]) {
      await withRead(MEMBERS, () => read, async () => {
        for (const [path, run] of updates(kid, MEMBERS, row.id, { status: 'removed' })) expect([path, (await run()).status]).toEqual([path, 'refused'])
      })
    }
    expect((await rowOf(live.id, kid)).status).toBe('invited')
  })
})
