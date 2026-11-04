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
import { bigrams, listActiveKeywordRows, normalizeKeyword, searchEntries } from './store.js'

/** 「这条消息可能值得翻记忆」的信号词。宁窄勿宽，误召回比漏召回更吵。 */
const TRIGGER_RE = /(之前|上次|上回|记不记得|还记得|我们说好|说过|提过|为什么|为何|偏好|习惯|教训|别再|注意|记住|remember|recall)/i

/** 纯确认/纯应答：不值得为它翻库。 */
const ACK_RE = /^(好|好的|行|可以|嗯|哦|ok|okay|继续|收到|明白|谢谢|对|是的|没问题)[。！!？?~～\s]*$/i

/** 门控词表上限：几百条库最多几千个 bigram，够用且单次匹配仍是微秒级。 */
const GATE_MAX_TERMS = 4000

/** 片段词至少命中几个才算信号：单个二字片段太容易撞上日常用语。 */
const GATE_MIN_PARTIAL_MATCHES = 2

/**
 * 区分度上限：一个词出现在太多条目里，就不能说明「这条消息和某条记忆有关」。
 * 整词与片段词分开算，片段词更严（它本来就是从长关键词里切出来的）。
 */
const maxDocFreq = (total, ratio, floor) => Math.max(floor, Math.ceil(total * ratio))
const STRONG_DF = { ratio: 0.05, floor: 3 }
const PARTIAL_DF = { ratio: 0.02, floor: 2 }

/** 通用词不当门控信号：「帮我跑一下测试」不该把「拦截测试」翻出来。 */
const GATE_STOP_TERMS = new Set([
  '测试', '检查', '修改', '帮我', '一下', '看看', '什么', '怎么', '哪个', '为何',
  '是否', '可以', '需要', '继续', '问题', '方式', '情况', '时候', '现在', '今天',
  '明天', '一直', '这个', '那个', '我们', '他们', '没有', '不是', '已经', '还是',
  '然后', '因为', '所以', '但是', '如果', '一个', '这次', '上次', '东西', '事情',
  // 编程任务的日常用语：几乎每条指令都会出现，不能说明和哪条记忆有关。
  '代码', '文件', '函数', '页面', '样式', '注释', '报错', '错误', '运行', '重构',
  '工具', '翻译', '解释', '简单', '清晰', '功能', '内容', '方法', '结果', '数据',
  '配置', '脚本', '项目', '处理', '使用', '实现', '添加', '删除', '更新', '优化',
  '英文', '中文', '再试', '应该', '这段', '那段', '一遍', '一次', '有没', '太长',
])

/** 英文同理：只挡最常见的动词和泛称，具体的技术名词仍然有效。 */
const LATIN_STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'not', 'fix', 'add', 'run', 'use', 'test',
  'code', 'file', 'bug', 'error', 'config', 'data', 'new', 'get', 'set', 'update',
])

const isCjk = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(ch)

const isAsciiTerm = (term) => Array.from(term).every((ch) => ch.charCodeAt(0) < 128)
const isWordChar = (ch) => ch !== undefined && /[a-z0-9]/i.test(ch)

/**
 * 门控词表。本身就是「整词」的 Set，片段词单独放 partial：
 * 整词命中一个就算信号，片段词要命中 GATE_MIN_PARTIAL_MATCHES 个才算。
 */
export class GateTerms extends Set {
  partial = new Set()
}

function isStopTerm(term) {
  return GATE_STOP_TERMS.has(term) || LATIN_STOP_TERMS.has(term.toLowerCase())
}

/** 把一条记忆的关键词拆成整词与片段词（同一条内去重，便于算文档频率）。 */
function collectKeywordTerms(raw) {
  const strong = new Set()
  const partial = new Set()
  for (const token of String(raw ?? '').split(/[\s,，;；]+/)) {
    if (token === '' || isStopTerm(token)) continue
    const chars = Array.from(token)
    if (chars.length >= 3 || (chars.length === 2 && chars.every(isCjk))) strong.add(token)
    if (chars.length < 3) continue
    for (let i = 0; i < chars.length - 1; i += 1) {
      if (!isCjk(chars[i]) || !isCjk(chars[i + 1])) continue
      const gram = chars[i] + chars[i + 1]
      if (!isStopTerm(gram)) partial.add(gram)
    }
  }
  for (const term of strong) partial.delete(term)
  return { strong, partial }
}

function selectByDocFreq(freq, limit) {
  return [...freq.entries()]
    .filter(([, count]) => count <= limit)
    .sort((a, b) => a[1] - b[1])
    .map(([term]) => term)
}

/**
 * Stage 0 的第三类信号（PLAN.md §6）：消息里出现记忆条目**关键词**的高 IDF 词。
 * 不另造词表，直接从库里已有的 keywords 生成——作者写关键词时就是在标「这条记忆该被什么话
 * 翻出来」，比硬编码信号词可靠。
 *
 * 两档信号：整词（≥3 字，或 2 字中文词如「精排」）命中一个即可；从长关键词切出的中文片段
 * 单个不算数。两档都按文档频率过滤，词表超限时优先保留最稀有的词。
 */
export function buildGateTerms(globalDb, workspaceDb) {
  const strongFreq = new Map()
  const partialFreq = new Map()
  let total = 0
  for (const db of [globalDb, workspaceDb]) {
    if (!db) continue
    for (const raw of listActiveKeywordRows(db)) {
      total += 1
      const { strong, partial } = collectKeywordTerms(raw)
      for (const term of strong) strongFreq.set(term, (strongFreq.get(term) ?? 0) + 1)
      for (const term of partial) partialFreq.set(term, (partialFreq.get(term) ?? 0) + 1)
    }
  }
  const terms = new GateTerms()
  const strongTerms = selectByDocFreq(strongFreq, maxDocFreq(total, STRONG_DF.ratio, STRONG_DF.floor))
  for (const term of strongTerms.slice(0, GATE_MAX_TERMS)) terms.add(term)
  const room = Math.max(0, GATE_MAX_TERMS - terms.size)
  const partialTerms = selectByDocFreq(partialFreq, maxDocFreq(total, PARTIAL_DF.ratio, PARTIAL_DF.floor))
  for (const term of partialTerms.slice(0, room)) {
    if (!terms.has(term)) terms.partial.add(term)
  }
  return terms
}

/** 英文词要求整词匹配：关键词 log 不该被 login 或 dialog 触发。 */
function containsTerm(hay, term) {
  const needle = term.toLowerCase()
  if (!isAsciiTerm(needle)) return hay.includes(needle)
  let from = 0
  while (from <= hay.length) {
    const at = hay.indexOf(needle, from)
    if (at < 0) return false
    if (!isWordChar(hay[at - 1]) && !isWordChar(hay[at + needle.length])) return true
    from = at + 1
  }
  return false
}

/** 消息命中了哪些门控词（同时用作 Stage 1 的补充检索词）。 */
export function matchGateTerms(text, gateTerms) {
  const trimmed = String(text ?? '')
  if (trimmed === '' || gateTerms === null || gateTerms === undefined) return []
  const hay = trimmed.normalize('NFKC').toLowerCase()
  const compact = normalizeKeyword(hay)
  // 先按原样匹配，再忽略分隔符：消息里写 sub-agent 也能命中关键词 subagent。
  const hits = (term) => {
    if (containsTerm(hay, term)) return true
    const key = normalizeKeyword(term)
    return key !== '' && containsTerm(compact, key)
  }
  const matched = []
  for (const term of gateTerms) {
    if (term.length >= 2 && hits(term)) matched.push(term)
  }
  const partial = [...(gateTerms.partial ?? [])].filter(hits)
  if (partial.length >= GATE_MIN_PARTIAL_MATCHES) matched.push(...partial)
  return matched
}

/**
 * Stage 0：规则门。
 * @param {string} text 当前用户消息
 * @param {{minChars?:number, maxHitsPerSession?:number, injectedCount?:number, projectNames?:string[], enabled?:boolean, gateTerms?:Set<string>, matchedTerms?:string[]}} options
 */
export function shouldRecall(text, options = {}) {
  return gateDecision(text, options).open
}

/**
 * 规则门的完整判断，说明开或不开的原因（账本和 /mem-why 用）。
 * reason：short / quota / ack 不能再开门；nosignal 表示还可以试语义；其余是开门的依据。
 * @returns {{open:boolean, reason:'short'|'quota'|'ack'|'nogate'|'trigger'|'project'|'keyword'|'nosignal'}}
 */
export function gateDecision(text, options = {}) {
  const {
    minChars = 4,
    maxHitsPerSession = 8,
    injectedCount = 0,
    projectNames = [],
    enabled = true,
    gateTerms = null,
    matchedTerms = null,
  } = options
  const trimmed = String(text ?? '').trim()
  if (Array.from(trimmed).length < minChars) return { open: false, reason: 'short' }
  if (injectedCount >= maxHitsPerSession) return { open: false, reason: 'quota' }
  if (ACK_RE.test(trimmed)) return { open: false, reason: 'ack' }
  // 关掉规则门 = 不再要求信号词，每条消息都走粗筛；基本的过滤和配额仍然有效。
  if (!enabled) return { open: true, reason: 'nogate' }
  if (TRIGGER_RE.test(trimmed)) return { open: true, reason: 'trigger' }
  if (projectNames.some((name) => typeof name === 'string' && name.length > 0 && trimmed.includes(name))) {
    return { open: true, reason: 'project' }
  }
  const matched = Array.isArray(matchedTerms) ? matchedTerms : gateTerms === null ? [] : matchGateTerms(trimmed, gateTerms)
  return matched.length > 0 ? { open: true, reason: 'keyword' } : { open: false, reason: 'nosignal' }
}

/** 正文的词有多少已经出现在用户消息里。超过这个比例，再注入也不会带来新信息。 */
const ECHO_COVERAGE = 0.7

/**
 * 用户是不是正在复述这条记忆（「你说过 X 对吧」）。这种时候相似度最高，注入却是多余的。
 * 只看正文：只提到标题的提问，正文对用户来说仍然是新信息。
 */
export function isEcho(text, entry) {
  const body = bigrams(entry?.body ?? '')
  if (body.size < 4) return false
  const message = bigrams(text)
  let covered = 0
  for (const gram of body) if (message.has(gram)) covered += 1
  return covered / body.size >= ECHO_COVERAGE
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
  const { globalDb, workspaceDb, text, topK = 20, exclude = new Set(), now = Date.now(), extraTerms = [], minStrength = 0 } = options
  const merged = new Map()

  const collect = (db, levels) => {
    if (!db) return
    for (const hit of searchEntries(db, text, { limit: topK, levels, now, extraTerms })) {
      if (exclude.has(hit.entry.id)) continue
      // 主动注入宁缺勿滥：只撞上一个片段的候选不进上下文，也不消耗配额。
      if (hit.strength < minStrength) continue
      const existing = merged.get(hit.entry.id)
      if (existing === undefined || hit.score > existing.score) merged.set(hit.entry.id, hit)
    }
  }

  // 核心层（soul/user/rules）已经整段注入，命中不再重复给。
  collect(globalDb, ['fact', 'lesson', 'topic'])
  collect(workspaceDb, ['fact', 'lesson', 'topic', 'project'])

  return [...merged.values()].sort((a, b) => b.score - a.score)
}

/**
 * Stage 1.5：关键词结果与向量结果做 RRF 融合（M6）。
 * 不用原始分数相加：FTS rank 与余弦相似度量纲不同，按名次融合最稳。
 * 只在两路都出现的条目上优势最大，这正是我们想要的。
 */
export function fuseRRF(lexicalHits, vectorHits, { k = 60, exclude = new Set() } = {}) {
  const totals = new Map()
  const entries = new Map()
  const add = (hits, weight) => {
    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index]
      const id = hit.entry?.id
      if (typeof id !== 'string' || exclude.has(id)) continue
      totals.set(id, (totals.get(id) ?? 0) + weight / (k + index + 1))
      if (!entries.has(id)) entries.set(id, hit)
      else if (hit.via === 'vector' && entries.get(id).via !== 'vector') entries.set(id, hit)
    }
  }
  add(lexicalHits, 1)
  add(vectorHits, 1)
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...entries.get(id), score }))
}

function clip(text, maxChars) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim())
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`
}

/** 原因和用法让模型能处理边界情况，只知道结论时很难判断这条是否适用。 */
function hitExtras(entry) {
  const why = entry.why ? ` 原因：${clip(entry.why, 60)}` : ''
  const how = entry.how_to_apply ? ` 用法：${clip(entry.how_to_apply, 60)}` : ''
  return `${why}${how}`
}

/** 命中块的装配：只取少量、只取正文，超预算就少给一条。 */
export function assembleHits(hits, { maxHits = 2, maxCharsPerHit = 180, budget = 450, now = Date.now() } = {}) {
  const picked = []
  let used = 0
  for (const hit of hits) {
    if (picked.length >= maxHits) break
    const text = `${clip(hit.entry.body, maxCharsPerHit)}${hitExtras(hit.entry)}`
    const cost = Array.from(text).length + 24 // 24 ≈ 标签与时间开销
    if (used + cost > budget) break
    picked.push({ entry: hit.entry, text })
    used += cost
  }
  return { picked, used }
}
