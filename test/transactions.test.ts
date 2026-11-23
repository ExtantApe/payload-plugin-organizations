import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { organizations } from '../src/index.js'

let mongo: MongoMemoryReplSet
const started: Payload[] = []

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
}, 180_000)
afterAll(async () => {
  // Every adapter is closed and the server stopped with its temp folder removed, even if one close throws.
  try {
    for (const p of started) await Promise.resolve(p.db?.destroy?.()).catch(() => undefined)
  } finally {
    await mongo?.stop({ doCleanup: true, force: true })
  }
})

const build = (name: string, transactions: boolean, allow?: boolean) =>
  buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri(name), ...(transactions ? {} : { transactionOptions: false }) }),
    collections: [{ slug: 'users', auth: true, fields: [] }],
    plugins: [organizations({ kinds: [{ value: 'zoo' }], refuseMember: false, allowWithoutTransactions: allow })],
  })

describe('transactions', () => {
  it('starts when the database can run them, and leaves none open', async () => {
    const payload = await getPayload({ config: await build('tx_on', true), key: 'tx-on' })
    started.push(payload)
    const id = await payload.db.beginTransaction()
    expect(id).toBeTruthy()
    await payload.db.rollbackTransaction(id!)
  })

  it('refuses to start when the adapter hands back no transaction', async () => {
    await expect(getPayload({ config: await build('tx_off', false), key: 'tx-off' })).rejects.toThrow(/no transactions/)
  })

  it('starts without them only when the host says so', async () => {
    const payload = await getPayload({ config: await build('tx_allowed', false, true), key: 'tx-allowed' })
    started.push(payload)
    expect(await payload.db.beginTransaction()).toBeNull()
  })

  it('lets guarded writes through when the host says so, and turns the check off for server code that disables the transaction', async () => {
    const payload = await getPayload({ config: await build('tx_writes', false, true), key: 'tx-writes' })
    started.push(payload)
    const made = (await payload.create({ collection: 'organizations' as never, data: { name: 'Made-up Zoo', kind: 'zoo' } as never, overrideAccess: true })) as unknown as { id: string | number }
    expect(made.id).toBeTruthy()
    const again = (await payload.create({ collection: 'organizations' as never, data: { name: 'Second Zoo', kind: 'zoo' } as never, overrideAccess: true, disableTransaction: true })) as unknown as { id: string | number }
    expect(again.id).toBeTruthy()
    const found = await payload.find({ collection: 'organization-events' as never, overrideAccess: true, pagination: false })
    expect(found.docs.filter((d) => (d as { event?: string }).event === 'create')).toHaveLength(2)
  })

  it('refuses to start when allowWithoutTransactions is anything but true, false or unset', async () => {
    for (const bad of ['true', 'yes', 1, 0, null, {}, []]) {
      expect(() => organizations({ kinds: [{ value: 'zoo' }], refuseMember: false, allowWithoutTransactions: bad as never })({ collections: [] } as never)).toThrow(/allowWithoutTransactions.*exactly `true` or `false`/)
    }
    for (const ok of [true, false, undefined]) {
      expect(() => organizations({ kinds: [{ value: 'zoo' }], refuseMember: false, allowWithoutTransactions: ok })({ collections: [] } as never)).not.toThrow()
    }
  })

  it('keeps the guard on for an explicit false', async () => {
    await expect(getPayload({ config: await build('tx_false', false, false), key: 'tx-false' })).rejects.toThrow(/no transactions/)
  })
})
