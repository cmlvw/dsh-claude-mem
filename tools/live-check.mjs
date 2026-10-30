#!/usr/bin/env node
/**
 * dsh-claude-mem · M4 真机只读验证
 *
 * 用**真实的**全局库与工作区库（只读打开，不写），验证五个工具在现网数据结构上可用：
 * 检索、读取、项目全景。不写库、不改配置、不重启。
 *
 * 用法：node tools/live-check.mjs [工作区路径]
 * 默认工作区 = C:\Users\User\.dsh\profiles\desktop
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { defaultConfig, resolveConfig } from '../src/config.js'
import { projectOverview, readMemory, searchMemory } from '../src/tools.js'
import { listProjects, shortId } from '../src/store.js'

const workspace = process.argv[2] ?? 'C:\\Users\\User\\.dsh\\profiles\\desktop'
const resolved = resolveConfig({})
const cfg = defaultConfig()

const results = []
function check(label, pass, detail = '') {
  results.push({ label, pass, detail })
}

function openReadOnly(path) {
  if (!existsSync(path)) return null
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

const globalPath = resolved.globalDbPath
const workspacePath = resolved.workspaceDbPath(workspace)
const globalDb = openReadOnly(globalPath)
const workspaceDb = openReadOnly(workspacePath)

try {
  check('全局库可只读打开', globalDb !== null, globalPath)
  check('工作区库可只读打开', workspaceDb !== null, workspacePath)
  if (workspaceDb !== null) {
    const count = workspaceDb.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n
    check('工作区库有条目', count > 0, `entries=${count}`)

    const projects = listProjects(workspaceDb, { limit: 50 }).map((row) => row.project)
    check('能列出项目', projects.length > 0, projects.slice(0, 6).join(','))

    // mem_project 全景
    const overview = projectOverview(workspaceDb, globalDb, { project: projects[0], maxRows: 10 }, cfg)
    check('mem_project 返回项目全景', overview.ok === true && overview.total > 0, `${overview.project} total=${overview.total}`)

    // 取一条真实条目，走短 id 读取
    const sample = workspaceDb.prepare(`SELECT * FROM entries WHERE status='active' ORDER BY updated_at DESC LIMIT 1`).get()
    if (sample !== undefined) {
      const short = shortId(sample.id)
      const read = readMemory(globalDb, workspaceDb, { id: short })
      check('mem_read 按短 id 取到真实条目', read.ok === true && read.full_id === sample.id, `${short} → ${read.ok}`)
      check('全文非空', read.ok === true && String(read.body ?? '').length > 0, String(read.body ?? '').slice(0, 30))
    }

    // mem_search 用真实关键词
    const kw = workspaceDb
      .prepare(`SELECT keywords FROM entries WHERE status='active' AND keywords <> '' LIMIT 1`)
      .get()
    if (kw !== undefined) {
      const term = String(kw.keywords).split(' ').slice(0, 2).join(' ')
      const found = searchMemory(globalDb, workspaceDb, { query: term, k: 5 }, cfg)
      check('mem_search 在真实库上检索', found.ok === true, `query="${term}" hits=${found.hits.length}`)
    }
  }
} finally {
  try {
    globalDb?.close()
  } catch {}
  try {
    workspaceDb?.close()
  } catch {}
}

const failed = results.filter((r) => !r.pass)
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  ← ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1
