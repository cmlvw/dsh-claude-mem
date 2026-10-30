/**
 * dsh-claude-mem · 注入文本装配
 *
 * 两种块（PLAN.md §5）：
 * - 核心块：每会话一次。soul/rules/user 给全文（它们短、且是行为依据），
 *   项目只给索引行（带 6 位短 id），全局 fact/lesson 不进核心块、只走命中。
 * - 命中块：每轮按需，≤N 条正文，超预算少给一条，没有命中就不出现。
 *
 * 预算按「行」累加，装不下就丢；丢弃数会写进返回值，供 M2/后续观测用。
 */
import {
  formatIndexLine,
  listGlobalCoreRows,
  listProjects,
  projectIndexFor,
  shortId,
} from './store.js'
import { scanSecrets } from './secret.js'
import { ageLabel, needsFreshnessWarning } from './time.js'

const CORE_TAG = { soul: '自我', rules: '准则', user: '用户' }
const CORE_ORDER = { rules: 0, user: 1, soul: 2 }

function safeEntry(entry) {
  if (!entry) return false
  return !scanSecrets(`${entry.title ?? ''}\n${entry.body ?? ''}\n${(entry.keywords ?? []).join(' ')}`).hit
}

function dateLabel(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function truncate(text, maxChars) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim())
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`
}

function coreLine(entry, maxChars) {
  const tag = CORE_TAG[entry.level] ?? entry.level
  return `[${tag}·${shortId(entry.id)}] ${truncate(entry.body, maxChars)}`
}

function projectLine(entry, { maxLineChars, now }) {
  // 把短 id 塞进行首，这样索引本身就能支撑 mem_read。
  const line = formatIndexLine(entry, { maxLineChars: Math.max(20, maxLineChars - 7), now })
  return line.replace(/^- /, `- ${shortId(entry.id)} `)
}

/**
 * 核心块装配（纯函数，便于单测）。
 * 先预留头尾两行的预算，再按「行」装正文；页脚永远在，避免模型不知道短 id 怎么用。
 * @param {{coreRows:object[], projectIndex:?object, budget:number, now:number, maxBodyChars?:number, maxLineChars?:number}} input
 */
export function renderCore(input) {
  const { coreRows = [], projectIndex = null, budget = 1600, now = Date.now(), maxBodyChars = 160 } = input
  const maxLineChars = input.maxLineChars ?? 60

  const headerLine = `【长期记忆 · ${dateLabel(now)}】`
  const footerLine = '需要正文用 mem_read(短id)；超过 1 天的条目是时间点观察，断言前先验证。'
  const cost = (line) => Array.from(line).length + 1

  let remaining = budget - cost(headerLine) - cost(footerLine)
  const dropped = []
  if (remaining < 0) {
    return { text: headerLine, ids: [], dropped: 1, chars: cost(headerLine) }
  }

  const body = []
  const ids = []
  const push = (line, id) => {
    const lineCost = cost(line)
    if (lineCost > remaining) {
      dropped.push(line)
      return false
    }
    body.push(line)
    remaining -= lineCost
    if (typeof id === 'string') ids.push(id)
    return true
  }

  const sorted = [...coreRows].sort((a, b) => {
    const order = (CORE_ORDER[a.level] ?? 9) - (CORE_ORDER[b.level] ?? 9)
    if (order !== 0) return order
    if ((b.importance ?? 1) !== (a.importance ?? 1)) return (b.importance ?? 1) - (a.importance ?? 1)
    return b.updated_at - a.updated_at
  })

  for (const entry of sorted) {
    push(coreLine(entry, maxBodyChars), entry.id)
  }

  if (projectIndex !== null && projectIndex.entries.length > 0) {
    const lines = projectIndex.entries.map((entry) => ({
      entry,
      line: projectLine(entry, { maxLineChars, now }),
    }))
    // 预算不够时先减行、再决定标题里的「显示 N 条」，不写一个装不下的数字。
    const headerFor = (n) => `项目「${projectIndex.name}」· ${projectIndex.total} 条（显示 ${n} 条）`
    let n = lines.length
    let header = headerFor(n)
    const sum = (items) => items.reduce((total, item) => total + cost(item.line), 0)
    while (n > 0 && cost(header) + sum(lines.slice(0, n)) > remaining) {
      n -= 1
      header = headerFor(n)
    }
    if (n > 0 && cost(header) <= remaining) {
      push(header)
      for (const item of lines.slice(0, n)) push(item.line, item.entry.id)
      if (projectIndex.total > n) {
        const more = `（还有 ${projectIndex.total - n} 条：mem_project("${projectIndex.name}")）`
        push(more)
      }
      if (n < lines.length) dropped.push(...lines.slice(n).map((item) => item.line))
    } else {
      dropped.push(header)
    }
  }

  const lines = [headerLine, ...body, footerLine]
  return {
    text: lines.join('\n'),
    ids,
    dropped: dropped.length,
    chars: lines.reduce((total, line) => total + cost(line), 0),
  }
}

/** 从两个库收集核心块原料，再交给 renderCore。
 *  projectDetected 由调用方显式告知：true=真识别到项目（铺满 maxIndexRows 行），
 *  false=只兜底给 1 行「最近项目」提示。不传时按 project 是否为 null 保守推断。 */
export function collectCore({ globalDb, workspaceDb, cfg, project = null, projectDetected, now = Date.now() }) {
  const coreRows = listGlobalCoreRows(globalDb, { limitPerLevel: 12 }).filter(safeEntry)
  const names = listProjects(workspaceDb, { limit: 20 }).map((row) => row.project)
  const detected = typeof projectDetected === 'boolean' ? projectDetected : project !== null
  const chosen = project ?? names[0] ?? null
  const rawIndex =
    chosen === null
      ? null
      : projectIndexFor(workspaceDb, chosen, {
          maxRows: detected ? cfg.inject.maxIndexRows : 1,
          maxLineChars: cfg.inject.maxIndexLineChars,
          now,
        })
  const index = rawIndex === null ? null : {
    ...rawIndex,
    entries: (rawIndex.entries ?? []).filter(safeEntry),
    total: (rawIndex.entries ?? []).filter(safeEntry).length,
  }
  const rendered = renderCore({
    coreRows,
    projectIndex: index,
    budget: cfg.inject.firstTurnBudget,
    now,
    maxLineChars: cfg.inject.maxIndexLineChars,
  })
  return { ...rendered, project: chosen, projectNames: names, projectDetected: detected }
}

/** 命中块装配。warn 只在 >1 天时加，避免每条都挂免责声明。 */
export function renderHitBlock(picked, { now = Date.now() } = {}) {
  const safePicked = picked.filter(({ entry, text }) => safeEntry(entry) && !scanSecrets(String(text ?? '')).hit)
  if (safePicked.length === 0) return ''
  const lines = ['【记忆命中】']
  for (const { entry, text } of safePicked) {
    const tag = CORE_TAG[entry.level] ?? { fact: '事实', lesson: '教训', topic: '话题', project: '项目' }[entry.level] ?? entry.level
    const warn = needsFreshnessWarning(entry.updated_at, now) ? '（时间点观察，非实时，断言前先验证）' : ''
    lines.push(`- [${tag}·${shortId(entry.id)}] ${text}（${ageLabel(entry.updated_at, now)}）${warn}`)
  }
  return lines.join('\n')
}

/** 粗估 token（中文约 1.6 字/token；只用于报告，不作为硬判断）。 */
export function estimateTokens(chars) {
  return Math.ceil(chars / 1.6)
}
