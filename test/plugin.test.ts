import { describe, expect, it } from 'vitest'

import { organizations } from '../src/index.js'

const base = { kinds: [{ value: 'zoo' }] }

describe('organizations', () => {
  it('leaves a config unchanged when turned off', () => {
    const config = { collections: [], secret: 'made-up' } as never
    expect(organizations({ ...base, refuseMember: false, enabled: false })(config)).toBe(config)
  })

  it('requires refuseMember, or an explicit false', () => {
    expect(() => organizations(base as never)({ collections: [] } as never)).toThrow(/refuseMember/)
    expect(() => organizations({ ...base, refuseMember: false })({ collections: [] } as never)).not.toThrow()
  })

  it('takes only a function or exactly false for refuseMember', () => {
    for (const bad of [null, 0, '', true, 'no', {}]) {
      expect(() => organizations({ ...base, refuseMember: bad as never })({ collections: [] } as never)).toThrow(/refuseMember/)
    }
    expect(() => organizations({ ...base, refuseMember: () => null })({ collections: [] } as never)).not.toThrow()
  })

  it('adds three collections and keeps the host’s own', () => {
    const out = organizations({ ...base, refuseMember: false })({ collections: [{ slug: 'users', fields: [] }] } as never) as { collections: { slug: string }[] }
    expect(out.collections.map((c) => c.slug)).toEqual(['users', 'organizations', 'organization-members', 'organization-events'])
  })

  it('offers only the kinds the host gives', () => {
    const out = organizations({ kinds: [{ value: 'zoo', label: 'Zoo' }, { value: 'lab' }], refuseMember: false })({ collections: [] } as never) as { collections: { fields: unknown[] }[] }
    const kind = (out.collections[0]!.fields as { name?: string; options?: unknown }[]).find((f) => f.name === 'kind')!
    expect(kind.options).toEqual([{ label: 'Zoo', value: 'zoo' }, { label: 'lab', value: 'lab' }])
  })
})
