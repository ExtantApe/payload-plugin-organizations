import { APIError } from 'payload'
import type { CollectionBeforeChangeHook, CollectionBeforeOperationHook, CollectionConfig, GlobalBeforeChangeHook, GlobalBeforeOperationHook, GlobalConfig, Payload } from 'payload'

export const BAD_KEY_MESSAGE = 'Field names in a save can’t start with a dollar sign or contain a dot. Send each field by its plain name.'

/** Whether a key isn't a plain field name. */
export const badKey = (k: string) => k.startsWith('$') || k.includes('.') || k.includes('\u0000')

const refusal = () => new APIError(BAD_KEY_MESSAGE, 400, undefined, true)

/**
 * Throws when a save's data has a top-level key that isn't a plain field name, or isn't an object. Missing data is
 * left to Payload.
 */
export function refuseBadKeys(data: unknown): void {
  if (data === undefined || data === null) return
  if (typeof data !== 'object' || Array.isArray(data)) throw refusal()
  for (const k of Object.keys(data)) if (badKey(k)) throw refusal()
}

const WRITES = new Set(['create', 'update', 'updateByID'])

/** Marks the guard's own hooks so the start-up pass can find them. */
const GUARD = Symbol.for('payload-plugin-organizations:key-guard')
const mark = <T extends object>(fn: T): T => Object.assign(fn, { [GUARD]: true })
const isGuard = (fn: unknown) => typeof fn === 'function' && (fn as unknown as Record<symbol, unknown>)[GUARD] === true

/**
 * Runs first in `beforeOperation`. Covers create, duplicate, and update by id and in bulk, for every caller, server
 * code with `overrideAccess` too.
 */
export const collectionKeyGuard: CollectionBeforeOperationHook = mark(({ args, operation }) => {
  if (WRITES.has(operation)) refuseBadKeys((args as { data?: unknown }).data)
  return args
})

/** The same check, placed last in `beforeChange`. */
export const collectionChangeGuard: CollectionBeforeChangeHook = mark(({ data }) => {
  refuseBadKeys(data)
  return data
})

export const globalKeyGuard: GlobalBeforeOperationHook = mark(({ args, operation }) => {
  if (operation === 'update') refuseBadKeys((args as { data?: unknown }).data)
  return args
})

/** The same check for globals, placed last in `beforeChange`. */
export const globalChangeGuard: GlobalBeforeChangeHook = mark(({ data }) => {
  refuseBadKeys(data)
  return data
})

type Hooks = { beforeOperation?: unknown[]; beforeChange?: unknown[] }

/** Puts the first check at the front of `beforeOperation` and the last one at the end of `beforeChange`, once each. */
function place(hooks: Hooks, first: unknown, last: unknown): Hooks {
  const before = (hooks.beforeOperation ?? []).filter((h) => !isGuard(h))
  const change = (hooks.beforeChange ?? []).filter((h) => !isGuard(h))
  return { ...hooks, beforeOperation: [first, ...before], beforeChange: [...change, last] }
}

export const guardCollection = (c: CollectionConfig): CollectionConfig => ({ ...c, hooks: place((c.hooks ?? {}) as Hooks, collectionKeyGuard, collectionChangeGuard) as CollectionConfig['hooks'] })
export const guardGlobal = (g: GlobalConfig): GlobalConfig => ({ ...g, hooks: place((g.hooks ?? {}) as Hooks, globalKeyGuard, globalChangeGuard) as GlobalConfig['hooks'] })

/**
 * Run at start-up. Places the guard on every collection and global, first in `beforeOperation` and last in
 * `beforeChange`.
 */
export function placeEverywhere(payload: Payload) {
  const collections = Object.values(payload.collections ?? {}).map((c) => c.config as unknown as { hooks?: Hooks })
  const globals = (payload.config.globals ?? []) as unknown as { hooks?: Hooks }[]
  for (const c of collections) {
    const next = place(c.hooks ?? {}, collectionKeyGuard, collectionChangeGuard)
    c.hooks ??= {}
    c.hooks.beforeOperation = next.beforeOperation
    c.hooks.beforeChange = next.beforeChange
  }
  for (const g of globals) {
    const next = place(g.hooks ?? {}, globalKeyGuard, globalChangeGuard)
    g.hooks ??= {}
    g.hooks.beforeOperation = next.beforeOperation
    g.hooks.beforeChange = next.beforeChange
  }
}
