/**
 * dsh-claude-mem · 记忆整理报告
 *
 * 只读：列出值得人或模型处理的问题，不改任何数据。实际修改走 mem_update，保留判断空间，
 * 也避免自动整理把记忆改坏。mem_review 工具、/mem-review 命令和 mem-admin 共用这份报告。
 */
import { bigrams, hasOppositePolarity, listPendingEntries, parseKeywords, rowToEntry, shortId } from './store.js'
import { listRecentNotes } from './notes.js'
import { hasRelativeDate, scanDirective } from './safety.js'
import { scanPii } from './secret.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_ROWS_SCANNED = 400
const MAX_ITEMS = 10
const DUPLICATE_THRESHOLD = 0.7
const UNUSED_AFTER_DAYS = 60
const REASON_LEVELS = new Set(['rules', 'user', 'lesson'])

function summarize(entry, source) {
  return { id: shortId(entry.id), source, level: entry.level, project: entry.project ?? null, title: entry.title }
}

function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.sqrt(left.size * right.size)
}

function findDuplicates(entries, source) {
  const items = entries.map((entry) => ({ entry, tokens: bigrams(`${entry.title}\n${entry.body}`) }))
  const pairs = []
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].entry
      const b = items[j].entry
      if (a.level !== b.level || (a.project ?? '') !== (b.project ?? '')) continue
      const score = overlap(items[i].tokens, items[j].tokens)
      if (score < DUPLICATE_THRESHOLD) continue
      pairs.push({
        source,
        ids: [shortId(a.id), shortId(b.id)],
        titles: [a.title, b.title],
        score: Number(score.toFixed(2)),
        maybeOpposite: hasOppositePolarity(a.body, b.body),
      })
    }
  }
  return pairs.sort((x, y) => y.score - x.score)
}

/** 已入库条目里所有会被注入的文本。写入检测上线前存进来的内容，靠报告发现。 */
const injectableText = (entry) => [entry.title, entry.body, entry.why, entry.how_to_apply, entry.when_to_use].filter(Boolean).join('\n')

function scanDb(db, source, { keywordMax, now }) {
  const entries = db
    .prepare(`SELECT * FROM entries WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?`)
    .all(MAX_ROWS_SCANNED)
    .map(rowToEntry)
  const unusedCutoff = now - UNUSED_AFTER_DAYS * DAY_MS
  return {
    active: db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE status = 'active'`).get().n,
    duplicates: findDuplicates(entries, source),
    overKeywords: entries.filter((entry) => parseKeywords(entry.keywords).length > keywordMax).map((entry) => summarize(entry, source)),
    missingReason: entries.filter((entry) => REASON_LEVELS.has(entry.level) && !entry.why).map((entry) => summarize(entry, source)),
    unused: entries
      .filter((entry) => !['soul', 'user', 'rules'].includes(entry.level) && (entry.inject_count ?? 0) === 0 && entry.created_at < unusedCutoff)
      .map((entry) => summarize(entry, source)),
    suspicious: entries.flatMap((entry) => {
      const { hit, rules } = scanDirective(injectableText(entry))
      return hit ? [{ ...summarize(entry, source), rules }] : []
    }),
    relativeDates: entries.filter((entry) => hasRelativeDate(injectableText(entry))).map((entry) => summarize(entry, source)),
    privacy: entries.flatMap((entry) => {
      const { hit, rules } = scanPii(`${injectableText(entry)}\n${parseKeywords(entry.keywords).join(' ')}`)
      return hit ? [{ ...summarize(entry, source), rules }] : []
    }),
  }
}

const section = (lists) => {
  const items = lists.flat()
  return { count: items.length, items: items.slice(0, MAX_ITEMS) }
}

/**
 * @param {{globalDb?:object, workspaceDb?:object, keywordMax?:number, notesSince?:number, now?:number}} input
 */
export function buildReviewReport({ globalDb, workspaceDb, keywordMax = 13, notesSince = 0, now = Date.now() }) {
  const sources = [
    ['global', globalDb],
    ['workspace', workspaceDb],
  ].filter(([, db]) => db !== null && db !== undefined)
  const scans = sources.map(([source, db]) => scanDb(db, source, { keywordMax, now }))
  return {
    active: scans.reduce((total, scan) => total + scan.active, 0),
    pending: section(sources.map(([source, db]) => listPendingEntries(db).map((entry) => summarize(entry, source)))),
    duplicates: section(scans.map((scan) => scan.duplicates)),
    overKeywords: section(scans.map((scan) => scan.overKeywords)),
    missingReason: section(scans.map((scan) => scan.missingReason)),
    unused: section(scans.map((scan) => scan.unused)),
    suspicious: section(scans.map((scan) => scan.suspicious)),
    privacy: section(scans.map((scan) => scan.privacy)),
    relativeDates: section(scans.map((scan) => scan.relativeDates)),
    recentNotes: workspaceDb
      ? listRecentNotes(workspaceDb, { since: notesSince, limit: 20 }).map((note) => ({ kind: note.kind, body: note.body, at: note.at }))
      : [],
  }
}

/** 人读版本（/mem-review 与 mem-admin 用）。 */
export function formatReviewText(report) {
  const list = (items, render) => items.map((item) => `  - ${render(item)}`)
  const entryLine = (item) => `${item.id} [${item.level}] ${item.title}`
  const more = ({ count, items }) => (count > items.length ? [`  …还有 ${count - items.length} 条`] : [])
  const lines = [`记忆库共 ${report.active} 条生效。`]

  lines.push(`待确认 ${report.pending.count} 条（/mem-approve <id|all> 批准，/mem-reject <id|all> 拒绝）`)
  lines.push(...list(report.pending.items, entryLine), ...more(report.pending))

  lines.push(`疑似重复 ${report.duplicates.count} 组`)
  lines.push(
    ...list(report.duplicates.items, (pair) => `${pair.ids.join(' / ')} 相似度 ${pair.score}${pair.maybeOpposite ? '（立场可能相反）' : ''}：${pair.titles.join(' / ')}`),
    ...more(report.duplicates),
  )

  lines.push(`关键词超限 ${report.overKeywords.count} 条`)
  lines.push(...list(report.overKeywords.items, entryLine), ...more(report.overKeywords))

  lines.push(`缺少原因 ${report.missingReason.count} 条`)
  lines.push(...list(report.missingReason.items, entryLine), ...more(report.missingReason))

  lines.push(`超过 ${UNUSED_AFTER_DAYS} 天未被注入过 ${report.unused.count} 条`)
  lines.push(...list(report.unused.items, entryLine), ...more(report.unused))

  const flagged = (item) => `${entryLine(item)}（${item.rules.join(', ')}）`
  lines.push(`内容疑似提示注入 ${report.suspicious.count} 条，请确认是否是你自己要记的`)
  lines.push(...list(report.suspicious.items, flagged), ...more(report.suspicious))

  lines.push(`含手机号或身份证号 ${report.privacy.count} 条`)
  lines.push(...list(report.privacy.items, flagged), ...more(report.privacy))

  lines.push(`含相对日期 ${report.relativeDates.count} 条（如「昨天」「上周」，建议改成绝对日期）`)
  lines.push(...list(report.relativeDates.items, entryLine), ...more(report.relativeDates))

  return lines.join('\n')
}
