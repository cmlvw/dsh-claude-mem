import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dbStats, newEntryId, openMemoryDb, readMeta, SCHEMA_VERSION, schemaVersion, writeMeta } from '../src/db.js'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-claude-mem-db-'))
}

function insertEntry(db, overrides = {}) {
  const now = Date.now()
  const row = {
    id: newEntryId(),
    level: 'fact',
    scope: 'workspace',
    project: 'demo',
    subcategory: null,
    goal: null,
    title: overrides.title ?? '全局库放 D 盘',
    body: overrides.body ?? 'C 盘紧，全局库不要放 C 盘。',
    keywords: overrides.keywords ?? '全局库 D盘 磁盘 存储 路径 配置 记忆',
    importance: 2,
    status: 'active',
    source_session: null,
    source_hash: null,
    created_at: now,
    updated_at: now,
    accessed_at: null,
    inject_count: 0,
    ...overrides,
  }
  db.prepare(
    `INSERT INTO entries(id, level, scope, project, subcategory, goal, title, body, keywords,
      importance, status, source_session, source_hash, created_at, updated_at, accessed_at, inject_count)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.level, row.scope, row.project, row.subcategory, row.goal, row.title, row.body,
    row.keywords, row.importance, row.status, row.source_session, row.source_hash,
    row.created_at, row.updated_at, row.accessed_at, row.inject_count,
  )
  return row
}

test('建库：目录自动创建、schema 版本写入、可重复打开', () => {
  const dir = tmpDir()
  try {
    const path = join(dir, 'nested', 'memory.db')
    const first = openMemoryDb(path)
    assert.equal(first.ok, true)
    assert.equal(first.fts, true)
    assert.equal(schemaVersion(first.db), SCHEMA_VERSION)
    first.db.close()

    const second = openMemoryDb(path)
    assert.equal(second.ok, true)
    assert.equal(second.db.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key='schema_version'`).get().n, 1)
    second.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不可写的库路径返回 ok:false 而不是 throw', () => {
  const res = openMemoryDb(join('\0invalid', 'x.db'))
  assert.equal(res.ok, false)
  assert.equal(typeof res.error, 'string')
})

test('FTS5 trigram：≥3 字中文可命中，含中文子串', () => {
  const dir = tmpDir()
  try {
    const { db } = openMemoryDb(join(dir, 'memory.db'))
    insertEntry(db, { title: '全局库放 D 盘', body: 'C 盘紧，全局库不要放 C 盘' })
    const hits = db.prepare(`SELECT title FROM entries_fts WHERE entries_fts MATCH ?`).all('全局库')
    assert.equal(hits.length, 1)
    const sub = db.prepare(`SELECT title FROM entries_fts WHERE entries_fts MATCH ?`).all('不要放')
    assert.equal(sub.length, 1, 'trigram 支持词中子串')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已知限制：2 字中文词 trigram 命不中（M3 需 LIKE 兜底）', () => {
  const dir = tmpDir()
  try {
    const { db } = openMemoryDb(join(dir, 'memory.db'))
    insertEntry(db, { title: '插件默认 disabled', body: '安装后不启用' })
    const hits = db.prepare(`SELECT title FROM entries_fts WHERE entries_fts MATCH ?`).all('插件')
    assert.equal(hits.length, 0, '若这条变成 1，说明 SQLite 行为变了，M3 可以简化')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FTS 触发器：更新与删除保持同步', () => {
  const dir = tmpDir()
  try {
    const { db } = openMemoryDb(join(dir, 'memory.db'))
    const row = insertEntry(db, { title: '旧标题', body: '旧正文' })
    db.prepare(`UPDATE entries SET title=?, body=? WHERE id=?`).run('新的语义精排决策', '精排默认关闭', row.id)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entries_fts WHERE entries_fts MATCH ?`).get('语义精排').n, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entries_fts WHERE entries_fts MATCH ?`).get('旧正文').n, 0)
    db.prepare(`DELETE FROM entries WHERE id=?`).run(row.id)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entries_fts WHERE entries_fts MATCH ?`).get('语义精排').n, 0)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('meta 读写与 stats', () => {
  const dir = tmpDir()
  try {
    const { db } = openMemoryDb(join(dir, 'memory.db'))
    writeMeta(db, 'last_dream_at', 12345)
    assert.equal(readMeta(db, 'last_dream_at'), '12345')
    assert.equal(readMeta(db, 'missing'), null)
    insertEntry(db)
    const stats = dbStats(db)
    assert.equal(stats.entries, 1)
    assert.equal(stats.schemaVersion, SCHEMA_VERSION)
    assert.equal(stats.quarantine, 0)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enableFts=false 时不建 FTS，表仍可用', () => {
  const dir = tmpDir()
  try {
    const { db, fts } = openMemoryDb(join(dir, 'memory.db'), { enableFts: false })
    assert.equal(fts, false)
    insertEntry(db)
    assert.equal(dbStats(db).entries, 1)
    assert.throws(() => db.prepare(`SELECT * FROM entries_fts LIMIT 1`).get())
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('newEntryId：唯一、格式稳定、时间前缀单调不减', () => {
  const ids = new Set()
  let prevTs = 0
  for (let i = 0; i < 200; i += 1) {
    const id = newEntryId()
    assert.match(id, /^\d{13}-[a-z0-9]{6}$/)
    assert.equal(ids.has(id), false, `重复 id: ${id}`)
    ids.add(id)
    const ts = Number(id.slice(0, 13))
    assert.ok(ts >= prevTs, '时间前缀不该倒退')
    prevTs = ts
  }
})
