import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { openMemoryDb } from '../src/db.js'
import {
  buildProjectIndex,
  formatIndexLine,
  getEntry,
  hitInjectionCount,
  injectedIds,
  insertEntry,
  listProjectRows,
  markInjected,
  searchEntries,
  updateEntry,
  upsertEntry,
} from '../src/store.js'
import { ageLabel, needsFreshnessWarning } from '../src/time.js'

let tmp
let db

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-store-'))
  const opened = openMemoryDb(join(tmp, 'memory.db'))
  assert.equal(opened.ok, true, opened.error)
  db = opened.db
})

after(() => {
  try {
    db?.close()
  } catch {}
  rmSync(tmp, { recursive: true, force: true })
})

const now = Date.UTC(2026, 9, 28, 12, 0, 0)

test('插入事实：派生标题、关键词解析、可按 id 取回', () => {
  const entry = insertEntry(
    db,
    {
      level: 'fact',
      scope: 'workspace',
      project: 'projA',
      body: '用户要求改配置前先备份，并把备份路径发给他。',
      keywords: ['备份', '配置', '回滚'],
      importance: 2,
    },
    now,
  )
  assert.ok(entry.id)
  assert.equal(entry.title, '用户要求改配置前先备份，并把备份路径发给他')
  assert.deepEqual(entry.keywords, ['备份', '配置', '回滚'])

  const again = getEntry(db, entry.id)
  assert.equal(again.body, entry.body)
  assert.equal(again.importance, 2)
})

test('去重：相似内容合并成一条，而不是新增', () => {
  const first = insertEntry(
    db,
    {
      level: 'lesson',
      scope: 'workspace',
      project: 'projA',
      body: '插件身份改名要改四处，只改前两处会触发 duplicate factory registration。',
      keywords: ['插件身份', 'duplicate', 'factory'],
      importance: 3,
    },
    now,
  )
  const before = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n
  const result = upsertEntry(
    db,
    {
      level: 'lesson',
      scope: 'workspace',
      project: 'projA',
      body: '插件身份改名要改四处，只改前两处会触发 duplicate factory registration。',
      keywords: ['改名', '四处'],
      importance: 4,
    },
    { dedupThreshold: 0.9 },
    now,
  )
  const after = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n
  assert.equal(result.action, 'merged')
  assert.equal(result.entry.id, first.id)
  assert.equal(before, after)
  assert.equal(result.entry.importance, 4)
  assert.ok(result.entry.keywords.includes('四处'))
})

test('索引投影：决策优先、行数封顶、隐藏数正确', () => {
  const project = 'indexProj'
  const make = (subcategory, title, importance, at) =>
    insertEntry(
      db,
      {
        level: 'project',
        scope: 'workspace',
        project,
        subcategory,
        body: `${title} 的正文`,
        title,
        keywords: ['索引', title],
        importance,
      },
      at,
    )
  make('quotes', '一句原话', 3, now - 1000)
  make('ops', '部署说明', 3, now - 900)
  make('decisions', '关键决策', 1, now - 800)
  make('overview', '项目概述', 2, now - 700)

  const index = buildProjectIndex(db, { maxProjects: 5, maxRows: 3, maxLineChars: 60, now })
  const target = index.projects.find((p) => p.name === project)
  assert.ok(target)
  assert.equal(target.total, 4)
  assert.equal(target.lines.length, 3)
  assert.equal(target.hidden, 1)
  assert.ok(target.lines[0].includes('关键决策'), target.lines.join('|'))
  assert.ok(target.lines[1].includes('项目概述'), target.lines.join('|'))
  // [决策] 标签 + 截断 + 时间标签
  const line = formatIndexLine(
    { level: 'project', subcategory: 'decisions', title: '这是一个非常非常非常非常长非常非常非常非常长的标题超出上限', updated_at: now - 86400000 * 3 },
    { maxLineChars: 30, now },
  )
  assert.ok(line.startsWith('- [决策] '), line)
  assert.ok(Array.from(line).length <= 30, line)
  assert.ok(line.endsWith('（3 天前）'), line)
})

test('召回：3 字中文走 FTS、2 字中文走 LIKE，短词也能命中', () => {
  insertEntry(
    db,
    {
      level: 'fact',
      scope: 'workspace',
      project: 'recallProj',
      body: '记忆插件设计的关键是注入成本可控，不能每轮全量灌。',
      title: '记忆插件设计',
      keywords: ['记忆插件', '注入成本', '召回'],
      importance: 3,
    },
    now,
  )
  insertEntry(
    db,
    {
      level: 'fact',
      scope: 'workspace',
      project: 'recallProj',
      body: '显卡选型：RTX 5070 Ti 16GB，跑 13GB 级模型余量只剩 0.5GB。',
      title: '显卡选型',
      keywords: ['显卡', '5070ti', '显存'],
      importance: 2,
    },
    now,
  )

  const ftsHits = searchEntries(db, '记忆插件', { limit: 5, now })
  assert.ok(ftsHits.length >= 1, 'FTS 未命中')
  assert.equal(ftsHits[0].entry.title, '记忆插件设计')

  const likeHits = searchEntries(db, '显卡', { limit: 5, now })
  assert.ok(likeHits.length >= 1, '短词 LIKE 未命中')
  assert.ok(likeHits.some((hit) => hit.entry.title === '显卡选型'))

  const none = searchEntries(db, '完全不存在的词组合', { limit: 5, now })
  assert.equal(none.length, 0)
})

test('更新正文后 FTS 同步（旧词查不到、新词查得到）', () => {
  const entry = insertEntry(
    db,
    {
      level: 'fact',
      scope: 'workspace',
      project: 'reindexProj',
      body: '旧内容：端口是 8080。',
      title: '端口记录',
      keywords: ['端口'],
    },
    now,
  )
  updateEntry(db, entry.id, { body: '新内容：端口改成 8091。', keywords: ['端口', '8091'] }, now + 1)
  const oldHits = searchEntries(db, '8080', { limit: 5, now })
  const newHits = searchEntries(db, '8091', { limit: 5, now })
  assert.ok(!oldHits.some((hit) => hit.entry.id === entry.id), '旧内容仍在索引里')
  assert.ok(newHits.some((hit) => hit.entry.id === entry.id), '新内容没进索引')
})

test('注入记录：同一会话只记一次，可以回查', () => {
  const ids = listProjectRows(db, 'indexProj').map((e) => e.id)
  assert.ok(ids.length >= 2)
  const first = markInjected(db, 'session-x', ids, 'initial', now)
  const second = markInjected(db, 'session-x', ids, 'hit', now + 1)
  assert.equal(first, ids.length)
  assert.equal(second, 0)
  assert.deepEqual([...injectedIds(db, 'session-x')].sort(), [...ids].sort())

  // 命中额度只数 hit，不被 initial 吃光
  markInjected(db, 'session-y', ['h1', 'h2'], 'hit', now)
  markInjected(db, 'session-y', ['h1'], 'hit', now + 1)
  assert.equal(hitInjectionCount(db, 'session-y'), 2)
  assert.equal(hitInjectionCount(db, 'session-x'), 0)
})

test('时间标签：刚刚/分钟/小时/昨天/天，>1 天才告警', () => {
  assert.equal(ageLabel(now - 10 * 1000, now), '刚刚')
  assert.equal(ageLabel(now - 5 * 60000, now), '5 分钟前')
  assert.equal(ageLabel(now - 3 * 3600000, now), '3 小时前')
  assert.equal(ageLabel(now - 30 * 3600000, now), '昨天')
  assert.equal(ageLabel(now - 3 * 86400000, now), '3 天前')
  assert.equal(needsFreshnessWarning(now - 3600000, now), false)
  assert.equal(needsFreshnessWarning(now - 2 * 86400000, now), true)
})
