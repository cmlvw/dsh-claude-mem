#!/usr/bin/env node
/**
 * dsh-claude-mem · 记忆库管理工具（给人用的命令行）
 *
 * 记忆存在 SQLite 里，人看不到内容，错误的记忆可能一直留着。这个工具提供人工审阅的入口。
 * 只读命令用只读方式打开数据库；写入命令默认只预览，加 --yes 才真正执行。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

import { openMemoryDb } from '../src/db.js'
import { DEFAULT_EMBED_MODEL, DEFAULT_EMBED_URL } from '../src/embed.js'
import { embedEntryById, VECTOR_LEVELS } from '../src/vector.js'
import { buildReviewReport, formatReviewText } from '../src/review.js'
import { listPendingEntries, normalizeKeyword, parseKeywords, resolveEntry, rowToEntry, shortId, updateEntry } from '../src/store.js'
import { createTrustStore } from '../src/trust.js'

const USAGE = `用法：node tools/mem-admin.mjs <命令> [选项]

只读：
  review  --db <库>                  整理报告
  export  --db <库> --out <目录>     导出为 Markdown 和 JSON（--all 含已作废的条目）

写入（不加 --yes 只预览）：
  approve --db <库> --id <id|all>    批准待确认条目
  reject  --db <库> --id <id|all>    拒绝待确认条目
  purge   --db <库>                  永久删除已作废的条目（删除前自动备份）
  trust   --data-dir <全局库所在目录> --workspace <工作区目录>
                                     信任工作区的记忆库（只写信任标记）
  clean-keywords --db <库> [--max 13] 去掉重复写法的关键词，超过上限的删到上限（执行前自动备份）
  embed   --db <库> [--url <向量服务>] [--model <模型>]
                                     给还没有向量的条目补向量（要求向量服务在运行）
`

function fail(message) {
  console.error(message)
  process.exit(1)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    out: { type: 'string' },
    id: { type: 'string' },
    all: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'data-dir': { type: 'string' },
    workspace: { type: 'string' },
    max: { type: 'string', default: '13' },
    url: { type: 'string', default: DEFAULT_EMBED_URL },
    model: { type: 'string', default: DEFAULT_EMBED_MODEL },
  },
})
const command = positionals[0]

function requireDbPath() {
  if (!values.db) fail('缺少 --db')
  const path = resolve(values.db)
  if (!existsSync(path)) fail(`找不到记忆库：${path}`)
  return path
}

function openReadOnly() {
  return new DatabaseSync(requireDbPath(), { readOnly: true })
}

function openWritable() {
  const opened = openMemoryDb(requireDbPath())
  if (!opened.ok) fail(`打开记忆库失败：${opened.error}`)
  return opened.db
}

function hasColumn(db, name) {
  return db.prepare(`PRAGMA table_info(entries)`).all().some((column) => column.name === name)
}

function entryMarkdown(entry) {
  const meta = [
    `- id: ${entry.id}`,
    `- 状态: ${entry.status} · 重要性: ${entry.importance} · 被注入: ${entry.inject_count} 次`,
    entry.project ? `- 项目: ${entry.project}${entry.subcategory ? ` / ${entry.subcategory}` : ''}` : null,
    `- 更新: ${new Date(entry.updated_at).toISOString()}`,
    entry.keywords.length > 0 ? `- 关键词: ${entry.keywords.join('、')}` : null,
  ].filter(Boolean)
  const details = [
    entry.why ? `**原因：** ${entry.why}` : null,
    entry.how_to_apply ? `**用法：** ${entry.how_to_apply}` : null,
    entry.when_to_use ? `**何时用：** ${entry.when_to_use}` : null,
    entry.goal ? `**目标：** ${entry.goal}` : null,
  ].filter(Boolean)
  return [`## ${entry.title}`, '', ...meta, '', entry.body, ...(details.length > 0 ? ['', ...details] : []), ''].join('\n')
}

function runExport() {
  if (!values.out) fail('缺少 --out')
  const db = openReadOnly()
  try {
    const where = values.all ? '' : `WHERE status <> 'archived'`
    const entries = db.prepare(`SELECT * FROM entries ${where} ORDER BY level, project, updated_at DESC`).all().map(rowToEntry)
    const outDir = resolve(values.out)
    mkdirSync(outDir, { recursive: true })
    const byLevel = new Map()
    for (const entry of entries) {
      if (!byLevel.has(entry.level)) byLevel.set(entry.level, [])
      byLevel.get(entry.level).push(entry)
    }
    for (const [level, items] of byLevel) {
      writeFileSync(join(outDir, `${level}.md`), `# ${level}（${items.length} 条）\n\n${items.map(entryMarkdown).join('\n')}`, 'utf8')
    }
    writeFileSync(join(outDir, 'entries.json'), `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    console.log(`已导出 ${entries.length} 条到 ${outDir}。导出文件含记忆原文，请注意保管。`)
  } finally {
    db.close()
  }
}

function runReview() {
  const db = openReadOnly()
  try {
    if (!hasColumn(db, 'why')) fail('这个库还是旧版本结构，插件打开一次后才能生成报告（或先运行写入命令升级）。')
    console.log(formatReviewText(buildReviewReport({ workspaceDb: db })))
  } finally {
    db.close()
  }
}

function runSettle(status, verb) {
  if (!values.id) fail('缺少 --id')
  const db = openWritable()
  try {
    let targets
    if (values.id.toLowerCase() === 'all') {
      targets = listPendingEntries(db, { limit: 1000 })
    } else {
      const { entry, ambiguous } = resolveEntry(db, values.id)
      if (ambiguous) fail(`id 有歧义：${values.id}`)
      if (entry === null) fail(`没找到：${values.id}`)
      if (entry.status !== 'pending') fail(`${shortId(entry.id)} 不是待确认状态（当前 ${entry.status}）`)
      targets = [entry]
    }
    for (const entry of targets) {
      console.log(`${values.yes ? verb : `将${verb}`}：${shortId(entry.id)} [${entry.level}] ${entry.title}`)
      if (values.yes) updateEntry(db, entry.id, { status })
    }
    if (targets.length === 0) console.log('没有待确认的条目。')
    else if (!values.yes) console.log('以上为预览，加 --yes 执行。')
  } finally {
    db.close()
  }
}

function runPurge() {
  const path = requireDbPath()
  const db = openWritable()
  try {
    const rows = db.prepare(`SELECT id, level, title FROM entries WHERE status = 'archived'`).all()
    for (const row of rows) console.log(`${values.yes ? '删除' : '将删除'}：${shortId(row.id)} [${row.level}] ${row.title}`)
    if (rows.length === 0) {
      console.log('没有已作废的条目。')
      return
    }
    if (!values.yes) {
      console.log(`共 ${rows.length} 条。以上为预览，加 --yes 执行（删除前会自动备份）。`)
      return
    }
    const backup = `${path}.bak-purge-${Date.now()}`
    db.prepare(`VACUUM INTO ?`).run(backup)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`DELETE FROM entry_vectors WHERE entry_id IN (SELECT id FROM entries WHERE status = 'archived')`)
      db.exec(`DELETE FROM injections WHERE entry_id IN (SELECT id FROM entries WHERE status = 'archived')`)
      db.exec(`DELETE FROM entries WHERE status = 'archived'`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    console.log(`已删除 ${rows.length} 条。备份在 ${backup}（含被删内容，确认无误后可自行删除）。`)
  } finally {
    db.close()
  }
}

function runTrust() {
  if (!values['data-dir'] || !values.workspace) fail('需要 --data-dir 和 --workspace')
  const workspace = resolve(values.workspace)
  const store = createTrustStore(join(resolve(values['data-dir']), 'trusted-workspaces'))
  if (store.isTrusted(workspace)) {
    console.log(`${workspace} 已在信任名单中。`)
    return
  }
  if (!values.yes) {
    console.log(`将信任 ${workspace} 的记忆库。以上为预览，加 --yes 执行。`)
    return
  }
  if (!store.trust(workspace, 'mem-admin')) fail('写入信任标记失败。')
  console.log(`已信任 ${workspace} 的记忆库。`)
}

/**
 * 清理关键词：去掉同一条里写法不同的重复词，超过上限的删到上限。
 * 优先删正文里已经有的词（全文检索仍然能搜到它），其次删很多条目都有的词（区分度低），
 * 只有关键词才能命中的词尽量保留。这不算内容更新，所以不动 updated_at。
 */
function runCleanKeywords() {
  const path = requireDbPath()
  const db = openWritable()
  try {
    const max = Number(values.max)
    if (!Number.isInteger(max) || max < 2) fail('--max 必须是不小于 2 的整数')
    const rows = db.prepare(`SELECT id, level, title, body, keywords, why, how_to_apply, when_to_use FROM entries WHERE status <> 'archived'`).all()
    const docFreq = new Map()
    for (const row of rows) {
      for (const keyword of parseKeywords(row.keywords)) {
        const key = normalizeKeyword(keyword)
        docFreq.set(key, (docFreq.get(key) ?? 0) + 1)
      }
    }
    const changes = []
    for (const row of rows) {
      const unique = parseKeywords(row.keywords)
      const text = normalizeKeyword([row.title, row.body, row.why, row.how_to_apply, row.when_to_use].filter(Boolean).join(' '))
      const ranked = unique
        .map((keyword, position) => ({ keyword, position, inText: text.includes(normalizeKeyword(keyword)), df: docFreq.get(normalizeKeyword(keyword)) ?? 0 }))
        .sort((a, b) => Number(a.inText) - Number(b.inText) || a.df - b.df || a.position - b.position)
      const kept = new Set(ranked.slice(0, max).map((item) => item.keyword))
      const next = unique.filter((keyword) => kept.has(keyword)).join(' ')
      if (next !== String(row.keywords).trim()) changes.push({ row, next, removed: String(row.keywords).trim().split(/\s+/).length - kept.size })
    }
    if (changes.length === 0) {
      console.log('没有需要清理的条目。')
      return
    }
    const removed = changes.reduce((total, change) => total + change.removed, 0)
    if (!values.yes) {
      console.log(`将清理 ${changes.length} 条，共删除 ${removed} 个关键词。以上为预览，加 --yes 执行（执行前会自动备份）。`)
      return
    }
    const backup = `${path}.bak-keywords-${Date.now()}`
    db.prepare(`VACUUM INTO ?`).run(backup)
    const update = db.prepare(`UPDATE entries SET keywords = ? WHERE id = ?`)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const { row, next } of changes) update.run(next, row.id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    console.log(`已清理 ${changes.length} 条，共删除 ${removed} 个关键词。备份在 ${backup}。`)
  } finally {
    db.close()
  }
}

async function runEmbed() {
  const db = openWritable()
  try {
    const rows = db
      .prepare(
        `SELECT e.id, e.level, e.title FROM entries e LEFT JOIN entry_vectors v ON v.entry_id = e.id AND v.model = ?
         WHERE e.status = 'active' AND e.level IN (${VECTOR_LEVELS.map(() => '?').join(',')}) AND v.entry_id IS NULL`,
      )
      .all(values.model, ...VECTOR_LEVELS)
    if (rows.length === 0) {
      console.log('所有条目都有向量了。')
      return
    }
    if (!values.yes) {
      console.log(`有 ${rows.length} 条没有向量。以上为预览，加 --yes 执行。`)
      return
    }
    let done = 0
    for (const row of rows) {
      // 第一条可能要等模型重新加载，超时给足。
      if (await embedEntryById(db, row.id, { url: values.url, model: values.model, timeoutMs: 20000 })) done += 1
    }
    console.log(`已补 ${done} / ${rows.length} 条。${done < rows.length ? '其余失败，请检查向量服务是否在运行。' : ''}`)
  } finally {
    db.close()
  }
}

switch (command) {
  case 'clean-keywords':
    runCleanKeywords()
    break
  case 'embed':
    await runEmbed()
    break
  case 'review':
    runReview()
    break
  case 'export':
    runExport()
    break
  case 'approve':
    runSettle('active', '批准')
    break
  case 'reject':
    runSettle('archived', '拒绝')
    break
  case 'purge':
    runPurge()
    break
  case 'trust':
    runTrust()
    break
  default:
    console.log(USAGE)
    if (command !== undefined && command !== 'help') process.exit(1)
}
