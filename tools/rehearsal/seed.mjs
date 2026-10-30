#!/usr/bin/env node
/**
 * 演练种子（全局 + 工作区）。
 *
 * 用法：node tools/rehearsal/seed.mjs --workspace <dir> --global <global.db>
 *
 * 两侧各写一条带 REHEARSAL-MARKER 的记忆：
 *   - 工作区库：证明「当前工作区的记忆」进了首轮注入；
 *   - 全局库：证明「跨项目层」也走通了，且演练数据与真实 D:\ 数据完全隔离。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { openMemoryDb } from '../../src/db.js'
import { insertEntry } from '../../src/store.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') args.workspace = argv[++i]
    else if (argv[i] === '--global') args.global = argv[++i]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (typeof args.workspace !== 'string' || typeof args.global !== 'string') {
  console.error('用法：node tools/rehearsal/seed.mjs --workspace <dir> --global <global.db>')
  process.exit(2)
}

const out = { ok: true, workspace: null, global: null }

function seed(dbPath, entry, mkdirTarget) {
  if (mkdirTarget !== undefined) mkdirSync(mkdirTarget, { recursive: true })
  else mkdirSync(dirname(dbPath), { recursive: true })
  const opened = openMemoryDb(dbPath, { enableFts: true })
  if (!opened.ok) throw new Error(`开库失败 ${dbPath}：${opened.error}`)
  const row = insertEntry(opened.db, entry)
  opened.db.close()
  return row?.id ?? null
}

try {
  out.workspace = seed(join(args.workspace, '.dsh-claude-mem', 'memory.db'), {
    level: 'project',
    scope: 'workspace',
    project: '演练项目',
    subcategory: 'overview',
    title: '演练标记·工作区',
    body: 'REHEARSAL-MARKER-WORKSPACE：工作区层注入链路证明。',
    keywords: ['演练', '标记', '工作区', '注入', '证明', '隔离', '种子'],
    importance: 4,
    status: 'active',
  })

  out.global = seed(args.global, {
    level: 'rules',
    scope: 'global',
    project: '全局',
    title: '演练标记·全局',
    body: 'REHEARSAL-MARKER-GLOBAL：全局层注入链路证明。',
    keywords: ['演练', '标记', '全局', '注入', '证明', '隔离', '种子'],
    importance: 4,
    status: 'active',
  })
} catch (error) {
  out.ok = false
  out.error = error instanceof Error ? error.message : String(error)
}

console.log(JSON.stringify(out))
process.exitCode = out.ok ? 0 : 1
