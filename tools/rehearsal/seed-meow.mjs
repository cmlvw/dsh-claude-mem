#!/usr/bin/env node
/**
 * 演练用：往 meow-memory 自己的库（.dsh-meow/memory.db）写一条可识别记忆。
 * 目的是「回滚之后能断言 meow 真的在工作」，而不是只看它有没有报错。
 *
 * 用法：node tools/rehearsal/seed-meow.mjs <workspaceDir>
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.argv[2]
const dbPath = join(workspace ?? '.', '.dsh-meow', 'memory.db')
if (!existsSync(dbPath)) {
  console.error(`meow 库不存在：${dbPath}（先让 meow 在该工作区跑一次，它会自建）`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
const now = Date.now()
db.prepare(
  `INSERT INTO user (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
).run(
  'meow-rehearsal-1',
  '演练标记（meow）',
  'MEOW-MARKER-ROUNDTRIP：这条是 meow-memory 写的，用于证明回滚后 meow 接管了注入。',
  3,
  JSON.stringify(['演练', '标记', 'meow', '回滚', '接管', '证明']),
  'active',
  'rehearsal',
  now,
  now,
  now,
)
const count = db.prepare('SELECT count(*) c FROM user').get().c
db.close()
console.log(JSON.stringify({ ok: true, dbPath, userRows: count }))
