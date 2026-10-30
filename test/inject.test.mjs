import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { Config } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import { assembleHits, detectProject, recall, shouldRecall } from '../src/recall.js'
import { collectCore, estimateTokens, renderCore, renderHitBlock } from '../src/inject.js'
import { insertEntry, projectIndexFor } from '../src/store.js'

let tmp
let globalDb
let workspaceDb
const now = Date.UTC(2026, 9, 28, 12, 0, 0)

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-inject-'))
  globalDb = openMemoryDb(join(tmp, 'global.db')).db
  workspaceDb = openMemoryDb(join(tmp, 'workspace.db')).db

  insertEntry(
    globalDb,
    {
      level: 'rules',
      scope: 'global',
      project: '全局',
      body: '写入记忆前先扫敏感信息：token、appSecret、密码一律不写进记忆库。',
      keywords: ['敏感信息', '准则', '密钥'],
      importance: 3,
    },
    now,
  )
  insertEntry(
    globalDb,
    {
      level: 'user',
      scope: 'global',
      project: '全局',
      body: '用户要求改配置前先备份，并把回滚文件的地址先发给他。',
      keywords: ['备份', '回滚', '用户偏好'],
      importance: 3,
    },
    now,
  )
  insertEntry(
    workspaceDb,
    {
      level: 'project',
      scope: 'workspace',
      project: 'projA',
      subcategory: 'decisions',
      title: '注入只给索引',
      body: '注入只灌索引行，正文按需读，避免每轮全量。',
      keywords: ['注入', '索引'],
      importance: 3,
    },
    now,
  )
  insertEntry(
    workspaceDb,
    {
      level: 'project',
      scope: 'workspace',
      project: 'projA',
      subcategory: 'todo',
      title: '下一步做召回评测',
      body: '用 10 条真实 query 评测召回。',
      keywords: ['召回', '评测'],
      importance: 2,
    },
    now,
  )
})

after(() => {
  try {
    globalDb.close()
    workspaceDb.close()
  } catch {}
  rmSync(tmp, { recursive: true, force: true })
})

test('核心块：准则/用户全文 + 项目索引行 + 短 id，顺序稳定', () => {
  const cfg = Config({})
  const core = collectCore({ globalDb, workspaceDb, cfg, project: 'projA', projectDetected: true, now })
  assert.ok(core.text.startsWith('【长期记忆 · 2026-10-28】'), core.text)
  assert.ok(core.text.includes('[准则·'), '缺少准则行')
  assert.ok(core.text.includes('[用户·'), '缺少用户行')
  assert.ok(core.text.includes('项目「projA」· 2 条'), core.text)
  // 决策优先于待办
  const decisionAt = core.text.indexOf('注入只给索引')
  const todoAt = core.text.indexOf('下一步做召回评测')
  assert.ok(decisionAt > 0 && todoAt > decisionAt, core.text)
  assert.equal(core.ids.length, 4)
  // 索引行带 6 位短 id，能撑起 mem_read
  assert.match(core.text, /^- [0-9a-z]{6} \[决策\] /m)
  assert.ok(core.chars <= cfg.inject.firstTurnBudget)
})

test('首轮未识别到项目时只兜底 1 行，不铺满索引（省字数决策 2026-10-28）', () => {
  const cfg = Config({})
  // 不传 project：模拟 detectProject 返回 null，只兜底「最近项目」1 行
  const fallback = collectCore({ globalDb, workspaceDb, cfg, now })
  assert.equal(fallback.projectDetected, false)
  assert.equal(fallback.project, 'projA', '兜底应取最近项目')
  // 只 1 行索引：标题写「显示 1 条」，不该出现第 2 条短 id 行
  assert.ok(fallback.text.includes('（显示 1 条）'), fallback.text)
  const indexLines = fallback.text.split('\n').filter((line) => /^- [0-9a-z]{6} \[/.test(line))
  assert.equal(indexLines.length, 1, '兜底只给 1 行索引')
  // 明确识别到同一项目时应铺满上限（本夹具 projA 只有 2 条，兜底只给 1 条）
  const detected = collectCore({ globalDb, workspaceDb, cfg, project: 'projA', projectDetected: true, now })
  assert.equal(detected.projectDetected, true)
  const detectedLines = detected.text.split('\n').filter((line) => /^- [0-9a-z]{6} \[/.test(line))
  assert.ok(detectedLines.length > indexLines.length, '识别到项目时应比兜底多给索引行')
})

test('预算裁剪：预算不够时丢行而不是超发，丢弃数可观测', () => {
  const core = renderCore({
    coreRows: [
      { id: 'aaaaaa-1', level: 'rules', body: '准则一'.repeat(20), importance: 3, updated_at: now },
      { id: 'bbbbbb-2', level: 'user', body: '用户偏好'.repeat(20), importance: 3, updated_at: now },
    ],
    projectIndex: null,
    budget: 80,
    now,
  })
  assert.ok(core.chars <= 80, String(core.chars))
  assert.ok(core.dropped > 0, '应当有被丢弃的行')
  assert.ok(core.text.length > 0)
})

test('命中块：只对 >1 天的条目附新鲜度告警', () => {
  const recent = renderHitBlock(
    [{ entry: { id: 'x1', level: 'lesson', body: '新教训', updated_at: now - 3600000 }, text: '新教训' }],
    { now },
  )
  assert.ok(!recent.includes('时间点观察'), recent)
  const old = renderHitBlock(
    [{ entry: { id: 'x2', level: 'lesson', body: '旧教训', updated_at: now - 3 * 86400000 }, text: '旧教训' }],
    { now },
  )
  assert.ok(old.includes('时间点观察'), old)
  assert.ok(old.includes('3 天前'))
})

test('规则门：短消息/纯确认不问，触发词/项目名才问', () => {
  const options = { minChars: 4, maxHitsPerSession: 8, injectedCount: 0, projectNames: ['projA'] }
  assert.equal(shouldRecall('好的', options), false)
  assert.equal(shouldRecall('嗯', options), false)
  assert.equal(shouldRecall('继续', options), false)
  assert.equal(shouldRecall('上次说的备份要求是什么', options), true)
  assert.equal(shouldRecall('projA 现在做到哪了', options), true)
  assert.equal(shouldRecall('帮我把这段翻译成英文', options), false)
  assert.equal(shouldRecall('上次说的备份要求是什么', { ...options, injectedCount: 8 }), false)
})

test('项目识别：命中项目名则选中，否则为空', () => {
  assert.equal(detectProject('继续做 projA 的召回', ['projA', 'projB']), 'projA')
  assert.equal(detectProject('随便聊聊', ['projA', 'projB']), null)
})

test('召回：两个库各查一次后合并，已展示的排除', () => {
  insertEntry(
    globalDb,
    {
      level: 'lesson',
      scope: 'global',
      project: '全局',
      body: '召回评测的全局教训：短词要走 LIKE。',
      keywords: ['召回', '评测', 'LIKE'],
      importance: 3,
    },
    now,
  )
  insertEntry(
    workspaceDb,
    {
      level: 'fact',
      scope: 'workspace',
      project: 'projA',
      body: '召回评测的项目事实：10 条 query 先手工标注。',
      keywords: ['召回', '评测', '标注'],
      importance: 2,
    },
    now,
  )
  const hits = recall({ globalDb, workspaceDb, text: '上次说的召回评测怎么做的', topK: 10, now })
  assert.ok(hits.length >= 2, JSON.stringify(hits.map((h) => h.entry.title)))
  const one = hits[0]
  const filtered = recall({
    globalDb,
    workspaceDb,
    text: '上次说的召回评测怎么做的',
    topK: 10,
    now,
    exclude: new Set([one.entry.id]),
  })
  assert.ok(!filtered.some((hit) => hit.entry.id === one.entry.id))
})

test('命中装配：条数与预算双上限', () => {
  const hits = Array.from({ length: 5 }, (_, i) => ({
    entry: { id: `id-${i}`, level: 'fact', body: '正文'.repeat(60), updated_at: now },
    score: 1 - i * 0.1,
  }))
  const assembled = assembleHits(hits, { maxHits: 2, maxCharsPerHit: 180, budget: 1000, now })
  assert.equal(assembled.picked.length, 2)
  const tiny = assembleHits(hits, { maxHits: 2, maxCharsPerHit: 180, budget: 60, now })
  assert.equal(tiny.picked.length, 0, '预算 60 时一条都装不下就不给')
})

test('项目索引投影可直接取单个项目', () => {
  const index = projectIndexFor(workspaceDb, 'projA', { maxRows: 1, now })
  assert.equal(index.name, 'projA')
  assert.ok(index.total >= 2)
  assert.equal(index.entries.length, 1)
})

test('token 粗估只做报告，不参与判断', () => {
  assert.equal(estimateTokens(160), 100)
  assert.equal(estimateTokens(0), 0)
})
