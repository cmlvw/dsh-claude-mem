import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

import { dreamGate, forceDreamStamp, HOUR_MS, MINUTE_MS, runDreamGate } from '../src/dream.js'
import { openMemoryDb, readMeta } from '../src/db.js'
import { touchSession } from '../src/store.js'

let tmp
let seq = 0
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-dream-'))
})
after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const dbPath = () => join(tmp, `dream-${(seq += 1)}.db`)

/** 默认门控参数（与 config 默认值一致）。 */
const CFG = { minHours: 24, minSessions: 5, throttleMinutes: 10 }

/** 造 n 个会话，last_seen_at 都落在 since 之后。 */
function seedSessions(db, n, at) {
  for (let i = 0; i < n; i += 1) touchSession(db, `s-${at}-${i}`, 'ws', at)
}

// ---------------------------------------------------------------- 纯函数：dreamGate

test('dreamGate：从未整理过 + 会话够 → 触发（首梦不被「没有上次」卡死）', () => {
  const g = dreamGate({ now: 1000 * HOUR_MS, lastDreamAt: null, lastScanAt: null, sessions: 5, ...CFG })
  assert.equal(g.trigger, true)
  assert.equal(g.reason, 'ready')
})

test('dreamGate：不到 24h → 不触发（hours）', () => {
  const now = 1000 * HOUR_MS
  const g = dreamGate({ now, lastDreamAt: now - 23 * HOUR_MS, lastScanAt: null, sessions: 99, ...CFG })
  assert.equal(g.trigger, false)
  assert.equal(g.reason, 'hours')
})

test('dreamGate：恰好 24h（边界）→ 允许触发', () => {
  const now = 1000 * HOUR_MS
  const g = dreamGate({ now, lastDreamAt: now - 24 * HOUR_MS, lastScanAt: null, sessions: 5, ...CFG })
  assert.equal(g.trigger, true)
})

test('dreamGate：会话不到 5 个 → 不触发（sessions）', () => {
  const now = 1000 * HOUR_MS
  const g = dreamGate({ now, lastDreamAt: now - 48 * HOUR_MS, lastScanAt: null, sessions: 4, ...CFG })
  assert.equal(g.trigger, false)
  assert.equal(g.reason, 'sessions')
})

test('dreamGate：10 分钟内刚扫过 → 连判断都不做（throttle，scan=false）', () => {
  const now = 1000 * HOUR_MS
  const g = dreamGate({
    now,
    lastDreamAt: now - 48 * HOUR_MS,
    lastScanAt: now - 9 * MINUTE_MS,
    sessions: 99,
    ...CFG,
  })
  assert.equal(g.scan, false, '节流中不该再扫库')
  assert.equal(g.trigger, false)
  assert.equal(g.reason, 'throttle')
})

test('dreamGate：正好 10 分钟 → 允许扫描', () => {
  const now = 1000 * HOUR_MS
  const g = dreamGate({ now, lastDreamAt: null, lastScanAt: now - 10 * MINUTE_MS, sessions: 5, ...CFG })
  assert.equal(g.scan, true)
  assert.equal(g.trigger, true)
})

// ---------------------------------------------------------------- 落库：runDreamGate

test('假时钟：24h 内多次空闲只触发 1 次（不能多触发）', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const t0 = 1000 * HOUR_MS
    seedSessions(db, 5, t0 - HOUR_MS)

    // 第 1 次：会话够、从没整理过 → 触发
    const first = runDreamGate(db, CFG, t0)
    assert.equal(first.trigger, true, `第 1 次应触发：${JSON.stringify(first)}`)
    assert.equal(readMeta(db, 'last_dream_at'), String(t0))

    // 之后 24 小时内反复空闲（每次隔 11 分钟，能越过 10 分钟节流）+ 不断加新会话
    let triggered = 0
    for (let i = 1; i <= 120; i += 1) {
      const now = t0 + i * 11 * MINUTE_MS // 跨约 22 小时，仍在 24h 内
      seedSessions(db, 1, now - MINUTE_MS)
      const g = runDreamGate(db, CFG, now)
      if (g.trigger) triggered += 1
    }
    assert.equal(triggered, 0, `24h 内不应再触发，实际多触发 ${triggered} 次`)
  } finally {
    db.close()
  }
})

test('假时钟：越过 24h 后才允许第 2 次触发', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const t0 = 1000 * HOUR_MS
    seedSessions(db, 5, t0 - HOUR_MS)
    assert.equal(runDreamGate(db, CFG, t0).trigger, true)

    // 23h59m 后：不触发（注意留出 >10 分钟节流窗口，否则连判定都不做）
    const almost = t0 + 24 * HOUR_MS - MINUTE_MS
    seedSessions(db, 10, almost - MINUTE_MS)
    assert.equal(runDreamGate(db, CFG, almost).trigger, false)

    // 24h 后：触发（同样要越过 10 分钟节流）
    const later = t0 + 24 * HOUR_MS + 11 * MINUTE_MS
    seedSessions(db, 10, later - MINUTE_MS)
    assert.equal(runDreamGate(db, CFG, later).trigger, true)
  } finally {
    db.close()
  }
})

test('5 会话阈值：不到 5 个会话不触发（多个 24h 周期也不行）', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const t0 = 1000 * HOUR_MS
    // 只有 4 个会话，且分散在很久以前
    seedSessions(db, 4, t0 - 100 * HOUR_MS)

    const g1 = runDreamGate(db, CFG, t0)
    assert.equal(g1.trigger, false)
    assert.equal(g1.reason, 'sessions')
    assert.equal(g1.sessions, 4)
    assert.equal(readMeta(db, 'last_dream_at'), null, '不触发就不该盖 last_dream_at')

    // 再等 3 天、也没新会话：仍然不触发（会话数没涨）
    const g2 = runDreamGate(db, CFG, t0 + 72 * HOUR_MS)
    assert.equal(g2.trigger, false)
    assert.equal(g2.reason, 'sessions')
  } finally {
    db.close()
  }
})

test('5 会话阈值：补齐第 5 个会话后触发', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const t0 = 1000 * HOUR_MS
    seedSessions(db, 4, t0 - 100 * HOUR_MS)
    assert.equal(runDreamGate(db, CFG, t0).trigger, false)

    seedSessions(db, 1, t0 - 50 * HOUR_MS)
    // 越过 10 分钟节流再判（第一次扫描刚在 t0 盖过章时这里已被节流挡住）
    const g = runDreamGate(db, CFG, t0 + 11 * MINUTE_MS)
    assert.equal(g.trigger, true)
    assert.equal(g.sessions, 5)
  } finally {
    db.close()
  }
})

test('10 分钟节流：扫描间隔有效（首次扫完 9 分钟内不再扫，也不改扫描时刻）', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const t0 = 1000 * HOUR_MS
    // 会话不够，第一次只扫描不触发
    seedSessions(db, 1, t0 - HOUR_MS)
    const g1 = runDreamGate(db, CFG, t0)
    assert.equal(g1.reason, 'sessions')
    assert.equal(readMeta(db, 'dream_scan_at'), String(t0))

    // 9 分钟后：被节流挡住，扫描时刻保持 t0（不刷新）
    const g2 = runDreamGate(db, CFG, t0 + 9 * MINUTE_MS)
    assert.equal(g2.reason, 'throttle')
    assert.equal(g2.scan, false)
    assert.equal(readMeta(db, 'dream_scan_at'), String(t0), '节流命中不该刷新扫描时刻')

    // 期间即使会话数够了，节流期内也不触发
    seedSessions(db, 10, t0 + 5 * MINUTE_MS)
    const g3 = runDreamGate(db, CFG, t0 + 9.5 * MINUTE_MS)
    assert.equal(g3.trigger, false, '节流期内不能触发')

    // 越过 10 分钟：重新扫描并触发
    const g4 = runDreamGate(db, CFG, t0 + 11 * MINUTE_MS)
    assert.equal(g4.scan, true)
    assert.equal(g4.trigger, true)
    assert.equal(readMeta(db, 'dream_scan_at'), String(t0 + 11 * MINUTE_MS))
  } finally {
    db.close()
  }
})

test('三条件同时满足才触发：挨个补齐，缺一不触发', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const base = 1000 * HOUR_MS

    // 会话不足（4 个）、时间也不足 → sessions（时间先过不去的话报 hours，这里时间够）
    seedSessions(db, 4, base - 30 * HOUR_MS)
    assert.equal(runDreamGate(db, CFG, base).reason, 'sessions')

    // 补会话到 5 → 触发
    seedSessions(db, 1, base - 20 * HOUR_MS)
    assert.equal(runDreamGate(db, CFG, base + 11 * MINUTE_MS).trigger, true)

    // 刚触发完 1 小时，会话再多也不触发（hours）
    seedSessions(db, 20, base + 30 * MINUTE_MS)
    const g = runDreamGate(db, CFG, base + 1 * HOUR_MS)
    assert.equal(g.trigger, false)
    assert.equal(g.reason, 'hours')
  } finally {
    db.close()
  }
})

test('runDreamGate：触发时写 dream_runs（sessions_since 与 outcome 可观测）', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const t0 = 1000 * HOUR_MS
    seedSessions(db, 6, t0 - HOUR_MS)
    const g = runDreamGate(db, CFG, t0)
    assert.equal(g.trigger, true)
    assert.ok(g.runId)
    const row = db.prepare(`SELECT * FROM dream_runs WHERE id = ?`).get(g.runId)
    assert.equal(row.outcome, 'gate-open')
    assert.equal(row.sessions_since, 6)
    assert.equal(row.started_at, t0)
  } finally {
    db.close()
  }
})

test('runDreamGate：坏库/null 不 throw，返回不触发', () => {
  assert.doesNotThrow(() => runDreamGate(null, CFG, Date.now()))
  assert.equal(runDreamGate(null, CFG, Date.now()).trigger, false)
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  db.close()
  // 已关闭的库：内部语句会抛，必须被吞掉
  assert.equal(runDreamGate(db, CFG, Date.now()).trigger, false)
})

test('forceDreamStamp：手动整理不受门控限制，直接盖时间戳', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const t0 = 1000 * HOUR_MS
    const id = forceDreamStamp(db, t0)
    assert.ok(id)
    assert.equal(readMeta(db, 'last_dream_at'), String(t0))
    // 手动整理后，紧接着的门控因 hours 不满足而不触发
    seedSessions(db, 99, t0 - HOUR_MS)
    assert.equal(runDreamGate(db, CFG, t0 + HOUR_MS).trigger, false)
  } finally {
    db.close()
  }
})
