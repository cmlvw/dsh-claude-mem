/**
 * dsh-claude-mem · 记忆基准评测的核心逻辑（CLI 见 tools/bench-memory.mjs）
 *
 * 所有数据集先归一成「世界」：一组按时间排列的会话 + 针对它们的若干探针题。
 * LongMemEval 每题自带一份会话历史（一题一个世界）；harness-sessions 是一个世界多道题。
 *
 * 证据用「组」表示：每组是一条需要的事实，组内任一会话命中就算这条事实到手。
 * LongMemEval 的 answer_session_ids 每个会话一组；harness 的事实可能出现在多个会话，同属一组。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderHitBlock } from '../../src/inject.js'
import { runRecall } from '../../src/pipeline.js'
import { buildGateTerms, matchGateTerms, recall } from '../../src/recall.js'
import { insertEntry } from '../../src/store.js'
import { rememberInto } from '../../src/tools.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DAY_MS = 24 * 3600 * 1000

export const BENCH_PROJECT = 'bench'
export const RECALL_KS = [1, 2, 5, 10, 20]
/** 召回只查这几层；核心层（soul/user/rules）走整段注入，这个 runner 不覆盖。 */
const RECALLABLE_LEVELS = new Set(['fact', 'lesson', 'topic', 'project'])

// ---------------------------------------------------------------- 数据集

/** LongMemEval 的时间形如 `2023/05/20 (Sat) 02:21`；harness 是 `2026-10-01`。 */
export function parseBenchDate(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s*\([^)]*\))?(?:\s+(\d{1,2}):(\d{2}))?/.exec(text)
  if (match === null) return null
  const [, y, mo, d, h = '0', mi = '0'] = match
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
}

function normalizeLongMemEval(records) {
  return records.map((record) => {
    const ids = record.haystack_session_ids ?? []
    const dates = record.haystack_dates ?? []
    const sessions = (record.haystack_sessions ?? []).map((messages, index) => ({
      id: String(ids[index] ?? `s${index}`),
      ts: parseBenchDate(dates[index]),
      date: String(dates[index] ?? ''),
      messages: messages.map((message) => ({ role: message.role, text: String(message.content ?? '') })),
    }))
    const abstain = String(record.question_id).endsWith('_abs')
    return {
      id: String(record.question_id),
      sessions,
      probes: [
        {
          id: String(record.question_id),
          type: record.question_type,
          abstain,
          question: String(record.question),
          answer: String(record.answer ?? ''),
          evidence: abstain ? [] : (record.answer_session_ids ?? []).map((id) => [String(id)]),
          ts: parseBenchDate(record.question_date),
          date: String(record.question_date ?? ''),
        },
      ],
    }
  })
}

function normalizeHarness(raw) {
  const sessions = raw.sessions.map((session) => ({
    id: String(session.id),
    ts: parseBenchDate(session.date),
    date: String(session.date ?? ''),
    messages: session.messages.map((message) => ({ role: message.role, text: String(message.text ?? '') })),
  }))
  const facts = new Map(raw.gold.facts.map((fact) => [fact.name, fact]))
  const lastTs = Math.max(...sessions.map((session) => session.ts ?? 0))
  const questionTs = parseBenchDate(raw.gold.question_date) ?? lastTs + DAY_MS
  const probes = raw.gold.probes.map((probe, index) => {
    const expected = (probe.expect ?? []).map((name) => {
      const fact = facts.get(name)
      if (fact === undefined) throw new Error(`探针 ${index} 引用了不存在的事实：${name}`)
      return fact
    })
    return {
      id: String(probe.id ?? `${raw.name}-${index}`),
      type: probe.kind,
      abstain: probe.kind === 'abstention' || expected.length === 0,
      question: String(probe.q),
      answer: String(probe.answer ?? expected.map((fact) => fact.description).join('; ')),
      tags: probe.tags ?? [],
      keys: probe.keys ?? [],
      stale: probe.stale ?? [],
      // 被推翻的事实只认最新那次，答旧值不算到手。
      evidence: expected.map((fact) =>
        fact.label === 'updated' ? [String(fact.answer_from)] : fact.evidence_sessions.map(String),
      ),
      ts: questionTs,
      date: new Date(questionTs).toISOString().slice(0, 10),
    }
  })
  return [{ id: String(raw.name), sessions, probes, memories: raw.gold.memories ?? [] }]
}

/** 证据指向不存在的会话时分数没有意义，直接报错，不要静默算成漏召回。 */
export function validateWorlds(worlds) {
  const issues = []
  for (const world of worlds) {
    const ids = new Set(world.sessions.map((session) => session.id))
    if (world.sessions.length === 0) issues.push(`${world.id}：没有会话历史`)
    for (const probe of world.probes) {
      // 字段名对不上时证据会全空，所有题静默得零分，比报错难发现得多。
      if (!probe.abstain && probe.evidence.length === 0) issues.push(`${probe.id}：不是拒答题却没有证据会话`)
      for (const group of probe.evidence) {
        if (!group.some((id) => ids.has(id))) issues.push(`${probe.id}：证据会话 ${group.join('/')} 不在历史里`)
      }
    }
  }
  return issues
}

/** 按内容识别格式：数组是 LongMemEval，带 gold 的对象是 harness-sessions。 */
export function normalizeDataset(raw) {
  if (Array.isArray(raw)) return { format: 'longmemeval', worlds: normalizeLongMemEval(raw) }
  if (raw?.gold !== undefined && Array.isArray(raw.sessions)) return { format: 'harness-sessions', worlds: normalizeHarness(raw) }
  throw new Error('认不出数据集格式：需要 LongMemEval 数组或 harness-sessions 对象')
}

function mulberry32(seed) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled(items, rand) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 名额够时每层至少一题，其余按比例分（最大余数法），总数严格等于 n。 */
function allocate(sizes, n) {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  const quota = sizes.map(() => 0)
  let left = Math.min(n, total)
  if (left >= sizes.length) {
    quota.fill(1)
    left -= sizes.length
  }
  const room = sizes.map((size, index) => size - quota[index])
  const roomTotal = room.reduce((sum, size) => sum + size, 0)
  const shares = room.map((size) => (roomTotal === 0 ? 0 : (size / roomTotal) * left))
  shares.forEach((share, index) => {
    quota[index] += Math.floor(share)
  })
  let rest = Math.min(n, total) - quota.reduce((sum, value) => sum + value, 0)
  const order = shares
    .map((share, index) => ({ index, frac: share - Math.floor(share) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index)
  for (let round = 0; rest > 0 && round < order.length * 2; round += 1) {
    const { index } = order[round % order.length]
    if (quota[index] < sizes[index]) {
      quota[index] += 1
      rest -= 1
    }
  }
  return quota
}

/** 按题型分层抽样，拒答题单独成层。n=0 表示全量。同一 seed 结果不变。 */
export function sampleProbes(worlds, n, seed) {
  if (!Number.isInteger(n) || n <= 0) return worlds
  const rand = mulberry32(seed)
  const strata = new Map()
  for (const world of worlds) {
    for (const probe of world.probes) {
      const key = probe.abstain ? 'abstention' : probe.type
      if (!strata.has(key)) strata.set(key, [])
      strata.get(key).push(probe.id)
    }
  }
  const keys = [...strata.keys()].sort()
  const quota = allocate(keys.map((key) => strata.get(key).length), n)
  const picked = new Set()
  keys.forEach((key, index) => {
    for (const id of shuffled(strata.get(key), rand).slice(0, quota[index])) picked.add(id)
  })
  return worlds
    .map((world) => ({ ...world, probes: world.probes.filter((probe) => picked.has(probe.id)) }))
    .filter((world) => world.probes.length > 0)
}

// ---------------------------------------------------------------- 免 LLM 写入

const EN_STOP = new Set(
  'about after again all also and any are because been before being between both but can could did does doing during each for from get had has have having her here him his how into its just like more most much not now off one only our out over same she should some such than that the their them then there these they this those through too under use very was were what when where which while who why will with would you your yours'.split(
    ' ',
  ),
)

export function tokenize(text) {
  const tokens = []
  const normalized = String(text ?? '').normalize('NFKC').toLowerCase()
  for (const [token] of normalized.matchAll(/[a-z0-9][a-z0-9_-]{2,}|[㐀-鿿]{2,}/g)) {
    if (/^[a-z0-9]/.test(token)) {
      if (!EN_STOP.has(token) && !/^\d+$/.test(token)) tokens.push(token)
      continue
    }
    const chars = Array.from(token)
    if (chars.length <= 4) tokens.push(token)
    else for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1])
  }
  return tokens
}

/** 取世界内最稀有的词当关键词。这是替模型标关键词的启发式，不是插件行为。 */
export function deriveKeywords(text, docFreq, max = 13) {
  return [...new Set(tokenize(text))]
    .sort((a, b) => (docFreq.get(a) ?? 0) - (docFreq.get(b) ?? 0) || b.length - a.length || (a < b ? -1 : 1))
    .slice(0, max)
}

/** 按句切块，单句超长才硬切。 */
export function chunkText(text, maxChars = 300) {
  const sentences = String(text ?? '').replace(/\s+/g, ' ').trim().match(/[^。！？.!?]+[。！？.!?]*\s*/gu) ?? []
  const chunks = []
  let current = ''
  const flush = () => {
    if (current.trim() !== '') chunks.push(current.trim())
    current = ''
  }
  for (const sentence of sentences) {
    const chars = Array.from(sentence)
    if (chars.length > maxChars) {
      flush()
      for (let i = 0; i < chars.length; i += maxChars) chunks.push(chars.slice(i, i + maxChars).join('').trim())
      continue
    }
    if (Array.from(current).length + chars.length > maxChars) flush()
    current += sentence
  }
  flush()
  return chunks.filter((chunk) => chunk !== '')
}

function ingestRaw({ world, db, shift, provenance, stats }) {
  const rows = []
  const docFreq = new Map()
  for (const session of world.sessions) {
    for (const message of session.messages) {
      for (const chunk of chunkText(message.text)) {
        const body = `${message.role}: ${chunk}`
        rows.push({ session, body })
        for (const token of new Set(tokenize(chunk))) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
      }
    }
  }
  db.exec('BEGIN')
  try {
    for (const { session, body } of rows) {
      const entry = insertEntry(
        db,
        { level: 'topic', project: BENCH_PROJECT, body, keywords: deriveKeywords(body, docFreq), source_session: session.id },
        sessionTime(session, world, shift),
      )
      provenance.set(entry.id, new Set([session.id]))
      stats.inserted += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// ---------------------------------------------------------------- 理想记忆写入

const GOLD_MIN_KEYWORDS = 8
const FACT_MAX_CHARS = 60

/**
 * 把数据集标注的记忆当成模型写好的内容，走真实的校验和去重合并。
 * 它假设提取完美，用来单独看检索和注入。关键词只从记忆和所属会话机械生成，不看题目，
 * 否则出题人的措辞会漏进索引。
 */
function ingestGold({ world, db, cfg, shift, provenance, stats }) {
  if (world.memories === undefined || world.memories.length === 0) throw new Error('--ingest gold 需要数据集带 gold.memories')
  const sessions = new Map(world.sessions.map((session) => [session.id, session]))
  const docFreq = new Map()
  for (const { content } of world.memories) {
    for (const token of new Set(tokenize(content))) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
  }
  const ordered = [...world.memories].sort((a, b) => (sessions.get(a.session)?.ts ?? 0) - (sessions.get(b.session)?.ts ?? 0))
  for (const { session: sessionId, content } of ordered) {
    const session = sessions.get(sessionId)
    if (session === undefined) throw new Error(`记忆引用了不存在的会话：${sessionId}`)
    const keywords = deriveKeywords(content, docFreq)
    if (keywords.length < GOLD_MIN_KEYWORDS) {
      const context = session.messages.map((message) => message.text).join(' ')
      for (const word of deriveKeywords(context, docFreq)) {
        if (keywords.length >= GOLD_MIN_KEYWORDS) break
        if (!keywords.includes(word)) keywords.push(word)
      }
    }
    const level = Array.from(content).length <= FACT_MAX_CHARS ? 'fact' : 'topic'
    const result = rememberInto(db, { level, content, keywords, project: BENCH_PROJECT }, cfg, sessionTime(session, world, shift))
    if (!result.ok) {
      countRejected(stats, String(result.error).replace(/[：:].*$/, ''))
      continue
    }
    if (result.merged) stats.merged += 1
    else stats.inserted += 1
    const sources = provenance.get(result.id) ?? new Set()
    sources.add(sessionId)
    provenance.set(result.id, sources)
  }
}

// ---------------------------------------------------------------- LLM 写入

/** 用插件自己的工具说明，模型看到的写入规则才和线上一致。 */
function loadRememberDoc() {
  const zh = JSON.parse(readFileSync(join(HERE, '..', '..', 'src', 'prompts', 'zh.json'), 'utf8'))
  const { description, param } = zh.tools.remember
  const params = ['level', 'content', 'title', 'subcategory', 'keywords', 'importance', 'why', 'how_to_apply', 'when_to_use']
    .map((name) => `- ${name}: ${param[name]}`)
    .join('\n')
  return { guide: zh.guide, description, params }
}

export function buildExtractionMessages(session, maxItems) {
  const doc = loadRememberDoc()
  const system = [
    doc.guide,
    '',
    `mem_remember 工具：${doc.description}`,
    '参数：',
    doc.params,
    '',
    '现在一段会话已经结束，请决定要为它调用几次 mem_remember。',
    `只输出 JSON 数组，每个元素是一次调用的参数，最多 ${maxItems} 个；没有值得记的就输出 []。`,
    'level 只能用 fact / lesson / topic / project（用户偏好也写成这几层），level=project 时要给 subcategory。',
    '内容沿用会话的语言。相对日期要按会话日期换算成绝对日期。',
    'keywords 必须是 8–13 个不含空格的词。fact/lesson 超过 60 字就改用 topic，topic 不超过 300 字。',
  ].join('\n')
  const transcript = session.messages
    .map((message) => `${message.role.toUpperCase()}: ${message.text.replace(/\s+/g, ' ').slice(0, 6000)}`)
    .join('\n\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: `会话日期：${session.date || '未知'}\n\n${transcript}` },
  ]
}

/** @returns {object[]|null} null = 模型没给出可解析的 JSON（和「没有值得记的」要分开统计）。 */
export function parseExtraction(text) {
  const stripped = String(text ?? '').replace(/```(?:json)?/g, '').trim()
  const attempts = [stripped]
  const start = stripped.indexOf('[')
  const end = stripped.lastIndexOf(']')
  if (start >= 0 && end > start) attempts.push(stripped.slice(start, end + 1))
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt)
      if (Array.isArray(value)) return value
      if (Array.isArray(value?.memories)) return value.memories
    } catch {
      // 试下一种
    }
  }
  return null
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
  return results
}

async function ingestLlm({ world, db, cfg, shift, provenance, stats, llm, concurrency, maxPerSession }) {
  // 提取互不依赖，可以并发；写入必须按时间顺序，相似合并才符合「新内容覆盖旧内容」。
  const extracted = await mapLimit(world.sessions, concurrency, async (session) => {
    try {
      return parseExtraction(await llm.chat(buildExtractionMessages(session, maxPerSession), { maxTokens: 2048 }))
    } catch (error) {
      if (error instanceof LlmFatalError) throw error
      stats.extractFailed += 1
      return []
    }
  })
  world.sessions.forEach((session, index) => {
    const items = extracted[index]
    if (items === null) {
      stats.parseFailed += 1
      return
    }
    for (const item of items.slice(0, maxPerSession)) {
      const level = String(item?.level ?? 'fact').trim()
      if (!RECALLABLE_LEVELS.has(level)) {
        countRejected(stats, `level 不可召回：${level}`)
        continue
      }
      const result = rememberInto(db, { ...item, level, project: BENCH_PROJECT }, cfg, sessionTime(session, world, shift))
      if (!result.ok) {
        countRejected(stats, String(result.error).replace(/[：:].*$/, ''))
        continue
      }
      if (result.merged) stats.merged += 1
      else stats.inserted += 1
      // upsert 合并时不保留来源，所以来源记在这里：一条记忆可以同时来自多个会话。
      const sources = provenance.get(result.id) ?? new Set()
      sources.add(session.id)
      provenance.set(result.id, sources)
    }
  })
}

function countRejected(stats, reason) {
  stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1
}

/**
 * runRecall 内部用真实时钟算新鲜度。把世界整体平移到「最后一题发生在现在」，
 * 否则所有历史条目的新鲜度都是 0，相对新旧也丢了。
 */
export function worldShift(world, now = Date.now()) {
  const stamps = [...world.probes.map((probe) => probe.ts), ...world.sessions.map((session) => session.ts)].filter(
    (ts) => ts !== null && ts !== undefined,
  )
  return stamps.length === 0 ? 0 : now - Math.max(...stamps)
}

function sessionTime(session, world, shift) {
  if (session.ts === null || session.ts === undefined) return Date.now()
  return session.ts + shift
}

export function emptyIngestStats() {
  return { inserted: 0, merged: 0, rejected: {}, parseFailed: 0, extractFailed: 0 }
}

/** @returns {Promise<{provenance:Map<string,Set<string>>, stats:object}>} */
export async function ingestWorld({ world, db, cfg, mode, llm, concurrency = 4, maxPerSession = 8, now = Date.now() }) {
  const ordered = { ...world, sessions: [...world.sessions].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)) }
  const context = { world: ordered, db, cfg, shift: worldShift(world, now), provenance: new Map(), stats: emptyIngestStats() }
  if (mode === 'raw') ingestRaw(context)
  else if (mode === 'gold') ingestGold(context)
  else if (mode === 'llm') await ingestLlm({ ...context, llm, concurrency, maxPerSession })
  else throw new Error(`未知写入方式：${mode}`)
  return { provenance: context.provenance, stats: context.stats }
}

// ---------------------------------------------------------------- 档位

/**
 * 同一份记忆库上比较的几套召回配置。wide 用的是配置项允许的上限，
 * 它和 default 的差距就是门控与预算吃掉的部分。
 */
export function buildProfile(name, base) {
  const cfg = structuredClone(base)
  const openUp = () => {
    cfg.recall.gate.enabled = false
    cfg.recall.minStrength = 0
    cfg.inject.maxHitsPerTurn = 5
    cfg.inject.hitBudget = 2000
    cfg.inject.maxHitChars = 400
  }
  const useVector = () => {
    cfg.recall.vector.enabled = true
    // 线上 400ms 是延迟预算；这里测的是质量，超时不该算进召回能力。
    cfg.recall.vector.timeoutMs = 3000
  }
  // default-h3 / vector-h3-b700：只改每轮条数和字数预算，其余和基础档位相同。
  const tuned = /^(default|vector)-h(\d+)(?:-b(\d+))?$/.exec(name)
  if (tuned !== null) {
    if (tuned[1] === 'vector') useVector()
    cfg.inject.maxHitsPerTurn = Number(tuned[2])
    if (tuned[3] !== undefined) cfg.inject.hitBudget = Number(tuned[3])
    return cfg
  }
  switch (name) {
    case 'default':
      break
    case 'no-gate':
      cfg.recall.gate.enabled = false
      break
    case 'wide':
      openUp()
      break
    case 'vector':
      useVector()
      break
    case 'vector-wide':
      openUp()
      useVector()
      break
    default:
      throw new Error(`未知档位：${name}（可选 default / no-gate / wide / vector / vector-wide，或 default-h3、vector-h3-b700 这样指定条数和预算）`)
  }
  return cfg
}

export const needsVectors = (profiles) => profiles.some((name) => name.startsWith('vector'))

// ---------------------------------------------------------------- 打分

function sessionsOfEntry(provenance, id) {
  return provenance.get(id) ?? new Set()
}

function coveredGroups(groups, sessions) {
  return groups.filter((group) => group.some((id) => sessions.has(id))).length
}

/**
 * @param {Array<Set<string>>} ranked 排好序的条目各自的来源会话
 * @param {string[][]} groups 证据组
 * @returns {{any:Record<number,boolean>, all:Record<number,boolean>, rr:number}}
 *   any = 前 k 条至少覆盖一条证据；all = 覆盖全部证据（多会话题要看这个）。
 */
export function scoreRanking(ranked, groups, ks = RECALL_KS) {
  const any = {}
  const all = {}
  for (const k of ks) {
    const seen = new Set(ranked.slice(0, k).flatMap((sessions) => [...sessions]))
    const covered = coveredGroups(groups, seen)
    any[k] = covered > 0
    all[k] = groups.length > 0 && covered === groups.length
  }
  const firstHit = ranked.findIndex((sessions) => coveredGroups(groups, sessions) > 0)
  return { any, all, rr: firstHit < 0 ? 0 : 1 / (firstHit + 1) }
}

/** 这一题的证据卡在流水线哪一步。按流水线顺序判，取最早的那一步。 */
export function attributeLoss({ outcome, injectedAny, retrievedAny }) {
  if (injectedAny) return 'injected'
  if (String(outcome).startsWith('skip_')) return 'gate_closed'
  return retrievedAny ? 'filtered_or_budget' : 'not_retrieved'
}

const squash = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')

/** 答案串：外层都要有，内层任一写法。没配答案串的题返回 false。 */
export function containsAnswer(text, keys) {
  const hay = squash(text)
  return keys.length > 0 && keys.every((group) => group.some((key) => hay.includes(squash(key))))
}

/**
 * 答案这一级卡在哪一步。比会话级严格：长会话里命中的可能是不含答案的另一句。
 * clipped = 条目选中了，答案却被单条字数上限切掉，模型看不到。
 * echoed = 含答案的条目被 isEcho 判成用户在复述，没有注入。
 */
export function attributeAnswerLoss({ outcome, block, pickedBodies, echoedBodies = [], rankedBodies, keys }) {
  if (containsAnswer(block, keys)) return 'injected'
  if (String(outcome).startsWith('skip_')) return 'gate_closed'
  if (containsAnswer(pickedBodies.join('\n'), keys)) return 'clipped'
  if (containsAnswer([...pickedBodies, ...echoedBodies].join('\n'), keys)) return 'echoed'
  return containsAnswer(rankedBodies.join('\n'), keys) ? 'filtered_or_budget' : 'not_retrieved'
}

function bm25Units(text) {
  const units = []
  const lower = String(text).normalize('NFKC').toLowerCase()
  for (const [word] of lower.matchAll(/[a-z0-9][a-z0-9_.:/-]+/g)) units.push(word)
  for (const [run] of lower.matchAll(/[一-鿿]+/gu)) {
    const chars = Array.from(run)
    if (chars.length === 1) units.push(chars[0])
    for (let i = 0; i + 1 < chars.length; i += 1) units.push(chars[i] + chars[i + 1])
  }
  return units
}

/**
 * 校准用的朴素基线：中文二字切分加标准 BM25，不用任何插件逻辑。
 * 插件分数低时，靠它分清是题太难，还是检索本身有差距。
 * @returns {(query:string) => string[]} 按相关度排好序的正文
 */
export function createBm25(bodies, { k1 = 1.2, b = 0.75 } = {}) {
  const docs = bodies.map((body) => {
    const units = bm25Units(body)
    const freq = new Map()
    for (const unit of units) freq.set(unit, (freq.get(unit) ?? 0) + 1)
    return { body, freq, length: units.length }
  })
  const docFreq = new Map()
  for (const { freq } of docs) for (const unit of freq.keys()) docFreq.set(unit, (docFreq.get(unit) ?? 0) + 1)
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length)
  return (query) => {
    const terms = [...new Set(bm25Units(query))]
    return docs
      .map((doc) => {
        let score = 0
        for (const term of terms) {
          const count = doc.freq.get(term) ?? 0
          if (count === 0) continue
          const df = docFreq.get(term)
          const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
          score += (idf * count * (k1 + 1)) / (count + k1 * (1 - b + (b * doc.length) / average))
        }
        return { body: doc.body, score }
      })
      .filter((doc) => doc.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((doc) => doc.body)
  }
}

/** 跑完一个世界的检索层和注入层。全程只读，不调 LLM。 */
export async function probeWorld({ world, db, cfg, provenance, profiles, embed }) {
  const gateTerms = buildGateTerms(null, db)
  const topK = cfg.recall.topK
  const baseline = createBm25(db.prepare(`SELECT body FROM entries WHERE status = 'active'`).all().map((row) => row.body))
  const rows = []
  for (const probe of world.probes) {
    const matched = matchGateTerms(probe.question, gateTerms)
    const hits = recall({ globalDb: null, workspaceDb: db, text: probe.question, topK, extraTerms: matched, minStrength: 0 })
    const ranked = hits.map((hit) => sessionsOfEntry(provenance, hit.entry.id))
    const retrieval = scoreRanking(ranked, probe.evidence)
    const retrievedAny = ranked.some((sessions) => coveredGroups(probe.evidence, sessions) > 0)
    const keys = probe.keys ?? []
    const stale = probe.stale ?? []
    const keyed = !probe.abstain && keys.length > 0
    const rankedBodies = hits.map((hit) => hit.entry.body)
    if (keyed) {
      retrieval.answer = Object.fromEntries(RECALL_KS.map((k) => [k, containsAnswer(rankedBodies.slice(0, k).join('\n'), keys)]))
      const naive = baseline(probe.question)
      retrieval.baseline = Object.fromEntries(RECALL_KS.map((k) => [k, containsAnswer(naive.slice(0, k).join('\n'), keys)]))
    }

    const injection = {}
    for (const [name, profileCfg] of Object.entries(profiles)) {
      const run = await runRecall({
        text: probe.question,
        globalDb: null,
        workspaceDb: db,
        config: profileCfg,
        gateTerms,
        projectNames: [],
        injectedCount: 0,
        exclude: new Set(),
        ...(embed === undefined ? {} : { embed }),
      })
      const injected = new Set(run.picked.flatMap(({ entry }) => [...sessionsOfEntry(provenance, entry.id)]))
      const covered = coveredGroups(probe.evidence, injected)
      const block = renderHitBlock(run.picked)
      injection[name] = {
        gate: run.gate,
        outcome: run.outcome,
        picked: run.picked.length,
        chars: Array.from(block).length,
        embedFailed: run.embedFailed,
        injectedAny: covered > 0,
        injectedAll: probe.evidence.length > 0 && covered === probe.evidence.length,
        stage: probe.abstain ? null : attributeLoss({ outcome: run.outcome, injectedAny: covered > 0, retrievedAny }),
        block,
      }
      if (keyed) {
        const answerHit = containsAnswer(block, keys)
        injection[name].answerHit = answerHit
        injection[name].answerStage = attributeAnswerLoss({
          outcome: run.outcome,
          block,
          pickedBodies: run.picked.map(({ entry }) => entry.body),
          echoedBodies: run.echoes.map(({ id }) => db.prepare('SELECT body FROM entries WHERE id = ?').get(id)?.body ?? ''),
          rankedBodies,
          keys,
        })
        // 答案没进来、旧值进来了：比什么都没注入更糟，模型会照着旧值答。
        injection[name].staleOnly = !answerHit && stale.some((word) => containsAnswer(block, [[word]]))
      }
    }
    rows.push({
      id: probe.id,
      world: world.id,
      type: probe.type,
      tags: probe.tags ?? [],
      keyed,
      stale: stale.length > 0,
      abstain: probe.abstain,
      evidenceGroups: probe.evidence.length,
      entries: provenance.size,
      retrieval,
      injection,
    })
  }
  return rows
}

const rate = (hits, total) => (total === 0 ? null : hits / total)

export function summarizeRetrieval(rows, ks = RECALL_KS) {
  const scored = rows.filter((row) => !row.abstain)
  const summary = { n: scored.length, any: {}, all: {}, mrr: rate(scored.reduce((sum, row) => sum + row.retrieval.rr, 0), scored.length) }
  for (const k of ks) {
    summary.any[k] = rate(scored.filter((row) => row.retrieval.any[k]).length, scored.length)
    summary.all[k] = rate(scored.filter((row) => row.retrieval.all[k]).length, scored.length)
  }
  return summary
}

export function summarizeInjection(rows, profile) {
  const scored = rows.filter((row) => !row.abstain)
  const abstain = rows.filter((row) => row.abstain)
  const stages = { injected: 0, gate_closed: 0, not_retrieved: 0, filtered_or_budget: 0 }
  for (const row of scored) stages[row.injection[profile].stage] += 1
  return {
    n: scored.length,
    gateOpen: rate(rows.filter((row) => !row.injection[profile].outcome.startsWith('skip_')).length, rows.length),
    evidenceAny: rate(scored.filter((row) => row.injection[profile].injectedAny).length, scored.length),
    evidenceAll: rate(scored.filter((row) => row.injection[profile].injectedAll).length, scored.length),
    abstainInjected: rate(abstain.filter((row) => row.injection[profile].picked > 0).length, abstain.length),
    avgChars: rate(rows.reduce((sum, row) => sum + row.injection[profile].chars, 0), rows.length),
    embedFailed: rows.filter((row) => row.injection[profile].embedFailed).length,
    stages,
  }
}

/** 答案级汇总。只统计配了答案串的题，公开集没有这个字段时返回 null。 */
export function summarizeAnswers(rows, profiles, ks = RECALL_KS) {
  const keyed = rows.filter((row) => row.keyed)
  if (keyed.length === 0) return null
  const slice = (list) => ({
    n: list.length,
    retrieved: rate(list.filter((row) => row.retrieval.answer[5]).length, list.length),
    injected: Object.fromEntries(
      profiles.map((name) => [name, rate(list.filter((row) => row.injection[name].answerHit).length, list.length)]),
    ),
  })
  const group = (keysOf) => {
    const groups = new Map()
    for (const row of keyed) {
      for (const key of keysOf(row)) groups.set(key, [...(groups.get(key) ?? []), row])
    }
    return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, slice(list)]))
  }
  const staleRows = keyed.filter((row) => row.stale)
  return {
    n: keyed.length,
    recallAtK: Object.fromEntries(ks.map((k) => [k, rate(keyed.filter((row) => row.retrieval.answer[k]).length, keyed.length)])),
    baselineAtK: Object.fromEntries(ks.map((k) => [k, rate(keyed.filter((row) => row.retrieval.baseline[k]).length, keyed.length)])),
    profiles: Object.fromEntries(
      profiles.map((name) => {
        const stages = { injected: 0, gate_closed: 0, not_retrieved: 0, filtered_or_budget: 0, echoed: 0, clipped: 0 }
        for (const row of keyed) stages[row.injection[name].answerStage] += 1
        return [
          name,
          {
            hit: rate(stages.injected, keyed.length),
            staleOnly: rate(staleRows.filter((row) => row.injection[name].staleOnly).length, staleRows.length),
            stages,
          },
        ]
      }),
    ),
    byType: group((row) => [row.type]),
    byTag: group((row) => row.tags),
  }
}

/** 拒答题按难点分组：话题相近的题比完全无关的题更容易把内容硬拉进来。 */
export function summarizeAbstention(rows, profiles) {
  const abstain = rows.filter((row) => row.abstain)
  const groups = new Map()
  for (const row of abstain) {
    for (const tag of row.tags.length > 0 ? row.tags : ['untagged']) groups.set(tag, [...(groups.get(tag) ?? []), row])
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, list]) => [
        tag,
        {
          n: list.length,
          injected: Object.fromEntries(
            profiles.map((name) => [name, rate(list.filter((row) => row.injection[name].picked > 0).length, list.length)]),
          ),
        },
      ]),
  )
}

/**
 * 判不出来的题（API 失败、judge 答非所问）不计入分母，单独报数量，
 * 否则基础设施故障会被算成记忆答错。
 */
export function summarizeE2e(rows, condition) {
  const judged = rows.filter((row) => row.e2e?.[condition]?.correct === true || row.e2e?.[condition]?.correct === false)
  const correct = (list) => list.filter((row) => row.e2e[condition].correct).length
  const scored = judged.filter((row) => !row.abstain)
  const abstain = judged.filter((row) => row.abstain)
  const byType = {}
  for (const row of scored) {
    byType[row.type] ??= { correct: 0, total: 0 }
    byType[row.type].total += 1
    if (row.e2e[condition].correct) byType[row.type].correct += 1
  }
  const types = Object.values(byType)
  return {
    n: judged.length,
    unjudged: rows.length - judged.length,
    taskAveraged: types.length === 0 ? null : types.reduce((sum, type) => sum + type.correct / type.total, 0) / types.length,
    overall: rate(correct(judged), judged.length),
    abstention: rate(correct(abstain), abstain.length),
    byType,
  }
}

// ---------------------------------------------------------------- 端到端

// LongMemEval 官方判分模板（src/evaluation/evaluate_qa.py）。
const JUDGE_BASE =
  'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.'
const JUDGE_TEMPORAL = `${JUDGE_BASE} Note: For questions asking about the number of days, please allow for off-by-one errors; if the response is off by one day, still answer yes.`
const JUDGE_UPDATE = `${JUDGE_BASE} Note: If the question asks for some information but the model response contains some old out-dated information along with a new updated answer, please still answer yes as long as the updated answer is correct.`
const JUDGE_PREFERENCE =
  "I will give you a question, the description of a correct response, and a response from a model. Please answer yes if the response recalls and utilizes the user's personal information correctly and thus fits the user's personal preference. Otherwise, answer no. \n\nQuestion: {question}\n\nDescription of Correct Response: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only."
const JUDGE_ABSTENTION =
  'I will give you a question and a response from a model. The question is designed to be unanswerable, meaning the information required to answer it is not available in the knowledge source. The correct behavior is for the model to acknowledge that it cannot answer the question or that the information is not available. Please answer yes if the model response correctly identifies the question as unanswerable. Answer no if the model response attempts to provide an answer or guesses. \n\nQuestion: {question}\n\nModel Response: {response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.'

export function judgePrompt(probe, response) {
  let template = JUDGE_BASE
  if (probe.abstain) template = JUDGE_ABSTENTION
  else if (probe.type === 'temporal-reasoning' || probe.type === 'temporal') template = JUDGE_TEMPORAL
  else if (probe.type === 'knowledge-update') template = JUDGE_UPDATE
  else if (probe.type === 'single-session-preference') template = JUDGE_PREFERENCE
  // 用函数式替换：回答里的 $& 之类不能被当成替换模式。
  const values = { question: probe.question, answer: probe.answer, response }
  return template.replace(/\{(question|answer|response)\}/g, (_, key) => values[key])
}

/** @returns {boolean|null} null = 判不出来。 */
export function parseVerdict(text) {
  const head = String(text ?? '').trim().toLowerCase()
  if (/^\W*yes\b/.test(head)) return true
  if (/^\W*no\b/.test(head)) return false
  return null
}

export function buildReaderPrompt(probe, block) {
  // 条目短 id 每次运行都是随机的，留着会让相同内容的 prompt 永远命不中缓存。
  // 作答模型没有 mem_read 可调，这个 id 对它没有用。
  const stable = block.replace(/^- \[([^·\]]+)·[^\]]+\]/gm, '- [$1]')
  const memory = stable === '' ? '' : `Memories from past sessions (background, may be incomplete):\n${stable}\n\n`
  return `Current date: ${probe.date || 'unknown'}\n\n${memory}Question: ${probe.question}\nAnswer concisely, in the language of the question. If you don't have the information, say so.`
}

/** 给一题一个条件作答并判分。条件 none 没有记忆，用来算净贡献。 */
export async function answerAndJudge({ probe, block, llm, judgeModel }) {
  try {
    const answer = await llm.chat([{ role: 'user', content: buildReaderPrompt(probe, block) }], { maxTokens: 512 })
    const verdict = await llm.chat([{ role: 'user', content: judgePrompt(probe, answer) }], { maxTokens: 10, model: judgeModel })
    return { answer, correct: parseVerdict(verdict) }
  } catch (error) {
    if (error instanceof LlmFatalError) throw error
    return { answer: null, correct: null, error: String(error?.message ?? error).slice(0, 200) }
  }
}

// ---------------------------------------------------------------- LLM 客户端

/** 重试也没用的错误（key 不对、模型名不对）：立刻停，别烧完全部题目。 */
export class LlmFatalError extends Error {}

/**
 * OpenAI 兼容的 chat 客户端，结果按内容哈希落盘。
 * LongMemEval 不同题的历史大量重合，缓存能省掉多数提取调用；中断后重跑也靠它续上。
 */
export function createLlm({ baseUrl, apiKey, model, cachePath = null, fetchImpl = globalThis.fetch, retryDelayMs = 2000, timeoutMs = 120000 }) {
  const cache = new Map()
  const pending = new Map()
  const stats = { calls: 0, cached: 0 }
  if (cachePath !== null && existsSync(cachePath)) {
    for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
      if (line === '') continue
      try {
        const { key, text } = JSON.parse(line)
        cache.set(key, text)
      } catch {
        // 上次写到一半被杀，丢掉这一行重算即可。
      }
    }
  }

  async function request(messages, maxTokens, useModel) {
    const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
    let lastError = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)))
      let response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: useModel, messages, max_tokens: maxTokens, temperature: 0 }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        lastError = error
        continue
      }
      if (response.ok) {
        stats.calls += 1
        const payload = await response.json()
        return payload?.choices?.[0]?.message?.content ?? ''
      }
      lastError = new Error(`LLM API ${response.status}`)
      if (response.status !== 429 && response.status < 500) throw new LlmFatalError(`${lastError.message}：请检查 key、--model 和 --base-url`)
    }
    throw lastError
  }

  async function chat(messages, { maxTokens = 512, model: override } = {}) {
    const useModel = override ?? model
    const key = createHash('sha256').update(JSON.stringify([useModel, maxTokens, messages])).digest('hex')
    if (cache.has(key)) {
      stats.cached += 1
      return cache.get(key)
    }
    if (pending.has(key)) return pending.get(key)
    const task = request(messages, maxTokens, useModel)
      .then((text) => {
        // 空回复多半是临时异常，不进缓存，下次还能重试。
        if (text !== '') {
          cache.set(key, text)
          if (cachePath !== null) {
            mkdirSync(dirname(cachePath), { recursive: true })
            appendFileSync(cachePath, `${JSON.stringify({ key, text })}\n`)
          }
        }
        return text
      })
      .finally(() => pending.delete(key))
    pending.set(key, task)
    return task
  }

  return { chat, stats }
}

/** 跑之前算清楚要花多少次调用：提取按去重后的会话算，缓存命中只会更少。 */
export function estimateCalls(worlds, { ingest, e2e, conditions }) {
  const sessions = new Set()
  let probes = 0
  for (const world of worlds) {
    probes += world.probes.length
    for (const session of world.sessions) {
      sessions.add(createHash('sha256').update(JSON.stringify([session.date, session.messages])).digest('hex'))
    }
  }
  const extraction = ingest === 'llm' ? sessions.size : 0
  const qa = e2e ? probes * conditions * 2 : 0
  return { worlds: worlds.length, probes, uniqueSessions: sessions.size, extraction, qa, total: extraction + qa }
}
