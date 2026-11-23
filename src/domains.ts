import { domainToASCII } from 'node:url'
import type { Payload, PayloadRequest } from 'payload'

import { settings } from './helpers.js'
import { ORGANIZATIONS, type Resolved } from './types.js'

/**
 * Domains that say nothing about where someone works: public mail, ISPs and schools. None can be put on an
 * organization, and none ever suggests one. The host can add to this list, never take from it. An entry starting with
 * `*.` covers the domain and everything under it.
 */
export const GENERIC_DOMAINS: readonly string[] = [
  // public mail
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.com.au', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.com', 'fastmail.com', 'fastmail.fm', 'zoho.com', 'gmx.com',
  'gmx.net', 'gmx.de', 'web.de', 'mail.com', 'mail.ru', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com',
  'hey.com', 'duck.com', 'hushmail.com',
  // internet providers
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net',
  'optonline.net', 'frontier.com', 'centurylink.net', 'windstream.net', 'rr.com', 'roadrunner.com', 'shaw.ca', 'rogers.com',
  'bell.net', 'sympatico.ca', 'telus.net', 'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net', 'orange.fr',
  'free.fr', 'wanadoo.fr', 't-online.de', 'bigpond.com', 'optusnet.com.au', 'xtra.co.nz',
  // schools (districts and school networks; universities are set up by hand)
  '*.k12.al.us', '*.k12.ak.us', '*.k12.az.us', '*.k12.ar.us', '*.k12.ca.us', '*.k12.co.us', '*.k12.ct.us', '*.k12.de.us',
  '*.k12.fl.us', '*.k12.ga.us', '*.k12.hi.us', '*.k12.id.us', '*.k12.il.us', '*.k12.in.us', '*.k12.ia.us', '*.k12.ks.us',
  '*.k12.ky.us', '*.k12.la.us', '*.k12.me.us', '*.k12.md.us', '*.k12.ma.us', '*.k12.mi.us', '*.k12.mn.us', '*.k12.ms.us',
  '*.k12.mo.us', '*.k12.mt.us', '*.k12.ne.us', '*.k12.nv.us', '*.k12.nh.us', '*.k12.nj.us', '*.k12.nm.us', '*.k12.ny.us',
  '*.k12.nc.us', '*.k12.nd.us', '*.k12.oh.us', '*.k12.ok.us', '*.k12.or.us', '*.k12.pa.us', '*.k12.ri.us', '*.k12.sc.us',
  '*.k12.sd.us', '*.k12.tn.us', '*.k12.tx.us', '*.k12.ut.us', '*.k12.vt.us', '*.k12.va.us', '*.k12.wa.us', '*.k12.wv.us',
  '*.k12.wi.us', '*.k12.wy.us', '*.sch.uk', '*.school.nz', '*.schools.nsw.edu.au', '*.vic.edu.au',
]

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** A tidy lowercase ASCII domain, or null if the text isn't a plausible domain (it needs at least two labels, and can't hold a path, a port or an `@`). */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let d = input.trim().toLowerCase()
  if (d.startsWith('@')) d = d.slice(1)
  if (d.endsWith('.')) d = d.slice(0, -1)
  if (!d || /[\s/\\:@?#]/.test(d)) return null
  const ascii = domainToASCII(d)
  if (!ascii || ascii.length > 253) return null
  const labels = ascii.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels[labels.length - 1]!)) return null
  return ascii
}

/** The domain of an email address, normalized, or null. */
export function domainOf(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const at = email.lastIndexOf('@')
  return at < 1 ? null : normalizeDomain(email.slice(at + 1))
}

/** Whether a domain is on the shipped list or the host's additions. */
export function isGenericDomain(domain: string, extra: readonly string[] = []): boolean {
  const d = normalizeDomain(domain)
  if (!d) return false
  for (const raw of [...GENERIC_DOMAINS, ...extra]) {
    const entry = raw.trim().toLowerCase()
    if (entry.startsWith('*.')) {
      const base = entry.slice(2)
      if (d === base || d.endsWith(`.${base}`)) return true
    } else if (d === entry) return true
  }
  return false
}

/** The domain and every parent with at least two labels: `a.b.zoo.org` gives `a.b.zoo.org`, `b.zoo.org`, `zoo.org`. */
const withParents = (d: string) => {
  const labels = d.split('.')
  const out: string[] = []
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'))
  return out
}

export type DomainMatch = { id: string | number; name: string; kind: string; domain: string }

/**
 * Organizations an email address suggests. This is a hint and nothing more: it never adds a membership or grants
 * anything, the host decides what to do with it, and a minor's address must not be passed in (a minor never joins an
 * organization). It finds only active organizations. Public mail, school and ISP domains match nothing. A kind listed
 * in `rorRequiredKinds` matches only once it has a ROR id. A listed domain also matches its subdomains. It reads
 * without access rules, so call it from server code and show the result only to the person it is about.
 */
export async function matchOrganizations(from: Payload | Pick<PayloadRequest, 'payload'>, email: string): Promise<DomainMatch[]> {
  const payload = 'payload' in from ? from.payload : from
  const s = settings({ payload })
  const domain = domainOf(email)
  if (!domain || isGenericDomain(domain, s.genericDomains)) return []
  const candidates = withParents(domain)
  const found = await payload.find({
    collection: ORGANIZATIONS as never,
    where: { and: [{ status: { equals: 'active' } }, { domains: { in: candidates } }] } as never,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  const out: DomainMatch[] = []
  for (const o of found.docs as unknown as { id: string | number; name: string; kind: string; rorId?: string | null; domains?: string[] }[]) {
    if (s.rorRequiredKinds.includes(o.kind) && !o.rorId) continue
    const hit = candidates.find((c) => (o.domains ?? []).includes(c))
    if (hit) out.push({ id: o.id, name: o.name, kind: o.kind, domain: hit })
  }
  return out
}

export type { Resolved }
