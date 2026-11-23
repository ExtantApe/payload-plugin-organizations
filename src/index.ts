import type { Config, Payload, Plugin } from 'payload'

import { eventsCollection, membersCollection } from './members.js'
import { organizationsCollection } from './organizations.js'
import type { OrganizationsOptions, Resolved } from './types.js'

export { GENERIC_DOMAINS, domainOf, isGenericDomain, isPublicSuffix, matchOrganizations, normalizeDomain, type DomainMatch } from './domains.js'
export { organizationField, type OrganizationFieldOptions } from './field.js'
export { levelIn, organizationsOf } from './helpers.js'
export { normalizeRor } from './organizations.js'
export * from './types.js'

/**
 * Opens and rolls back one transaction. A database adapter that can't run them (db-mongodb with `transactionOptions:
 * false`, or a standalone MongoDB) hands back nothing, and the plugin's guards would then run without protection.
 */
async function checkTransactions(payload: Payload, allow: boolean) {
  const id = await payload.db.beginTransaction().catch(() => null)
  if (id === null || id === undefined) {
    if (allow) {
      payload.logger.warn('payload-plugin-organizations: this database has no transactions. The last-Coordinator guard and history rows are not atomic.')
      return
    }
    throw new Error('payload-plugin-organizations: the database adapter has no transactions, so the plugin refuses to run. Use a replica set, or pass `allowWithoutTransactions: true` if you accept that risk.')
  }
  await payload.db.rollbackTransaction(id)
}

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
    if (typeof options.refuseMember !== 'function' && options.refuseMember !== false)
      throw new Error('payload-plugin-organizations: pass `refuseMember`, a function that vetoes a member, or exactly `refuseMember: false` to say there is none')
    const users = options.users ?? config.admin?.user ?? 'users'
    const kinds = options.kinds ?? []
    const resolved: Resolved = {
      users,
      kinds,
      rorRequiredKinds: options.rorRequiredKinds ?? [],
      genericDomains: options.genericDomains ?? [],
      refuseMember: options.refuseMember,
      needsTransactions: options.allowWithoutTransactions !== true,
    }
    return {
      ...config,
      custom: { ...config.custom, organizations: resolved },
      onInit: async (payload) => {
        await config.onInit?.(payload)
        await checkTransactions(payload, options.allowWithoutTransactions === true)
      },
      collections: [...(config.collections ?? []), organizationsCollection(resolved, options), membersCollection(resolved, options), eventsCollection(resolved, options)],
    }
  }
