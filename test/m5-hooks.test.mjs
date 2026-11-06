import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { apply } from '../src/index.js'
import { openMemoryDb } from '../src/db.js'
import { hasInjection, injectedIds, insertEntry } from '../src/store.js'

let tmp
let workspace
let globalPath
const disposers = []

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-m5-'))
  workspace = join(tmp, 'ws')
  globalPath = join(tmp, 'global.db')
})
after(() => {
  for (const dispose of disposers) dispose()
  rmSync(tmp, { recursive: true, force: true })
})

function fakeCtx() {
  const hooks = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(event, handler) {
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return { section: () => () => {} }
    },
    tools: { register: () => () => {} },
    effect: (cb) => {
      cb()
      return () => {}
    },
  }
  return { ctx, hooks, logs }
}

async function setup(cfg = {}) {
  const fake = fakeCtx()
  // 下面直接造工作区库，不是插件创建的，要声明可信才会被读取。
  const status = await apply(fake.ctx, { globalDbPath: globalPath, workspace: { trusted: [workspace] }, ...cfg })
  disposers.push(status.dispose)

  const global = openMemoryDb(globalPath).db
  if (global.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n === 0) {
    insertEntry(global, {
      level: 'rules',
      scope: 'global',
      project: '全局',
      body: '先备份再改配置。',
      keywords: ['备份', '准则', '配置'],
      importance: 3,
    })
  }
  global.close()

  const wsDb = openMemoryDb(join(workspace, '.dsh-claude-mem', 'memory.db')).db
  if (wsDb.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n === 0) {
    insertEntry(wsDb, {
      level: 'project',
      scope: 'workspace',
      project: 'projA',
      subcategory: 'overview',
      body: '这是一个测试项目。',
      keywords: ['测试', '项目', '概要'],
      importance: 2,
    })
  }
  wsDb.close()
  return { ...fake, status }
}

function makeAgent(sessionId, origin = 'root') {
  return { session: { header: { id: sessionId, cwd: workspace, origin } } }
}

function decisionFor(sessionId, text) {
  const agent = makeAgent(sessionId)
  return {
    kind: 'enter',
    messages: [{ id: `u-${Math.random()}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    agent,
  }
}

/** 跑一次 pre-step：返回 decision（含被插件插进来的消息）。 */
async function runPreStep(hooks, sessionId, text) {
  const decision = decisionFor(sessionId, text)
  const hook = hooks.get('agent/pre-step')
  return hook({ agent: decision.agent, messages: decision.messages, signal: { aborted: false } }, async () => decision)
}

/** 模拟一次压缩：session/event 走 start → summary → end。 */
function simulateCompaction(hooks, sessionId, { fail = false } = {}) {
  const hook = hooks.get('session/event')
  const session = { id: sessionId, header: { cwd: workspace } }
  hook(session, { type: 'compaction/start', data: {} })
  hook(session, { type: 'compaction/summary', data: { tokens: 9000 } })
  hook(session, { type: 'compaction/end', data: fail ? { error: 'compaction failed' } : {} })
}

// ---------------------------------------------------------------- 验收 4：压缩后重注入

test('验收4：压缩模拟后，下一轮确实出现重注入', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath })
  const sid = 's-compact-1'

  // 先跑首轮，建立 initial 注入
  const first = await runPreStep(hooks, sid, '我们开始做 projA 吧')
  assert.equal(first.messages.length, 2, '首轮应有核心块 + 用户消息')
  assert.ok(first.messages[0].content[0].text.includes('【长期记忆'))

  // 压缩
  simulateCompaction(hooks, sid)

  // 下一轮：应出现 reinject 块
  const after1 = await runPreStep(hooks, sid, '继续刚才那个话题')
  assert.equal(after1.messages.length, 2, `压缩后应有重注入块，实际 ${after1.messages.length}`)
  const block = after1.messages[0]
  assert.equal(block.source.kind, 'plugin:dsh-claude-mem')
  assert.equal(block.source.form, 'snapshot')
  assert.equal(block.source.meta.injectionKind, 'reinject', '注入类型必须是 reinject')
  assert.equal(block.source.meta.reinjectReason, 'compaction')
  assert.ok(block.content[0].text.includes('【长期记忆'), block.content[0].text)
  assert.ok(block.content[0].text.includes('先备份再改配置'), '核心块内容要补回来')

  // 库里有 reinject 记录
  const wsDb = openMemoryDb(join(workspace, '.dsh-claude-mem', 'memory.db')).db
  try {
    assert.equal(hasInjection(wsDb, sid, 'reinject'), true)
  } finally {
    wsDb.close()
  }
})

test('验收4：重注入不重复——插过一次后，后续轮次不再插', async () => {
  const { hooks, logs } = await setup({ globalDbPath: globalPath })
  const sid = 's-compact-2'

  await runPreStep(hooks, sid, '我们开始做 projA 吧')
  simulateCompaction(hooks, sid)

  // 第 1 轮：重注入
  const first = await runPreStep(hooks, sid, '压缩完了，接着干')
  const reinjected = first.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject')
  assert.equal(reinjected.length, 1, '压缩后第一次 pre-step 应重注入一次')

  // 第 2、3 轮：不该再重注入（标记已被取走）
  for (let i = 0; i < 3; i += 1) {
    const again = await runPreStep(hooks, sid, `再聊一句关于压缩的话题 ${i}`)
    const extra = again.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject')
    assert.equal(extra.length, 0, `第 ${i + 2} 轮不该重复重注入`)
  }

  // 日志里 reinject 只应出现一次
  const reinjectLogs = logs.filter(([, m]) => m.includes('压缩后重注入'))
  assert.equal(reinjectLogs.length, 1, `重注入应只发生 1 次，实际 ${reinjectLogs.length}：${JSON.stringify(reinjectLogs)}`)
})

test('验收4：同一轮 pre-step 反复调用也只注入一次', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath })
  const sid = 's-compact-3'
  await runPreStep(hooks, sid, '我们开始做 projA 吧')
  simulateCompaction(hooks, sid)

  // 连跑 5 次（模拟同一轮被重试/多次触发）
  let reinjectCount = 0
  for (let i = 0; i < 5; i += 1) {
    const d = await runPreStep(hooks, sid, `同一轮的重复调用 ${i}`)
    reinjectCount += d.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject').length
  }
  assert.equal(reinjectCount, 1, `同一轮重复调用应只重注入 1 次，实际 ${reinjectCount}`)
})

test('压缩失败（end 带 error）不触发重注入', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath })
  const sid = 's-compact-fail'
  await runPreStep(hooks, sid, '我们开始做 projA 吧')

  simulateCompaction(hooks, sid, { fail: true })

  const next = await runPreStep(hooks, sid, '压缩失败了接着聊')
  const reinjects = next.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject')
  assert.equal(reinjects.length, 0, '压缩失败不该重注入')
})

test('压缩中途（start/summary）不触发，只有 end 后才注入', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath })
  const sid = 's-compact-mid'
  await runPreStep(hooks, sid, '我们开始做 projA 吧')

  const hook = hooks.get('session/event')
  const session = { id: sid, header: { cwd: workspace } }
  hook(session, { type: 'compaction/start', data: {} })
  // start 之后：不该重注入
  const mid = await runPreStep(hooks, sid, '压缩进行中')
  assert.equal(mid.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject').length, 0)

  hook(session, { type: 'compaction/end', data: {} })
  const done = await runPreStep(hooks, sid, '压缩结束了')
  assert.equal(done.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject').length, 1)
})

test('子代理会话压缩不重注入', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath })
  const sid = 's-sub-compact'
  simulateCompaction(hooks, sid)
  const agent = makeAgent(sid, 'subagent')
  const decision = {
    kind: 'enter',
    messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '子代理的活' }] }],
    agent,
  }
  const hook = hooks.get('agent/pre-step')
  const result = await hook({ agent, messages: decision.messages, signal: { aborted: false } }, async () => decision)
  assert.equal(result.messages.length, 1, '子代理不该被注入')
})

test('无会话头的压缩事件不抛错', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath })
  const hook = hooks.get('session/event')
  assert.doesNotThrow(() => hook({}, { type: 'compaction/end', data: {} }))
  assert.doesNotThrow(() => hook(null, { type: 'compaction/end', data: {} }))
  assert.doesNotThrow(() => hook({ id: 'x' }, null))
  assert.doesNotThrow(() => hook({ id: 'x' }, { type: 'turn/start' }))
})

// ---------------------------------------------------------------- dream 钩子接线

test('turn-stopping：会话不足 5 个不触发 dream，也不抛', async () => {
  const { hooks, status } = await setup({ globalDbPath: globalPath })
  const hook = hooks.get('agent/turn-stopping')
  const agent = makeAgent('s-dream-1')
  assert.doesNotThrow(() => hook({ agent, turn: 1 }))
  assert.equal(status.ok, true)
})

test('turn-stopping：子代理会话不写笔记、不判 dream', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath })
  const hook = hooks.get('agent/turn-stopping')
  const agent = makeAgent('s-dream-sub', 'subagent')
  assert.doesNotThrow(() => hook({ agent, turn: 1 }))
})

test('turn-stopping：无 agent/无头部不抛错（fail-open）', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath })
  const hook = hooks.get('agent/turn-stopping')
  assert.doesNotThrow(() => hook({}))
  assert.doesNotThrow(() => hook({ agent: {} }))
  assert.doesNotThrow(() => hook(null))
})

test('dream.mode=push 且 followup 缺失：只记日志不抛错', async () => {
  const { hooks } = await setup({ globalDbPath: globalPath, dream: { mode: 'push' } })
  // 造够会话 + 会话事件，让门控有机会打开
  const wsDb = openMemoryDb(join(workspace, '.dsh-claude-mem', 'memory.db')).db
  for (let i = 0; i < 6; i += 1) {
    wsDb.prepare(`INSERT OR REPLACE INTO sessions(session_id, workspace, started_at, last_seen_at) VALUES(?,?,?,?)`).run(
      `seed-${i}`, workspace, Date.now() - 1000, Date.now() - 1000,
    )
  }
  wsDb.close()

  const agent = makeAgent('s-dream-push')
  // 没有 followup：不该抛
  assert.doesNotThrow(() => hooks.get('agent/turn-stopping')({ agent }))

  // followup 抛错也不该冒泡
  const throwing = makeAgent('s-dream-push-2')
  throwing.followup = () => {
    throw new Error('followup boom')
  }
  assert.doesNotThrow(() => hooks.get('agent/turn-stopping')({ agent: throwing }))
})
