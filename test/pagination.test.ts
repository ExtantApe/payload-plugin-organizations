import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { answers, change, editOrg, invite, join, liveOrg, make, rowOf, start, state, stop, wipe, type U } from './setup.js'

let ann: U, bea: U, cy: U, dee: U, eli: U

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
})

/**
 * Inside a transaction, a paginated find sends the find and a count together on one session. When that is the
 * transaction's first query, MongoDB can fail it with NoSuchTransaction. So every find the plugin makes with a request
 * must turn pagination off. This watches them all while the plugin's flows run.
 */
describe('finds inside a transaction', () => {
  it('never paginate', async () => {
    const calls: { collection: string; pagination: unknown; hasReq: boolean }[] = []
    const real = state.payload.find.bind(state.payload)
    ;(state.payload as { find: unknown }).find = (args: { collection: string; pagination?: unknown; req?: unknown }) => {
      calls.push({ collection: args.collection, pagination: args.pagination, hasReq: !!args.req })
      return real(args as never)
    }
    try {
      const org = await liveOrg(cy, ann)
      await join(org.id, cy, dee, 'member')
      await join(org.id, cy, bea, 'coordinator')
      await invite(cy, org.id, { user: eli.id, level: 'viewer' })
      // The duplicate check, in both of its answers (seen and unseen).
      await change(dee, (await rowOf(org.id, dee)).id, { level: 'member' })
      await invite(cy, org.id, { user: eli.id, level: 'viewer' }).catch(() => null)
      await invite(dee, org.id, { user: eli.id, level: 'viewer' }).catch(() => null)
      // The last-Coordinator check, and reopening.
      await change(bea, (await rowOf(org.id, bea)).id, { status: 'removed' })
      await editOrg(ann, org.id, { status: 'closed' })
      await editOrg(ann, org.id, { status: 'active' })
    } finally {
      delete (state.payload as { find?: unknown }).find
    }
    const withReq = calls.filter((c) => c.hasReq)
    expect(withReq.length).toBeGreaterThan(5)
    expect(withReq.filter((c) => c.pagination !== false)).toEqual([])
  })
})
