import type { Config, Plugin } from 'payload'

import { eventsCollection, membersCollection } from './members.js'
import { organizationsCollection } from './organizations.js'
import type { OrganizationsOptions, Resolved } from './types.js'

export { GENERIC_DOMAINS, domainOf, isGenericDomain, matchOrganizations, normalizeDomain, type DomainMatch } from './domains.js'
export { organizationField, type OrganizationFieldOptions } from './field.js'
export { levelIn, organizationsOf } from './helpers.js'
export { normalizeRor } from './organizations.js'
export * from './types.js'

/**
 * Organizations for Payload. Three collections: `organizations`, `organization-members` and the append-only
 * `organization-events`. An organization is a place people work or belong; people join at Coordinator, Member or Viewer.
 * The plugin knows nothing about the host's records or rules. The host passes its rules as hooks, and with no hooks
 * nobody can do anything. Each hook allows only on an exact `true`.
 */
export const organizations =
  (options: OrganizationsOptions): Plugin =>
  (config: Config): Config => {
    if (options.enabled === false) return config
    if (options.refuseMember === undefined)
      throw new Error('payload-plugin-organizations: pass `refuseMember`, a function that vetoes a member, or `refuseMember: false` to say there is none')
    const users = options.users ?? config.admin?.user ?? 'users'
    const kinds = options.kinds ?? []
    const resolved: Resolved = {
      users,
      kinds,
      rorRequiredKinds: options.rorRequiredKinds ?? [],
      genericDomains: options.genericDomains ?? [],
    }
    return {
      ...config,
      custom: { ...config.custom, organizations: resolved },
      collections: [...(config.collections ?? []), organizationsCollection(resolved, options), membersCollection(resolved, options), eventsCollection(resolved, options)],
    }
  }
