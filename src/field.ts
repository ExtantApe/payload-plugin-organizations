import type { Field } from 'payload'

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
 * given, that the editor may read. The server also checks any organization that is newly chosen: a pending or closed
 * one, or one of another kind, is refused. An organization that was already chosen and has since closed stays, so old
 * records still save.
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
    validate: (async (value: unknown, { req, previousValue }: { req: { payload: { findByID: Function } }; previousValue?: unknown }) => {
      const ids = (Array.isArray(value) ? value : [value]).map(idOf).filter((x): x is string | number => x !== null)
      if (!ids.length) return options.required ? 'Choose an organization.' : true
      const had = new Set((Array.isArray(previousValue) ? previousValue : [previousValue]).map(idOf).filter((x) => x !== null).map(String))
      for (const id of ids) {
        if (had.has(String(id))) continue
        const org = (await req.payload.findByID({ collection: ORGANIZATIONS, id, depth: 0, overrideAccess: true }).catch(() => null)) as { status?: string; kind?: string } | null
        if (!org || org.status !== 'active') return 'That organization isn’t active.'
        if (kinds?.length && !kinds.includes(org.kind ?? '')) return 'That kind of organization isn’t allowed here.'
      }
      return true
    }) as never,
    admin: { description: 'An active organization. Pick one from the list.' },
  } as unknown as Field
}
