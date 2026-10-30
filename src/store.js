/**
 * dsh-claude-mem · 条目存储与索引投影
 *
 * M1 的交付：写入/更新/去重、按层查询、项目索引投影、FTS+LIKE 混合召回、
 * 注入记录。M2 的注入层只消费这里返回的「行」，不直接写 SQL。
 *
 * 关键取舍（PLAN.md §4.3）：
 * - 项目索引是「实时投影」而不是物化表：每次注入现算，永远和库一致。
 * - 工作区库里的 project 行天然属于这个工作区，注入时不需要把工作区路径
 *   映射成项目名；索引取最近活跃的 ≤N 个项目即可。
 * - 中文召回：FTS trigram 只认 ≥3 字，2 字查询走 LIKE 兜底（db.js 已注明）。
 */
import { createHash } from 'node:crypto'

import { newEntryId } from './db.js'
import { ageLabel } from './time.js'

export const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

export const SUBCATEGORIES = ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo']

/** 索引里的排序优先级：决策 > 概述 > 待办 > 结构 > 部署 > 原话（PLAN.md §4.3）。 */
const PROJECT_PRIORITY = {
  decisions: 0,
  overview: 1,
  todo: 2,
  structure: 3,
  ops: 4,
  quotes: 5,
}

const LEVEL_LABEL = {
  soul: '自我',
  user: '用户',
  rules: '准则',
  project: '项目',
  fact: '事实',
  lesson: '教训',
  topic: '话题',
}

const GLOBAL_PROJECT = '全局'

// ---------------------------------------------------------------- 关键词与文本

export function parseKeywords(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value !== 'string' || value.trim() === '') return []
  const text = value.trim()
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch {
      // 退化为分隔符切分
    }
  }
  return text.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
}

export function keywordString(value) {
  return parseKeywords(value).join(' ')
}

/** 比较用归一化：去标点/空白，转小写。 */
export function normalizeForCompare(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 中文 bigram + 拉丁词；用于相似度与 LIKE 兜底的关键词提取。 */
export function bigrams(text) {
  const normalized = normalizeForCompare(text)
  const chars = Array.from(normalized)
  const result = new Set()
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []
  for (const word of latin) result.add(word)
  const isCjk = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(ch)
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (isCjk(chars[i]) && isCjk(chars[i + 1])) result.add(chars[i] + chars[i + 1])
  }
  return result
}

export function similarity(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.sqrt(left.size * right.size)
}

/** 没标题的条目（迁移来的 fact/topic）用正文首句当索引行。 */
export function deriveTitle(body, maxChars = 40) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return '（无标题）'
  const first = text.split(/[。！？!?\n]/)[0].trim() || text
  const chars = Array.from(first)
  return chars.length <= maxChars ? first : `${chars.slice(0, maxChars).join('')}…`
}

export function hashEntry({ level, project, title, body }) {
  return createHash('sha256')
    .update(`${level}\u0000${project ?? ''}\u0000${title ?? ''}\u0000${body ?? ''}`)
    .digest('hex')
    .slice(0, 32)
}

// ---------------------------------------------------------------- 行映射

export function rowToEntry(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    level: row.level,
    scope: row.scope,
    project: row.project,
    subcategory: row.subcategory,
    goal: row.goal,
    title: row.title,
    body: row.body,
    keywords: parseKeywords(row.keywords),
    importance: row.importance ?? 1,
    status: row.status ?? 'active',
    source_session: row.source_session ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    accessed_at: row.accessed_at ?? null,
    inject_count: row.inject_count ?? 0,
  }
}

// ---------------------------------------------------------------- 写入

function validateEntry(entry) {
  const errors = []
  if (!LEVELS.includes(entry.level)) errors.push(`level 非法：${entry.level}`)
  if (typeof entry.body !== 'string' || entry.body.trim() === '') errors.push('body 不能为空')
  if (entry.level === 'project' && (!entry.project || entry.project.trim() === '')) {
    errors.push('project 层的 project 必填')
  }
  if (entry.subcategory !== undefined && entry.subcategory !== null && !SUBCATEGORIES.includes(entry.subcategory)) {
    errors.push(`subcategory 非法：${entry.subcategory}`)
  }
  return errors
}

export function insertEntry(db, entry, now = Date.now()) {
  const errors = validateEntry(entry)
  if (errors.length > 0) throw new Error(errors.join('；'))
  const id = entry.id ?? newEntryId()
  const title = entry.title && String(entry.title).trim() !== '' ? String(entry.title).trim() : deriveTitle(entry.body)
  const keywords = keywordString(entry.keywords)
  db.prepare(
    `INSERT INTO entries
      (id, level, scope, project, subcategory, goal, title, body, keywords, importance,
       status, source_session, source_hash, created_at, updated_at, accessed_at, inject_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    entry.level,
    entry.scope ?? 'workspace',
    entry.project ?? null,
    entry.subcategory ?? null,
    entry.goal ?? null,
    title,
    entry.body,
    keywords,
    entry.importance ?? 1,
    entry.status ?? 'active',
    entry.source_session ?? null,
    entry.source_hash ?? hashEntry({ level: entry.level, project: entry.project, title, body: entry.body }),
    entry.created_at ?? now,
    entry.updated_at ?? now,
    entry.accessed_at ?? null,
  )
  return getEntry(db, id)
}

export function getEntry(db, id) {
  return rowToEntry(db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id))
}

/** 索引行里只放 id 的短尾巴；mem_read 用这条尾巴回查。 */
export function shortId(id) {
  const text = String(id ?? '')
  return text.length <= 6 ? text : text.slice(-6)
}

/**
 * 按完整 id 或短 id 唯一匹配取条目。
 * @returns {{entry:object|null, ambiguous:boolean}}
 */
export function resolveEntry(db, token) {
  const text = String(token ?? '').trim()
  if (text === '') return { entry: null, ambiguous: false }
  const exact = getEntry(db, text)
  if (exact !== null) return { entry: exact, ambiguous: false }
  const rows = db.prepare(`SELECT * FROM entries WHERE id LIKE ? LIMIT 2`).all(`%${text}`)
  if (rows.length === 1) return { entry: rowToEntry(rows[0]), ambiguous: false }
  return { entry: null, ambiguous: rows.length > 1 }
}

export function updateEntry(db, id, patch, now = Date.now()) {
  const current = getEntry(db, id)
  if (current === null) return null
  const next = { ...current, ...patch }
  const title = next.title && String(next.title).trim() !== '' ? String(next.title).trim() : deriveTitle(next.body)
  db.prepare(
    `UPDATE entries SET
       level = ?, scope = ?, project = ?, subcategory = ?, goal = ?, title = ?, body = ?,
       keywords = ?, importance = ?, status = ?, source_session = ?, source_hash = ?,
       updated_at = ?, accessed_at = ?
     WHERE id = ?`,
  ).run(
    next.level,
    next.scope,
    next.project ?? null,
    next.subcategory ?? null,
    next.goal ?? null,
    title,
    next.body,
    keywordString(next.keywords),
    next.importance ?? 1,
    next.status ?? 'active',
    next.source_session ?? current.source_session ?? null,
    next.source_hash ?? current.source_hash ?? hashEntry({ level: next.level, project: next.project, title, body: next.body }),
    now,
    next.accessed_at ?? current.accessed_at,
    id,
  )
  return getEntry(db, id)
}

/** 同层同项目的候选里找最相似的一条（写入去重与 dream 合并共用）。 */
export function findSimilar(db, entry, { threshold = 0.9, limit = 300 } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM entries
       WHERE level = ? AND status = 'active'
         AND (project IS ? OR project = ?)
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(entry.level, entry.project ?? null, entry.project ?? entry.project ?? '', limit)
  const haystack = `${entry.title ?? ''}\n${entry.body ?? ''}`
  let best = null
  for (const row of rows) {
    if (row.id === entry.id) continue
    const score = similarity(haystack, `${row.title}\n${row.body}`)
    if (best === null || score > best.score) best = { row, score }
  }
  return best !== null && best.score >= threshold ? best : null
}

/**
 * 写入入口：相似度 ≥ 阈值时合并旧条（更新正文/关键词/importance），否则新增。
 * @returns {{action:'inserted'|'merged', entry:object, score?:number}}
 */
export function upsertEntry(db, entry, options = {}, now = Date.now()) {
  const threshold = options.dedupThreshold ?? 0.9
  const similar = findSimilar(db, entry, { threshold })
  if (similar === null) {
    return { action: 'inserted', entry: insertEntry(db, entry, now) }
  }
  const merged = {
    body: String(entry.body ?? '').length >= similar.row.body.length ? entry.body : similar.row.body,
    keywords: [...parseKeywords(similar.row.keywords), ...parseKeywords(entry.keywords)],
    importance: Math.max(similar.row.importance ?? 1, entry.importance ?? 1),
    status: 'active',
  }
  const updated = updateEntry(db, similar.row.id, merged, now)
  return { action: 'merged', entry: updated, score: similar.score }
}

export function archiveEntry(db, id, status = 'archived', now = Date.now()) {
  return updateEntry(db, id, { status }, now)
}

// ---------------------------------------------------------------- 查询与索引投影

export function listByLevel(db, level, { project, status = 'active', limit = 100 } = {}) {
  const clauses = ['level = ?']
  const params = [level]
  if (status !== 'all') {
    clauses.push('status = ?')
    params.push(status)
  }
  if (project !== undefined) {
    clauses.push('project = ?')
    params.push(project)
  }
  params.push(limit)
  return db
    .prepare(`SELECT * FROM entries WHERE ${clauses.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
    .all(...params)
    .map(rowToEntry)
}

/** 全局库的「核心层」：soul / user / rules，输出顺序固定。 */
export function listGlobalCoreRows(db, { limitPerLevel = 12 } = {}) {
  const rows = []
  for (const level of ['soul', 'user', 'rules']) {
    rows.push(
      ...db
        .prepare(`SELECT * FROM entries WHERE level = ? AND status = 'active' ORDER BY importance DESC, updated_at DESC LIMIT ?`)
        .all(level, limitPerLevel)
        .map(rowToEntry),
    )
  }
  return rows
}

/** 全局库里 project='全局' 的 fact/lesson（跨项目事实）。 */
export function listGlobalFactRows(db, { limit = 12 } = {}) {  return db
    .prepare(
      `SELECT * FROM entries
       WHERE level IN ('fact','lesson') AND status = 'active' AND project = ?
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
    )
    .all(GLOBAL_PROJECT, limit)
    .map(rowToEntry)
}

/** 所有 active 条目的关键词原文（门控词表原料，PLAN.md §6 Stage 0 第三类信号）。 */
export function listActiveKeywordRows(db, { limit = 5000 } = {}) {
  if (!db) return []
  return db
    .prepare(`SELECT keywords FROM entries WHERE status = 'active' LIMIT ?`)
    .all(limit)
    .map((row) => row.keywords)
    .filter((value) => typeof value === 'string' && value.trim() !== '')
}

/** 工作区里最近活跃的项目（按最后更新时间倒序）。 */
export function listProjects(db, { limit = 2 } = {}) {
  return db
    .prepare(
      `SELECT project, COUNT(*) AS total, MAX(updated_at) AS last_at
       FROM entries
       WHERE status = 'active' AND level IN ('project','fact','lesson','topic')
         AND project IS NOT NULL AND project <> '' AND project <> ?
       GROUP BY project ORDER BY last_at DESC LIMIT ?`,
    )
    .all(GLOBAL_PROJECT, limit)
}

export function listProjectRows(db, project, { limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT * FROM entries
       WHERE status = 'active' AND project = ? AND level IN ('project','fact','lesson','topic')
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(project, limit)
    .map(rowToEntry)
}

function indexPriority(entry) {
  if (entry.level !== 'project') return 10
  return PROJECT_PRIORITY[entry.subcategory] ?? 9
}

function levelLabel(entry) {
  if (entry.level === 'project') {
    return { overview: '概述', structure: '结构', decisions: '决策', quotes: '原话', ops: '部署', todo: '待办' }[entry.subcategory] ?? '项目'
  }
  return LEVEL_LABEL[entry.level] ?? entry.level
}

/** 一行索引：`- [决策] 标题（3 天前）`，超长截断。 */
export function formatIndexLine(entry, { maxLineChars = 60, now = Date.now() } = {}) {
  const head = `- [${levelLabel(entry)}] `
  const tail = `（${ageLabel(entry.updated_at, now)}）`
  const room = Math.max(8, maxLineChars - Array.from(head).length - Array.from(tail).length)
  const titleChars = Array.from(entry.title ?? '')
  const title = titleChars.length <= room ? titleChars.join('') : `${titleChars.slice(0, room - 1).join('')}…`
  return `${head}${title}${tail}`
}

/**
 * 单个项目的索引投影（PLAN.md §4.3）。
 * @returns {{name:string,total:number,hidden:number,lines:string[]}}
 */
export function projectIndexFor(db, project, { maxRows = 12, maxLineChars = 60, now = Date.now() } = {}) {
  const rows = listProjectRows(db, project, { limit: 200 }).sort((a, b) => {
    const priority = indexPriority(a) - indexPriority(b)
    if (priority !== 0) return priority
    if ((b.importance ?? 1) !== (a.importance ?? 1)) return (b.importance ?? 1) - (a.importance ?? 1)
    return b.updated_at - a.updated_at
  })
  const shown = rows.slice(0, maxRows)
  return {
    name: project,
    total: rows.length,
    hidden: Math.max(0, rows.length - shown.length),
    lines: shown.map((entry) => formatIndexLine(entry, { maxLineChars, now })),
    entries: shown,
  }
}

/**
 * 项目索引投影（PLAN.md §4.3）。
 * @returns {{projects: Array<{name:string,total:number,lines:string[],hidden:number}>}}
 */
export function buildProjectIndex(db, { maxProjects = 2, maxRows = 12, maxLineChars = 60, now = Date.now() } = {}) {
  const projects = listProjects(db, { limit: maxProjects })
  return {
    projects: projects.map((project) => projectIndexFor(db, project.project, { maxRows, maxLineChars, now })),
  }
}

// ---------------------------------------------------------------- 召回

/** 查询词切分：保留 ≥3 字的词给 FTS（trigram 限制），其它给 LIKE。 */
export function queryTerms(query) {
  return String(query ?? '')
    .split(/[\s,，。;；:：!?！？、"'“”‘’()（）]+/u)
    .map((term) => term.trim())
    .filter((term) => Array.from(term).length >= 2)
}

function escapeLike(term) {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 长中文查询拆成 3-gram：整句当子串去 MATCH 命中不了，拆开 OR 才能命中句中的词。 */
function expandTerm(term) {
  const chars = Array.from(term)
  if (!/[\u4e00-\u9fff]/u.test(term)) return [term]
  if (chars.length <= 3) return [term]
  const grams = new Set()
  for (let i = 0; i + 3 <= chars.length; i += 1) grams.add(chars.slice(i, i + 3).join(''))
  return [...grams]
}

/**
 * 混合召回：FTS（≥3 字）优先，结果不足或用短词时用 LIKE 补齐。
 * 打分：FTS rank + importance + 时间衰减；LIKE 命中按 importance + 新旧排。
 * @returns {Array<{entry:object, score:number, via:'fts'|'like'}>}
 */
export function searchEntries(db, query, { limit = 20, project, levels, now = Date.now(), extraTerms = [] } = {}) {
  const seen = new Set()
  const terms = []
  for (const term of [...queryTerms(query), ...extraTerms]) {
    const text = String(term ?? '').trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    terms.push(text)
  }
  if (terms.length === 0) return []
  const longTerms = terms.filter((term) => Array.from(term).length >= 3)
  const shortTerms = terms.filter((term) => Array.from(term).length < 3)
  const gateTerms = new Set(extraTerms.map((term) => String(term ?? '').trim()).filter(Boolean))

  const clauses = [`e.status = 'active'`]
  const params = []
  if (Array.isArray(levels) && levels.length > 0) {
    clauses.push(`e.level IN (${levels.map(() => '?').join(',')})`)
    params.push(...levels)
  }
  if (typeof project === 'string' && project !== '') {
    clauses.push(`(e.project = ? OR e.project = ? OR e.project IS NULL OR e.project = '')`)
    params.push(project, GLOBAL_PROJECT)
  }
  const scopeSql = clauses.join(' AND ')

  // 检索词 → 信号 n-gram（2/3 字）。只用于给候选打分，不直接决定候选集合。
  const signalGrams = new Set()
  for (const term of terms) {
    if (gateTerms.has(term)) continue
    const chars = Array.from(term)
    if (chars.length <= 3) {
      signalGrams.add(term)
      continue
    }
    for (const gram of expandTerm(term)) signalGrams.add(gram)
  }

  const found = new Map()

  if (longTerms.length > 0) {
    const grams = new Set()
    for (const term of longTerms) {
      for (const gram of expandTerm(term)) grams.add(gram)
      if (grams.size >= 24) break
    }
    const match = [...grams].slice(0, 24).map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
    try {
      const rows = db
        .prepare(
          `SELECT e.* FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
           WHERE entries_fts MATCH ? AND ${scopeSql}
           ORDER BY bm25(entries_fts) LIMIT ?`,
        )
        .all(match, ...params, limit)
      for (const row of rows) found.set(row.id, { entry: rowToEntry(row), via: 'fts' })
    } catch {
      // FTS 不可用/查询语法失败 → 交给 LIKE
    }
  }

  const likeTerms = [...shortTerms, ...(found.size === 0 ? longTerms : [])]
  for (const term of likeTerms) {
    const pattern = `%${escapeLike(term)}%`
    try {
      const rows = db
        .prepare(
          `SELECT e.* FROM entries e
           WHERE ${scopeSql} AND (e.title LIKE ? ESCAPE '\\' OR e.keywords LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\')
           ORDER BY e.importance DESC, e.updated_at DESC LIMIT ?`,
        )
        .all(...params, pattern, pattern, pattern, limit)
      for (const row of rows) {
        if (found.has(row.id)) continue
        found.set(row.id, { entry: rowToEntry(row), via: 'like' })
      }
    } catch {
      // 单个词失败不影响其他词
    }
  }

  // 统一打分：命中信号词的强度为主，importance/新鲜度只做小幅加权。
  // 不能直接比 bm25 原始分与 LIKE 分——两者量纲不同，会让「撞上一个通用词」压过真正相关的条目。
  for (const hit of found.values()) {
    const entry = hit.entry
    const haystack = `${entry.title ?? ''}\n${(entry.keywords ?? []).join(' ')}\n${entry.body ?? ''}`.toLowerCase()
    let strength = 0
    for (const term of gateTerms) {
      if (haystack.includes(term.toLowerCase())) strength += 2
    }
    for (const gram of signalGrams) {
      if (haystack.includes(gram.toLowerCase())) strength += 0.4
    }
    const fresh = Math.max(0, 1 - (now - (entry.updated_at ?? now)) / (30 * 24 * 3600 * 1000))
    hit.score = strength + (entry.importance ?? 1) * 0.15 + fresh * 0.15
  }

  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

// ---------------------------------------------------------------- 注入记录与会话

export function markInjected(db, sessionId, entryIds, kind = 'hit', now = Date.now()) {
  const stmt = db.prepare(
    `INSERT INTO injections(session_id, entry_id, kind, at) VALUES(?, ?, ?, ?)
     ON CONFLICT(session_id, entry_id) DO NOTHING`,
  )
  let count = 0
  for (const id of entryIds) {
    try {
      count += stmt.run(sessionId, id, kind, now).changes > 0 ? 1 : 0
    } catch {
      // 单条失败不影响其余
    }
  }
  return count
}

export function injectedIds(db, sessionId) {
  return new Set(
    db
      .prepare(`SELECT entry_id FROM injections WHERE session_id = ?`)
      .all(sessionId)
      .map((row) => row.entry_id),
  )
}

/** 这个会话是否已经做过某一类注入（首轮/压缩重注入用来防重复）。 */
export function hasInjection(db, sessionId, kind) {
  const row = db.prepare(`SELECT 1 AS x FROM injections WHERE session_id = ? AND kind = ? LIMIT 1`).get(sessionId, kind)
  return row !== undefined
}

/** 会话里做过「首轮 / 压缩重注入」中的任意一种（两者都给过核心块）。 */
export function hasCoreInjection(db, sessionId) {
  const row = db
    .prepare(`SELECT 1 AS x FROM injections WHERE session_id = ? AND kind IN ('initial', 'reinject') LIMIT 1`)
    .get(sessionId)
  return row !== undefined
}

/**
 * 压缩重注入的落库（M5）。
 *
 * 为什么不能用 markInjected：injections 主键是 (session_id, entry_id)，首轮已用
 * kind='initial' 插过同一批条目，`ON CONFLICT DO NOTHING` 会把重注入静默吞掉，
 * kind 永远停在 initial —— 「这个会话重注入过」就查不出来了（实测踩到）。
 * 这里用 DO UPDATE 把 kind 升级成 reinject：既补插缺失条目，又让已有条目如实反映
 * 「最近一次给它的注入是压缩重注入」。
 */
export function markReinjected(db, sessionId, entryIds, now = Date.now()) {
  const stmt = db.prepare(
    `INSERT INTO injections(session_id, entry_id, kind, at) VALUES(?, ?, 'reinject', ?)
     ON CONFLICT(session_id, entry_id) DO UPDATE SET kind = 'reinject', at = excluded.at`,
  )
  let count = 0
  for (const id of entryIds) {
    try {
      stmt.run(sessionId, id, now)
      count += 1
    } catch {
      // 单条失败不影响其余
    }
  }
  return count
}

/** 只数「命中注入」的次数：首轮注入的条目不算命中额度，否则额度一开局就被吃光。 */
export function hitInjectionCount(db, sessionId) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM injections WHERE session_id = ? AND kind = 'hit'`).get(sessionId)
  return row?.n ?? 0
}

export function injectionStats(db, sessionId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n, MAX(at) AS last_at FROM injections WHERE session_id = ?`)
    .get(sessionId)
  return { count: row?.n ?? 0, lastAt: row?.last_at ?? null }
}

export function touchSession(db, sessionId, workspace, now = Date.now()) {
  db.prepare(
    `INSERT INTO sessions(session_id, workspace, started_at, last_seen_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, workspace = excluded.workspace`,
  ).run(sessionId, workspace ?? null, now, now)
}

/** 自 since 以来出现过的会话数（dream 门控用，§7）。 */
export function sessionsSince(db, since) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE last_seen_at > ?`).get(since)
  return row?.n ?? 0
}
