// Step-1 end-to-end: store decides first, authority commits second.
// Uses only synthetic directories under data/; no live database and no network port.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { loadLiveStoreClass, storeThenCommit } from './store-adapter.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PKG = join(HERE, '..', 'TideMind', 'deploy', 'existing')

async function boot() {
  const root = mkdtempSync(join(HERE, '..', 'data', 'e2e-'))
  const sandbox = root
  mkdirSync(sandbox, { recursive: true })
  const leaseDb = join(sandbox, 'lease.db')
  const memDir = join(root, 'memory')
  mkdirSync(memDir, { recursive: true })

  process.env.TIDEMIND_SANDBOX_ROOT = sandbox
  process.env.TIDEMIND_LEASE_DB = leaseDb

  const leaseMod = await import(pathToFileURL(join(PKG, 'lease.mjs')).href)
  const gateway = await import(pathToFileURL(join(PKG, 'tide-gateway.mjs')).href)
  // lease.mjs freezes its default database path at import time, so every entry is
  // pinned to this test's own isolated database instead.
  const lease = {
    openAuthority: () => leaseMod.openAuthority(leaseDb),
    acquire: (h, o = {}) => leaseMod.acquire(h, { file: leaseDb, ...o }),
    renew: (h, t, o = {}) => leaseMod.renew(h, t, { file: leaseDb, ...o }),
    release: (h, t, o = {}) => leaseMod.release(h, t, { file: leaseDb, ...o }),
    status: () => leaseMod.status(leaseDb),
    fenced: (h, t, cb, o = {}) => leaseMod.fenced(h, t, cb, { file: leaseDb, ...o })
  }


  process.env.TIDEMIND_STORE_SIGNING_KEY='synthetic-test-signing-key-at-least-32-characters'
  process.env.TIDEMIND_REQUIRE_STORE_PROOF='1'
  const { MemoryStore } = await loadLiveStoreClass()
  const store = new MemoryStore(memDir)
  store.write({ layer: 'episodic', content: '老爹今天吃了半片全麦面包', source: 'tool' })
  store.close()
  const replica=await import('../TideMind/deploy/existing/tide-replica.mjs')
  replica.initializeReplica(join(memDir,'memory.db'))
  gateway.initialize(lease,{protectedIds:[],baseline:replica.replicaHead(join(memDir,'memory.db'))})

  return { root, lease, gateway, memDir, dbPath: join(memDir, 'memory.db'), MemoryStore }
}

test('duplicate refresh keeps one row and preserves original-store result', async () => {
  const env = await boot()
  try {
    const got = env.lease.acquire('local', { ttl: 60000 })
    assert.equal(got.ok, true)
    const out = await storeThenCommit({
      gateway: env.gateway,
      lease: env.lease,
      holder: 'local',
      term: got.term,
      srcDbPath: env.dbPath,
      op: 'step1-dup',
      expectedRevision: 0,
      expectedHash: 'GENESIS',
      mutation: {
        id: 'm-step1-dup',
        fields: { content: '老爹今天吃了半片全麦面包', layer: 'episodic', status: 'active' }
      }
    })
    assert.ok(['store','materialized'].includes(out.stage))
    assert.equal(out.decision.action, 'duplicate')
    const head = env.gateway.head(env.lease)
    assert.ok(head.revision<=1)
    const check=new env.MemoryStore(env.memDir)
    assert.equal(check.db.prepare("SELECT count(*) n FROM memories WHERE layer='episodic'").get().n,1)
    check.close()
  } finally { rmSync(env.root, { recursive: true, force: true }) }
})

test('store accepts new content, then the authority commits exactly once', async () => {
  const env = await boot()
  try {
    const got = env.lease.acquire('local', { ttl: 60000 })
    const mutation = {
      id: 'm-step1-new',
      fields: { content: '今天要装潮池 3.0 的第一步', layer: 'episodic', status: 'active', tags: '["计划"]' }
    }
    const out = await storeThenCommit({
      gateway: env.gateway, lease: env.lease, holder: 'local', term: got.term,
      srcDbPath: env.dbPath, op: 'step1-new',
      expectedRevision: 0, expectedHash: 'GENESIS', mutation
    })
    assert.equal(out.committed, true)
    assert.equal(out.decision.action, 'accepted')
    assert.equal(out.committed_result.revision, 1)
    assert.equal(out.committed_result.replayed, false)
    assert.equal(env.gateway.head(env.lease).revision, 1)
  } finally { rmSync(env.root, { recursive: true, force: true }) }
})

test('expired lease blocks the authority even when the store would accept', async () => {
  const env = await boot()
  try {
    const got = env.lease.acquire('local', { ttl: 100 })
    await new Promise((r) => setTimeout(r, 300))
    await assert.rejects(async () => storeThenCommit({
      gateway: env.gateway, lease: env.lease, holder: 'local', term: got.term,
      srcDbPath: env.dbPath, op: 'step1-expired',
      expectedRevision: 0, expectedHash: 'GENESIS',
      mutation: { id: 'm-step1-exp', fields: { content: '租约过期后不该写进去', layer: 'episodic' } }
    }))
    assert.equal(env.gateway.head(env.lease).revision, 0)
  } finally { rmSync(env.root, { recursive: true, force: true }) }
})
