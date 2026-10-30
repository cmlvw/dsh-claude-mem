import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, test } from 'node:test'

import { migrate } from '../src/migrate.js'

let tmp
let sourcePath
let globalDbPath
let workspaceDbPath

const COLUMNS = `
  id TEXT PRIMARY KEY, title TEXT, content TEXT, importance INTEGER, keywords TEXT,
  status TEXT, source_session TEXT, hit_count INTEGER, created_at INTEGER,
  updated_at INTEGER, last_accessed_at INTEGER, project TEXT, subcategory TEXT,
  goal TEXT, corrected INTEGER
`

function createFakeMeowDb(path) {
  const db = new DatabaseSync(path)
  for (const table of ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']) {
    db.exec(`CREATE TABLE ${table} (${COLUMNS})`)
  }
  const insert = (table, row) => {
    db.prepare(
      `INSERT INTO ${table} (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at, project, subcategory, goal, corrected)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.title ?? null,
      row.content,
      row.importance ?? 2,
      JSON.stringify(row.keywords ?? ['关键词']),
      row.status ?? 'active',
      row.source_session ?? null,
      row.created_at ?? 1_790_000_000_000,
      row.updated_at ?? 1_790_000_000_000,
      row.last_accessed_at ?? null,
      row.project ?? null,
      row.subcategory ?? null,
      row.goal ?? null,
      row.corrected ?? null,
    )
  }

  insert('soul', { id: 's1', content: '我是这个会话里的助手。', keywords: ['自我'] })
  insert('user', { id: 'u1', content: '用户要求改配置前先备份。', keywords: ['备份', '用户偏好'] })
  insert('rules', { id: 'r1', content: '设计原则：可以从代码查到的内容不要写进记忆。', keywords: ['设计原则', '信息边界'] })
  insert('fact', { id: 'f1', content: '全局事实：本机推理走本地千问。', keywords: ['本地模型'], project: '全局' })
  insert('fact', { id: 'f2', content: '项目事实：注入只灌索引不灌正文。', keywords: ['索引', '注入'], project: 'projA' })
  insert('fact', { id: 'f2-dup', content: '项目事实：注入只灌索引不灌正文。', keywords: ['索引', '注入'], project: 'projA' })
  insert('lesson', {
    id: 'l1',
    content: '教训：只改前两处身份会触发 duplicate factory registration。',
    keywords: ['教训', '插件身份'],
    project: 'projA',
    corrected: 1,
  })
  insert('project', { id: 'p1', content: '项目概述正文。', title: '项目概述', keywords: ['概述'], project: 'projA', subcategory: 'decisions' })
  insert('topic', { id: 't1', content: '话题正文：召回还在评测。', keywords: ['话题'], project: 'projA', goal: '把召回做准' })
  insert('fact', {
    id: 'f3-secret',
    content: '这条带密钥：appSecret: UVWYadgkotz5CJRZir1BMYkxAOcr6Mct',
    keywords: ['密钥'],
    project: 'projA',
  })
  db.close()
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-migrate-'))
  sourcePath = join(tmp, 'meow.db')
  createFakeMeowDb(sourcePath)
  globalDbPath = join(tmp, 'global.db')
  workspaceDbPath = join(tmp, 'ws', '.dsh-claude-mem', 'memory.db')
})

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

test('dry-run：只统计不落盘，密钥进隔离、重复被识别', () => {
  const report = migrate({ sourcePath, globalDbPath, workspaceDbPath, dryRun: true })
  assert.equal(report.totals.rows, 10)
  assert.equal(report.totals.quarantined, 1, JSON.stringify(report.byLevel))
  assert.equal(report.totals.duplicates, 1)
  assert.equal(report.totals.imported, 8)
  assert.equal(report.byLevel.fact.rows, 4)
  assert.equal(report.byLevel.fact.quarantined, 1)
  assert.equal(report.byLevel.fact.duplicates, 1)
  assert.ok(report.quarantine[0].reason.includes('secret-assignment'), report.quarantine[0].reason)
  assert.ok(!report.quarantine[0].excerpt.includes('UVWYadgkotz5CJRZir1BMYkxAOcr6Mct'), '隔离样本不应回显密钥')
  assert.equal(existsSync(globalDbPath), false, 'dry-run 不应创建全局库')
  assert.equal(existsSync(workspaceDbPath), false, 'dry-run 不应创建工作区库')
})

test('apply：按层路由到两个库，密钥不落库、只在 quarantine 留痕', () => {
  const report = migrate({ sourcePath, globalDbPath, workspaceDbPath, dryRun: false })
  assert.equal(report.applied, true)
  assert.equal(report.totals.imported, 8)

  const global = new DatabaseSync(globalDbPath, { readOnly: true })
  const workspace = new DatabaseSync(workspaceDbPath, { readOnly: true })
  try {
    const globalCount = global.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n
    const workspaceCount = workspace.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n
    assert.equal(globalCount, 4, '全局库应有 soul/user/rules/全局 fact')
    assert.equal(workspaceCount, 4, '工作区库应有 fact/lesson/project/topic')

    const leaked = workspace.prepare(`SELECT COUNT(*) AS n FROM entries WHERE body LIKE '%UVWYadgkotz5CJRZir1BMYkxAOcr6Mct%'`).get().n
    assert.equal(leaked, 0, '密钥不应进 entries')
    const quarantined = workspace.prepare(`SELECT COUNT(*) AS n FROM quarantine`).get().n
    assert.equal(quarantined, 1)
    const quarantinedGlobal = global.prepare(`SELECT COUNT(*) AS n FROM quarantine`).get().n
    assert.equal(quarantinedGlobal, 0)

    const levels = global.prepare(`SELECT DISTINCT level FROM entries ORDER BY level`).all().map((row) => row.level)
    assert.deepEqual(levels, ['fact', 'rules', 'soul', 'user'])
  } finally {
    global.close()
    workspace.close()
  }
})

test('重复执行幂等：第二次 apply 一条不新增', () => {
  const report = migrate({ sourcePath, globalDbPath, workspaceDbPath, dryRun: false })
  assert.equal(report.totals.imported, 0)
  assert.equal(report.totals.duplicates, 9)
  const workspace = new DatabaseSync(workspaceDbPath, { readOnly: true })
  try {
    assert.equal(workspace.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n, 4)
  } finally {
    workspace.close()
  }
})
