import { configToSchema } from '@payloadcms/graphql'
import { graphql } from 'graphql'
import { createLocalReq } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { levelIn, organizationsOf } from '../src/index.js'
import { answers, as, call, change, invite, join, liveOrg, log, make, propose, refused, rowOf, rows, start, state, stop, token, wipe, type U } from './setup.js'

/**
 * What an invited person can read before they accept. Someone the host's veto would refuse (here, an account flagged
 * minor) must not read the organization's name, other text its people wrote, or who invited them, on any read path.
 * Someone the veto allows reads what they always did.
 */

const NAME = 'Made-up note for whoever reads this 4417'
let ann: U, cy: U, dee: U, eli: U, kid: U
let org: { id: string | number }

beforeAll(start, 180_000)
afterAll(stop)
beforeEach(async () => {
  for (const k of Object.keys(answers)) delete answers[k]
  log.length = 0
  await wipe()
  ann = await make('ann@example.com', { staff: true })
  cy = await make('cy@example.com')
  dee = await make('dee@example.com')
  eli = await make('eli@example.com')
  kid = await make('kid@example.com', { minor: true })
  org = await liveOrg(cy, ann, { name: NAME })
  await invite(cy, org.id, { user: kid.id, level: 'viewer' })
  await invite(cy, org.id, { user: dee.id, level: 'viewer' })
  log.length = 0
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settle = async (p: Promise<unknown>): Promise<any> => {
  try {
    return await p
  } catch (e) {
    return { refused: (e as Error).message }
  }
}

const find = (u: U, collection: string, extra: Record<string, unknown> = {}) =>
  settle(state.payload.find({ collection: collection as never, user: as(u), overrideAccess: false, pagination: false, ...extra }))
const byId = (u: U, collection: string, id: unknown, depth: number) =>
  settle(state.payload.findByID({ collection: collection as never, id: id as never, user: as(u), overrideAccess: false, depth }))
const count = async (u: U, collection: string, where: Record<string, unknown> = {}) =>
  (await state.payload.count({ collection: collection as never, user: as(u), overrideAccess: false, where: where as never })).totalDocs

/** Every read path an invited person has, keyed by a name for the failure message. */
async function everything(u: U, email: string) {
  const out: Record<string, unknown> = {}
  const row = await rowOf(org.id, u)
  for (const depth of [0, 1, 2]) {
    out[`find organizations depth ${depth}`] = await find(u, 'organizations', { depth })
    out[`findByID organization depth ${depth}`] = await byId(u, 'organizations', org.id, depth)
    out[`find members depth ${depth}`] = await find(u, 'organization-members', { depth })
    out[`findByID own row depth ${depth}`] = await byId(u, 'organization-members', row.id, depth)
    out[`find events depth ${depth}`] = await find(u, 'organization-events', { depth })
  }
  out['organizations sorted by name'] = await find(u, 'organizations', { sort: 'name', depth: 0 })
  out['members sorted by inviter'] = await find(u, 'organization-members', { sort: 'invitedBy', depth: 0 })
  out['members where the organization name matches'] = await find(u, 'organization-members', { where: { 'organization.name': { like: 'note for' } }, depth: 1 })
  out['members selecting the organization only'] = await find(u, 'organization-members', { select: { organization: true, invitedBy: true }, depth: 1 })
  // A host collection that points at the organization, read with the person's own access.
  const place = await state.payload.create({ collection: 'places' as never, data: { title: 'Made-up place' } as never, overrideAccess: true })
  await state.payload.db.updateOne({ collection: 'places' as never, id: (place as { id: never }).id, data: { organization: org.id } as never })
  out['a host document pointing at it, depth 1'] = await find(u, 'places', { depth: 1 })
  const t = await token(email)
  out['REST organizations'] = (await call('/organizations?depth=2', { method: 'GET', token: t })).json
  out['REST organization'] = (await call(`/organizations/${org.id}?depth=2`, { method: 'GET', token: t })).json
  out['REST members'] = (await call('/organization-members?depth=2', { method: 'GET', token: t })).json
  out['REST own row'] = (await call(`/organization-members/${row.id}?depth=2`, { method: 'GET', token: t })).json
  out['REST count'] = (await call('/organizations/count', { method: 'GET', token: t })).json
  const { schema } = configToSchema(state.payload.config)
  const req = await createLocalReq({ user: as(u) }, state.payload)
  req.payloadAPI = 'GraphQL'
  out['GraphQL'] = await graphql({
    schema,
    source: `{ Organizations { docs { id name createdBy { id } } } OrganizationMembers { docs { id invitedBy { id } organization { id name createdBy { id } } } } }`,
    contextValue: { req },
  })
  out['levelIn'] = await levelIn({ payload: state.payload, user: as(u) } as never, org.id)
  out['organizationsOf'] = await organizationsOf({ payload: state.payload, user: as(u) } as never)
  return out
}

/** The paths whose answer carries the organization's name or the inviter's id. */
const leaking = (all: Record<string, unknown>) =>
  Object.entries(all)
    .filter(([, v]) => {
      const text = JSON.stringify(v) ?? ''
      return text.includes(NAME) || text.includes(String(cy.id))
    })
    .map(([k]) => k)

describe('an invited account the veto would refuse', () => {
  it('reads no organization name, no text and no inviter on any read path', async () => {
    expect(leaking(await everything(kid, 'kid@example.com'))).toEqual([])
  })

  it('gets the same answers whether a guess about the hidden values is right or wrong', async () => {
    const pairs: [Record<string, unknown>, Record<string, unknown>, string][] = [
      [{ name: { equals: NAME } }, { name: { equals: 'Nothing like it' } }, 'organizations'],
      [{ name: { like: 'note' } }, { name: { like: 'zzz' } }, 'organizations'],
      [{ createdBy: { equals: cy.id } }, { createdBy: { equals: eli.id } }, 'organizations'],
      [{ invitedBy: { equals: cy.id } }, { invitedBy: { equals: eli.id } }, 'organization-members'],
      [{ 'organization.name': { equals: NAME } }, { 'organization.name': { equals: 'Nothing like it' } }, 'organization-members'],
      [{ organization: { equals: org.id } }, { organization: { equals: '000000000000000000000000' } }, 'organization-members'],
    ]
    for (const [right, wrong, collection] of pairs) {
      const a = await settle(count(kid, collection, right))
      const b = await settle(count(kid, collection, wrong))
      expect([collection, right, a]).toEqual([collection, right, b])
    }
  })

  it('stays hidden after the invitation is withdrawn or declined, since it was never accepted', async () => {
    await change(cy, (await rowOf(org.id, kid)).id, { status: 'removed' })
    expect(leaking(await everything(kid, 'kid@example.com'))).toEqual([])
  })

  it('is still refused at accept with the veto’s reason, and can still decline', async () => {
    const row = await rowOf(org.id, kid)
    expect(await refused(change(kid, row.id, { status: 'active' }))).toMatch(/Not available for this account/)
    expect((await rowOf(org.id, kid)).status).toBe('invited')
    expect(await refused(change(kid, row.id, { status: 'removed' }))).toBeNull()
    expect((await rowOf(org.id, kid)).status).toBe('removed')
  })

  it('can’t attach the organization to a host document through the picker', async () => {
    expect(await refused(state.payload.create({ collection: 'places' as never, data: { title: 'x', organization: org.id } as never, user: as(kid), overrideAccess: false }))).toMatch(/invalid/)
  })
})

describe('everyone else keeps what they see', () => {
  it('an invitee the veto allows still reads the organization and who invited them', async () => {
    const all = await everything(dee, 'dee@example.com')
    for (const path of ['find organizations depth 0', 'findByID organization depth 0', 'find members depth 0', 'findByID own row depth 0', 'REST organization', 'REST own row', 'GraphQL'])
      expect(leaking(all)).toContain(path)
    expect(log).toContain('veto-preview:accept')
  })

  it('the inviter sees the same rows, shapes and answers for both invitees, and the veto is never asked on their side', async () => {
    const shape = (d: Record<string, any>) => ({ keys: Object.keys(d).sort(), level: d.level, status: d.status, invitedBy: String(d.invitedBy?.id ?? d.invitedBy), org: d.organization?.name })
    for (const depth of [0, 1, 2]) {
      const a = (await byId(cy, 'organization-members', (await rowOf(org.id, kid)).id, depth)) as Record<string, any>
      const b = (await byId(cy, 'organization-members', (await rowOf(org.id, dee)).id, depth)) as Record<string, any>
      expect(shape(a)).toEqual(shape(b))
    }
    const t = await token('cy@example.com')
    const ra = await call(`/organization-members/${(await rowOf(org.id, kid)).id}`, { method: 'GET', token: t })
    const rb = await call(`/organization-members/${(await rowOf(org.id, dee)).id}`, { method: 'GET', token: t })
    expect([ra.status, Object.keys(ra.json).sort()]).toEqual([rb.status, Object.keys(rb.json).sort()])
    expect(await count(cy, 'organization-members', { status: { equals: 'invited' } })).toBe(2)
    // Another invitation and a withdrawal, from the inviter's side: nothing asks the veto.
    await invite(cy, org.id, { user: eli.id, level: 'viewer' })
    await change(cy, (await rowOf(org.id, eli)).id, { status: 'removed' })
    expect(log.filter((l) => l.startsWith('veto'))).toEqual([])
  })

  it('Coordinators, active members and staff read what they did before, without the veto being asked', async () => {
    await join(org.id, cy, eli, 'member')
    log.length = 0
    // The Coordinator sees every row, the minor's included, with who invited.
    const staffed = (await find(cy, 'organization-members', { depth: 0 })) as { docs: Record<string, any>[] }
    const kidRow = staffed.docs.find((d) => String(d.user) === String(kid.id))!
    expect(String(kidRow.invitedBy)).toBe(String(cy.id))
    expect(((await find(cy, 'organizations', { depth: 0 })) as { docs: { name: string }[] }).docs.map((d) => d.name)).toEqual([NAME])
    // An active member sees the organization, their own row with its inviter, and the Coordinators.
    const member = (await find(eli, 'organization-members', { depth: 1 })) as { docs: Record<string, any>[] }
    expect(member.docs.map((d) => d.level).sort()).toEqual(['coordinator', 'member'])
    expect(JSON.stringify(member.docs)).toContain(NAME)
    expect(String(member.docs.find((d) => d.level === 'member')!.invitedBy.id)).toBe(String(cy.id))
    expect(((await find(eli, 'organizations')) as { docs: { name: string }[] }).docs.map((d) => d.name)).toEqual([NAME])
    // Staff read everything.
    expect(await count(ann, 'organization-members', { user: { equals: kid.id } })).toBe(1)
    expect(log.filter((l) => l.startsWith('veto'))).toEqual([])
  })

  it('a maker reading their own pending organization still sees it', async () => {
    const mine = await propose(eli, { name: 'Made-up Lab', kind: 'lab' })
    log.length = 0
    expect(((await find(eli, 'organizations')) as { docs: { id: unknown }[] }).docs.map((d) => String(d.id))).toEqual([String(mine.id)])
    // A pending organization's people are activated by an approver, so the check asks as that approval would.
    expect(log).toContain('veto-preview:approve')
  })
})

describe('the check fails closed', () => {
  const deeSees = async () => (((await find(dee, 'organizations', { depth: 0 })) as { docs?: unknown[] }).docs ?? []).length > 0

  it('hides the details on a throw, a rejection or any answer but a clear allow', async () => {
    const answersToTry: (() => unknown)[] = [
      () => {
        throw new Error('boom')
      },
      () => Promise.reject(new Error('boom')),
      () => false,
      () => '',
      () => 'no',
      () => 0,
      () => true,
      () => ({}),
    ]
    for (const answer of answersToTry) {
      answers.refuse = answer
      expect([String(answer), await deeSees()]).toEqual([String(answer), false])
    }
    for (const answer of [() => null, () => undefined, async () => null]) {
      answers.refuse = answer
      expect([String(answer), await deeSees()]).toEqual([String(answer), true])
    }
  })

  it('passes the row’s level, the accept action and a preview flag, so a host can tell a quiet check apart', async () => {
    const got: Record<string, unknown>[] = []
    answers.refuse = ((a: Record<string, unknown>) => {
      got.push(a)
      return null
    }) as never
    await find(dee, 'organizations')
    expect(got.length).toBeGreaterThan(0)
    expect(got.map((a) => [a.action, a.level, a.preview, String(a.userId)])).toContainEqual(['accept', 'viewer', true, String(dee.id)])
  })

  it('hides the details when the veto doesn’t answer in time, and the read still ends', async () => {
    answers.refuse = () => new Promise(() => {})
    const began = Date.now()
    expect(await deeSees()).toBe(false)
    expect(Date.now() - began).toBeLessThan(10_000)
  })

  it('hides the details from a read the veto itself makes, so it can’t loop', async () => {
    let inner: unknown = 'not run'
    answers.refuse = (async (a: { req: never; preview?: boolean }) => {
      if (a.preview) inner = (await settle(state.payload.find({ collection: 'organizations' as never, req: a.req, overrideAccess: false, depth: 0 }))).docs?.length ?? 0
      return null
    }) as never
    expect(await deeSees()).toBe(true)
    expect(inner).toBe(0)
  })
})

describe('what a write sends back', () => {
  /** The organization's name, the inviter's id or the organization's id anywhere in an answer. */
  const reveals = (v: unknown) => {
    const text = JSON.stringify(v) ?? ''
    return [NAME, String(cy.id), String(org.id)].filter((x) => text.includes(x))
  }
  const local = (u: U, id: unknown, data: Record<string, unknown>, depth: number) =>
    settle(state.payload.update({ collection: 'organization-members' as never, id: id as never, data: data as never, user: as(u), overrideAccess: false, depth }))
  const rest = async (email: string, id: unknown, data: Record<string, unknown>, depth: number) =>
    (await call(`/organization-members/${id}?depth=${depth}`, { method: 'PATCH', token: await token(email), body: data })).json
  const gql = async (u: U, id: unknown, data: string) => {
    const { schema } = configToSchema(state.payload.config)
    const req = await createLocalReq({ user: as(u) }, state.payload)
    req.payloadAPI = 'GraphQL'
    return graphql({ schema, source: `mutation { updateOrganizationMember(id: "${id}", data: { ${data} }) { id status invitedBy { id } removedBy { id } organization { id name } } }`, contextValue: { req } })
  }
  /** Every write path at depth 0 and 1. GraphQL picks its own depth from the fields asked for, which here reach one level in. */
  const paths = (u: U, email: string) => [
    ['Local depth 0', (id: unknown, d: Record<string, unknown>) => local(u, id, d, 0)],
    ['Local depth 1', (id: unknown, d: Record<string, unknown>) => local(u, id, d, 1)],
    ['REST depth 0', (id: unknown, d: Record<string, unknown>) => rest(email, id, d, 0)],
    ['REST depth 1', (id: unknown, d: Record<string, unknown>) => rest(email, id, d, 1)],
    ['GraphQL', (id: unknown, d: Record<string, unknown>) => gql(u, id, Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(', '))],
  ] as const

  it('a refused invitee’s no-op write to their invitation answers with nothing a read hides', async () => {
    const row = await rowOf(org.id, kid)
    for (const [name, write] of paths(kid, 'kid@example.com')) expect([name, reveals(await write(row.id, { level: 'viewer' }))]).toEqual([name, []])
    expect((await rowOf(org.id, kid)).status).toBe('invited')
  })

  it('a refused invitee can decline on every path, and the answer reveals nothing', async () => {
    for (const [name, write] of paths(kid, 'kid@example.com')) {
      const row = (await rows({ and: [{ organization: { equals: org.id } }, { user: { equals: kid.id } }, { status: { equals: 'invited' } }] })).docs[0] as unknown as { id: string | number }
      const answer = await write(row.id, { status: 'removed' })
      expect([name, reveals(answer)]).toEqual([name, []])
      const after = (await state.payload.findByID({ collection: 'organization-members' as never, id: row.id as never, overrideAccess: true })) as unknown as { status: string }
      expect([name, after.status]).toEqual([name, 'removed'])
      await invite(cy, org.id, { user: kid.id, level: 'viewer' })
    }
  })

  it('a no-op write to a declined or withdrawn invitation reveals nothing either', async () => {
    const row = await rowOf(org.id, kid)
    await change(cy, row.id, { status: 'removed' })
    for (const [name, write] of paths(kid, 'kid@example.com')) {
      expect([name, reveals(await write(row.id, { level: 'viewer' }))]).toEqual([name, []])
      expect([name, reveals(await write(row.id, { status: 'removed' }))]).toEqual([name, []])
    }
  })

  it('an invitee the veto allows, and the inviter, still get the full row back', async () => {
    const mine = await rowOf(org.id, dee)
    for (const [name, write] of paths(dee, 'dee@example.com')) expect([name, reveals(await write(mine.id, { level: 'viewer' })).length > 0]).toEqual([name, true])
    const theirs = await rowOf(org.id, kid)
    for (const [name, write] of paths(cy, 'cy@example.com')) expect([name, reveals(await write(theirs.id, { level: 'viewer' })).length > 0]).toEqual([name, true])
  })
})

describe('edit locks', () => {
  it('Payload’s document locks are off for the plugin’s collections, so no lock row names them', async () => {
    for (const slug of ['organizations', 'organization-members', 'organization-events']) {
      expect([slug, (state.payload.collections as Record<string, { config: { lockDocuments?: unknown } }>)[slug]!.config.lockDocuments]).toEqual([slug, false])
    }
    const locks = state.payload.collections['payload-locked-documents' as never] as unknown as { config: { fields: { name?: string; relationTo?: string[] }[] } } | undefined
    const targets = locks?.config.fields.find((f) => f.name === 'document')?.relationTo ?? []
    for (const slug of ['organizations', 'organization-members', 'organization-events']) expect(targets).not.toContain(slug)
  })
})
