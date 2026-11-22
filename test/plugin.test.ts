import { describe, expect, it } from 'vitest'
import { organizations } from '../src/index.js'

describe('organizations', () => {
  it('leaves a config unchanged while it is a skeleton, and when turned off', () => {
    const config = { collections: [], secret: 'made-up' } as never
    expect(organizations()(config)).toEqual(config)
    expect(organizations({ enabled: false })(config)).toBe(config)
  })
})
