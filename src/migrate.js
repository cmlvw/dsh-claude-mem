/**
 * dsh-claude-mem · 从 meow-memory 迁移（只读源库）
 *
 * 设计（PLAN.md §9）：
 * - 源库永远只读打开，不改一个字；
 * - 按层路由：soul/user/rules 和 project='全局' 的条目进全局库，其余进工作区库；
 * - source_hash 幂等：重复执行只会跳过，不会制造重复；
 * - 命中密钥的条目不导入，写进目标库的 quarantine 表（留脱敏原文 + 原因）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { insertEntry, deriveTitle, hashEntry, parseKeywords } from './store.js'
import { redactSecrets, scanSecrets } from './secret.js'
import { openMemoryDb } from './db.js'

export const MEOW_TABLES = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

const GLOBAL_LEVELS = new Set(['soul', 'user', 'rules'])
const GLOBAL_PROJECT = '全局'
const UNCATEGORIZED = '未分类'

/** 打开源库，把七张表拍平成统一形状。 */
export function readMeowEntries(sourcePath) {
  if (!existsSync(sourcePath)) throw new Error(`源库不存在：${sourcePath}`)
  const db = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    const present = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((row) => row.name),
    )
    const entries = []
    const warnings = []
    for (const table of MEOW_TABLES) {
      if (!present.has(table)) {
        warnings.push(`源库缺少表 ${table}，跳过`)
        continue
      }
      const rows = db.prepare(`SELECT * FROM ${table}`).all()
      for (const row of rows) entries.push(mapMeowRow(table, row))
    }
    return { entries, warnings }
  } finally {
    db.close()
  }
}

function mapMeowRow(table, row) {
  const project = typeof row.project === 'string' && row.project.trim() !== '' ? row.project.trim() : null
  const scope = GLOBAL_LEVELS.has(table) || project === GLOBAL_PROJECT ? 'global' : 'workspace'
  const body = String(row.content ?? '')
  const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : deriveTitle(body)
  const normalizedProject = scope === 'global' ? GLOBAL_PROJECT : project ?? UNCATEGORIZED
  return {
    level: table,
    scope,
    project: normalizedProject,
    subcategory: table === 'project' ? (row.subcategory ?? null) : null,
    goal: table === 'topic' ? (row.goal ?? null) : null,
    title,
    body,
    keywords: parseKeywords(row.keywords),
    importance: typeof row.importance === 'number' ? row.importance : 1,
    status: typeof row.status === 'string' && row.status !== '' ? row.status : 'active',
    source_session: row.source_session ?? null,
    created_at: typeof row.created_at === 'number' ? row.created_at : Date.now(),
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : Date.now(),
    accessed_at: typeof row.last_accessed_at === 'number' ? row.last_accessed_at : null,
    // 迁移审计用，不写进目标条目
    _source: { table, id: row.id ?? null },
  }
}

function entryHash(entry) {
  return hashEntry({ level: entry.level, project: entry.project, title: entry.title, body: entry.body })
}

function readExistingHashes(dbPath) {
  if (typeof dbPath !== 'string' || !existsSync(dbPath)) return new Set()
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return new Set(
      db
        .prepare(`SELECT source_hash FROM entries WHERE source_hash IS NOT NULL`)
        .all()
        .map((row) => row.source_hash),
    )
  } catch {
    return new Set()
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

function quarantineId(entry) {
  return `q-${createHash('sha256')
    .update(`${entry._source.table}\u0000${entry._source.id ?? ''}\u0000${entry.body}`)
    .digest('hex')
    .slice(0, 16)}`
}

/**
 * 迁移主入口。
 * @param {{sourcePath:string, globalDbPath:string, workspaceDbPath:string, dryRun?:boolean, now?:number}} options
 */
export function migrate(options) {
  const { sourcePath, globalDbPath, workspaceDbPath, dryRun = true, now = Date.now() } = options
  const { entries, warnings } = readMeowEntries(sourcePath)

  const hashes = {
    global: readExistingHashes(globalDbPath),
    workspace: readExistingHashes(workspaceDbPath),
  }

  const plan = {
    sourcePath,
    dryRun,
    targets: { global: globalDbPath, workspace: workspaceDbPath },
    totals: { rows: entries.length, imported: 0, duplicates: 0, quarantined: 0 },
    byLevel: {},
    quarantine: [],
    samples: [],
    warnings: [...warnings],
  }

  const toInsert = { global: [], workspace: [] }

  for (const entry of entries) {
    const bucket = (plan.byLevel[entry.level] ??= { rows: 0, imported: 0, duplicates: 0, quarantined: 0 })
    bucket.rows += 1

    const secret = scanSecrets(`${entry.title}\n${entry.body}\n${entry.keywords.join(' ')}`)
    if (secret.hit) {
      bucket.quarantined += 1
      plan.totals.quarantined += 1
      plan.quarantine.push({
        id: quarantineId(entry),
        source: `${entry._source.table}:${entry._source.id ?? '?'}`,
        level: entry.level,
        reason: secret.rules.join(','),
        excerpt: redactSecrets(entry.body).slice(0, 200),
      })
      continue
    }

    const hash = entryHash(entry)
    if (hashes[entry.scope].has(hash)) {
      bucket.duplicates += 1
      plan.totals.duplicates += 1
      continue
    }
    hashes[entry.scope].add(hash)

    bucket.imported += 1
    plan.totals.imported += 1
    toInsert[entry.scope].push({ ...entry, source_hash: hash, _hash: hash })
    if (plan.samples.length < 5) plan.samples.push(`[${entry.level}] ${entry.title}`)
  }

  if (dryRun) return plan

  // ---- 真正落库 ----
  const globalDb = openMemoryDb(globalDbPath)
  if (!globalDb.ok) throw new Error(`全局库打开失败：${globalDb.error}`)
  const workspaceDb = openMemoryDb(workspaceDbPath)
  if (!workspaceDb.ok) {
    globalDb.db.close()
    throw new Error(`工作区库打开失败：${workspaceDb.error}`)
  }

  try {
    const insertBatch = (db, list) => {
      for (const entry of list) {
        insertEntry(db, {
          level: entry.level, scope: entry.scope, project: entry.project,
          subcategory: entry.subcategory, goal: entry.goal, title: entry.title,
          body: entry.body, keywords: entry.keywords, importance: entry.importance,
          status: entry.status, source_session: entry.source_session,
          source_hash: entry.source_hash, created_at: entry.created_at,
          updated_at: entry.updated_at, accessed_at: entry.accessed_at,
        }, now)
      }
    }
    const transaction = (db, work) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        work()
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch {}
        throw error
      }
    }
    transaction(globalDb.db, () => insertBatch(globalDb.db, toInsert.global))
    transaction(workspaceDb.db, () => {
      insertBatch(workspaceDb.db, toInsert.workspace)
      for (const item of plan.quarantine) {
        workspaceDb.db
          .prepare(`INSERT OR IGNORE INTO quarantine(id, source, raw, reason, at) VALUES(?, ?, ?, ?, ?)`)
          .run(item.id, item.source, item.excerpt, item.reason, now)
      }
    })
    plan.applied = true
  } finally {
    globalDb.db.close()
    workspaceDb.db.close()
  }

  return plan
}
