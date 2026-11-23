import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { isConflict } from '../src/helpers.js'
import { as, call, change, join, liveOrg, make, rowOf, start, state, stop, token, wipe, type U } from './setup.js'

let ann: U, cy: U, dee: U
let org: { id: string | number }

beforeAll(start, 180_000)
afterAll(stop)
beforeEach(async () => {
  await wipe()
  ann = await make('ann@example.com', { staff: true })
  cy = await make('cy@example.com')
  dee = await make('dee@example.com')
  org = await liveOrg(cy, ann)
})

const RAW = /write ?conflict|transienttransaction|mongo|code 112|stack|at .*\(.*:\d+:\d+\)/i
type Outcome = { ok: boolean; status: number; message: string }

const local = async (p: Promise<unknown>): Promise<Outcome> => {
  try {
    await p
    return { ok: true, status: 200, message: '' }
  } catch (e) {
    const x = e as { status?: number; isPublic?: boolean; message?: string }
    return { ok: false, status: x.status ?? 500, message: `${x.isPublic ? '' : '[not public] '}${x.message ?? ''}` }
  }
}
const rest = async (id: unknown, who: string, body: Record<string, unknown>): Promise<Outcome> => {
  const res = await call(`/organization-members/${id}`, { method: 'PATCH', body, token: await token(who) })
  const errors = res.json.errors as { message?: string }[] | undefined
  return { ok: res.status < 400, status: res.status, message: errors?.map((e) => e.message).join(' ') ?? '' }
}

/** Gives dee a fresh offer of Coordinator on a row. */
const offer = async () => {
  const row = await join(org.id, cy, dee, 'member')
  await change(cy, row.id, { level: 'coordinator' })
  return row
}

describe('a withdraw and an accept at the same moment', () => {
  it('maps the database’s conflict errors, wrapped or not', () => {
    expect(isConflict({ codeName: 'WriteConflict' })).toBe(true)
    expect(isConflict({ code: 112 })).toBe(true)
    expect(isConflict({ errorLabels: ['TransientTransactionError'] })).toBe(true)
    expect(isConflict({ hasErrorLabel: (l: string) => l === 'TransientTransactionError' })).toBe(true)
    expect(isConflict(new Error('outer', { cause: new Error('inner', { cause: { codeName: 'WriteConflict' } }) }))).toBe(true)
    expect(isConflict({ errorResponse: { code: 112 } })).toBe(true)
    expect(isConflict(new Error('Duplicate key'))).toBe(false)
    expect(isConflict({ code: 11000 })).toBe(false)
    expect(isConflict(null)).toBe(false)
    const loop: { cause?: unknown } = {}
    loop.cause = loop
    expect(isConflict(loop)).toBe(false)
  })

  it('refuses cleanly, over the Local API, when another transaction holds the row', async () => {
    const row = await offer()
    const other = await state.payload.db.beginTransaction()
    try {
      await state.payload.db.updateOne({ collection: 'organization-members' as never, id: row.id as never, data: {} as never, req: { payload: state.payload, transactionID: other } as never, returning: false } as never)
      const out = await local(change(dee, row.id, { level: 'coordinator' }))
      expect(out).toMatchObject({ ok: false, status: 403 })
      expect(out.message).not.toMatch(RAW)
      expect(out.message).not.toMatch(/not public/)
    } finally {
      if (other) await state.payload.db.rollbackTransaction(other)
    }
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'member', pendingLevel: 'coordinator' })
  })

  it('refuses cleanly, over REST, when another transaction holds the row', async () => {
    const row = await offer()
    const other = await state.payload.db.beginTransaction()
    try {
      await state.payload.db.updateOne({ collection: 'organization-members' as never, id: row.id as never, data: {} as never, req: { payload: state.payload, transactionID: other } as never, returning: false } as never)
      const out = await rest(row.id, 'dee@example.com', { level: 'coordinator' })
      expect(out.status).toBe(403)
      expect(out.message).not.toMatch(RAW)
    } finally {
      if (other) await state.payload.db.rollbackTransaction(other)
    }
    expect(await rowOf(org.id, dee)).toMatchObject({ level: 'member', pendingLevel: 'coordinator' })
  })

  for (const transport of ['local', 'rest'] as const) {
    it(`ends in one winner and no raw error when both run together over ${transport}`, async () => {
      for (let i = 0; i < 8; i++) {
        await wipe()
        ann = await make(`ann${i}@example.com`, { staff: true })
        cy = await make(`cy${i}@example.com`)
        dee = await make(`dee${i}@example.com`)
        org = await liveOrg(cy, ann, { name: `Zoo ${i}` })
        const row = await offer()
        const [withdraw, accept] =
          transport === 'local'
            ? await Promise.all([local(change(cy, row.id, { pendingLevel: null })), local(change(dee, row.id, { level: 'coordinator' }))])
            : await Promise.all([rest(row.id, `cy${i}@example.com`, { pendingLevel: null }), rest(row.id, `dee${i}@example.com`, { level: 'coordinator' })])
        for (const r of [withdraw, accept]) {
          if (r.ok) continue
          expect(r.status).toBe(403)
          expect(r.message).not.toMatch(RAW)
          expect(r.message).not.toMatch(/not public/)
        }
        expect(withdraw.ok || accept.ok).toBe(true)
        const after = await rowOf(org.id, dee)
        // Either the accept stood, or the withdraw did. Never both, never neither.
        if (accept.ok && after.level === 'coordinator') expect(after.pendingLevel ?? null).toBe(null)
        else expect(after).toMatchObject({ level: 'member', pendingLevel: null })
        if (!withdraw.ok || !accept.ok) expect(withdraw.ok !== accept.ok).toBe(true)
      }
    })
  }
})
