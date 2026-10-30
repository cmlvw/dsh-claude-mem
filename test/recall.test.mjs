import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { openMemoryDb } from '../src/db.js'
import { assembleHits, buildGateTerms, detectProject, matchGateTerms, recall, shouldRecall } from '../src/recall.js'
import { insertEntry } from '../src/store.js'

let tmp
let db

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-recall-'))
  const opened = openMemoryDb(join(tmp, 'memory.db'))
  assert.equal(opened.ok, true, opened.error)
  db = opened.db
  insertEntry(db, {
    level: 'fact',
    scope: 'workspace',
    project: '自有记忆插件',
    title: '全局库默认放 D 盘',
    body: '全局库默认位置不要放 C 盘，改用 D:\\dsh-claude-mem\\global.db。',
    keywords: ['全局库', 'D 盘', 'C 盘紧'],
    importance: 3,
  })
  insertEntry(db, {
    level: 'fact',
    scope: 'workspace',
    project: 'qwen38',
    title: 'KV cache 选 q4_0',
    body: '16GB 显存跑 100K 上下文时选 q4_0 KV，实测 48-49 tok/s。',
    keywords: ['KV', 'q4_0', '100K'],
    importance: 2,
  })
  // 核心层条目：recall 不应该把它当命中返回（它已经整段进核心块）。
  insertEntry(db, {
    level: 'user',
    scope: 'global',
    project: '全局',
    title: '用户偏好实测',
    body: '全局库选默认值之前先实测再定。',
    keywords: ['全局库', '实测'],
    importance: 3,
  })
  insertEntry(db, {
    level: 'fact',
    scope: 'workspace',
    project: '自有记忆插件',
    title: '语义精排默认关',
    body: '语义精排默认关闭，实测后再决定是否打开。',
    keywords: ['语义精排', '默认关'],
    importance: 3,
  })
})

after(() => {
  try {
    db?.close()
  } catch {}
  rmSync(tmp, { recursive: true, force: true })
})

test('Stage 0：信号词、项目名触发；短消息/纯应答/额度用尽不触发', () => {
  assert.equal(shouldRecall('上次说的备份要求是什么'), true)
  assert.equal(shouldRecall('记不记得我们拍板过精排默认关'), true)
  assert.equal(shouldRecall('帮我看下 live-server 的端口'), false)
  assert.equal(shouldRecall('好的'), false)
  assert.equal(shouldRecall('嗯'), false)
  assert.equal(shouldRecall('随便说说'), false)
  assert.equal(shouldRecall('记忆机制改进 现在到哪了', { projectNames: ['记忆机制改进'] }), true)
  assert.equal(shouldRecall('上次说的备份要求是什么', { injectedCount: 8, maxHitsPerSession: 8 }), false)
  assert.equal(shouldRecall('上次说的备份要求是什么', { enabled: false }), false)
  assert.equal(shouldRecall('随便说说随便说说随便说说', { minChars: 99 }), false)
})

test('项目识别：长名字优先命中消息里出现的项目', () => {
  assert.equal(detectProject('记忆机制改进 下一步是什么', ['记忆机制改进', '自有记忆插件']), '记忆机制改进')
  assert.equal(detectProject('看看这个插件的进度', ['自有记忆插件']), null)
})

test('Stage 1：FTS 命中 fact，核心层用户条目不会被当命中返回', () => {
  const hits = recall({ globalDb: null, workspaceDb: db, text: '全局库放哪个盘', topK: 20 })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].entry.title, '全局库默认放 D 盘')
  assert.equal(hits.some((hit) => hit.entry.level === 'user'), false)
})

test('Stage 1：没有命中就返回空数组（零注入的前置条件）', () => {
  assert.deepEqual(recall({ globalDb: null, workspaceDb: db, text: '完全不存在的记忆词条 zzzz', topK: 20 }), [])
})

test('Stage 0 关键词信号：从库里 keywords 生成词表，2 字实体也能触发', () => {
  const terms = buildGateTerms(null, db)
  assert.equal(terms.has('语义精排'), true)
  assert.equal(terms.has('精排'), true)
  assert.equal(terms.has('全局库'), true)
  assert.deepEqual(matchGateTerms('精排默认开还是关', terms).includes('精排'), true)
  assert.equal(shouldRecall('精排默认开还是关', { gateTerms: terms }), true)
  assert.equal(shouldRecall('今天天气怎么样', { gateTerms: terms }), false)
})

test('Stage 1 补充词：整句 trigram 撞不上时，用门控命中的 2 字词补齐', () => {
  const plain = recall({ globalDb: null, workspaceDb: db, text: '精排开还是关', topK: 20 })
  assert.equal(plain.length, 0)
  const withExtra = recall({ globalDb: null, workspaceDb: db, text: '精排开还是关', topK: 20, extraTerms: ['精排'] })
  assert.ok(withExtra.length >= 1)
  assert.equal(withExtra[0].entry.title, '语义精排默认关')
})

test('Stage 1：exclude 生效，已注入过的条目不重复给', () => {
  const first = recall({ globalDb: null, workspaceDb: db, text: '全局库放哪个盘', topK: 20 })
  const exclude = new Set([first[0].entry.id])
  const second = recall({ globalDb: null, workspaceDb: db, text: '全局库放哪个盘', topK: 20, exclude })
  assert.equal(second.some((hit) => hit.entry.id === first[0].entry.id), false)
})

test('Stage 3：预算装配最多两条、单条截断、超预算不 hard failure', () => {
  const entries = [
    { entry: { id: 'a', body: '第一条很短' } },
    { entry: { id: 'b', body: '第二条'.repeat(100) } },
    { entry: { id: 'c', body: '第三条' } },
  ]
  const assembled = assembleHits(entries, { maxHits: 2, maxCharsPerHit: 20, budget: 450 })
  assert.equal(assembled.picked.length, 2)
  assert.equal(assembled.picked[0].entry.id, 'a')
  assert.ok(Array.from(assembled.picked[1].text).length <= 20)
  assert.ok(assembled.used <= 450)
})

test('Stage 3：预算为 0 / 条目过长装不下时一条都不给', () => {
  const entries = [{ entry: { id: 'a', body: '很长'.repeat(100) } }]
  assert.equal(assembleHits(entries, { maxHits: 2, maxCharsPerHit: 180, budget: 20 }).picked.length, 0)
  assert.equal(assembleHits([], { maxHits: 2 }).picked.length, 0)
})
