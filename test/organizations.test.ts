import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { levelIn } from '../src/index.js'
import { answers, as, change, editOrg, events, invite, join, liveOrg, log, make, orgRow, propose, refused, rowOf, rows, start, state, stop, wipe, type U } from './setup.js'

let ann: U, bea: U, cy: U, dee: U, eli: U, kid: U
const reqFor = (u: U) => ({ payload: state.payload, user: as(u) }) as never

beforeAll(start, 180_000)
afterAll(stop)
beforeEach(async () => {
  for (const k of Object.keys(answers)) delete answers[k]
  log.length = 0
  await wipe()
  ann = await make('ann@example.com', { staff: true })
  bea = await make('bea@example.com', { staff: true })
  cy = await make('cy@example.com')
  dee = await make('dee@example.com')
  eli = await make('eli@example.com')
  kid = await make('kid@example.com', { minor: true })
})

describe('proposing an organization', () => {
  it('always starts pending, whatever the client sends, with its maker waiting as first Coordinator', async () => {
    const org = await propose(cy, { status: 'active', createdBy: dee.id, lock: 9 })
    const doc = await orgRow(org.id)
    expect(doc.status).toBe('pending')
    expect(String((doc.createdBy as { id?: unknown })?.id ?? doc.createdBy)).toBe(String(cy.id))
    const raw = (await (state.payload.db as unknown as { collections: Record<string, { findOne: (f: object) => { lean: () => Promise<{ lock?: number }> } }> }).collections.organizations!.findOne({}).lean())
    expect(raw.lock).toBe(0)
    const r = await rowOf(org.id, cy)
    expect([r.level, r.status]).toEqual(['coordinator', 'invited'])
    expect(await levelIn(reqFor(cy), org.id)).toBeNull()
  })

  it('refuses without the host hook, or when it answers anything but an exact true', async () => {
    for (const answer of [() => false, () => 'yes', () => 1, () => { throw new Error('boom') }, () => undefined]) {
      answers.canCreate = answer
      expect(await refused(propose(cy))).toMatch(/can’t add/)
    }
    answers.canCreate = () => true
    expect(await refused(propose(null))).toBeTruthy()
    expect((await state.payload.count({ collection: 'organizations' as never, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('refuses an unknown kind, a blank name, an overlong name and a user from another sign-in collection', async () => {
    expect(await refused(propose(cy, { kind: 'mystery' }))).toBeTruthy()
    expect(await refused(propose(cy, { name: '   ' }))).toMatch(/needs a name/)
    expect(await refused(propose(cy, { name: 'x'.repeat(201) }))).toMatch(/at most 200/)
    const root = await make('root@example.com', {}, 'admins')
    expect(await refused(state.payload.create({ collection: 'organizations' as never, data: { name: 'Made-up Lab', kind: 'lab' } as never, user: as(root, 'admins'), overrideAccess: false }))).toBeTruthy()
    expect((await state.payload.count({ collection: 'organizations' as never, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('drops domains and a ROR id from every proposer, approvers included, and keeps them for server code', async () => {
    const a = await propose(cy, { domains: ['made-up-zoo.org'], rorId: '02mhbdp94' })
    expect((await orgRow(a.id)).domains).toEqual([])
    expect((await orgRow(a.id)).rorId ?? null).toBeNull()
    const b = await propose(ann, { name: 'Made-up Lab', kind: 'lab', domains: ['lab.example.org'], rorId: '02mhbdp94' })
    expect((await orgRow(b.id)).domains).toEqual([])
    expect((await orgRow(b.id)).rorId ?? null).toBeNull()
    const c = (await state.payload.create({ collection: 'organizations' as never, data: { name: 'Server Lab', kind: 'lab', domains: ['@Lab.Example.ORG', 'lab.example.org'], rorId: 'https://ror.org/02MHBDP94' } as never, overrideAccess: true })) as unknown as { id: string }
    const doc = await orgRow(c.id)
    expect(doc.domains).toEqual(['lab.example.org'])
    expect(doc.rorId).toBe('02mhbdp94')
  })

  it('refuses public mail, school and provider domains, bad domains and bad ROR ids from an approver', async () => {
    expect(await refused(propose(ann, { domains: ['gmail.com'] }))).toMatch(/public mail/)
    expect(await refused(propose(ann, { domains: ['x.k12.ca.us'] }))).toMatch(/public mail/)
    expect(await refused(propose(ann, { domains: ['box.sample-isp.test'] }))).toMatch(/public mail/)
    expect(await refused(propose(ann, { domains: ['extra-mail.example'] }))).toMatch(/public mail/)
    expect(await refused(propose(ann, { domains: ['not a domain'] }))).toMatch(/valid domain/)
    expect(await refused(propose(ann, { domains: ['localhost'] }))).toMatch(/valid domain/)
    expect(await refused(propose(ann, { domains: Array.from({ length: 51 }, (_, i) => `zoo${i}.example.org`) }))).toBeTruthy()
    const org = await propose(ann, { name: 'Made-up Lab', kind: 'lab' })
    expect(await refused(editOrg(ann, org.id, { rorId: 'not-a-ror' }))).toMatch(/ROR/)
  })

  it('makes an organization with nobody in it only for whoever canPrecreate allows', async () => {
    const org = await propose(ann, { name: 'Pre-made Lab', kind: 'lab' })
    expect((await rows({ organization: { equals: org.id } })).totalDocs).toBe(0)
    expect((await orgRow(org.id)).status).toBe('pending')
    delete answers.canPrecreate
    answers.canPrecreate = () => 'yes'
    const other = await propose(ann, { name: 'Other Lab', kind: 'lab' })
    expect((await rows({ organization: { equals: other.id } })).totalDocs).toBe(1)
  })

  it('rolls the organization back if the veto stops its first Coordinator', async () => {
    expect(await refused(propose(kid))).toMatch(/Not available for this account/)
    expect((await state.payload.count({ collection: 'organizations' as never, overrideAccess: true })).totalDocs).toBe(0)
    expect((await rows()).totalDocs).toBe(0)
  })
})

describe('approval', () => {
  it('goes live when an approver activates the first Coordinator', async () => {
    const org = await propose(cy)
    const r = await rowOf(org.id, cy)
    await change(ann, r.id, { status: 'active' })
    expect((await orgRow(org.id)).status).toBe('active')
    expect(await levelIn(reqFor(cy), org.id)).toBe('coordinator')
    expect((await events()).map((e) => e.event)).toEqual(['create', 'invite', 'approve', 'activate'])
  })

  it('has no time limit and no self-approval: the first Coordinator cannot activate themselves, an approver can’t if they made it', async () => {
    const org = await propose(cy)
    const r = await rowOf(org.id, cy)
    expect(await refused(change(cy, r.id, { status: 'active' }))).toBeTruthy()
    expect((await rowOf(org.id, cy)).status).toBe('invited')
    // an approver who is also the invited Coordinator is refused too
    const mine = await propose(ann, { name: 'Ann’s Lab', kind: 'lab' })
    expect(await refused(editOrg(ann, mine.id, { status: 'active' }))).toMatch(/made or belong/)
    expect(await refused(change(ann, (await invite(ann, mine.id, { user: ann.id, level: 'coordinator' })).id, { status: 'active' }))).toMatch(/approves themselves/)
    await editOrg(bea, mine.id, { status: 'active' })
    expect((await orgRow(mine.id)).status).toBe('active')
  })

  it('refuses anyone who isn’t an approver, and any answer but an exact true', async () => {
    const org = await propose(cy)
    const r = await rowOf(org.id, cy)
    await invite(ann, org.id, { user: dee.id, level: 'member' })
    expect(await refused(change(dee, (await rowOf(org.id, dee)).id, { status: 'active' }))).toMatch(/approves themselves/)
    for (const answer of [() => 'yes', () => 1, () => { throw new Error('boom') }]) {
      answers.canApprove = answer
      expect(await refused(change(ann, r.id, { status: 'active' }))).toMatch(/approver/)
    }
    expect((await orgRow(org.id)).status).toBe('pending')
  })

  it('asks the veto at approval', async () => {
    const org = await propose(cy)
    log.length = 0
    answers.refuse = () => 'Not available for this account.'
    expect(await refused(change(ann, (await rowOf(org.id, cy)).id, { status: 'active' }))).toMatch(/Not available/)
    expect(log).toContain('veto:approve')
    expect((await orgRow(org.id)).status).toBe('pending')
  })

  it('lets only an approver set an organization active directly, and a pending organization never grants anything', async () => {
    const org = await propose(cy)
    expect(await refused(editOrg(cy, org.id, { status: 'active' }))).toBeTruthy()
    expect((await orgRow(org.id)).status).toBe('pending')
    await invite(ann, org.id, { user: dee.id, level: 'member' })
    expect(await refused(change(dee, (await rowOf(org.id, dee)).id, { status: 'active' }))).toBeTruthy()
    expect(await levelIn(reqFor(dee), org.id)).toBeNull()
  })
})

describe('status', () => {
  it('only moves pending to active or closed, active to closed, and closed to active, through an approver', async () => {
    const org = await liveOrg(cy, ann)
    expect(await refused(editOrg(cy, org.id, { status: 'closed' }))).toMatch(/approver/)
    expect(await refused(editOrg(bea, org.id, { status: 'pending' }))).toMatch(/isn’t allowed/)
    await editOrg(bea, org.id, { status: 'closed' })
    expect(await levelIn(reqFor(cy), org.id)).toBeNull()
    expect(await refused(editOrg(cy, org.id, { status: 'active' }))).toMatch(/approver/)
    expect(await refused(editOrg(bea, org.id, { status: 'pending' }))).toMatch(/isn’t allowed/)
    await editOrg(bea, org.id, { status: 'active' })
    expect(await levelIn(reqFor(cy), org.id)).toBe('coordinator')
    expect((await events()).map((e) => e.event)).toEqual(expect.arrayContaining(['close', 'reopen']))
  })

  it('refuses to reopen for someone who belongs to it, even an approver', async () => {
    const org = await liveOrg(cy, ann)
    await join(org.id, cy, bea, 'member')
    // bea is an approver, but she is in the organization, so she can’t close it
    expect(await refused(editOrg(bea, org.id, { status: 'closed' }))).toMatch(/made or belong/)
    expect((await orgRow(org.id)).status).toBe('active')
  })

  it('allows no changes, invitations or acceptances in a closed organization', async () => {
    const org = await liveOrg(cy, ann)
    await invite(cy, org.id, { user: dee.id, level: 'member' })
    await editOrg(ann, org.id, { status: 'closed' })
    expect(await refused(editOrg(ann, org.id, { name: 'Renamed' }))).toMatch(/closed/)
    expect(await refused(invite(ann, org.id, { user: eli.id, level: 'viewer' }))).toMatch(/closed/)
    expect(await refused(change(dee, (await rowOf(org.id, dee)).id, { status: 'active' }))).toMatch(/closed/)
  })

  it('asks the veto again about everyone when an organization reopens, and ends the ones it refuses', async () => {
    const org = await liveOrg(cy, ann)
    await join(org.id, cy, dee, 'member')
    await join(org.id, cy, eli, 'viewer')
    await editOrg(ann, org.id, { status: 'closed' })
    log.length = 0
    answers.refuse = undefined
    // dee has since been flagged as a minor
    await state.payload.update({ collection: 'users', id: dee.id as never, data: { minor: true } as never, overrideAccess: true })
    await editOrg(bea, org.id, { status: 'active' })
    expect(log.filter((l) => l === 'veto:reopen').length).toBe(3)
    expect((await rowOf(org.id, dee)).status).toBe('removed')
    expect((await rowOf(org.id, eli)).status).toBe('active')
    expect((await rowOf(org.id, cy)).status).toBe('active')
    expect(await levelIn(reqFor(dee), org.id)).toBeNull()
  })

  it('stops a reopening that would remove the last Coordinator', async () => {
    const org = await liveOrg(cy, ann)
    await editOrg(ann, org.id, { status: 'closed' })
    await state.payload.update({ collection: 'users', id: cy.id as never, data: { minor: true } as never, overrideAccess: true })
    expect(await refused(editOrg(bea, org.id, { status: 'active' }))).toMatch(/keeps a Coordinator/)
    expect((await orgRow(org.id)).status).toBe('closed')
    expect((await rowOf(org.id, cy)).status).toBe('active')
  })
})

describe('what can change', () => {
  it('lets a Coordinator rename and nobody else, and never change the kind or maker', async () => {
    const org = await liveOrg(cy, ann)
    await editOrg(cy, org.id, { name: 'Renamed Zoo' })
    expect((await orgRow(org.id)).name).toBe('Renamed Zoo')
    await join(org.id, cy, dee, 'member')
    expect(await refused(editOrg(dee, org.id, { name: 'Nope' }))).toMatch(/can’t change/)
    expect(await refused(editOrg(eli, org.id, { name: 'Nope' }))).toBeTruthy()
    expect(await refused(editOrg(cy, org.id, { kind: 'lab' }))).toMatch(/kind/)
    expect(await refused(editOrg(ann, org.id, { createdBy: dee.id }))).toMatch(/Who made/)
    expect(await refused(editOrg(cy, org.id, { name: '' }))).toMatch(/needs a name/)
    expect((await events()).map((e) => e.event)).toContain('update')
  })

  it('lets only an approver change ROR id or domains, which widens who it suggests', async () => {
    const org = await liveOrg(cy, ann)
    expect(await refused(editOrg(cy, org.id, { domains: ['made-up-zoo.org'] }))).toMatch(/approver/)
    expect(await refused(editOrg(cy, org.id, { rorId: '02mhbdp94' }))).toMatch(/approver/)
    await editOrg(ann, org.id, { domains: ['made-up-zoo.org'], rorId: '02mhbdp94' })
    expect((await orgRow(org.id)).domains).toEqual(['made-up-zoo.org'])
    expect(await refused(editOrg(ann, org.id, { rorId: null }))).toMatch(/replaced but not cleared/)
    expect((await events()).map((e) => e.event)).toContain('change-domains')
  })

  it('keeps ROR ids unique, also when two are set at once, and lets many organizations have none', async () => {
    const a = await propose(ann, { name: 'A', kind: 'lab' })
    const b = await propose(ann, { name: 'B', kind: 'lab' })
    await propose(ann, { name: 'C', kind: 'lab' })
    const results = await Promise.allSettled([editOrg(bea, a.id, { rorId: '03yrm5c26' }), editOrg(bea, b.id, { rorId: '03yrm5c26' })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await state.payload.count({ collection: 'organizations' as never, where: { rorId: { equals: '03yrm5c26' } } as never, overrideAccess: true })).totalDocs).toBe(1)
  })

  it('hides private notes from members, Coordinators included, and lets only the host’s hook read or write them', async () => {
    const org = await liveOrg(cy, ann)
    await editOrg(ann, org.id, { privateNotes: 'call before approving' })
    expect((await orgRow(org.id)).privateNotes).toBe('call before approving')
    const read = async (u: U) => ((await state.payload.findByID({ collection: 'organizations' as never, id: org.id as never, user: as(u), overrideAccess: false })) as unknown as Record<string, unknown>).privateNotes
    expect(await read(ann)).toBe('call before approving')
    expect(await read(cy)).toBeUndefined()
    await editOrg(cy, org.id, { privateNotes: 'overwritten', name: 'Zoo Two' })
    expect((await orgRow(org.id)).privateNotes).toBe('call before approving')
    expect(await refused(editOrg(ann, org.id, { privateNotes: 'x'.repeat(2001) }))).toBeTruthy()
    answers.canSeePrivate = () => 'yes'
    expect(await read(ann)).toBeUndefined()
  })

  it('is never deleted, even with overrideAccess', async () => {
    const org = await liveOrg(cy, ann)
    expect(await refused(state.payload.delete({ collection: 'organizations' as never, id: org.id as never, overrideAccess: true }))).toMatch(/never deleted/)
    expect(await refused(state.payload.delete({ collection: 'organizations' as never, id: org.id as never, user: as(ann), overrideAccess: false }))).toBeTruthy()
    expect((await orgRow(org.id)).status).toBe('active')
  })
})

describe('who sees an organization', () => {
  it('shows it to its invited and active people and to the host’s readers, and to nobody else', async () => {
    const org = await liveOrg(cy, ann)
    await join(org.id, cy, dee, 'viewer')
    const seeable = (u: U) => state.payload.find({ collection: 'organizations' as never, user: as(u), overrideAccess: false, pagination: false }).then((r) => r.totalDocs, () => 0)
    expect(await seeable(cy)).toBe(1)
    expect(await seeable(dee)).toBe(1)
    expect(await seeable(ann)).toBe(1)
    expect(await seeable(eli)).toBe(0)
    expect(await refused(state.payload.find({ collection: 'organizations' as never, overrideAccess: false }))).toBeTruthy()
    answers.canRead = () => 'yes'
    expect(await seeable(ann)).toBe(0)
  })
})

describe('the audit hooks', () => {
  it('stops a change when a before hook throws, and logs an after hook that throws', async () => {
    answers.beforeAudit = () => {
      throw new Error('down')
    }
    expect(await refused(propose(cy))).toMatch(/can’t be recorded/)
    expect((await state.payload.count({ collection: 'organizations' as never, overrideAccess: true })).totalDocs).toBe(0)
    delete answers.beforeAudit
    answers.afterAudit = () => {
      throw new Error('down')
    }
    const org = await propose(cy)
    expect((await orgRow(org.id)).status).toBe('pending')
  })
})

describe('reopening', () => {
  it('asks the veto about active people only, and leaves invited ones to be checked when they accept', async () => {
    const org = await liveOrg(cy, ann)
    answers.canInvite = () => true
    await invite(cy, org.id, { user: kid.id, level: 'viewer' })
    await invite(cy, org.id, { user: dee.id, level: 'viewer' })
    await editOrg(ann, org.id, { status: 'closed' })
    log.length = 0
    await editOrg(bea, org.id, { status: 'active' })
    expect(log.filter((l) => l === 'veto:reopen').length).toBe(1)
    expect((await rowOf(org.id, kid)).status).toBe('invited')
    expect((await rowOf(org.id, dee)).status).toBe('invited')
    expect((await events()).filter((e) => e.event === 'remove')).toEqual([])
    expect(await refused(change(kid, (await rowOf(org.id, kid)).id, { status: 'active' }))).toMatch(/Not available/)
  })
})

describe('widening by someone involved', () => {
  it('stops an approver who made or belongs to an organization from changing its ROR id or domains', async () => {
    const org = await liveOrg(cy, ann)
    // Ann approved it, so she is not in it. Bea joins, then tries.
    await join(org.id, cy, bea, 'viewer')
    expect(await refused(editOrg(bea, org.id, { domains: ['made-up-zoo.org'] }))).toMatch(/made or belong to/)
    expect(await refused(editOrg(bea, org.id, { rorId: '02mhbdp94' }))).toMatch(/made or belong to/)
    expect((await orgRow(org.id)).domains).toEqual([])
    // An approver who made an organization can't either.
    answers.canPrecreate = () => false
    const mine = await liveOrg(ann, bea, { name: 'Ann Made This' })
    expect(await refused(editOrg(ann, mine.id, { domains: ['ann-zoo.org'] }))).toMatch(/made or belong to/)
    await editOrg(bea, mine.id, { domains: ['ann-zoo.org'] }).catch(() => null)
  })

  it('refuses public suffixes, and accepts a name under one', async () => {
    const org = await liveOrg(cy, ann)
    for (const bad of ['co.uk', 'github.io', 'com.au', 'blogspot.com']) expect(await refused(editOrg(ann, org.id, { domains: [bad] }))).toMatch(/public suffix/)
    await editOrg(ann, org.id, { domains: ['zoo.co.uk', 'me.github.io'] })
    expect((await orgRow(org.id)).domains).toEqual(['me.github.io', 'zoo.co.uk'])
  })

  it('only checks domains being added, so a domain the host later marks generic does not block a rename or a close', async () => {
    const org = await liveOrg(cy, ann)
    await editOrg(ann, org.id, { domains: ['later-generic.example', 'kept.example'] })
    const custom = (state.payload.config.custom as { organizations: { genericDomains: string[] } }).organizations
    custom.genericDomains.push('later-generic.example')
    try {
      await editOrg(cy, org.id, { name: 'Renamed While Generic', domains: ['later-generic.example', 'kept.example'] })
      expect((await orgRow(org.id)).name).toBe('Renamed While Generic')
      expect(await refused(editOrg(ann, org.id, { domains: ['later-generic.example', 'kept.example', 'extra-mail.example'] }))).toMatch(/public mail/)
      await editOrg(ann, org.id, { status: 'closed' })
      expect((await orgRow(org.id)).status).toBe('closed')
    } finally {
      custom.genericDomains.pop()
    }
  })
})

describe('the history', () => {
  it('records the domain and ROR values, and both events when one change does two things', async () => {
    const org = await liveOrg(cy, ann)
    await editOrg(ann, org.id, { domains: ['made-up-zoo.org'], rorId: '02mhbdp94' })
    const dom = (await state.payload.find({ collection: 'organization-events' as never, where: { event: { equals: 'change-domains' } } as never, overrideAccess: true })).docs[0] as any
    expect(dom.domains).toEqual(['made-up-zoo.org'])
    expect(dom.rorId).toBe('02mhbdp94')
    expect(dom.previousDomains ?? []).toEqual([])
    log.length = 0
    await editOrg(ann, org.id, { status: 'closed', domains: ['made-up-zoo.org', 'second.example.org'] })
    const names = (await events()).map((e) => e.event)
    expect(names.slice(-2)).toEqual(['close', 'change-domains'])
    expect(log.filter((l) => l.startsWith('before:'))).toEqual(['before:close', 'before:change-domains'])
    expect(log.filter((l) => l.startsWith('after:'))).toEqual(['after:close', 'after:change-domains'])
    const last = (await state.payload.find({ collection: 'organization-events' as never, where: { event: { equals: 'change-domains' } } as never, sort: '-createdAt', limit: 1, overrideAccess: true })).docs[0] as any
    expect(last.domains).toEqual(['made-up-zoo.org', 'second.example.org'])
    expect(last.previousDomains).toEqual(['made-up-zoo.org'])
  })

  it('records a notes-only change as an update, with no private text in it', async () => {
    const org = await liveOrg(cy, ann)
    log.length = 0
    await editOrg(ann, org.id, { privateNotes: 'staff only words' })
    expect(log).toEqual(['before:update', 'after:update'])
    const all = await events()
    expect(all[all.length - 1]!.event).toBe('update')
    const flat = await state.payload.find({ collection: 'organization-events' as never, depth: 0, pagination: false, overrideAccess: true })
    expect(JSON.stringify(flat.docs)).not.toMatch(/staff only words/)
  })
})

describe('changing one document at a time', () => {
  it('refuses a bulk update or delete, even from server code, and leaves every document as it was', async () => {
    const other = await liveOrg(eli, ann, { name: 'Other Zoo' })
    for (const collection of ['organizations', 'organization-members', 'organization-events']) {
      expect(await refused(state.payload.update({ collection: collection as never, where: { id: { exists: true } } as never, data: { name: 'Hacked' } as never, overrideAccess: true }))).toMatch(/one document at a time/)
      expect(await refused(state.payload.delete({ collection: collection as never, where: { id: { exists: true } } as never, overrideAccess: true }))).toMatch(/one document at a time/)
    }
    expect((await orgRow(other.id)).name).toBe('Other Zoo')
    expect(await count('organizations')).toBe(1)
    expect(await count('organization-members')).toBe(1)
  })

  it('still refuses a delete by id from server code', async () => {
    expect(await refused(state.payload.delete({ collection: 'organizations' as never, id: (await liveOrg(eli, ann, { name: 'X' })).id as never, overrideAccess: true }))).toMatch(/never deleted/)
  })
})

const count = async (collection: string) => (await state.payload.count({ collection: collection as never, overrideAccess: true })).totalDocs
