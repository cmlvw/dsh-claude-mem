/**
 * 老库升级验证：M5 新表（session_notes）在 v1 老库上能不能自动补建、会不会动老数据。
 * 这一步不涉及现网，纯本地临时库。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { dbStats, openMemoryDb } from '../src/db.js'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-cm-oldlib-'))
const p = join(tmp, 'old.db')

// 1) 造一个「没有 session_notes 表」的 v1 老库
const old = new DatabaseSync(p)
old.exec(`
CREATE TABLE entries(
  id TEXT PRIMARY KEY, level TEXT NOT NULL, scope TEXT NOT NULL, project TEXT,
  subcategory TEXT, goal TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
  keywords TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active',
  source_session TEXT, source_hash TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, accessed_at INTEGER, inject_count INTEGER DEFAULT 0
);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
INSERT INTO meta VALUES('schema_version','1');
INSERT INTO entries(id,level,scope,project,title,body,keywords,created_at,updated_at)
  VALUES('old-1','rules','global','全局','老准则','老库里的旧内容','备份,准则',1,1);
`)
old.close()

// 2) 用新代码打开
const reopened = openMemoryDb(p)
const hasNotes = reopened.db
  .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='session_notes'`)
  .get().n === 1
console.log('open ok =', reopened.ok, '| warnings =', reopened.warnings.length)
console.log('session_notes 自动补建 =', hasNotes)
console.log('老条目还在 =', reopened.db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n)
console.log('老正文未改 =', reopened.db.prepare(`SELECT body FROM entries WHERE id='old-1'`).get().body)
console.log('schema_version 未被动 =', reopened.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get().value)
console.log('stats.sessionNotes =', dbStats(reopened.db).sessionNotes)
reopened.db.close()

// 3) 再开一次确认幂等
const again = openMemoryDb(p)
const stillOne = again.db
  .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='session_notes'`)
  .get().n === 1
console.log('二次打开幂等 =', again.ok && stillOne)
again.db.close()

rmSync(tmp, { recursive: true, force: true })
