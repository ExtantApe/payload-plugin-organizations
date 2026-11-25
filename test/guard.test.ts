import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { answers, change, editOrg, events, invite, join, liveOrg, log, make, orgRow, propose, refused, rowOf, rows, start, state, stop, wipe, type U } from './setup.js'

let ann: U, cy: U, dee: U, eli: U, fay: U
let org: { id: string | number }
const original = () => state.payload.db.beginTransaction
let begin: typeof state.payload.db.beginTransaction
const marker = async (p: Promise<unknown>) => {
  // The shape review tools such as whitehat accept as a refusal: a 403 whose data is exactly { refusal: 'transactions-required' }.
  const e = (await p.then(() => null, (err: unknown) => err)) as { status?: unknown; data?: unknown } | null
  expect(e?.status).toBe(403)
  expect(e?.data).toEqual({ refusal: 'transactions-required' })
  expect(Object.getPrototypeOf(e?.data)).toBe(Object.prototype)
}

beforeAll(start, 180_000)
afterAll(stop)
beforeEach(async () => {
  for (const k of Object.keys(answers)) delete answers[k]
  await wipe()
  ann = await make('ann@example.com', { staff: true })
  cy = await make('cy@example.com')
  dee = await make('dee@example.com')
  eli = await make('eli@example.com')
  fay = await make('fay@example.com')
  org = await liveOrg(cy, ann)
  begin = original()
})
afterEach(() => {
  state.payload.db.beginTransaction = begin
})

const noTransactions = () => {
  state.payload.db.beginTransaction = async () => null
}
const counts = async () => ({
  members: (await rows()).totalDocs,
  organizations: (await state.payload.count({ collection: 'organizations' as never, overrideAccess: true })).totalDocs,
  events: (await events()).length,
})

describe('a database that stops handing out transactions after start-up', () => {
  it('refuses an invitation and writes nothing', async () => {
    const before = await counts()
    noTransactions()
    expect(await refused(invite(cy, org.id, { user: dee.id, level: 'member' }))).toMatch(/needs a transaction/)
    state.payload.db.beginTransaction = begin
    expect(await counts()).toEqual(before)
    expect(await rowOf(org.id, dee)).toBeUndefined()
  })

  it('refuses with the transactions-required marker, over the Local API and with disableTransaction', async () => {
    noTransactions()
    await marker(invite(cy, org.id, { user: dee.id, level: 'member' }))
    state.payload.db.beginTransaction = begin
    await marker(state.payload.create({ collection: 'organization-members' as never, data: { organization: org.id, user: dee.id, level: 'viewer' } as never, overrideAccess: true, disableTransaction: true }))
  })

  it('refuses accept, level change and removal, and leaves each row as it was', async () => {
    await invite(cy, org.id, { user: dee.id, level: 'member' })
    await join(org.id, cy, eli, 'member')
    const invited = await rowOf(org.id, dee)
    const active = await rowOf(org.id, eli)
    const before = await counts()
    noTransactions()
    expect(await refused(change(dee, invited.id, { status: 'active' }))).toMatch(/needs a transaction/)
    expect(await refused(change(cy, active.id, { level: 'viewer' }))).toMatch(/needs a transaction/)
    expect(await refused(change(cy, active.id, { status: 'removed' }))).toMatch(/needs a transaction/)
    expect(await refused(change(eli, active.id, { status: 'removed' }))).toMatch(/needs a transaction/)
    state.payload.db.beginTransaction = begin
    expect(await counts()).toEqual(before)
    expect(await rowOf(org.id, dee)).toMatchObject({ status: 'invited' })
    expect(await rowOf(org.id, eli)).toMatchObject({ status: 'active', level: 'member' })
  })

  it('refuses a new organization, an edit and a close, and the last Coordinator can still not leave', async () => {
    const before = await counts()
    noTransactions()
    expect(await refused(propose(fay))).toMatch(/needs a transaction/)
    expect(await refused(editOrg(cy, org.id, { name: 'Renamed' }))).toMatch(/needs a transaction/)
    expect(await refused(editOrg(ann, org.id, { status: 'closed' }))).toMatch(/needs a transaction/)
    expect(await refused(change(cy, (await rowOf(org.id, cy)).id, { status: 'removed' }))).toMatch(/needs a transaction/)
    state.payload.db.beginTransaction = begin
    expect(await counts()).toEqual(before)
    expect(await orgRow(org.id)).toMatchObject({ status: 'active', name: 'Made-up Zoo' })
  })

  it('refuses server code too, and a history row on its own', async () => {
    const before = await counts()
    noTransactions()
    const p = state.payload
    expect(await refused(p.create({ collection: 'organization-members' as never, data: { organization: org.id, user: dee.id, level: 'viewer' } as never, overrideAccess: true }))).toMatch(/needs a transaction/)
    expect(await refused(p.create({ collection: 'organization-events' as never, data: { organization: org.id, event: 'create' } as never, overrideAccess: true }))).toMatch(/needs a transaction/)
    expect(await refused(p.create({ collection: 'organizations' as never, data: { name: 'Server Zoo', kind: 'zoo' } as never, overrideAccess: true }))).toMatch(/needs a transaction/)
    state.payload.db.beginTransaction = begin
    expect(await counts()).toEqual(before)
  })

  it('refuses when server code turns the transaction off', async () => {
    const before = await counts()
    const made = state.payload.create({ collection: 'organization-members' as never, data: { organization: org.id, user: dee.id, level: 'viewer' } as never, overrideAccess: true, disableTransaction: true })
    expect(await refused(made as Promise<unknown>)).toMatch(/needs a transaction/)
    expect(await counts()).toEqual(before)
  })

  it('leaves the audit hooks silent on a refusal', async () => {
    await invite(cy, org.id, { user: dee.id, level: 'member' })
    await join(org.id, cy, eli, 'member')
    log.length = 0
    noTransactions()
    const active = await rowOf(org.id, eli)
    const invited = await rowOf(org.id, dee)
    await refused(invite(cy, org.id, { user: fay.id, level: 'member' }))
    await refused(change(dee, invited.id, { status: 'active' }))
    await refused(change(cy, active.id, { level: 'viewer' }))
    await refused(change(cy, active.id, { status: 'removed' }))
    await refused(editOrg(cy, org.id, { name: 'Renamed' }))
    await refused(propose(fay))
    state.payload.db.beginTransaction = begin
    expect(log).toEqual([])
  })

  it('refuses disableTransaction on update and delete as well as create', async () => {
    const r = await join(org.id, cy, dee, 'member')
    const before = await counts()
    const update = state.payload.update({ collection: 'organization-members' as never, id: r.id as never, data: { level: 'viewer' } as never, overrideAccess: true, disableTransaction: true })
    expect(await refused(update as Promise<unknown>)).toMatch(/needs a transaction/)
    const rename = state.payload.update({ collection: 'organizations' as never, id: org.id as never, data: { name: 'Renamed' } as never, overrideAccess: true, disableTransaction: true })
    expect(await refused(rename as Promise<unknown>)).toMatch(/needs a transaction/)
    // A delete is refused for good (nothing is ever deleted), with or without a transaction.
    const del = state.payload.delete({ collection: 'organization-members' as never, id: r.id as never, overrideAccess: true, disableTransaction: true })
    expect(await refused(del as Promise<unknown>)).toBeTruthy()
    const delOrg = state.payload.delete({ collection: 'organizations' as never, id: org.id as never, overrideAccess: true, disableTransaction: true })
    expect(await refused(delOrg as Promise<unknown>)).toBeTruthy()
    expect(await counts()).toEqual(before)
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'member', status: 'active' })
    expect(await orgRow(org.id)).toMatchObject({ name: 'Made-up Zoo' })
  })

  it('works again as soon as transactions come back', async () => {
    noTransactions()
    expect(await refused(invite(cy, org.id, { user: dee.id, level: 'member' }))).toBeTruthy()
    state.payload.db.beginTransaction = begin
    expect(await refused(invite(cy, org.id, { user: dee.id, level: 'member' }))).toBeNull()
    expect(await rowOf(org.id, dee)).toMatchObject({ status: 'invited' })
  })
})
