/**
 * dsh-claude-mem · dream 门控（PLAN.md §7 / M5）
 *
 * 三条约束**同时**满足才触发：
 *   1. 距上次整理 ≥ minHours（默认 24h）——「24h 内多次空闲只触发 1 次」靠这条；
 *   2. 期间的会话数 ≥ minSessions（默认 5）——「不到 5 个会话不触发」；
 *   3. 距上次**扫描** ≥ throttleMinutes（默认 10 分钟）——扫描节流，与触发解耦：
 *      节流不满足时连「要不要跑」都不判断，直接跳过，避免 turn-stopping 每次都查库。
 *
 * 门控判断是纯函数（dreamGate），时间由调用方传入，假时钟测试可直接打；
 * runDreamGate 只做「读 meta → 判 → 写 meta」的落库动作，全程 fail-open。
 *
 * 触发后的动作由 mode 决定（§R3 锁后交付：新能力默认关着）：
 *   - 'observe'（默认）：只记 dream_runs + last_dream_at，把「本该触发」留证据，不推任何 turn；
 *   - 'push'：额外用 agent.followup 推一轮整理指令（真机可见、可中断）。
 */
import { newEntryId, readMeta, writeMeta } from './db.js'
import { sessionsSince } from './store.js'

export const KEY_LAST_DREAM = 'last_dream_at'
export const KEY_LAST_SCAN = 'dream_scan_at'

export const HOUR_MS = 60 * 60 * 1000
export const MINUTE_MS = 60 * 1000

/**
 * 纯门控判断。
 * @param {{now:number, lastDreamAt:number|null, lastScanAt:number|null,
 *          sessions:number, minHours:number, minSessions:number, throttleMinutes:number}} input
 * @returns {{scan:boolean, trigger:boolean, reason:string, sinceLastDreamMs:number|null, sessions:number}}
 */
export function dreamGate(input) {
  const {
    now,
    lastDreamAt = null,
    lastScanAt = null,
    sessions = 0,
    minHours = 24,
    minSessions = 5,
    throttleMinutes = 10,
  } = input ?? {}

  // 1) 扫描节流：最近扫过就不扫了（连判断都省掉）。
  if (lastScanAt !== null && Number.isFinite(lastScanAt) && now - lastScanAt < throttleMinutes * MINUTE_MS) {
    return {
      scan: false,
      trigger: false,
      reason: 'throttle',
      sinceLastDreamMs: lastDreamAt === null ? null : now - lastDreamAt,
      sessions,
    }
  }

  const sinceLastDreamMs = lastDreamAt === null ? null : now - lastDreamAt

  // 2) 24h：从没过梦则视为满足（首梦不该被「没有上次」卡死）。
  if (sinceLastDreamMs !== null && sinceLastDreamMs < minHours * HOUR_MS) {
    return { scan: true, trigger: false, reason: 'hours', sinceLastDreamMs, sessions }
  }

  // 3) 会话数阈值。
  if (sessions < minSessions) {
    return { scan: true, trigger: false, reason: 'sessions', sinceLastDreamMs, sessions }
  }

  return { scan: true, trigger: true, reason: 'ready', sinceLastDreamMs, sessions }
}

/**
 * 读 meta → 判门控 → 写扫描时刻；命中则在 dream_runs 记一行。
 * 永不 throw：任何异常都当成「不触发」返回。
 * @param {import('node:sqlite').DatabaseSync} db 工作区库
 * @param {{minHours:number,minSessions:number,throttleMinutes:number}} cfg
 * @param {number} now
 * @returns {{scan:boolean, trigger:boolean, reason:string, sessions:number, runId:string|null}}
 */
export function runDreamGate(db, cfg, now = Date.now()) {
  const fallback = { scan: false, trigger: false, reason: 'error', sessions: 0, runId: null }
  try {
    if (db === null || db === undefined) return fallback
    const rawDream = readMeta(db, KEY_LAST_DREAM)
    const rawScan = readMeta(db, KEY_LAST_SCAN)
    const lastDreamAt = rawDream === null ? null : Number(rawDream)
    const lastScanAt = rawScan === null ? null : Number(rawScan)
    const since = lastDreamAt === null ? 0 : lastDreamAt
    const sessions = sessionsSince(db, since)

    const gate = dreamGate({
      now,
      lastDreamAt: Number.isFinite(lastDreamAt) ? lastDreamAt : null,
      lastScanAt: Number.isFinite(lastScanAt) ? lastScanAt : null,
      sessions,
      minHours: cfg?.minHours ?? 24,
      minSessions: cfg?.minSessions ?? 5,
      throttleMinutes: cfg?.throttleMinutes ?? 10,
    })

    // 扫描过就盖章：下一轮 10 分钟内不再扫。
    if (gate.scan) writeMeta(db, KEY_LAST_SCAN, now)

    let runId = null
    if (gate.trigger) {
      runId = newEntryId()
      db.prepare(
        `INSERT INTO dream_runs(id, started_at, finished_at, sessions_since, rounds, outcome)
         VALUES(?, ?, ?, ?, 0, ?)`,
      ).run(runId, now, now, gate.sessions, 'gate-open')
      // 盖章 last_dream_at：这就是「24h 内只触发 1 次」的落点。
      writeMeta(db, KEY_LAST_DREAM, now)
    }

    return { scan: gate.scan, trigger: gate.trigger, reason: gate.reason, sessions: gate.sessions, runId }
  } catch {
    return fallback
  }
}

/** 手动整理（/mem-dream）不受门控限制：只推进 last_dream_at，不查门控。 */
export function forceDreamStamp(db, now = Date.now()) {
  try {
    writeMeta(db, KEY_LAST_DREAM, now)
    const runId = newEntryId()
    db.prepare(
      `INSERT INTO dream_runs(id, started_at, finished_at, sessions_since, rounds, outcome)
       VALUES(?, ?, ?, 0, 0, ?)`,
    ).run(runId, now, now, 'manual')
    return runId
  } catch {
    return null
  }
}
