/**
 * dsh-claude-mem · SQLite 骨架
 *
 * 只用 Node 内置 node:sqlite（Node ≥22.5，本机 24.22.1 / SQLite 3.53.4 实测可用）。
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

export const SCHEMA_VERSION = 1

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
  inject_count INTEGER DEFAULT 0
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
      db.exec(`PRAGMA journal_mode = WAL`)
      db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`)
      db.exec(`PRAGMA foreign_keys = ON`)
    } catch (error) {
      warnings.push(`PRAGMA 设置失败（不致命）：${error instanceof Error ? error.message : String(error)}`)
    }

    db.exec(CORE_DDL)

    let fts = false
    if (enableFts) {
      try {
        db.exec(FTS_DDL)
        fts = true
      } catch (error) {
        warnings.push(`FTS5(trigram) 不可用，召回将退化为 LIKE：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    stampSchema(db)
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

/** 写 schema_version（首次建库写当前版本；未来升级在此分叉）。 */
function stampSchema(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()
  if (row === undefined) {
    db.prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?)`).run(String(SCHEMA_VERSION))
    db.prepare(`INSERT INTO meta(key, value) VALUES('created_at', ?)`).run(String(Date.now()))
  }
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
