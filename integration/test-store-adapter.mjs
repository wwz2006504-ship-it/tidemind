import {fileURLToPath} from 'node:url'
// Step-1 acceptance: the original MemoryStore must be the one deciding
// norm_hash / duplicate / supersede, and only accepted mutations may be committed.
// Everything runs on synthetic databases under data/; the live store is imported
// read-only and <MEMORY_LAYERS_DIR> is never opened.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { decideWithStore, loadLiveStoreClass } from './store-adapter.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

function freshStore(MemoryStore) {
  process.env.TIDEMIND_SANDBOX_ROOT=join(HERE,'..','data')
  process.env.TIDEMIND_STORE_SIGNING_KEY='synthetic-test-signing-key-at-least-32-characters'
  const dir = mkdtempSync(join(HERE, '..', 'data', 'dry-'))
  const store = new MemoryStore(dir)
  store.write({ layer: 'episodic', content: '主人今天吃了半片全麦面包', tags: ['饭'], source: 'tool' })
  store.write({ layer: 'episodic', content: 'rice is a favourite', key: 'rice', source: 'tool' })
  store.close()
  return { dir, dbPath: join(dir, 'memory.db') }
}

test('live plugin store module loads read-only', async () => {
  const { MemoryStore, normHash } = await loadLiveStoreClass()
  assert.equal(typeof MemoryStore, 'function')
  assert.equal(typeof normHash('rice'), 'string')
})

test('new content is accepted by the store', async () => {
  const { MemoryStore } = await loadLiveStoreClass()
  const { dir, dbPath } = freshStore(MemoryStore)
  try {
    const out = await decideWithStore(dbPath, {
      id: 'm-new-1',
      fields: { content: '今天要装潮池 3.0', layer: 'episodic', status: 'active', tags: '["计划"]' }
    }, { MemoryStore })
    assert.equal(out.action, 'accepted')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('same fact twice is a store duplicate, not a second row', async () => {
  const { MemoryStore } = await loadLiveStoreClass()
  const { dir, dbPath } = freshStore(MemoryStore)
  try {
    const out = await decideWithStore(dbPath, {
      id: 'm-dup-1',
      fields: { content: '主人今天吃了半片全麦面包', layer: 'episodic', status: 'active' }
    }, { MemoryStore })
    assert.equal(out.action, 'duplicate')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('same key with new content supersedes the old row', async () => {
  const { MemoryStore } = await loadLiveStoreClass()
  const { dir, dbPath } = freshStore(MemoryStore)
  try {
    const out = await decideWithStore(dbPath, {
      id: 'm-key-1',
      fields: { content: 'rice is first', layer: 'episodic', key: 'rice', status: 'active' }
    }, { MemoryStore })
    assert.equal(out.action, 'accepted')
    // The store retires the old row (status='superseded', superseded_by) and then
    // reports the new row as 'created'. Deterministic replacement stays store-side.
    assert.equal(out.storeResult?.action, 'created')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('empty content is rejected by the store', async () => {
  const { MemoryStore } = await loadLiveStoreClass()
  const { dir, dbPath } = freshStore(MemoryStore)
  try {
    const out = await decideWithStore(dbPath, {
      id: 'm-empty-1',
      fields: { content: '   ', layer: 'episodic', status: 'active' }
    }, { MemoryStore })
    assert.equal(out.action, 'rejected')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unknown field is rejected before the store sees it', async () => {
  const { MemoryStore } = await loadLiveStoreClass()
  const { dir, dbPath } = freshStore(MemoryStore)
  try {
    const out = await decideWithStore(dbPath, {
      id: 'm-bad-1',
      fields: { content: 'x', layer: 'episodic', password: 'nope' }
    }, { MemoryStore })
    assert.equal(out.action, 'rejected')
    assert.match(out.storeNote, /unsupported field/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('decide never mutates the source database', async () => {
  const { MemoryStore } = await loadLiveStoreClass()
  const { dir, dbPath } = freshStore(MemoryStore)
  try {
    const before = new MemoryStore(dir)
    const n1 = before.db.prepare('SELECT COUNT(*) AS c FROM memories').get().c
    before.close()
    await decideWithStore(dbPath, {
      id: 'm-shadow-1',
      fields: { content: '不该写进原库的一条', layer: 'episodic', status: 'active' }
    }, { MemoryStore })
    const after = new MemoryStore(dir)
    const n2 = after.db.prepare('SELECT COUNT(*) AS c FROM memories').get().c
    after.close()
    assert.equal(n1, n2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
