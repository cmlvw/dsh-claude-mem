#!/usr/bin/env node
/**
 * dsh-claude-mem · M2 缺口证据：从 DSH 会话日志里取 meow-memory 的**真实首轮注入**
 *
 * 为什么从会话日志取：这是端到端产物（插件在真实 pre-step 里插进消息流的原文），
 * 不是用模拟数据重算的估算值。只读会话日志，不碰现网、不加载插件、不写任何库。
 *
 * 用法：
 *   node tools/meow-baseline.mjs                       # 扫全部工作区
 *   node tools/meow-baseline.mjs --workspace desktop   # 只看目录名含 desktop 的
 *   node tools/meow-baseline.mjs --json
 *
 * 口径：
 * - 取每个会话里第一条 `source.kind === 'plugin:meow-memory' && form === 'snapshot'`
 *   的 user 消息，按 Array.from(text).length 计数（码点，与 inject-preview 一致）。
 * - 只取「长期记忆」section 的正文，不含 __meta__（那是插件自己的 ids 元数据）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS_ROOT = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'sessions')
  : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')

function parseArgs(argv) {
  const args = { json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') args.workspace = argv[++i]
    else if (argv[i] === '--json') args.json = true
    else throw new Error(`未知参数：${argv[i]}`)
  }
  return args
}

/** 会话文件名兼容 .jsonl.zstd / .jsonl / 目录内 session.v4.jsonl.zstd。 */
function readSessionText(file) {
  try {
    const buf = readFileSync(file)
    if (file.endsWith('.zstd')) return zstdDecompressSync(buf).toString('utf8')
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

function extractFirstTurn(text) {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const source = record?.data?.source
    if (source?.kind !== 'plugin:meow-memory' || source?.form !== 'snapshot') continue
    const sections = Array.isArray(source.sections) ? source.sections : []
    const main = sections.find((section) => section?.name && section.name !== '__meta__')
    if (!main || typeof main.text !== 'string') continue
    return {
      chars: Array.from(main.text).length,
      lines: main.text.split('\n').length,
      ids: (sections.find((section) => section?.name === '__meta__')?.text ?? '').length,
      head: main.text.split('\n').slice(0, 1).join(''),
    }
  }
  return null
}

const args = parseArgs(process.argv.slice(2))
const workspaces = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => args.workspace === undefined || name.includes(args.workspace))

const rows = []
for (const workspace of workspaces) {
  const dir = join(SESSIONS_ROOT, workspace)
  let sessions = []
  try {
    sessions = readdirSync(dir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const sessionDir = join(dir, session.name)
    let files = []
    try {
      files = readdirSync(sessionDir).filter((file) => file.includes('jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(sessionDir, file)
      const found = extractFirstTurn(readSessionText(path))
      if (found !== null) {
        let mtime = 0
        try {
          mtime = statSync(path).mtimeMs
        } catch {}
        rows.push({ workspace, session: session.name, file, mtime, ...found })
        break
      }
    }
  }
}

if (args.json) {
  console.log(JSON.stringify({ sessionsRoot: SESSIONS_ROOT, rows }, null, 2))
} else {
  console.log(`会话根：${SESSIONS_ROOT}`)
  console.log(`找到 ${rows.length} 个含 meow 首轮快照的会话\n`)
  const byWorkspace = new Map()
  for (const row of rows) {
    const list = byWorkspace.get(row.workspace) ?? []
    list.push(row)
    byWorkspace.set(row.workspace, list)
  }
  for (const [workspace, list] of byWorkspace) {
    const sorted = [...list].sort((a, b) => a.mtime - b.mtime)
    console.log(`${workspace}`)
    for (const row of sorted) {
      const stamp = new Date(row.mtime).toISOString().slice(0, 16).replace('T', ' ')
      console.log(`  ${stamp}  ${row.chars} 字 / ${row.lines} 行  （${row.session.slice(0, 20)}…）`)
    }
  }
}
