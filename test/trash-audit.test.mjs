import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createAuditLog } from '../lib/core/audit.js'
import { createTrashStore } from '../lib/core/trash.js'
import { makeTempHome } from './helpers.mjs'

test('trash: allocate → write → list → update → remove', async () => {
  const home = await makeTempHome()
  try {
    const trash = createTrashStore({ rootDir: join(home.root, 'trash'), now: () => 1_000 })
    const { trashId, dir } = await trash.allocate({ sessionId: 'session-abc' })
    assert.match(trashId, /^[0-9a-z]{2,40}-[0-9a-z]{2,20}$/)
    const entry = {
      format: 1, trashId, sessionId: 'session-abc', title: 'T', mode: 'soft', includeMemory: false,
      deletedAt: 1_000, status: 'pending', memory: { adapters: [], total: 0 }, sessionLog: null, catalog: null,
    }
    await trash.write(entry)
    assert.deepEqual(await trash.list(), [])
    await trash.update(trashId, { status: 'trashed' })
    const listed = await trash.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].trashId, trashId)
    assert.equal(listed[0].status, 'trashed')
    assert.equal(await trash.read('not-a-valid-id'), null)
    await trash.remove(trashId)
    assert.equal(await trash.read(trashId), null)
    assert.equal(dir.includes(trashId), true)
  } finally {
    await home.cleanup()
  }
})

test('trash: a malformed manifest is ignored instead of breaking the list', async () => {
  const home = await makeTempHome()
  try {
    const rootDir = join(home.root, 'trash')
    const trash = createTrashStore({ rootDir, now: () => 1_000 })
    const { trashId, dir } = await trash.allocate({ sessionId: 'session-abc' })
    await writeFile(join(dir, 'manifest.json'), '{ not json', 'utf8')
    assert.deepEqual(await trash.list(), [])
  } finally {
    await home.cleanup()
  }
})

test('audit: append + tail, malformed lines counted, compaction keeps the newest lines', async () => {
  const home = await makeTempHome()
  try {
    const filePath = join(home.root, 'audit.jsonl')
    let clock = 1_000
    const audit = createAuditLog({ filePath, maxBytes: 300, retentionLines: 3, now: () => clock })
    for (let index = 0; index < 6; index += 1) {
      clock += 1
      await audit.append({ id: `r${index}`, action: 'delete', result: 'success' })
    }
    const tail = await audit.tail(100)
    assert.ok(tail.records.length <= 4)
    assert.ok(tail.records.every((record) => record.action === 'delete'))
    assert.equal(tail.records[tail.records.length - 1].id, 'r5')
    await writeFile(filePath, `${await readFile(filePath, 'utf8')}\nnot json\n`, 'utf8')
    const after = await audit.tail(100)
    assert.equal(after.malformed, 1)
  } finally {
    await home.cleanup()
  }
})
