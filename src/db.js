/**
 * dsh-claude-mem · SQLite 骨架
 *
 * 只用 Node 内置 node:sqlite（Node ≥22.13 无需实验参数，本机 24.22.1 / SQLite 3.53.4 实测可用）。
 * 表结构严格对齐 PLAN.md §4.2；两个库（全局/工作区）共用同一套 DDL。
 *
 * 实测约束（M0 发现，M3 召回要用）：
 * - FTS5 trigram 只索引 ≥3 字符的序列，2 字中文词（如「部署」「插件」）MATCH 命不中；
 *   所以 recall 层对 <3 字的查询要走 LIKE 兜底，不能只依赖 MATCH。
 * - trigram 支持子串匹配（「记忆插」「全局库」命中），这正是中文需要的。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 2

/** v2 新增的条目字段：记下「为什么」和「什么时候用」，只加列，旧版本插件仍能读这个库。 */
const V2_ENTRY_COLUMNS = [
  ['why', 'TEXT'],
  ['how_to_apply', 'TEXT'],
  ['when_to_use', 'TEXT'],
  ['corrected', 'INTEGER DEFAULT 0'],
]

/** 核心表（§4.2）。 */
const CORE_DDL = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  project TEXT,
  subcategory TEXT,
  goal TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  keywords TEXT NOT NULL,
  importance INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  source_session TEXT,
  source_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accessed_at INTEGER,
  inject_count INTEGER DEFAULT 0,
  why TEXT,
  how_to_apply TEXT,
  when_to_use TEXT,
  corrected INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entries_level_status ON entries(level, status);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project, status);
CREATE INDEX IF NOT EXISTS idx_entries_source_hash ON entries(source_hash);
CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at DESC);

CREATE TABLE IF NOT EXISTS injections (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (session_id, entry_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  workspace TEXT,
  started_at INTEGER,
  last_seen_at INTEGER,
  injected_chars INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dream_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  sessions_since INTEGER DEFAULT 0,
  rounds INTEGER DEFAULT 0,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS quarantine (
  id TEXT PRIMARY KEY,
  source TEXT,
  raw TEXT,
  reason TEXT,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- M5 增量表：会话笔记。只写不注入，先跑观察（PLAN §7）。
-- 追加式 DDL 用 IF NOT EXISTS 幂等补建：老库打开时自动补表，
-- 因此不必升 schema_version（不破坏既有断言）。
CREATE TABLE IF NOT EXISTS session_notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_notes_session ON session_notes(session_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_session_notes_ws ON session_notes(workspace, at DESC);

-- M6 语义召回：条目向量（BLOB = float32 小端，入库前已 L2 归一化）。
-- 换模型或换维度时靠 model/dim 判断是否要重算；text_hash 变化才重新 embed。
CREATE TABLE IF NOT EXISTS entry_vectors (
  entry_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  vec BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 召回账本：按天聚合的计数，不含任何用户原话或记忆内容。
CREATE TABLE IF NOT EXISTS recall_stats (
  day TEXT NOT NULL,
  outcome TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, outcome)
);
`

/** FTS5（外部内容表 + 同步触发器）。失败则由调用方降级。 */
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, keywords, body,
  content='entries', content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, keywords, body)
  VALUES (new.rowid, new.title, new.keywords, new.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, keywords, body)
  VALUES ('delete', old.rowid, old.title, old.keywords, old.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, keywords, body)
  VALUES ('delete', old.rowid, old.title, old.keywords, old.body);
  INSERT INTO entries_fts(rowid, title, keywords, body)
  VALUES (new.rowid, new.title, new.keywords, new.body);
END;
`

/**
 * 打开（必要时创建）一个记忆库。永不 throw：失败时返回 { ok:false, error }。
 * @returns {{ok:true, db:DatabaseSync, path:string, fts:boolean, warnings:string[]} | {ok:false, path:string, error:string, warnings:string[]}}
 */
export function openMemoryDb(filePath, options = {}) {
  const warnings = []
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000
  const enableFts = options.enableFts !== false
  try {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const db = new DatabaseSync(filePath)
    try {
      // busy_timeout 必须最先设：切换 WAL 也要拿锁，多个会话同时启动时否则会立刻失败。
      db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`)
      db.exec(`PRAGMA journal_mode = WAL`)
      db.exec(`PRAGMA foreign_keys = ON`)
    } catch (error) {
      warnings.push(`PRAGMA 设置失败（不致命）：${error instanceof Error ? error.message : String(error)}`)
    }

    db.exec(CORE_DDL)
    migrateSchema(db, filePath, warnings)

    let fts = false
    if (enableFts) {
      try {
        db.exec(FTS_DDL)
        fts = true
        rebuildFtsIfStale(db, warnings)
      } catch (error) {
        warnings.push(`FTS5(trigram) 不可用，召回将退化为 LIKE：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return { ok: true, db, path: filePath, fts, warnings }
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
      warnings,
    }
  }
}

function missingEntryColumns(db) {
  const existing = new Set(db.prepare(`PRAGMA table_info(entries)`).all().map((column) => column.name))
  return V2_ENTRY_COLUMNS.filter(([name]) => !existing.has(name))
}

/** 升级前留一份备份：VACUUM INTO 在 WAL 下也能得到一致的快照。已有备份就不重复做。 */
function backupBeforeMigration(db, filePath, version, warnings) {
  const entries = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n
  if (entries === 0) return
  const target = `${filePath}.bak-schema${version}`
  if (existsSync(target)) return
  try {
    db.prepare(`VACUUM INTO ?`).run(target)
  } catch (error) {
    warnings.push(`升级前备份失败（继续升级，只新增字段不改旧数据）：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 建库时写入版本；旧库按版本升级。
 * 比当前版本更新的库不做任何改动，只给警告，避免旧插件破坏新库。
 */
function migrateSchema(db, filePath, warnings) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()
  const version = row === undefined ? null : Number(row.value)
  if (version !== null && version > SCHEMA_VERSION) {
    warnings.push(`记忆库版本 ${version} 高于插件支持的 ${SCHEMA_VERSION}（${filePath}），请升级插件。`)
    return
  }
  if (version === SCHEMA_VERSION && missingEntryColumns(db).length === 0) return

  if (version !== null) backupBeforeMigration(db, filePath, version, warnings)
  db.exec('BEGIN IMMEDIATE')
  try {
    // 拿到写锁后再查一次：另一个会话可能刚做完同样的升级。
    for (const [name, type] of missingEntryColumns(db)) {
      db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${type}`)
    }
    writeMeta(db, 'schema_version', SCHEMA_VERSION)
    if (version === null) writeMeta(db, 'created_at', Date.now())
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误
    }
    throw error
  }
}

/** 后开启 FTS 或索引损坏时，旧条目不在索引里：行数对不上就重建。 */
function rebuildFtsIfStale(db, warnings) {
  const indexed = db.prepare(`SELECT COUNT(*) AS n FROM entries_fts_docsize`).get().n
  const total = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n
  if (indexed === total) return
  db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`)
  warnings.push(`全文索引与条目数不一致（${indexed}/${total}），已重建。`)
}

export function readMeta(db, key) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)
  return row === undefined ? null : row.value
}

export function writeMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value))
}

export function schemaVersion(db) {
  const v = readMeta(db, 'schema_version')
  return v === null ? 0 : Number(v)
}

/** 统计（load-check 与测试的观测点）。 */
export function dbStats(db) {
  const count = (table) => {
    try {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    } catch {
      return -1
    }
  }
  return {
    entries: count('entries'),
    injections: count('injections'),
    sessions: count('sessions'),
    quarantine: count('quarantine'),
    sessionNotes: count('session_notes'),
    schemaVersion: schemaVersion(db),
  }
}

/** 生成条目 id：<毫秒时间戳>-<6位随机>，id 顺序 ≈ 创建顺序（§4.2）。 */
export function newEntryId() {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `${Date.now()}-${rand}`
}
