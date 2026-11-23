import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { levelIn, organizationsOf } from '../src/index.js'
import { answers, as, change, editOrg, events, invite, join, liveOrg, log, make, orgRow, propose, refused, rowOf, rows, seen, start, state, stop, wipe, type U } from './setup.js'

let ann: U, bea: U, cy: U, dee: U, eli: U, fay: U, kid: U
let org: { id: string | number }
const reqFor = (u: U | null) => ({ payload: state.payload, user: u ? as(u) : null }) as never
const server = (id: unknown, data: Record<string, unknown>) => state.payload.update({ collection: 'organization-members' as never, id: id as never, data: data as never, overrideAccess: true }) as unknown as Promise<unknown>

beforeAll(start, 180_000)
afterAll(stop)
beforeEach(async () => {
  for (const k of Object.keys(answers)) delete answers[k]
  log.length = 0
  seen.length = 0
  await wipe()
  ann = await make('ann@example.com', { staff: true })
  bea = await make('bea@example.com', { staff: true })
  cy = await make('cy@example.com')
  dee = await make('dee@example.com')
  eli = await make('eli@example.com')
  fay = await make('fay@example.com')
  kid = await make('kid@example.com', { minor: true })
  org = await liveOrg(cy, ann)
  log.length = 0
  seen.length = 0
})

describe('inviting', () => {
  it('starts invited whatever the client sends, and records who invited', async () => {
    await invite(cy, org.id, { user: dee.id, level: 'member', status: 'active', invitedBy: eli.id, acceptedAt: '2020-01-01' })
    const r = (await rows({ user: { equals: dee.id } })).docs[0] as unknown as Record<string, any>
    expect(r.status).toBe('invited')
    expect(String(r.invitedBy.id ?? r.invitedBy)).toBe(String(cy.id))
    expect(r.acceptedAt ?? null).toBeNull()
    expect(await levelIn(reqFor(dee), org.id)).toBeNull()
  })

  it('fails closed: no hook, a truthy answer, a throw or a signed-out asker all refuse', async () => {
    for (const answer of [() => false, () => 'yes', () => 1, () => { throw new Error('boom') }]) {
      answers.canInvite = answer
      expect(await refused(invite(cy, org.id, { user: dee.id, level: 'member' }))).toMatch(/can’t invite/)
    }
    delete answers.canInvite
    expect(await refused(invite(null, org.id, { user: dee.id, level: 'member' }))).toBeTruthy()
    expect((await rows({ user: { equals: dee.id } })).totalDocs).toBe(0)
  })

  it('lets the host decide by level: a Member invites Viewers only, a Viewer no one, a stranger no one', async () => {
    await join(org.id, cy, dee, 'member')
    await join(org.id, cy, eli, 'viewer')
    expect(await refused(invite(dee, org.id, { user: fay.id, level: 'member' }))).toMatch(/can’t invite/)
    await invite(dee, org.id, { user: fay.id, level: 'viewer' })
    expect(await refused(invite(eli, org.id, { user: kid.id, level: 'viewer' }))).toBeTruthy()
    const other = await liveOrg(fay, ann, { name: 'Other Zoo' })
    expect(await refused(invite(cy, other.id, { user: dee.id, level: 'viewer' }))).toMatch(/can’t invite/)
  })

  it('refuses unknown levels, organizations and people, and a second live row for the same person', async () => {
    expect(await refused(invite(cy, org.id, { user: dee.id, level: 'boss' }))).toBeTruthy()
    expect(await refused(invite(ann, '000000000000000000000000', { user: dee.id, level: 'member' }))).toBeTruthy()
    expect(await refused(invite(cy, org.id, { user: '000000000000000000000000', level: 'member' }))).toBeTruthy()
    await invite(cy, org.id, { user: dee.id, level: 'member' })
    expect(await refused(invite(cy, org.id, { user: dee.id, level: 'viewer' }))).toMatch(/already/)
    await change(dee, (await rowOf(org.id, dee)).id, { status: 'removed' })
    await invite(cy, org.id, { user: dee.id, level: 'viewer' })
    expect((await rows({ user: { equals: dee.id } })).totalDocs).toBe(2)
  })

  it('creates one row when the same invitation is sent twice at once', async () => {
    for (let i = 0; i < 3; i++) {
      const who = i === 0 ? dee : i === 1 ? eli : fay
      const results = await Promise.allSettled([invite(cy, org.id, { user: who.id, level: 'member' }), invite(cy, org.id, { user: who.id, level: 'member' })])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((await rows({ and: [{ user: { equals: who.id } }, { status: { in: ['invited', 'active'] } }] })).totalDocs).toBe(1)
    }
  })

  it('passes plain ids and the id and data of a change to the host’s hooks', async () => {
    await invite(cy, org.id, { user: dee.id, level: 'member' })
    const mem = seen.find((s) => (s.member as { user?: unknown })?.user !== undefined)!
    expect(typeof (mem.member as { organization: unknown }).organization).not.toBe('object')
    expect(typeof (mem.member as { user: unknown }).user).not.toBe('object')
    seen.length = 0
    const r = await rowOf(org.id, dee)
    await join(org.id, cy, eli, 'viewer')
    seen.length = 0
    await change(cy, (await rowOf(org.id, eli)).id, { level: 'member' })
    const c = seen.find((s) => s.id !== undefined)!
    expect(String(c.id)).toBe(String((await rowOf(org.id, eli)).id))
    expect((c.data as { level: string }).level).toBe('member')
    expect(r.status).toBe('invited')
  })
})

describe('the veto', () => {
  it('stops a minor on invite, even for server code that skips access', async () => {
    expect(await refused(state.payload.create({ collection: 'organization-members' as never, data: { organization: org.id, user: kid.id, level: 'viewer' } as never, overrideAccess: true }) as Promise<unknown>)).toMatch(/Not available/)
    expect((await rows({ user: { equals: kid.id } })).totalDocs).toBe(0)
  })

  it('looks the same to the inviter for a minor and anyone else, and refuses the minor on accept', async () => {
    log.length = 0
    const a = await invite(cy, org.id, { user: kid.id, level: 'viewer' })
    const b = await invite(cy, org.id, { user: dee.id, level: 'viewer' })
    expect(log).not.toContain('veto:invite')
    const shape = (r: Record<string, any>) => ({ keys: Object.keys(r).sort(), level: r.level, status: r.status, invitedBy: String(r.invitedBy?.id ?? r.invitedBy) })
    expect(shape(a)).toEqual(shape(b))
    expect((await events()).filter((e) => e.event === 'invite').map((e) => [e.level, e.status])).toEqual([['coordinator', 'invited'], ['viewer', 'invited'], ['viewer', 'invited']])
    // The inviter's own reads show nothing that tells the two apart.
    const seenBy = async () => (await state.payload.find({ collection: 'organization-members' as never, where: { user: { in: [kid.id, dee.id] } } as never, user: as(cy), overrideAccess: false, pagination: false })).docs.map((d: any) => [d.level, d.status])
    expect(await seenBy()).toEqual([['viewer', 'invited'], ['viewer', 'invited']])
    // The refusal reaches the invited person, and the row stays invited.
    expect(await refused(change(kid, (await rowOf(org.id, kid)).id, { status: 'active' }))).toMatch(/Not available for this account/)
    expect((await rowOf(org.id, kid)).status).toBe('invited')
    await change(dee, (await rowOf(org.id, dee)).id, { status: 'active' })
  })

  it('refuses a minor who invites themselves, since only they can read the answer', async () => {
    answers.canInvite = () => true
    expect(await refused(invite(kid, org.id, { user: kid.id, level: 'viewer' }))).toMatch(/Not available/)
  })

  it('is asked again on accept and on a level change, and stops them', async () => {
    await invite(cy, org.id, { user: dee.id, level: 'member' })
    await state.payload.update({ collection: 'users', id: dee.id as never, data: { minor: true } as never, overrideAccess: true })
    log.length = 0
    expect(await refused(change(dee, (await rowOf(org.id, dee)).id, { status: 'active' }))).toMatch(/Not available/)
    expect(log).toContain('veto:accept')
    await state.payload.update({ collection: 'users', id: dee.id as never, data: { minor: false } as never, overrideAccess: true })
    await change(dee, (await rowOf(org.id, dee)).id, { status: 'active' })
    await state.payload.update({ collection: 'users', id: dee.id as never, data: { minor: true } as never, overrideAccess: true })
    expect(await refused(change(cy, (await rowOf(org.id, dee)).id, { level: 'viewer' }))).toMatch(/can’t change this person’s level/)
    expect(await refused(server((await rowOf(org.id, dee)).id, { level: 'coordinator' }))).toMatch(/Not available/)
    expect((await rowOf(org.id, dee)).level).toBe('member')
  })

  it('refuses on a throw, on false and on a blank reason, with a general message', async () => {
    for (const answer of [() => { throw new Error('secret reason') }, () => false, () => '  ', () => 0]) {
      answers.refuse = answer
      const row = (await rowOf(org.id, dee)) ?? (await invite(cy, org.id, { user: dee.id, level: 'member' }))
      const msg = await refused(change(dee, row.id, { status: 'active' }))
      expect(msg).toMatch(/can’t be added to this organization/)
      expect(msg).not.toMatch(/secret/)
    }
  })
})

describe('accepting', () => {
  it('lets a person accept their own invitation and nobody else’s, in a live organization', async () => {
    await invite(cy, org.id, { user: dee.id, level: 'member' })
    const r = await rowOf(org.id, dee)
    expect(await refused(change(eli, r.id, { status: 'active' }))).toBeTruthy()
    expect(await refused(change(cy, r.id, { status: 'active' }))).toMatch(/accepts their own/)
    expect(await refused(change(ann, r.id, { status: 'active' }))).toMatch(/accepts their own/)
    await change(dee, r.id, { status: 'active' })
    expect(await levelIn(reqFor(dee), org.id)).toBe('member')
  })

  it('never turns an active member back into an invitation, or revives a removed one', async () => {
    const r = await join(org.id, cy, dee, 'member')
    expect(await refused(change(dee, r.id, { status: 'invited' }))).toMatch(/isn’t allowed/)
    await change(dee, r.id, { status: 'removed' })
    for (const data of [{ status: 'active' }, { status: 'invited' }, { level: 'coordinator' }]) {
      expect(await refused(server(r.id, data))).toMatch(/final/)
      expect(await refused(change(ann, r.id, data))).toBeTruthy()
    }
    expect((await rowOf(org.id, dee)).status).toBe('removed')
  })
})

describe('levels', () => {
  it('changes a level only if canChangeLevel returns exactly true, and never lets anyone raise their own', async () => {
    const r = await join(org.id, cy, dee, 'member')
    expect(await refused(change(dee, r.id, { level: 'coordinator' }))).toMatch(/raises their own/)
    for (const answer of [() => 'yes', () => 1, () => { throw new Error('boom') }]) {
      answers.canChangeLevel = answer
      expect(await refused(change(cy, r.id, { level: 'viewer' }))).toMatch(/can’t change/)
    }
    delete answers.canChangeLevel
    await change(cy, r.id, { level: 'viewer' })
    expect((await rowOf(org.id, dee)).level).toBe('viewer')
    // lowering one’s own level is fine
    await change(dee, r.id, { level: 'viewer' })
  })

  it('never changes organization, person or inviter', async () => {
    const r = await join(org.id, cy, dee, 'member')
    expect(await refused(change(cy, r.id, { user: eli.id }))).toMatch(/Only the level and status/)
    expect(await refused(change(cy, r.id, { organization: '000000000000000000000000' }))).toMatch(/Only the level and status/)
    expect(await refused(change(cy, r.id, { invitedBy: eli.id }))).toMatch(/Only the level and status/)
  })

  it('refuses unknown levels and statuses', async () => {
    const r = await join(org.id, cy, dee, 'member')
    expect(await refused(change(cy, r.id, { level: 'boss' }))).toBeTruthy()
    expect(await refused(change(cy, r.id, { status: 'banned' }))).toBeTruthy()
  })
})

describe('leaving and removal', () => {
  it('lets anyone leave, lets the host remove others, and makes removal final', async () => {
    const r = await join(org.id, cy, dee, 'member')
    const s = await join(org.id, cy, eli, 'viewer')
    await change(dee, r.id, { status: 'removed' })
    expect(await levelIn(reqFor(dee), org.id)).toBeNull()
    await change(cy, s.id, { status: 'removed' })
    expect((await rowOf(org.id, eli)).status).toBe('removed')
    const t = await join(org.id, cy, fay, 'viewer')
    expect(await refused(change(eli, t.id, { status: 'removed' }))).toBeTruthy()
    expect(await refused(change(dee, t.id, { status: 'removed' }))).toBeTruthy()
    answers.canChangeLevel = () => false
    expect(await refused(change(cy, t.id, { status: 'removed' }))).toMatch(/can’t remove/)
  })
})

describe('the last Coordinator', () => {
  it('can’t leave or be demoted, by the person, by the host or by server code', async () => {
    const r = await rowOf(org.id, cy)
    expect(await refused(change(cy, r.id, { status: 'removed' }))).toMatch(/keeps a Coordinator/)
    expect(await refused(change(cy, r.id, { level: 'member' }))).toMatch(/keeps a Coordinator/)
    expect(await refused(change(ann, r.id, { status: 'removed' }))).toMatch(/keeps a Coordinator/)
    expect(await refused(server(r.id, { level: 'viewer' }))).toMatch(/keeps a Coordinator/)
    expect(await refused(server(r.id, { status: 'removed' }))).toMatch(/keeps a Coordinator/)
    expect((await rowOf(org.id, cy)).level).toBe('coordinator')
  })

  it('doesn’t count an invited Coordinator', async () => {
    await invite(cy, org.id, { user: dee.id, level: 'coordinator' })
    expect(await refused(change(cy, (await rowOf(org.id, cy)).id, { status: 'removed' }))).toMatch(/keeps a Coordinator/)
  })

  it('lets a Coordinator step down once another is active', async () => {
    await join(org.id, cy, dee, 'coordinator')
    await change(cy, (await rowOf(org.id, cy)).id, { level: 'member' })
    expect(await levelIn(reqFor(dee), org.id)).toBe('coordinator')
    expect(await refused(change(dee, (await rowOf(org.id, dee)).id, { status: 'removed' }))).toMatch(/keeps a Coordinator/)
  })

  it('keeps one Coordinator when two Coordinators demote each other at once', async () => {
    for (let i = 0; i < 4; i++) {
      const o = await liveOrg(cy, ann, { name: `Zoo ${i}` })
      await join(o.id, cy, dee, 'coordinator')
      const a = (await rowOf(o.id, cy)).id
      const b = (await rowOf(o.id, dee)).id
      const results = await Promise.allSettled([change(dee, a, { level: 'viewer' }), change(cy, b, { level: 'viewer' })])
      const left = (await rows({ and: [{ organization: { equals: o.id } }, { level: { equals: 'coordinator' } }, { status: { equals: 'active' } }] })).totalDocs
      expect(left).toBeGreaterThanOrEqual(1)
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1)
    }
  })

  it('keeps one Coordinator when two Coordinators leave at once', async () => {
    for (let i = 0; i < 4; i++) {
      const o = await liveOrg(cy, ann, { name: `Lab ${i}`, kind: 'lab' })
      await join(o.id, cy, dee, 'coordinator')
      const a = (await rowOf(o.id, cy)).id
      const b = (await rowOf(o.id, dee)).id
      await Promise.allSettled([change(cy, a, { status: 'removed' }), change(dee, b, { status: 'removed' })])
      expect((await rows({ and: [{ organization: { equals: o.id } }, { level: { equals: 'coordinator' } }, { status: { equals: 'active' } }] })).totalDocs).toBe(1)
    }
  })
})

describe('no way round the gate, even for server code', () => {
  it('never deletes, even with overrideAccess', async () => {
    const r = await join(org.id, cy, dee, 'member')
    expect(await refused(state.payload.delete({ collection: 'organization-members' as never, id: r.id as never, overrideAccess: true }))).toMatch(/never deleted/)
    expect(await refused(state.payload.delete({ collection: 'organization-members' as never, id: r.id as never, user: as(cy), overrideAccess: false }))).toBeTruthy()
    expect((await rowOf(org.id, dee)).status).toBe('active')
  })

  it('asks the veto again for a raise from server code, and for a self-accept with a raised level', async () => {
    await invite(cy, org.id, { user: dee.id, level: 'viewer' })
    const r = await rowOf(org.id, dee)
    log.length = 0
    await change(dee, r.id, { status: 'active', level: 'viewer' })
    expect(log).toContain('veto:accept')
    expect(await refused(change(dee, r.id, { level: 'coordinator' }))).toBeTruthy()
    expect((await rowOf(org.id, dee)).level).toBe('viewer')
  })

  it('treats a user from another sign-in collection as nobody, even if the ids matched', async () => {
    const root = await make('root@example.com', {}, 'admins')
    const asRoot = (extra: object) => ({ payload: state.payload, user: { ...root, ...extra } }) as never
    expect(await levelIn(asRoot({ collection: 'admins', id: cy.id }), org.id)).toBeNull()
    expect(await levelIn(asRoot({ collection: undefined, id: cy.id }), org.id)).toBeNull()
    expect(await levelIn(asRoot({ collection: 'users', id: cy.id }), org.id)).toBe('coordinator')
    expect(await refused(state.payload.create({ collection: 'organization-members' as never, data: { organization: org.id, user: dee.id, level: 'viewer' } as never, user: { id: cy.id, collection: 'admins' } as never, overrideAccess: false }))).toBeTruthy()
    expect((await rows({ user: { equals: dee.id } })).totalDocs).toBe(0)
    expect(await refused(state.payload.update({ collection: 'organizations' as never, id: org.id as never, data: { name: 'Hijack' } as never, user: { id: cy.id, collection: 'admins' } as never, overrideAccess: true }))).toBeTruthy()
    expect((await orgRow(org.id)).name).toBe('Made-up Zoo')
  })
})

describe('the history', () => {
  it('records every creation, invitation, approval, acceptance, level change and removal, and nothing for a refused change', async () => {
    const r = await join(org.id, cy, dee, 'viewer')
    await change(cy, r.id, { level: 'member' })
    await change(dee, r.id, { status: 'removed' })
    const before = (await events()).length
    await refused(change(dee, r.id, { status: 'active' }))
    expect((await events()).length).toBe(before)
    const list = await events()
    expect(list.map((e) => e.event)).toEqual(['create', 'invite', 'approve', 'activate', 'invite', 'accept', 'change-level', 'remove'])
    const level = list.find((e) => e.event === 'change-level')!
    expect([level.previousLevel, level.level]).toEqual(['viewer', 'member'])
    expect(list.at(-1)!.previousStatus).toBe('active')
  })

  it('writes audit hooks around each change, and an after hook for each', async () => {
    log.length = 0
    await join(org.id, cy, dee, 'viewer')
    expect(log).toEqual(expect.arrayContaining(['before:invite', 'after:invite', 'before:accept', 'after:accept']))
  })

  it('can’t be written, edited or deleted, by clients or by server code', async () => {
    const e = (await state.payload.find({ collection: 'organization-events' as never, overrideAccess: true })).docs[0] as { id: string }
    expect(await refused(state.payload.create({ collection: 'organization-events' as never, data: { organization: org.id, event: 'create' } as never, user: as(ann), overrideAccess: false }))).toBeTruthy()
    expect(await refused(state.payload.update({ collection: 'organization-events' as never, id: e.id as never, data: { level: 'x' } as never, overrideAccess: true }))).toMatch(/edited/)
    expect(await refused(state.payload.delete({ collection: 'organization-events' as never, id: e.id as never, overrideAccess: true }))).toMatch(/deleted/)
  })

  it('is read by an organization’s Coordinators and the host’s readers only', async () => {
    await join(org.id, cy, dee, 'member')
    const read = (u: U) => state.payload.find({ collection: 'organization-events' as never, user: as(u), overrideAccess: false })
    expect((await read(cy)).totalDocs).toBeGreaterThan(0)
    expect((await read(ann)).totalDocs).toBeGreaterThan(0)
    expect(await refused(read(dee))).toBeTruthy()
    expect(await refused(read(eli))).toBeTruthy()
  })
})

describe('what people can see of each other', () => {
  it('shows a Member only the Coordinators and their own row; a Coordinator sees everyone', async () => {
    await join(org.id, cy, dee, 'member')
    await join(org.id, cy, eli, 'viewer')
    await join(org.id, cy, fay, 'coordinator')
    const users = async (u: U) =>
      (await state.payload.find({ collection: 'organization-members' as never, user: as(u), overrideAccess: false, pagination: false, depth: 0 })).docs.map((d) => String((d as unknown as { user: string }).user)).sort()
    expect(await users(dee)).toEqual([String(cy.id), String(dee.id), String(fay.id)].sort())
    expect(await users(eli)).toEqual([String(cy.id), String(eli.id), String(fay.id)].sort())
    expect((await users(cy)).length).toBe(4)
    expect((await users(ann)).length).toBe(4)
    expect(await refused(state.payload.find({ collection: 'organization-members' as never, overrideAccess: false }))).toBeTruthy()
  })

  it('shows another organization’s people to nobody outside it', async () => {
    const other = await liveOrg(fay, ann, { name: 'Other Zoo' })
    await join(other.id, bea, dee, 'member')
    const mine = (await state.payload.find({ collection: 'organization-members' as never, user: as(cy), overrideAccess: false, pagination: false, depth: 0 })).docs
    expect(mine.every((d) => String((d as unknown as { organization: string }).organization) === String(org.id))).toBe(true)
  })
})

describe('the helpers', () => {
  it('levelIn gives the highest active level, and null for invited, removed, pending, closed or signed out', async () => {
    await join(org.id, cy, dee, 'viewer')
    await invite(cy, org.id, { user: eli.id, level: 'coordinator' })
    expect(await levelIn(reqFor(dee), org.id)).toBe('viewer')
    expect(await levelIn(reqFor(eli), org.id)).toBeNull()
    expect(await levelIn(reqFor(null), org.id)).toBeNull()
    const pending = await propose(fay)
    expect(await levelIn(reqFor(fay), pending.id)).toBeNull()
    await editOrg(ann, org.id, { status: 'closed' })
    expect(await levelIn(reqFor(dee), org.id)).toBeNull()
  })

  it('organizationsOf lists active organizations with levels, and can ask for a least level', async () => {
    const second = await liveOrg(fay, ann, { name: 'Second Zoo' })
    await join(org.id, cy, dee, 'member')
    await join(second.id, bea, dee, 'coordinator')
    const all = await organizationsOf(reqFor(dee))
    expect(all.map((o) => [String(o.id), o.level]).sort()).toEqual([[String(org.id), 'member'], [String(second.id), 'coordinator']].sort())
    expect((await organizationsOf(reqFor(dee), { atLeast: 'coordinator' })).map((o) => String(o.id))).toEqual([String(second.id)])
    expect(await organizationsOf(reqFor(eli))).toEqual([])
    expect(await organizationsOf(reqFor(null))).toEqual([])
  })
})

describe('approving through a second account', () => {
  it('stops an approver who made an organization from activating it by approving an invited Coordinator', async () => {
    // Nobody is left in the organization but the approver and the person the approver invites.
    answers.canPrecreate = () => false
    const pend = await propose(ann, { name: 'Second Account Zoo' })
    await invite(ann, pend.id, { user: dee.id, level: 'coordinator' })
    const bRow = await rowOf(pend.id, dee)
    expect(await refused(change(ann, bRow.id, { status: 'active' }))).toMatch(/made or belong to/)
    expect((await orgRow(pend.id)).status).toBe('pending')
    expect((await rowOf(pend.id, dee)).status).toBe('invited')
    // The same holds once the approver has only been invited, never accepted.
    expect(await refused(change(ann, (await rowOf(pend.id, ann)).id, { status: 'active' }))).toMatch(/themselves/)
    // Dee cannot be used to bring the approver back in either: nothing is active, so Dee has no say.
    expect(await refused(invite(dee, pend.id, { user: ann.id, level: 'coordinator' }))).toBeTruthy()
    expect((await orgRow(pend.id)).status).toBe('pending')
    // A different approver can still approve.
    await change(bea, bRow.id, { status: 'active' })
    expect((await orgRow(pend.id)).status).toBe('active')
  })

  it('stops an approver who belongs to a pending organization from approving anyone in it', async () => {
    answers.canPrecreate = () => false
    answers.canInvite = () => true
    const pend = await propose(cy, { name: 'Member Approver Zoo' })
    await invite(cy, pend.id, { user: ann.id, level: 'member' })
    expect(await refused(change(ann, (await rowOf(pend.id, cy)).id, { status: 'active' }))).toMatch(/made or belong to/)
    expect((await orgRow(pend.id)).status).toBe('pending')
  })

  it('asks canApprove about the organization on this path, not about membership fields', async () => {
    answers.canPrecreate = () => false
    const pend = await propose(cy, { name: 'Shape Zoo' })
    let got: any
    answers.canApprove = (a: any) => {
      got = a
      return true
    }
    await change(ann, (await rowOf(pend.id, cy)).id, { status: 'active' })
    expect(got.data).toEqual({ status: 'active' })
    expect(got.organization.name).toBe('Shape Zoo')
  })
})

describe('who may ask about an organization', () => {
  it('gives a stranger the same answer for a live, closed and missing organization', async () => {
    const closed = await liveOrg(fay, ann, { name: 'Closed One' })
    await editOrg(bea, closed.id, { status: 'closed' })
    const asked = [org.id, closed.id, '000000000000000000000000'].map((id) => invite(eli, id, { user: dee.id, level: 'viewer' }))
    const msgs = await Promise.all(asked.map((p) => refused(p)))
    expect(new Set(msgs).size).toBe(1)
    expect(msgs[0]).toMatch(/can’t invite/)
  })
})

describe('what an inviter can learn from the answers', () => {
  it('refuses a level change on an invited row the same way for a minor and an adult', async () => {
    await invite(cy, org.id, { user: kid.id, level: 'viewer' })
    await invite(cy, org.id, { user: dee.id, level: 'viewer' })
    log.length = 0
    const a = await refused(change(cy, (await rowOf(org.id, kid)).id, { level: 'member' }))
    const b = await refused(change(cy, (await rowOf(org.id, dee)).id, { level: 'member' }))
    expect(a).toMatch(/until the person accepts/)
    expect(a).toBe(b)
    expect(log).not.toContain('veto:change-level')
    expect((await rowOf(org.id, kid)).level).toBe('viewer')
    expect((await rowOf(org.id, dee)).level).toBe('viewer')
  })

  it('answers an invitation to an id that does not exist like any other refused invitation', async () => {
    const missing = await refused(invite(cy, org.id, { user: '000000000000000000000000', level: 'member' }))
    const garbage = await refused(invite(cy, org.id, { user: 'not-an-id', level: 'member' }))
    const stranger = await refused(invite(eli, org.id, { user: dee.id, level: 'member' }))
    expect(missing).toMatch(/can’t invite people/)
    expect(missing).toBe(stranger)
    expect(garbage).toBe(stranger)
    expect((await rows({ user: { equals: '000000000000000000000000' } })).totalDocs).toBe(0)
  })

  it('does not tell a Member that someone they can’t see already has an invited row', async () => {
    await join(org.id, cy, dee, 'member')
    await invite(cy, org.id, { user: kid.id, level: 'viewer' })
    // A Member may invite Viewers; they can't see the minor's row.
    const dup = await refused(invite(dee, org.id, { user: kid.id, level: 'viewer' }))
    const other = await refused(invite(eli, org.id, { user: fay.id, level: 'viewer' }))
    expect(dup).toBe(other)
    expect(dup).not.toMatch(/already/)
    // A Coordinator sees every row, so they are told plainly.
    expect(await refused(invite(cy, org.id, { user: kid.id, level: 'viewer' }))).toMatch(/already/)
  })
})

describe('a level change on an active row', () => {
  it('looks the same to the changer for a vetoed member and one they may not change', async () => {
    const a = await join(org.id, cy, dee, 'member')
    const b = await join(org.id, cy, eli, 'member')
    await state.payload.update({ collection: 'users', id: dee.id as never, data: { minor: true } as never, overrideAccess: true })
    const before = (await events()).length
    answers.canChangeLevel = ({ member }: { member: { user?: unknown } }) => String(member.user) !== String(eli.id)
    const vetoed = await refused(change(cy, a.id, { level: 'viewer' }))
    const notAllowed = await refused(change(cy, b.id, { level: 'viewer' }))
    expect(vetoed).toBe(notAllowed)
    expect(vetoed).not.toMatch(/Not available/)
    expect((await rowOf(org.id, dee)).level).toBe('member')
    expect((await events()).length).toBe(before)
    // Server code still sees the reason.
    expect(await refused(state.payload.update({ collection: 'organization-members' as never, id: a.id as never, data: { level: 'viewer' } as never, overrideAccess: true }))).toMatch(/Not available/)
  })
})

describe('approving after leaving', () => {
  it('counts a removed row, so an approver can’t leave, approve and be invited back', async () => {
    answers.canPrecreate = () => false
    answers.canInvite = () => true
    const pend = await propose(cy, { name: 'Leave And Return Zoo' })
    await invite(cy, pend.id, { user: ann.id, level: 'member' })
    await change(ann, (await rowOf(pend.id, ann)).id, { status: 'removed' })
    expect(await refused(change(ann, (await rowOf(pend.id, cy)).id, { status: 'active' }))).toMatch(/made or belong to/)
    expect((await orgRow(pend.id)).status).toBe('pending')
    await change(bea, (await rowOf(pend.id, cy)).id, { status: 'active' })
    expect((await orgRow(pend.id)).status).toBe('active')
  })
})
