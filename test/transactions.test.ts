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
  for (const p of started) await p.db?.destroy?.()
  await mongo?.stop()
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
})
