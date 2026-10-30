#!/usr/bin/env node
/**
 * dsh-claude-mem · M5 验收（dream 门控 + 会话笔记 + 压缩重注入）
 *
 * 三项能力各自给「命令可见的原始证据」，不是只报一句「做好了」：
 *   1. 假时钟：24h 内多次空闲只触发 1 次
 *   2. 5 会话阈值：不到 5 个会话不触发
 *   3. 10 分钟节流：扫描间隔有效
 *   4. 压缩模拟后下一轮出现重注入，且不重复注入
 *   5. 会话笔记只写不注入
 *
 * 用法：node tools/m5-check.mjs
 * 退出码：0 = 全过；1 = 有失败。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { openMemoryDb, readMeta } from '../src/db.js'
import { HOUR_MS, MINUTE_MS, runDreamGate } from '../src/dream.js'
import { insertEntry, touchSession } from '../src/store.js'
import { listNotes } from '../src/notes.js'

const results = []
function check(label, pass, detail = '') {
  results.push({ label, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${label}${detail === '' ? '' : `\n      ${detail}`}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-m5-check-'))
const workspace = join(tmp, 'ws')
const globalPath = join(tmp, 'global.db')
const wsDbPath = join(workspace, '.dsh-claude-mem', 'memory.db')
const disposers = []

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

function seed() {
  const global = openMemoryDb(globalPath).db
  insertEntry(global, {
    level: 'rules',
    scope: 'global',
    project: '全局',
    body: '先备份再改配置。',
    keywords: ['备份', '准则', '配置'],
    importance: 3,
  })
  global.close()

  const wsDb = openMemoryDb(wsDbPath).db
  insertEntry(wsDb, {
    level: 'project',
    scope: 'workspace',
    project: 'projA',
    subcategory: 'overview',
    body: '这是一个测试项目。',
    keywords: ['测试', '项目', '概要'],
    importance: 2,
  })
  wsDb.close()
}

function makeAgent(sessionId, origin = 'root') {
  return { session: { header: { id: sessionId, cwd: workspace, origin } } }
}

async function runPreStep(hooks, sessionId, text) {
  const agent = makeAgent(sessionId)
  const decision = {
    kind: 'enter',
    messages: [{ id: `u-${Math.random()}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    agent,
  }
  const hook = hooks.get('agent/pre-step')
  return hook({ agent, messages: decision.messages, signal: { aborted: false } }, async () => decision)
}

function compaction(hooks, sessionId, { fail = false } = {}) {
  const hook = hooks.get('session/event')
  const session = { id: sessionId, header: { cwd: workspace } }
  hook(session, { type: 'compaction/start', data: {} })
  hook(session, { type: 'compaction/summary', data: { tokens: 9000 } })
  hook(session, { type: 'compaction/end', data: fail ? { error: 'boom' } : {} })
}

async function main() {
  seed()
  const fake = fakeCtx()
  const status = await apply(fake.ctx, { globalDbPath: globalPath })
  disposers.push(status.dispose)
  if (!status.ok) {
    check('apply 成功', false, JSON.stringify(status.warnings))
    return
  }
  check('apply 成功，三个钩子挂上', status.hooks.includes('agent/pre-step') && status.hooks.includes('agent/turn-stopping') && status.hooks.includes('session/event'),
    status.hooks.join(', '))

  // ---------------------------------------------------------------- 1) 假时钟：24h 内只触发 1 次
  {
    const db = openMemoryDb(join(tmp, 'gate-hours.db')).db
    const t0 = 1000 * HOUR_MS
    for (let i = 0; i < 5; i += 1) touchSession(db, `h-${i}`, workspace, t0 - HOUR_MS)

    const first = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, t0)
    let extra = 0
    let scans = 0
    for (let i = 1; i <= 120; i += 1) {
      const now = t0 + i * 11 * MINUTE_MS
      touchSession(db, `h-extra-${i}`, workspace, now - MINUTE_MS)
      const g = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, now)
      if (g.scan) scans += 1
      if (g.trigger) extra += 1
    }
    const lastDream = Number(readMeta(db, 'last_dream_at'))
    check(
      '假时钟：24h 内多次空闲只触发 1 次',
      first.trigger === true && extra === 0,
      `首次 trigger=${first.trigger}；随后 120 次空闲扫描 ${scans} 次、额外触发 ${extra} 次；last_dream_at 仍 = ${lastDream}（=首次时刻 ${t0}：${lastDream === t0}）`,
    )
    db.close()
  }

  // ---------------------------------------------------------------- 2) 5 会话阈值
  {
    const db = openMemoryDb(join(tmp, 'gate-sessions.db')).db
    const t0 = 1000 * HOUR_MS
    for (let i = 0; i < 4; i += 1) touchSession(db, `s4-${i}`, workspace, t0 - 100 * HOUR_MS)

    const g4 = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, t0)
    const after3d = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, t0 + 72 * HOUR_MS)
    touchSession(db, 's5-last', workspace, t0 - 50 * HOUR_MS)
    const g5 = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, t0 + 73 * HOUR_MS)
    check(
      '5 会话阈值：不到 5 个会话不触发（跨 3 天也不行），补齐后触发',
      g4.trigger === false && g4.reason === 'sessions' && after3d.trigger === false && g5.trigger === true,
      `4 会话→${g4.reason}(sessions=${g4.sessions})；3 天后仍 ${after3d.trigger}；补到 5 个→${g5.trigger}(sessions=${g5.sessions})`,
    )
    db.close()
  }

  // ---------------------------------------------------------------- 3) 10 分钟节流
  {
    const db = openMemoryDb(join(tmp, 'gate-throttle.db')).db
    const t0 = 1000 * HOUR_MS
    touchSession(db, 'thr-1', workspace, t0 - HOUR_MS)
    const g1 = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, t0)
    const scanAt1 = readMeta(db, 'dream_scan_at')

    const g2 = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, t0 + 9 * MINUTE_MS)
    const scanAt2 = readMeta(db, 'dream_scan_at')

    // 节流期内即使会话够了也不能触发
    for (let i = 0; i < 10; i += 1) touchSession(db, `thr-fill-${i}`, workspace, t0 + 5 * MINUTE_MS)
    const g3 = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, t0 + 9.5 * MINUTE_MS)

    const g4 = runDreamGate(db, { minHours: 24, minSessions: 5, throttleMinutes: 10 }, t0 + 11 * MINUTE_MS)
    check(
      '10 分钟节流：扫描间隔有效（9 分钟内不再扫、节流期内即使凑够会话也不触发）',
      g2.scan === false && g2.reason === 'throttle' && scanAt2 === scanAt1 && g3.trigger === false && g4.trigger === true,
      `t+0 扫描盖章 ${scanAt1}；t+9m scan=${g2.scan}(${g2.reason}) 盖章仍 ${scanAt2}；t+9.5m 会话够 trigger=${g3.trigger}；t+11m trigger=${g4.trigger}`,
    )
    db.close()
  }

  const hooks = fake.hooks

  // ---------------------------------------------------------------- 4) 压缩后重注入 + 不重复
  {
    const sid = 'e2e-compact'
    const first = await runPreStep(hooks, sid, '我们开始做 projA 吧')
    const hasInitial = first.messages.some((m) => m.source?.meta?.injectionKind === 'initial')

    compaction(hooks, sid)

    const after = await runPreStep(hooks, sid, '压缩完了，接着刚才的话题')
    const reinjected = after.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject')

    let repeats = 0
    for (let i = 0; i < 5; i += 1) {
      const again = await runPreStep(hooks, sid, `压缩后第 ${i + 2} 轮聊点别的`)
      repeats += again.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject').length
    }

    check(
      '压缩模拟后：下一轮出现重注入',
      hasInitial && reinjected.length === 1,
      `首轮 initial=${hasInitial}；压缩后下一轮 reinject=${reinjected.length}（${reinjected[0]?.content?.[0]?.text?.length ?? 0} 字，reason=${reinjected[0]?.source?.meta?.reinjectReason}）`,
    )
    check(
      '压缩重注入不重复：后续 5 轮合计 0 次',
      repeats === 0,
      `后续 5 轮额外 reinject = ${repeats}`,
    )

    // 压缩失败不该重注入
    const sidFail = 'e2e-compact-fail'
    await runPreStep(hooks, sidFail, '我们开始做 projA 吧')
    compaction(hooks, sidFail, { fail: true })
    const afterFail = await runPreStep(hooks, sidFail, '压缩失败后继续')
    const failReinject = afterFail.messages.filter((m) => m.source?.meta?.injectionKind === 'reinject').length
    check('压缩失败（end 带 error）不重注入', failReinject === 0, `reinject = ${failReinject}`)

    // 库里落了 reinject 记录
    const wsDb = openMemoryDb(wsDbPath).db
    const marked = wsDb.prepare(`SELECT COUNT(*) AS n FROM injections WHERE session_id = ? AND kind = 'reinject'`).get(sid)
    check('压缩重注入在 injections 表留了 reinject 记录（跨进程可查）', marked.n > 0, `kind='reinject' 记录数 = ${marked.n}`)
    wsDb.close()
  }

  // ---------------------------------------------------------------- 5) 会话笔记：只写不注入
  {
    const wsDb = openMemoryDb(wsDbPath).db
    const notesBefore = listNotes(wsDb, 'e2e-notes').length
    wsDb.close()

    const sid = 'e2e-notes'
    const agent = makeAgent(sid)
    agent.session.events = [
      { type: 'turn/start', data: {} },
      {
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这个插件的 dream 门控要三条同时满足才触发' }] },
      },
    ]
    hooks.get('agent/turn-stopping')({ agent, turn: 1 })

    const wsDb2 = openMemoryDb(wsDbPath).db
    const notes = listNotes(wsDb2, sid)
    wsDb2.close()

    // 关键：下一轮注入里绝不能出现笔记正文（结构上 collectCore 只读 entries）
    const next = await runPreStep(hooks, sid, '继续聊 dream 门控的三条约束')
    const injectedText = next.messages
      .filter((m) => m.source?.kind === 'plugin:dsh-claude-mem')
      .map((m) => m.content?.[0]?.text ?? '')
      .join('\n')

    check(
      '会话笔记：写进 session_notes（只写）',
      notesBefore === 0 && notes.length === 1,
      `turn-stopping 后该会话笔记数 = ${notes.length}，正文 = ${JSON.stringify(notes[0]?.body ?? null)}`,
    )
    check(
      '会话笔记：不进注入通道（不注入）',
      !injectedText.includes('三条同时满足才触发'),
      `下一轮注入块 ${injectedText.length} 字，是否含笔记正文：${injectedText.includes('三条同时满足才触发')}`,
    )

    // 寒暄不记
    const sid2 = 'e2e-notes-small'
    const agent2 = makeAgent(sid2)
    agent2.session.events = [
      { type: 'turn/start', data: {} },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '好的' }] } },
    ]
    hooks.get('agent/turn-stopping')({ agent: agent2, turn: 1 })
    const wsDb3 = openMemoryDb(wsDbPath).db
    const smallNotes = listNotes(wsDb3, sid2).length
    wsDb3.close()
    check('会话笔记：寒暄不写（防噪音）', smallNotes === 0, `「好的」产生笔记数 = ${smallNotes}`)
  }

  // ---------------------------------------------------------------- 6) dream 在真钩子上触发一次
  {
    const wsDb = openMemoryDb(wsDbPath).db
    const t = Date.now() - HOUR_MS
    for (let i = 0; i < 6; i += 1) touchSession(wsDb, `hook-seed-${i}`, workspace, t)
    wsDb.prepare(`DELETE FROM meta WHERE key IN ('last_dream_at', 'dream_scan_at')`).run()
    wsDb.close()

    const runsBefore = (() => {
      const d = openMemoryDb(wsDbPath).db
      const n = d.prepare(`SELECT COUNT(*) AS n FROM dream_runs`).get().n
      d.close()
      return n
    })()

    hooks.get('agent/turn-stopping')({ agent: makeAgent('e2e-dream'), turn: 1 })

    const d = openMemoryDb(wsDbPath).db
    const runsAfter = d.prepare(`SELECT COUNT(*) AS n FROM dream_runs`).get().n
    const lastDream = readMeta(d, 'last_dream_at')
    d.close()
    check(
      'dream 在 turn-stopping 真钩子上触发并落库（mode=observe 只记录不推送）',
      runsAfter === runsBefore + 1 && lastDream !== null,
      `dream_runs ${runsBefore} → ${runsAfter}；last_dream_at = ${lastDream}`,
    )

    // 紧接着再跑一轮：24h 内不该再触发
    hooks.get('agent/turn-stopping')({ agent: makeAgent('e2e-dream'), turn: 2 })
    const d2 = openMemoryDb(wsDbPath).db
    const runsAfter2 = d2.prepare(`SELECT COUNT(*) AS n FROM dream_runs`).get().n
    d2.close()
    check('dream：紧接着的下一轮不再触发（24h 内只 1 次）', runsAfter2 === runsAfter, `dream_runs 仍 = ${runsAfter2}`)
  }

  // ---------------------------------------------------------------- 汇总
  const passed = results.filter((r) => r.pass).length
  const failed = results.length - passed
  console.log(`\n${passed}/${results.length} 通过${failed > 0 ? `，${failed} 失败` : ''}`)
  return failed === 0
}

let ok = false
try {
  ok = await main()
} catch (error) {
  console.error('验收脚本异常：', error)
  ok = false
} finally {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {}
  }
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(ok ? 0 : 1)
