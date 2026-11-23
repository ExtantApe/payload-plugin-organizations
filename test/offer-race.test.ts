import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
    expect(isConflict(new Error('outer', { cause: new Error('inner', { cause: { codeName: 'WriteConflict' } }) }))).toBe(true)
    expect(isConflict({ errorResponse: { code: 112 } })).toBe(true)
    expect(isConflict(new Error('Duplicate key'))).toBe(false)
    expect(isConflict({ code: 11000 })).toBe(false)
    expect(isConflict(null)).toBe(false)
  })

  it('does not map other faults to the someone-else refusal', () => {
    expect(isConflict({ errorLabels: ['TransientTransactionError'] })).toBe(false)
    expect(isConflict({ hasErrorLabel: (l: string) => l === 'TransientTransactionError' })).toBe(false)
    expect(isConflict({ code: 6, errorLabels: ['TransientTransactionError'], message: 'connection reset' })).toBe(false)
    expect(isConflict(new Error('Write conflict during plan execution'))).toBe(false)
    expect(isConflict(new Error('WriteConflict'))).toBe(false)
    expect(isConflict({ message: 'write conflict', cause: { errorLabels: ['TransientTransactionError'] } })).toBe(false)
    expect(isConflict({ code: '112' })).toBe(false)
    expect(isConflict({ codeName: 'writeconflict' })).toBe(false)
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

describe('a refused change does not touch the row', () => {
  const asMinor = (u: U) => state.payload.update({ collection: 'users', id: u.id as never, data: { minor: true } as never, overrideAccess: true })
  const raw = async (id: unknown) => (await state.payload.findByID({ collection: 'organization-members' as never, id: id as never, overrideAccess: true, depth: 0 })) as unknown as { updatedAt: string; level: string; pendingLevel?: string | null }
  const claims = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((c: unknown[]) => (c[0] as { collection?: unknown; returning?: unknown }).collection === 'organization-members' && (c[0] as { returning?: unknown }).returning === false).length

  it('claims nothing and leaves the row, updatedAt included, as it was for refused changes (a vetoed accept and others)', async () => {
    const row = await offer()
    await asMinor(dee)
    const before = await raw(row.id)
    const spy = vi.spyOn(state.payload.db, 'updateOne')
    try {
      const out = [
        await local(change(dee, row.id, { level: 'coordinator' })),
        await rest(row.id, 'dee@example.com', { level: 'coordinator' }),
        await local(change(dee, row.id, { level: 'nonsense' })),
        await local(change(dee, row.id, { status: 'invited' })),
        await local(change(cy, row.id, { organization: '000000000000000000000000' })),
      ]
      for (const o of out) expect(o.ok).toBe(false)
      expect(claims(spy)).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(await raw(row.id)).toEqual(before)
  })

  it('claims once for a change that goes through', async () => {
    const row = await offer()
    const spy = vi.spyOn(state.payload.db, 'updateOne')
    try {
      await change(dee, row.id, { level: 'coordinator' })
      expect(claims(spy)).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(await raw(row.id)).toMatchObject({ level: 'coordinator' })
  })

  for (const transport of ['local', 'rest'] as const) {
    it(`gives a coordinator's no-op change the same answer whether a vetoed minor's accept is in flight or not, over ${transport}`, async () => {
      const idle: Outcome[] = []
      const busy: Outcome[] = []
      for (let i = 0; i < 12; i++) {
        await wipe()
        ann = await make(`ann${i}@example.com`, { staff: true })
        cy = await make(`cy${i}@example.com`)
        dee = await make(`dee${i}@example.com`)
        org = await liveOrg(cy, ann, { name: `Zoo ${i}` })
        const row = await offer()
        await asMinor(dee)
        const noop = () => (transport === 'local' ? local(change(cy, row.id, { level: 'member' })) : rest(row.id, `cy${i}@example.com`, { level: 'member' }))
        idle.push(await noop())
        const accept = () => (transport === 'local' ? local(change(dee, row.id, { level: 'coordinator' })) : rest(row.id, `dee${i}@example.com`, { level: 'coordinator' }))
        const [mine, theirs] = await Promise.all([noop(), accept()])
        busy.push(mine)
        expect(theirs.ok).toBe(false)
        expect(await rowOf(org.id, dee)).toMatchObject({ level: 'member', pendingLevel: 'coordinator' })
      }
      // Every round reads the same with the vetoed accept running as with nothing running: no 403, no raw error.
      expect(idle.every((o) => o.ok)).toBe(true)
      expect(busy.every((o) => o.ok)).toBe(true)
    })
  }
})
