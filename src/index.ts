import type { Config, Plugin } from 'payload'

/**
 * Organizations for Payload. A skeleton for now: the collection, importers, picker, suggestions and domain hint land in
 * their own pull requests. Access is always the host's to pass in; nothing here grants anything by default.
 */
export type OrganizationsOptions = {
  /** Turn the plugin off without removing it. Default true. */
  enabled?: boolean
}

export const organizations =
  (options: OrganizationsOptions = {}): Plugin =>
  (config: Config): Config => {
    if (options.enabled === false) return config
    return config
  }
