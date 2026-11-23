import { configToSchema } from '@payloadcms/graphql'
import { graphql } from 'graphql'
import { createLocalReq } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { answers, as, call, change, events, invite, join, liveOrg, log, make, refused, rowOf, rows, start, state, stop, token, wipe, type U } from './setup.js'

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
  kid = await make('kid@example.com')
  org = await liveOrg(cy, ann)
})

const setMinor = (u: U, minor: boolean) => state.payload.update({ collection: 'users', id: u.id as never, data: { minor } as never, overrideAccess: true })

/** Drops ids, people and dates, so two different people's rows can be compared. */
const scrub = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (['id', 'user', 'organization', 'createdAt', 'updatedAt', 'invitedBy', 'acceptedAt', 'memberId', 'liveKey', 'by', 'errors'].includes(k)) continue
      out[k] = scrub(v)
    }
    return out
  }
  return value
}

type Transport = 'local' | 'rest' | 'graphql'
const promote = async (transport: Transport, row: { id: string | number }, level: string) => {
  if (transport === 'local') {
    const err = await refused(change(cy, row.id, { level }))
    return { status: err ? 403 : 200, body: err ? { message: err } : undefined }
  }
  if (transport === 'rest') {
    const res = await call(`/organization-members/${row.id}`, { method: 'PATCH', body: { level }, token: await token('cy@example.com') })
    return { status: res.status, body: scrub(res.json) }
  }
  const { schema } = configToSchema(state.payload.config)
  const req = await createLocalReq({ user: as(cy) }, state.payload)
  req.payloadAPI = 'GraphQL'
  const out = (await graphql({ schema, source: `mutation { updateOrganizationMember(id: "${row.id}", data: { level: ${level} }) { level pendingLevel status } }`, contextValue: { req } })) as { data?: unknown; errors?: { message: string }[] }
  return { status: out.errors?.length ? 403 : 200, body: scrub({ data: out.data, messages: out.errors?.map((e) => e.message) }) }
}

/** Everything the one who promotes can see afterwards, for one person. */
const promoterSees = async (transport: Transport, who: U) => {
  const row = await rowOf(org.id, who)
  const before = (await events()).length
  const members = (await rows()).totalDocs
  log.length = 0
  const answer = await promote(transport, row, 'coordinator')
  const seenRow = (await state.payload.findByID({ collection: 'organization-members' as never, id: row.id as never, user: as(cy), overrideAccess: false, depth: 0 })) as unknown as Record<string, unknown>
  const seenEvents = (await state.payload.find({ collection: 'organization-events' as never, sort: 'createdAt', user: as(cy), overrideAccess: false, pagination: false, depth: 0 })).docs
  return {
    answer,
    row: scrub(seenRow),
    eventsAdded: (await events()).length - before,
    eventsVisible: scrub(seenEvents.slice(before)),
    membersAdded: (await rows()).totalDocs - members,
    audit: [...log],
  }
}

describe('a promotion looks the same for every person', () => {
  for (const transport of ['local', 'rest', 'graphql'] as Transport[]) {
    it(`gives the one who promotes the same answer, row, history, counts and audit for an adult and a minor over ${transport}`, async () => {
      await join(org.id, cy, dee, 'member')
      await join(org.id, cy, kid, 'member')
      await setMinor(kid, true)
      const adult = await promoterSees(transport, dee)
      const minor = await promoterSees(transport, kid)
      expect(adult.answer.status).toBe(200)
      expect(minor.answer).toEqual(adult.answer)
      expect(minor.row).toEqual(adult.row)
      expect(minor.eventsAdded).toBe(adult.eventsAdded)
      expect(minor.eventsAdded).toBe(1)
      expect(minor.eventsVisible).toEqual(adult.eventsVisible)
      expect(minor.membersAdded).toBe(adult.membersAdded)
      expect(minor.audit).toEqual(adult.audit)
      // The veto is not asked at all, so there is no work for a timing difference to come from.
      expect(adult.audit.some((l) => l.startsWith('veto:'))).toBe(false)
      expect(adult.audit).toEqual(['before:offer-level', 'after:offer-level'])
      expect(adult.row).toMatchObject({ level: 'member', pendingLevel: 'coordinator', status: 'active' })
    })
  }

  it('changes nothing until the person accepts, and the veto answers only the person', async () => {
    await join(org.id, cy, dee, 'member')
    await join(org.id, cy, kid, 'member')
    await setMinor(kid, true)
    await change(cy, (await rowOf(org.id, dee)).id, { level: 'coordinator' })
    await change(cy, (await rowOf(org.id, kid)).id, { level: 'coordinator' })
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'member', pendingLevel: 'coordinator' })
    log.length = 0
    expect(await refused(change(dee, (await rowOf(org.id, dee)).id, { level: 'coordinator' }))).toBeNull()
    expect(log).toContain('veto:change-level')
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'coordinator', pendingLevel: null })
    const before = (await events()).length
    expect(await refused(change(kid, (await rowOf(org.id, kid)).id, { level: 'coordinator' }))).toMatch(/Not available/)
    expect((await events()).length).toBe(before)
    expect(await rowOf(org.id, kid)).toMatchObject({ level: 'member', pendingLevel: 'coordinator' })
    const kinds = (await events()).map((e) => e.event)
    expect(kinds.filter((e) => e === 'offer-level')).toHaveLength(2)
    expect(kinds.filter((e) => e === 'change-level')).toHaveLength(1)
  })

  it('gives a promotion no effect on access before it is accepted', async () => {
    await join(org.id, cy, dee, 'member')
    await change(cy, (await rowOf(org.id, dee)).id, { level: 'coordinator' })
    expect(await refused(invite(dee, org.id, { user: eli.id, level: 'coordinator' }))).toBeTruthy()
  })
})

describe('the offer', () => {
  it('can be declined by the person and withdrawn by someone who may change levels, and not by anyone else', async () => {
    const r = await join(org.id, cy, dee, 'member')
    await join(org.id, cy, eli, 'member')
    await change(cy, r.id, { level: 'coordinator' })
    expect(await refused(change(eli, r.id, { pendingLevel: null }))).toBeTruthy()
    expect(await refused(change(dee, r.id, { pendingLevel: null }))).toBeNull()
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'member', pendingLevel: null })
    await change(cy, r.id, { level: 'coordinator' })
    expect(await refused(change(cy, r.id, { pendingLevel: null }))).toBeNull()
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'member', pendingLevel: null })
    expect((await events()).map((e) => e.event).filter((e) => e.endsWith('-level'))).toEqual(['offer-level', 'cancel-level', 'offer-level', 'cancel-level'])
    // Nothing is left to accept.
    expect(await refused(change(dee, r.id, { level: 'coordinator' }))).toMatch(/raises their own/)
  })

  it('can’t be set directly, by anyone, and can’t be accepted at another level or by someone else', async () => {
    const r = await join(org.id, cy, dee, 'member')
    expect(await refused(change(cy, r.id, { pendingLevel: 'coordinator' }))).toMatch(/Only the level and status/)
    expect(await refused(change(dee, r.id, { pendingLevel: 'coordinator' }))).toMatch(/Only the level and status/)
    expect(await refused(state.payload.update({ collection: 'organization-members' as never, id: r.id as never, data: { pendingLevel: 'coordinator' } as never, overrideAccess: true }))).toMatch(/Only the level and status/)
    await change(cy, r.id, { level: 'coordinator' })
    await join(org.id, cy, eli, 'member')
    expect(await refused(change(dee, r.id, { level: 'viewer' }))).toMatch(/can’t change this person’s level/)
    expect(await refused(change(eli, r.id, { level: 'coordinator' }))).toBeTruthy()
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'member', pendingLevel: 'coordinator' })
  })

  it('is cleared by a demotion and by removal', async () => {
    const a = await join(org.id, cy, dee, 'member')
    const b = await join(org.id, cy, eli, 'viewer')
    await change(cy, a.id, { level: 'coordinator' })
    await change(cy, b.id, { level: 'member' })
    await change(cy, a.id, { level: 'viewer' })
    await change(eli, b.id, { status: 'removed' })
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'viewer', pendingLevel: null })
    expect(await rowOf(org.id, eli)).toMatchObject({ status: 'removed', pendingLevel: null })
  })

  it('still lets server code promote at once, with the veto’s reason', async () => {
    const r = await join(org.id, cy, kid, 'member')
    await setMinor(kid, true)
    const server = (level: string) => state.payload.update({ collection: 'organization-members' as never, id: r.id as never, data: { level } as never, overrideAccess: true })
    expect(await refused(server('coordinator') as Promise<unknown>)).toMatch(/Not available/)
    await setMinor(kid, false)
    await server('coordinator')
    expect(await rowOf(org.id, kid)).toMatchObject({ level: 'coordinator', pendingLevel: null })
  })
})
