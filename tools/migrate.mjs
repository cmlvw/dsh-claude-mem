#!/usr/bin/env node
/**
 * dsh-claude-mem · 迁移 CLI（meow-memory → dsh-claude-mem）
 *
 * 默认 dry-run：只读源库、只统计，不写任何目标库。
 * 确认报告后才加 --apply。
 *
 * 用法：
 *   node tools/migrate.mjs --from "<workspace>/.dsh-meow/memory.db"
 *   node tools/migrate.mjs --from ... --apply
 * 可选：--global <global.db>  --workspace <dir>  --json
 */
import { dirname, isAbsolute, resolve } from 'node:path'

import { resolveConfig } from '../src/config.js'
import { migrate } from '../src/migrate.js'

function parseArgs(argv) {
  const args = { dryRun: true, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--from':
        args.from = argv[++i]
        break
      case '--global':
        args.global = argv[++i]
        break
      case '--workspace':
        args.workspace = argv[++i]
        break
      case '--apply':
        args.dryRun = false
        break
      case '--json':
        args.json = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }
  return args
}

function printReport(report) {
  console.log(`source : ${report.sourcePath}`)
  console.log(`mode   : ${report.dryRun ? 'DRY-RUN（不写库）' : 'APPLY（已写库）'}`)
  console.log(`global : ${report.targets.global}`)
  console.log(`worksp.: ${report.targets.workspace}`)
  console.log('')
  console.log('level      rows  import  dup  quarantine')
  for (const [level, stat] of Object.entries(report.byLevel)) {
    console.log(
      `${level.padEnd(10)} ${String(stat.rows).padStart(4)}  ${String(stat.imported).padStart(6)}  ${String(stat.duplicates).padStart(3)}  ${String(stat.quarantined).padStart(10)}`,
    )
  }
  const t = report.totals
  console.log(`${'合计'.padEnd(9)} ${String(t.rows).padStart(5)}  ${String(t.imported).padStart(6)}  ${String(t.duplicates).padStart(3)}  ${String(t.quarantined).padStart(10)}`)
  if (report.quarantine.length > 0) {
    console.log('\n隔离样本（脱敏）：')
    for (const item of report.quarantine.slice(0, 5)) console.log(`  - ${item.source} [${item.reason}] ${item.excerpt.replace(/\s+/g, ' ').slice(0, 80)}`)
  }
  if (report.samples.length > 0) {
    console.log('\n导入样本：')
    for (const sample of report.samples) console.log(`  - ${sample}`)
  }
  for (const warning of report.warnings) console.log(`warning: ${warning}`)
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || typeof args.from !== 'string') {
    console.log('用法：node tools/migrate.mjs --from <meow memory.db> [--apply] [--global <path>] [--workspace <dir>] [--json]')
    process.exit(args.help ? 0 : 2)
  }
  const sourcePath = isAbsolute(args.from) ? args.from : resolve(args.from)
  const workspace = args.workspace ?? dirname(dirname(sourcePath))
  const globalDbPath = args.global ?? resolveConfig({}).globalDbPath
  const report = migrate({
    sourcePath,
    globalDbPath,
    workspaceDbPath: resolve(workspace, '.dsh-claude-mem', 'memory.db'),
    dryRun: args.dryRun,
  })
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
} catch (error) {
  console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
