/**
 * dsh-claude-mem · 会话笔记（session notes，M5）
 *
 * PLAN §7 的定位：「**只写不注入**，先跑观察」。要点：
 *   - 会话里发生的事（用户说了什么、用了哪些工具、项目有没有变化）落成一行笔记，
 *     存进 session_notes 表，供后续 dream 整理和人工复盘看；
 *   - **绝不进注入通道**——collectCore 只读 entries，session_notes 永远不会被读到，
 *     这是结构上的保证，不是靠自觉；
 *   - 写入前先扫密钥：笔记正文来自真实对话，比手写记忆更容易带上 token（§8）。
 *
 * 防噪音：只有「有信息量」的事才记——用户消息 ≥12 字、或用了记忆工具、或换了项目；
 * 纯寒暄（「好的」「继续」）不写，否则观察期就会把表塞满废话。
 */
import { newEntryId } from './db.js'
import { scanPii, scanSecrets } from './secret.js'

export const NOTE_KIND = {
  userAsk: 'user-ask',
  toolUse: 'tool-use',
  project: 'project',
  dream: 'dream',
  compaction: 'compaction',
}

/** 一句寒暄/口水话，不值得成为笔记。 */
const SMALL_TALK = /^(?:好的?|嗯+|哦+|行|可以|继续|开始吧?|收到|谢谢|没问题|ok|okay|yes|no|你好)\s*[。！!.…~]*$/i

export function isSmallTalk(text) {
  const trimmed = String(text ?? '').replace(/\s+/g, ' ').trim()
  return trimmed.length < 2 || SMALL_TALK.test(trimmed)
}

/** 会话笔记该不该写：短句/寒暄不写，其余写。 */
export function shouldNoteUserAsk(text, { minChars = 12 } = {}) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim())
  if (chars.length < minChars) return false
  return !isSmallTalk(chars.join(''))
}

/** 笔记正文截断（一行一条，别把整段对话塞进库）。 */
export function summarizeForNote(text, maxChars = 200) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim())
  if (chars.length <= maxChars) return chars.join('')
  return `${chars.slice(0, maxChars - 1).join('')}…`
}

/**
 * 写一条会话笔记。**命中密钥直接不写**（连脱敏版都不留：观察期不需要秘文考古价值）。
 * 永不 throw。
 * @returns {{written:boolean, id:string|null, reason:string}}
 */
export function writeNote(db, { sessionId, workspace, kind, body, maxChars = 200 }, now = Date.now()) {
  const skipped = (reason) => ({ written: false, id: null, reason })
  try {
    if (db === null || db === undefined) return skipped('no-db')
    if (typeof sessionId !== 'string' || sessionId === '') return skipped('no-session')
    if (typeof kind !== 'string' || kind === '') return skipped('no-kind')
    // 先扫完整原文再截断：密钥正好跨在截断点上时，只扫片段会漏掉，半截密钥就进库了。
    const scan = scanSecrets(body)
    if (scan.hit) return skipped(`secret:${scan.rules.join('+')}`)
    // 笔记是用户原话，手机号和身份证同样不留。
    const pii = scanPii(body)
    if (pii.hit) return skipped(`pii:${pii.rules.join('+')}`)
    const text = summarizeForNote(body, maxChars)
    if (text === '') return skipped('empty')

    const id = newEntryId()
    db.prepare(
      `INSERT INTO session_notes(id, session_id, workspace, kind, body, at) VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, workspace ?? null, kind, text, now)
    return { written: true, id, reason: 'ok' }
  } catch {
    return skipped('error')
  }
}

/** 最近的笔记，供 mem_review 整理时参考。 */
export function listRecentNotes(db, { since = 0, limit = 20 } = {}) {
  try {
    return db
      .prepare(`SELECT id, session_id, kind, body, at FROM session_notes WHERE at >= ? ORDER BY at DESC LIMIT ?`)
      .all(since, limit)
  } catch {
    return []
  }
}

/** 读某会话的笔记（复盘/调试用，不进注入）。 */
export function listNotes(db, sessionId, { limit = 50 } = {}) {
  try {
    return db
      .prepare(`SELECT id, session_id, workspace, kind, body, at FROM session_notes WHERE session_id = ? ORDER BY at ASC LIMIT ?`)
      .all(sessionId, limit)
  } catch {
    return []
  }
}

/** 统计（观察期的观测点：写了多少条、被密钥拦了多少条）。 */
export function noteStats(db, { since = 0 } = {}) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM session_notes WHERE at >= ?`).get(since)
    return { count: row?.n ?? 0 }
  } catch {
    return { count: -1 }
  }
}
