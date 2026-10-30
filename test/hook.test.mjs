import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { apply } from '../src/index.js'
import { openMemoryDb } from '../src/db.js'
import { injectedIds, insertEntry } from '../src/store.js'

let tmp
let status
let hooks
let workspace

function fakeCtx() {
  const map = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) {
      map.set(event, handler)
      return () => map.delete(event)
    },
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return { section: () => () => {} }
    },
    tools: { register: () => () => {} },
    effect: (callback) => {
      callback()
      return () => {}
    },
  }
  return { ctx, map }
}

function makeDecision(text, sessionId, origin = 'root') {
  return {
    kind: 'enter',
    messages: [
      {
        id: 'u1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      },
    ],
    agent: { session: { header: { id: sessionId, cwd: workspace, origin } } },
  }
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-hook-'))
  workspace = join(tmp, 'ws')
  const fake = fakeCtx()
  hooks = fake.map
  status = await apply(fake.ctx, { globalDbPath: join(tmp, 'global.db') })

  const global = openMemoryDb(join(tmp, 'global.db')).db
  insertEntry(global, {
    level: 'rules',
    scope: 'global',
    project: '全局',
    body: '先备份再改配置。',
    keywords: ['备份', '准则'],
    importance: 3,
  })
  // 全局教训不进核心块（核心只放 soul/user/rules），只能靠命中召回。
  insertEntry(global, {
    level: 'lesson',
    scope: 'global',
    project: '全局',
    body: '上次备份演练的教训：回滚脚本要先跑一次 dry-run。',
    keywords: ['备份', '回滚', 'dry-run'],
    importance: 3,
  })
  global.close()

  const wsDb = openMemoryDb(join(workspace, '.dsh-claude-mem', 'memory.db')).db
  insertEntry(wsDb, {
    level: 'project',
    scope: 'workspace',
    project: 'projA',
    subcategory: 'overview',
    title: '项目概述',
    body: '这是一个测试项目。',
    keywords: ['测试', '项目'],
    importance: 2,
  })
  wsDb.close()
})

after(() => {
  try {
    status?.dispose()
  } catch {}
  rmSync(tmp, { recursive: true, force: true })
})

test('首轮：核心块插在用户消息前，且记了 initial 注入', async () => {
  const decision = makeDecision('我们开始做 projA 吧', 's-first')
  const hook = hooks.get('agent/pre-step')
  const result = await hook(
    { agent: decision.agent, messages: decision.messages, signal: { aborted: false } },
    async () => decision,
  )
  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[0].source.kind, 'plugin:dsh-claude-mem')
  assert.equal(result.messages[0].source.form, 'snapshot')
  assert.ok(result.messages[0].content[0].text.includes('【长期记忆'), result.messages[0].content[0].text)
  assert.ok(result.messages[0].content[0].text.includes('先备份再改配置'))
  assert.equal(result.messages[1].content[0].text, '我们开始做 projA 吧', '用户消息不能被改写')

  const wsDb = openMemoryDb(join(workspace, '.dsh-claude-mem', 'memory.db')).db
  try {
    assert.ok(injectedIds(wsDb, 's-first').size >= 2)
  } finally {
    wsDb.close()
  }
})

test('次轮：命中块按规则门注入，且不重复首轮条目', async () => {
  const decision = makeDecision('上次说的备份演练要注意什么', 's-first')
  const hook = hooks.get('agent/pre-step')
  const result = await hook(
    { agent: decision.agent, messages: decision.messages, signal: { aborted: false } },
    async () => decision,
  )
  assert.equal(result.messages.length, 2)
  const text = result.messages[0].content[0].text
  assert.ok(text.includes('【记忆命中'), text)
  assert.ok(text.includes('回滚脚本'), text)
})

test('子代理会话不注入', async () => {
  const decision = makeDecision('上次说的备份演练要注意什么', 's-sub', 'subagent')
  const hook = hooks.get('agent/pre-step')
  const result = await hook(
    { agent: decision.agent, messages: decision.messages, signal: { aborted: false } },
    async () => decision,
  )
  assert.equal(result.messages.length, 1)
})

test('没有会话头时不注入、也不抛错', async () => {
  const hook = hooks.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '上次的事' }] }] }
  const result = await hook({ agent: {}, messages: decision.messages, signal: { aborted: false } }, async () => decision)
  assert.equal(result.messages.length, 1)
})
