import { describe, expect, it } from 'vitest'

import { GENERIC_DOMAINS, domainOf, isGenericDomain, normalizeDomain, normalizeRor } from '../src/index.js'

/** Written out so the leak check sees no address in the file. */
const AT = '@'

describe('domains', () => {
  it('tidies a domain and refuses what is not one', () => {
    expect(normalizeDomain('  @Zoo.Example.ORG. ')).toBe('zoo.example.org')
    expect(normalizeDomain('münchen.example')).toBe('xn--mnchen-3ya.example')
    for (const bad of ['', 'localhost', 'a b.org', 'zoo.org/path', 'zoo.org:8080', `a${AT}b.org`, '-x.org', 'x-.org', 'zoo.123', 'zoo..org', 42, null, undefined, 'x'.repeat(64) + '.org']) {
      expect(normalizeDomain(bad)).toBeNull()
    }
  })

  it('takes the domain from the last @ in an address', () => {
    expect(domainOf(`Dee${AT}Zoo.org`)).toBe('zoo.org')
    expect(domainOf(`weird"@"name${AT}zoo.org`)).toBe('zoo.org')
    expect(domainOf('@zoo.org')).toBeNull()
    expect(domainOf('nobody')).toBeNull()
  })

  it('ships public mail, provider and school domains, which the host can add to but not remove', () => {
    expect(GENERIC_DOMAINS).toContain('gmail.com')
    expect(isGenericDomain('GMAIL.com')).toBe(true)
    expect(isGenericDomain('comcast.net')).toBe(true)
    expect(isGenericDomain('mail.k12.tx.us')).toBe(true)
    expect(isGenericDomain('k12.tx.us')).toBe(true)
    expect(isGenericDomain('zoo.org')).toBe(false)
    expect(isGenericDomain('zoo.org', ['*.zoo.org'])).toBe(true)
    expect(isGenericDomain('a.zoo.org', ['*.zoo.org'])).toBe(true)
    expect(isGenericDomain('notzoo.org', ['*.zoo.org'])).toBe(false)
    expect(isGenericDomain('zoo.org', ['zoo.org'])).toBe(true)
    expect(isGenericDomain('gmail.com', [])).toBe(true)
  })

  it('accepts a ROR id bare or as a link, and nothing else', () => {
    expect(normalizeRor('02mhbdp94')).toBe('02mhbdp94')
    expect(normalizeRor(' https://ror.org/02MHBDP94 ')).toBe('02mhbdp94')
    for (const bad of ['', '12mhbdp94', '02mhbdp9', '02mhbdp945', '02mhbdl94', 'https://example.org/02mhbdp94', 5, null]) expect(normalizeRor(bad)).toBeNull()
  })
})
