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

test('audit: tail keeps the first window line when the byte boundary lands on a newline', async () => {
  // The 256KB window in tail() used to unconditionally drop rawLines[0] on a
  // start>0 read, assuming the window began mid-line. When the boundary
  // happened to align with a newline, the first complete record was lost.
  // tailWindowBytes is injectable so this test can drive the exact byte
  // layout without writing hundreds of kilobytes to disk.
  const home = await makeTempHome()
  try {
    const filePath = join(home.root, 'audit.jsonl')
    const records = [
      { id: 'before-window', action: 'delete', result: 'success' },
      { id: 'first-on-boundary', action: 'restore', result: 'success' },
      { id: 'second', action: 'purge', result: 'success' },
      { id: 'last', action: 'delete', result: 'success' },
    ]
    const body = records.map((record) => `${JSON.stringify(record)}\n`).join('')
    await writeFile(filePath, body, 'utf8')
    const total = Buffer.byteLength(body, 'utf8')

    // A window that starts at the last three lines' combined length means the
    // byte at `start-1` is the `\n` after `before-window`: the tail must keep
    // `first-on-boundary` intact.
    const tailThree = Buffer.byteLength(records.slice(1).map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8')
    const boundaryAudit = createAuditLog({ filePath, tailWindowBytes: tailThree })
    assert.equal(total - tailThree, Buffer.byteLength(`${JSON.stringify(records[0])}\n`, 'utf8'))
    const boundary = await boundaryAudit.tail(50)
    const boundaryIds = boundary.records.map((record) => record.id)
    assert.deepEqual(boundaryIds, ['first-on-boundary', 'second', 'last'])
    assert.equal(boundary.malformed, 0)

    // Contrast: a window one byte smaller starts mid-line inside
    // `first-on-boundary`; the fragment must be dropped and only the two
    // complete trailing records returned.
    const midLineAudit = createAuditLog({ filePath, tailWindowBytes: tailThree - 1 })
    const midLine = await midLineAudit.tail(50)
    const midLineIds = midLine.records.map((record) => record.id)
    assert.deepEqual(midLineIds, ['second', 'last'])
    assert.equal(midLine.malformed, 0)
  } finally {
    await home.cleanup()
  }
})

test('trash: a manifest whose session id could escape the workspace is unreadable', async () => {
  const home = await makeTempHome()
  try {
    const trash = createTrashStore({ rootDir: join(home.root, 'trash'), now: () => 1_000 })
    const { trashId, dir } = await trash.allocate({ sessionId: 'session-abc' })
    const entry = {
      format: 1, trashId, sessionId: 'session-abc', title: 'T', mode: 'soft', includeMemory: false,
      deletedAt: 1_000, status: 'trashed', memory: { adapters: [], total: 0 }, sessionLog: null, catalog: null,
    }
    await trash.write(entry)
    assert.equal((await trash.list()).length, 1)

    const manifestPath = join(dir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.sessionId = '../../etc'
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    // The id is joined into a workspace path during purge; a hand-edited
    // manifest must not be able to point the janitor somewhere else.
    assert.deepEqual(await trash.list(), [])
    assert.equal(await trash.read(trashId), null)
  } finally {
    await home.cleanup()
  }
})
