import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { BAD_KEY_MESSAGE } from '../src/index.js'
import { answers, as, call, change, editOrg, invite, join, late, liveOrg, make, orgRow, refused, rowOf, start, state, stop, token, wipe, type U } from './setup.js'

/**
 * Saves send plain field names. A top-level key that starts with a dollar sign, contains a dot or holds a NUL is
 * refused with a 400 on every collection and global of the host, server code included.
 */

let ann: U, cy: U, dee: U, eli: U
let org: { id: string | number }

beforeAll(start, 180_000)
afterAll(stop)
beforeEach(async () => {
  for (const k of Object.keys(answers)) delete answers[k]
  late.sawKeys.length = 0
  await wipe()
  ann = await make('ann@example.com', { staff: true })
  cy = await make('cy@example.com')
  dee = await make('dee@example.com')
  eli = await make('eli@example.com')
  org = await liveOrg(cy, ann)
  await state.payload.updateGlobal({ slug: 'site-settings' as never, data: { motto: 'plain', owner: null } as never })
  await state.payload.updateGlobal({ slug: 'late-settings' as never, data: { text: 'plain' } as never })
})

/** The status and message of a Local API call that should be refused. */
const local = async (p: Promise<unknown>) => {
  try {
    await p
    return { status: 200, message: '' }
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 500, message: (e as Error).message }
  }
}
const badRequest = (r: { status: number; message?: string }) => {
  expect(r.status).toBe(400)
  if (r.message !== undefined) expect(r.message).toBe(BAD_KEY_MESSAGE)
}
const restMessage = (json: Record<string, unknown>) => (json.errors as { message: string }[] | undefined)?.[0]?.message

const BAD = [
  ['a leading dollar sign', (v: unknown) => ({ $max: v })],
  ['another leading dollar sign', (v: unknown) => ({ $set: v })],
  ['a dotted key', (v: unknown) => ({ 'rorId.x': v })],
  ['a NUL key', (v: unknown) => ({ ['rorId\u0000']: v })],
] as const

describe('the plugin’s own collections', () => {
  it('refuses non-plain field names on a member’s own row (Local API and REST)', async () => {
    await join(org.id, cy, dee, 'member')
    const row = await rowOf(org.id, dee)
    badRequest(await local(change(dee, row.id, { $max: { pendingLevel: 'coordinator' } })))
    badRequest(await local(change(dee, row.id, { $set: { pendingLevel: 'coordinator' } })))
    const rest = await call(`/organization-members/${row.id}`, { method: 'PATCH', token: await token('dee@example.com'), body: { $max: { pendingLevel: 'coordinator' } } })
    expect(rest.status).toBe(400)
    expect(restMessage(rest.json)).toBe(BAD_KEY_MESSAGE)
    expect((await rowOf(org.id, dee)).pendingLevel ?? null).toBeNull()
    expect(await refused(change(dee, row.id, { level: 'coordinator' }))).toBe('Nobody raises their own level.')
    expect((await rowOf(org.id, dee)).level).toBe('member')
  })

  it('refuses non-plain field names in further membership updates', async () => {
    await join(org.id, cy, dee, 'member')
    const row = await rowOf(org.id, dee)
    badRequest(await local(change(dee, row.id, { $set: { removedAt: new Date().toISOString() } })))
    badRequest(await local(change(dee, row.id, { $currentDate: { removedAt: true } })))
    const after = (await rowOf(org.id, dee)) as unknown as { removedAt?: unknown; status: string }
    expect(after.removedAt ?? null).toBeNull()
    expect(after.status).toBe('active')
  })

  it('refuses non-plain field names in organization updates (Local API and REST)', async () => {
    for (const [, shape] of BAD) badRequest(await local(editOrg(cy, org.id, shape('02mhbdp94') as never)))
    badRequest(await local(editOrg(cy, org.id, { $min: { privateNotes: 'x', rorId: '02mhbdp94' } })))
    const rest = await call(`/organizations/${org.id}`, { method: 'PATCH', token: await token('cy@example.com'), body: { $max: { rorId: '02mhbdp94', privateNotes: 'x' } } })
    expect(rest.status).toBe(400)
    const stored = await orgRow(org.id)
    expect(stored.rorId ?? null).toBeNull()
    expect(stored.privateNotes ?? null).toBeNull()
  })

  it('refuses non-plain field names from server code that overrides access, and on create and duplicate', async () => {
    const row = await rowOf(org.id, cy)
    badRequest(await local(state.payload.update({ collection: 'organization-members' as never, id: row.id as never, data: { $inc: { lock: 1 } } as never })))
    badRequest(await local(state.payload.update({ collection: 'organizations' as never, id: org.id as never, data: { 'status.x': 'closed' } as never, overrideAccess: true })))
    const before = (await state.payload.count({ collection: 'organizations' as never, overrideAccess: true })).totalDocs
    badRequest(await local(state.payload.create({ collection: 'organizations' as never, data: { name: 'Made-up Lab', kind: 'lab', 'createdBy.x': 'y' } as never, user: as(dee), overrideAccess: false })))
    badRequest(await local(state.payload.duplicate({ collection: 'organizations' as never, id: org.id as never, data: { $max: { rorId: '02mhbdp94' } } as never, user: as(cy), overrideAccess: false })))
    expect((await state.payload.count({ collection: 'organizations' as never, overrideAccess: true })).totalDocs).toBe(before)
    const members = (await state.payload.count({ collection: 'organization-members' as never, overrideAccess: true })).totalDocs
    badRequest(await local(invite(cy, org.id, { user: eli.id, level: 'viewer', 'pendingLevel.x': 'coordinator' })))
    expect((await state.payload.count({ collection: 'organization-members' as never, overrideAccess: true })).totalDocs).toBe(members)
  })
})

describe('the host’s collections', () => {
  it('refuses non-plain field names on create, update by id, bulk update and duplicate, with and without access checks', async () => {
    const place = (await state.payload.create({ collection: 'places' as never, data: { title: 'Made-up Place' } as never })) as unknown as { id: string }
    for (const [, shape] of BAD) {
      badRequest(await local(state.payload.create({ collection: 'places' as never, data: { title: 'x', ...shape('y') } as never })))
      badRequest(await local(state.payload.update({ collection: 'places' as never, id: place.id as never, data: shape({ title: 'y' }) as never, user: as(dee), overrideAccess: false })))
      badRequest(await local(state.payload.update({ collection: 'places' as never, where: { id: { exists: true } }, data: shape({ title: 'y' }) as never })))
      badRequest(await local(state.payload.duplicate({ collection: 'places' as never, id: place.id as never, data: shape({ title: 'y' }) as never })))
    }
    const t = await token('dee@example.com')
    for (const [method, path] of [['POST', '/places'], ['PATCH', `/places/${place.id}`], ['PATCH', '/places?where[id][exists]=true'], ['POST', `/places/${place.id}/duplicate`]] as const) {
      const res = await call(path, { method, token: t, body: { $max: { title: 'zzz' } } })
      expect(res.status, `${method} ${path}`).toBe(400)
    }
    const all = await state.payload.find({ collection: 'places' as never, pagination: false })
    expect(all.docs.map((d) => (d as unknown as { title: string }).title)).toEqual(['Made-up Place'])
  })

  it('still saves plain data, and runs before a hook a later plugin put in front of it', async () => {
    const place = (await state.payload.create({ collection: 'places' as never, data: { title: 'Made-up Place' } as never, user: as(dee), overrideAccess: false })) as unknown as { id: string }
    await state.payload.update({ collection: 'places' as never, id: place.id as never, data: { title: 'Renamed' } as never, user: as(dee), overrideAccess: false })
    await state.payload.update({ collection: 'places' as never, where: { id: { equals: place.id } }, data: { title: 'Bulk' } as never })
    await state.payload.duplicate({ collection: 'places' as never, id: place.id as never })
    expect(late.sawKeys.length).toBeGreaterThan(0)
    late.sawKeys.length = 0
    badRequest(await local(state.payload.update({ collection: 'places' as never, id: place.id as never, data: { $max: { title: 'zzz' } } as never })))
    expect(late.sawKeys).toEqual([])
  })

  it('refuses a non-plain field name a later hook adds after the first check', async () => {
    const place = (await state.payload.create({ collection: 'places' as never, data: { title: 'Made-up Place' } as never })) as unknown as { id: string }
    const r = await local(state.payload.update({ collection: 'places' as never, id: place.id as never, data: { title: 'Renamed' } as never, context: { addOperator: true } }))
    badRequest(r)
    expect(((await state.payload.findByID({ collection: 'places' as never, id: place.id as never })) as unknown as { title: string }).title).toBe('Made-up Place')
  })

  it('guards a collection a later plugin added', async () => {
    const note = (await state.payload.create({ collection: 'late-notes' as never, data: { text: 'plain' } as never })) as unknown as { id: string }
    badRequest(await local(state.payload.update({ collection: 'late-notes' as never, id: note.id as never, data: { $max: { flag: 'set' } } as never })))
    badRequest(await local(state.payload.create({ collection: 'late-notes' as never, data: { 'flag.x': 'set' } as never })))
    const stored = (await state.payload.findByID({ collection: 'late-notes' as never, id: note.id as never })) as unknown as { flag?: unknown }
    expect(stored.flag ?? null).toBeNull()
  })

  it('refuses data that isn’t an object', async () => {
    badRequest(await local(state.payload.create({ collection: 'places' as never, data: ['title'] as never })))
  })
})

describe('globals', () => {
  it('refuses non-plain field names on the host’s global and on one a later plugin added (Local API and REST)', async () => {
    for (const [, shape] of BAD) badRequest(await local(state.payload.updateGlobal({ slug: 'site-settings' as never, data: shape('someone') as never })))
    badRequest(await local(state.payload.updateGlobal({ slug: 'site-settings' as never, data: { $currentDate: { owner: true } } as never })))
    badRequest(await local(state.payload.updateGlobal({ slug: 'late-settings' as never, data: { $max: { text: 'zzz' } } as never })))
    const res = await call('/globals/site-settings', { method: 'POST', token: await token('ann@example.com'), body: { $max: { owner: 'someone' } } })
    expect(res.status).toBe(400)
    const g = (await state.payload.findGlobal({ slug: 'site-settings' as never })) as unknown as { owner?: unknown; motto?: unknown }
    expect(g.owner ?? null).toBeNull()
    expect(g.motto).toBe('plain')
    expect(((await state.payload.findGlobal({ slug: 'late-settings' as never })) as unknown as { text: string }).text).toBe('plain')
    await state.payload.updateGlobal({ slug: 'site-settings' as never, data: { motto: 'still saves' } as never })
    expect(((await state.payload.findGlobal({ slug: 'site-settings' as never })) as unknown as { motto: string }).motto).toBe('still saves')
  })
})

describe('new rows and copies start clean', () => {
  type RawRows = { collections: Record<string, { updateOne: (f: object, u: object) => Promise<unknown> }> }

  it('new memberships start without an offer', async () => {
    await join(org.id, cy, dee, 'member')
    await invite(dee, org.id, { user: eli.id, level: 'viewer', pendingLevel: 'coordinator' })
    const row = await rowOf(org.id, eli)
    expect(row.pendingLevel ?? null).toBeNull()
    await change(eli, row.id, { status: 'active' })
    expect(await refused(change(eli, row.id, { level: 'coordinator' }))).toBe('Nobody raises their own level.')
    expect((await rowOf(org.id, eli)).level).toBe('viewer')
  })

  it('copied memberships start without an offer', async () => {
    await join(org.id, cy, eli, 'viewer')
    const row = await rowOf(org.id, eli)
    await change(cy, row.id, { status: 'removed' })
    // Sets up the starting row by writing to the database directly.
    await (state.payload.db as unknown as RawRows).collections['organization-members']!.updateOne({ _id: row.id }, { $set: { pendingLevel: 'coordinator' } })
    const copy = (await state.payload.duplicate({ collection: 'organization-members' as never, id: row.id as never, user: as(cy), overrideAccess: false })) as unknown as { id: string; status: string; pendingLevel?: string | null }
    expect(copy.status).toBe('invited')
    expect(copy.pendingLevel ?? null).toBeNull()
    await change(eli, copy.id, { status: 'active' })
    expect(await refused(change(eli, copy.id, { level: 'coordinator' }))).toBe('Nobody raises their own level.')
  })

  it('checks the organization on a copied record in full, and still lets the original save', async () => {
    const place = (await state.payload.create({ collection: 'places' as never, data: { title: 'Made-up Place', organization: org.id } as never, user: as(cy), overrideAccess: false })) as unknown as { id: string }
    await editOrg(ann, org.id, { status: 'closed' })
    const r = await local(state.payload.duplicate({ collection: 'places' as never, id: place.id as never, user: as(cy), overrideAccess: false }))
    expect(r.status).toBe(400)
    expect(r.message).not.toBe(BAD_KEY_MESSAGE)
    await state.payload.update({ collection: 'places' as never, id: place.id as never, data: { title: 'Renamed' } as never, user: as(cy), overrideAccess: false })
    expect((await state.payload.find({ collection: 'places' as never, pagination: false })).totalDocs).toBe(1)
  })
})
