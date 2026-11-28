import type { Field, PayloadRequest } from 'payload'

import { idOf } from './helpers.js'
import { ORGANIZATIONS } from './types.js'

export type OrganizationFieldOptions = {
  name?: string
  label?: string
  hasMany?: boolean
  required?: boolean
  /** Only offer, and only accept, organizations of these kinds. Default: every kind. */
  kinds?: string[]
}

/**
 * The picker a host collection adds to point at an organization. It offers only active organizations, of the kinds
 * given, that the editor may read. The server also checks the organization on a new record, duplicates included, and
 * any organization newly chosen on an update: a pending or closed one, or one of another kind, is refused. On an update,
 * an organization that was already chosen and has since closed stays, so old records still save.
 */
export function organizationField(options: OrganizationFieldOptions = {}): Field {
  const kinds = options.kinds
  return {
    name: options.name ?? 'organization',
    type: 'relationship',
    relationTo: ORGANIZATIONS,
    hasMany: options.hasMany ?? false,
    index: true,
    label: options.label ?? 'Organization',
    filterOptions: () => ({ and: [{ status: { equals: 'active' } }, ...(kinds?.length ? [{ kind: { in: kinds } }] : [])] }) as never,
    validate: (async (value: unknown, { req, previousValue, overrideAccess, operation }: { req: PayloadRequest; previousValue?: unknown; overrideAccess?: boolean; operation?: string }) => {
      const ids = (Array.isArray(value) ? value : [value]).map(idOf).filter((x): x is string | number => x !== null)
      if (!ids.length) return options.required ? 'Choose an organization.' : true
      const kept = operation === 'update' ? previousValue : undefined
      const had = new Set((Array.isArray(kept) ? kept : [kept]).map(idOf).filter((x) => x !== null).map(String))
      for (const id of ids) {
        if (had.has(String(id))) continue
        // The editor's own read access applies, so a person can't attach an organization they can't see. Server code that skips access skips this too. Every refusal reads the same, so a stranger learns nothing about an id.
        const org = (await req.payload
          .findByID({ collection: ORGANIZATIONS as never, id, depth: 0, overrideAccess: overrideAccess === true, req })
          .catch(() => null)) as { status?: string; kind?: string } | null
        if (!org || org.status !== 'active') return 'That organization isn’t active.'
        if (kinds?.length && !kinds.includes(org.kind ?? '')) return 'That kind of organization isn’t allowed here.'
      }
      return true
    }) as never,
    admin: { description: 'An active organization. Pick one from the list.' },
  } as unknown as Field
}
