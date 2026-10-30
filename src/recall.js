/**
 * dsh-claude-mem · 召回（Stage 0 规则门 + Stage 1 混合检索 + Stage 3 装配输入）
 *
 * 设计（PLAN.md §6）：
 * - Stage 0 是「该不该查记忆」的判断，不是关键词匹配的替代：短消息、纯确认、
 *   本会话命中已满，一律不问记忆。没有命中就零注入。
 * - Stage 1 复用 store.searchEntries（FTS trigram + LIKE 兜底），全局库与
 *   工作区库各查一次，按分数合并。
 * - Stage 2 语义精排默认关（§13-B），这里只留接口位，不引入模型依赖。
 */
import { listActiveKeywordRows, searchEntries } from './store.js'

/** 「这条消息可能值得翻记忆」的信号词。宁窄勿宽，误召回比漏召回更吵。 */
const TRIGGER_RE = /(之前|上次|上回|记不记得|还记得|我们说好|说过|提过|为什么|为何|偏好|习惯|教训|别再|注意|记住|remember|recall)/i

/** 纯确认/纯应答：不值得为它翻库。 */
const ACK_RE = /^(好|好的|行|可以|嗯|哦|ok|okay|继续|收到|明白|谢谢|对|是的|没问题)[。！!？?~～\s]*$/i

/** 门控词表上限：几百条库最多几千个 bigram，够用且单次匹配仍是微秒级。 */
const GATE_MAX_TERMS = 4000

/** 2 字通用词不当门控信号：「帮我跑一下测试」不该把「拦截测试」翻出来。 */
const GATE_STOP_TERMS = new Set([
  '测试', '检查', '修改', '帮我', '一下', '看看', '什么', '怎么', '哪个', '为何',
  '是否', '可以', '需要', '继续', '问题', '方式', '情况', '时候', '现在', '今天',
  '明天', '一直', '这个', '那个', '我们', '他们', '没有', '不是', '已经', '还是',
  '然后', '因为', '所以', '但是', '如果', '一个', '这次', '上次', '东西', '事情',
])

const isCjk = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(ch)

function addKeywordTerms(terms, raw) {
  for (const token of String(raw ?? '').split(/[\s,，;；]+/)) {
    if (token === '') continue
    const chars = Array.from(token)
    if (chars.length >= 3) terms.add(token)
    for (let i = 0; i < chars.length - 1; i += 1) {
      if (!isCjk(chars[i]) || !isCjk(chars[i + 1])) continue
      const gram = chars[i] + chars[i + 1]
      if (!GATE_STOP_TERMS.has(gram)) terms.add(gram)
    }
  }
}

/**
 * Stage 0 的第三类信号（PLAN.md §6）：消息里出现记忆条目**关键词**的高 IDF 词。
 * 不另造词表，直接从库里已有的 keywords 生成——作者写关键词时就是在标「这条记忆该被什么话
 * 翻出来」，比硬编码信号词可靠。整词 ≥3 字 + 中文 bigram，覆盖 2 字实体（「精排」）。
 */
export function buildGateTerms(globalDb, workspaceDb) {
  const terms = new Set()
  for (const db of [globalDb, workspaceDb]) {
    if (!db) continue
    for (const raw of listActiveKeywordRows(db)) {
      addKeywordTerms(terms, raw)
      if (terms.size >= GATE_MAX_TERMS) return terms
    }
  }
  return terms
}

/** 消息命中了哪些门控词（同时用作 Stage 1 的补充检索词）。 */
export function matchGateTerms(text, gateTerms) {
  const trimmed = String(text ?? '')
  if (trimmed === '' || gateTerms === null || gateTerms === undefined) return []
  const hay = trimmed.toLowerCase()
  const matched = []
  for (const term of gateTerms) {
    if (term.length >= 2 && hay.includes(term.toLowerCase())) matched.push(term)
  }
  return matched
}

/**
 * Stage 0：规则门。
 * @param {string} text 当前用户消息
 * @param {{minChars?:number, maxHitsPerSession?:number, injectedCount?:number, projectNames?:string[], enabled?:boolean, gateTerms?:Set<string>, matchedTerms?:string[]}} options
 */
export function shouldRecall(text, options = {}) {
  const {
    minChars = 4,
    maxHitsPerSession = 8,
    injectedCount = 0,
    projectNames = [],
    enabled = true,
    gateTerms = null,
    matchedTerms = null,
  } = options
  if (!enabled) return false
  const trimmed = String(text ?? '').trim()
  if (Array.from(trimmed).length < minChars) return false
  if (injectedCount >= maxHitsPerSession) return false
  if (ACK_RE.test(trimmed)) return false
  if (TRIGGER_RE.test(trimmed)) return true
  if (projectNames.some((name) => typeof name === 'string' && name.length > 0 && trimmed.includes(name))) return true
  const matched = Array.isArray(matchedTerms) ? matchedTerms : gateTerms === null ? [] : matchGateTerms(trimmed, gateTerms)
  return matched.length > 0
}

/** 从消息里认出当前项目名（用于首轮选索引、命中加权）。 */
export function detectProject(text, projectNames) {
  const trimmed = String(text ?? '')
  for (const name of projectNames) {
    if (typeof name === 'string' && name.length >= 2 && trimmed.includes(name)) return name
  }
  return null
}

/**
 * Stage 1：两个库各查一次，合并去重。
 * @returns {Array<{entry:object, score:number, via:string}>}
 */
export function recall(options) {
  const { globalDb, workspaceDb, text, topK = 20, exclude = new Set(), now = Date.now(), extraTerms = [] } = options
  const merged = new Map()

  const collect = (db, levels) => {
    if (!db) return
    for (const hit of searchEntries(db, text, { limit: topK, levels, now, extraTerms })) {
      if (exclude.has(hit.entry.id)) continue
      const existing = merged.get(hit.entry.id)
      if (existing === undefined || hit.score > existing.score) merged.set(hit.entry.id, hit)
    }
  }

  // 核心层（soul/user/rules）已经整段注入，命中不再重复给。
  collect(globalDb, ['fact', 'lesson', 'topic'])
  collect(workspaceDb, ['fact', 'lesson', 'topic', 'project'])

  return [...merged.values()].sort((a, b) => b.score - a.score)
}

/** 命中块的装配：只取少量、只取正文，超预算就少给一条。 */
export function assembleHits(hits, { maxHits = 2, maxCharsPerHit = 180, budget = 450, now = Date.now() } = {}) {
  const picked = []
  let used = 0
  for (const hit of hits) {
    if (picked.length >= maxHits) break
    const body = String(hit.entry.body ?? '').replace(/\s+/g, ' ').trim()
    const chars = Array.from(body)
    const text = chars.length <= maxCharsPerHit ? body : `${chars.slice(0, maxCharsPerHit - 1).join('')}…`
    const cost = Array.from(text).length + 24 // 24 ≈ 标签与时间开销
    if (used + cost > budget) break
    picked.push({ entry: hit.entry, text })
    used += cost
  }
  return { picked, used }
}
