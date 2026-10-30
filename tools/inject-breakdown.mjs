#!/usr/bin/env node
/**
 * dsh-claude-mem · 首轮核心块的字数构成（M2 缺口 / user 层取舍的证据来源）
 *
 * 用真库真数据跑 renderCore，把 1596 字拆成：核心层各层多少字、项目索引多少字，
 * 并给出「去掉某一层」的对照。只读，不写库。
 *
 * 用法：
 *   node tools/inject-breakdown.mjs --workspace "C:\Users\User\.dsh\profiles\desktop"
 *   node tools/inject-breakdown.mjs --workspace ... --project 自有记忆插件
 */
import { resolveConfig } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import { renderCore } from '../src/inject.js'
import { listGlobalCoreRows, projectIndexFor } from '../src/store.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') args.workspace = argv[++i]
    else if (argv[i] === '--project') args.project = argv[++i]
    else throw new Error(`未知参数：${argv[i]}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.workspace) throw new Error('必须给 --workspace')
const resolved = resolveConfig({})
const globalDb = openMemoryDb(resolved.globalDbPath, { enableFts: resolved.config.db.enableFts })
const workspaceDb = openMemoryDb(resolved.workspaceDbPath(args.workspace), { enableFts: resolved.config.db.enableFts })
if (!globalDb.ok) throw new Error(`全局库打不开：${globalDb.error}`)
if (!workspaceDb.ok) throw new Error(`工作区库打不开：${workspaceDb.error}`)

try {
  const rows = listGlobalCoreRows(globalDb.db, { limitPerLevel: 12 })
  const byLevel = {}
  for (const entry of rows) byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1

  const render = (coreRows, projectIndex) =>
    renderCore({ coreRows, projectIndex, budget: resolved.config.inject.firstTurnBudget, now: Date.now() })

  const coreOnly = render(rows, null)
  console.log(`核心层（soul/user/rules）：${coreOnly.chars} 字，${coreOnly.ids.length} 条，丢 ${coreOnly.dropped} 行`)
  console.log(`  分层条数：${JSON.stringify(byLevel)}`)

  for (const level of ['user', 'rules', 'soul']) {
    const subset = rows.filter((entry) => entry.level === level)
    if (subset.length === 0) {
      console.log(`  ${level}：0 条`)
      continue
    }
    const only = render(subset, null)
    const withOthers = render(rows.filter((entry) => entry.level !== level), null)
    console.log(
      `  ${level}：${subset.length} 条｜单独渲染 ${only.chars} 字（含头尾 ${only.chars - subset.reduce((n, e) => n + Array.from(e.body).length, 0)} 字固定开销）｜去掉它剩 ${withOthers.chars} 字（省 ${coreOnly.chars - withOthers.chars} 字）`,
    )
  }

  const projectName = args.project ?? null
  if (projectName !== null) {
    const index = projectIndexFor(workspaceDb.db, projectName, {
      maxRows: resolved.config.inject.maxIndexRows,
      maxLineChars: resolved.config.inject.maxIndexLineChars,
      now: Date.now(),
    })
    const withProject = render(rows, index)
    console.log(
      `\n项目「${projectName}」索引：共 ${index.total} 条，首轮装下 ${index.lines.length} 行｜增量 ${withProject.chars - coreOnly.chars} 字`,
    )
    console.log(`完整首轮块：${withProject.chars} 字，${withProject.ids.length} 条，丢 ${withProject.dropped} 行`)
  }
} finally {
  try {
    globalDb.db.close()
  } catch {}
  try {
    workspaceDb.db.close()
  } catch {}
}
