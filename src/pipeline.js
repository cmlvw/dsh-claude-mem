/**
 * dsh-claude-mem · 每轮召回流水线
 *
 * 门控 → 关键词检索 → 向量检索与融合 → 精排 → 去掉复述 → 装配。
 * 全程不写库：真实注入和 /mem-why 的试运行共用这一份逻辑，试运行的结论才可信。
 */
import { assembleHits, fuseRRF, gateDecision, isEcho, matchGateTerms, recall } from './recall.js'
import { embedQuery } from './embed.js'
import { dot, getVector, searchVectors, unpackVec } from './vector.js'
import { rerankHits } from './rerank.js'

const describeHit = (hit) => ({
  id: hit.entry.id,
  title: hit.entry.title,
  via: hit.via ?? 'lexical',
  score: Number(Number(hit.score ?? 0).toFixed(3)),
})

async function searchSemantic({ text, cfg, dbs, embed }) {
  const queryVec = await embed(text, {
    url: cfg.url,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    queryPrefix: cfg.queryPrefix,
  })
  if (queryVec === null) return null
  const hits = []
  const seen = new Set()
  for (const db of dbs) {
    for (const hit of searchVectors(db, queryVec, { limit: cfg.topK, minScore: cfg.minScore, model: cfg.model })) {
      if (seen.has(hit.entry.id)) continue
      seen.add(hit.entry.id)
      hits.push(hit)
    }
  }
  return { queryVec, hits: hits.sort((a, b) => b.score - a.score) }
}

/**
 * 语义否决：「帮我查接口格式」会因为「接口」这个词撞上不相干的记忆。
 * 关键词命中了、整句话和这条记忆却很远，就不算相关。没有向量的条目无从判断，保留。
 */
function vetoUnrelated(lexicalHits, queryVec, dbs, { model, vetoScore, vetoProtectStrength = Infinity }) {
  const similarity = (id) => {
    for (const db of dbs) {
      const stored = getVector(db, id)
      if (stored === null || stored.model !== model) continue
      const vec = unpackVec(stored.vec)
      if (vec !== null && vec.length === queryVec.length) return dot(queryVec, vec)
    }
    return null
  }
  const kept = []
  const vetoed = []
  // 关键词信号最强的那条是直接证据：信号够强就不因语义分低被否决。
  const strongest = lexicalHits.reduce((best, hit) => ((hit.strength ?? 0) > (best?.strength ?? -1) ? hit : best), null)
  for (const hit of lexicalHits) {
    const score = similarity(hit.entry.id)
    const isProtected = hit === strongest && (hit.strength ?? 0) >= vetoProtectStrength
    if (score !== null && score < vetoScore && !isProtected) vetoed.push(hit)
    else kept.push(hit)
  }
  return { kept, vetoed }
}

/**
 * @param {object} input
 * @param {string} input.text 用户消息
 * @param {object} input.globalDb
 * @param {object} input.workspaceDb
 * @param {object} input.config 插件配置
 * @param {Set<string>} input.gateTerms 门控词表
 * @param {string[]} input.projectNames
 * @param {number} input.injectedCount 本会话已命中轮数
 * @param {Set<string>} input.exclude 不再注入的条目
 * @param {Function} [input.embed] 测试时替换向量服务
 * @returns {Promise<{gate:string, outcome:string, picked:Array, candidates:Array, echoes:Array, embedFailed:boolean, rerank:object|null}>}
 *   gate 是开门依据；outcome 是这一轮的结局（skip_*、no_candidates 或 injected_hit）。
 */
export async function runRecall(input) {
  const { text, globalDb, workspaceDb, config, gateTerms, projectNames, injectedCount, exclude, embed = embedQuery } = input
  const matched = matchGateTerms(text, gateTerms)
  const gate = gateDecision(text, {
    enabled: config.recall.gate.enabled,
    minChars: config.recall.gate.minChars,
    maxHitsPerSession: config.recall.gate.maxHitsPerSession,
    injectedCount,
    projectNames,
    matchedTerms: matched,
  })
  const result = { gate: gate.reason, outcome: `skip_${gate.reason}`, picked: [], candidates: [], echoes: [], vetoed: [], embedFailed: false, rerank: null }
  // 太短、纯确认、配额用完：这些消息连向量服务都不用问。
  if (!gate.open && gate.reason !== 'nosignal') return result

  const vectorCfg = config.recall.vector
  const dbs = [globalDb, workspaceDb].filter((db) => db !== null && db !== undefined)
  let vectorHits = []
  let queryVec = null
  if (vectorCfg.enabled) {
    const found = await searchSemantic({ text, cfg: vectorCfg, dbs, embed })
    if (found === null) result.embedFailed = true
    else {
      queryVec = found.queryVec
      vectorHits = found.hits.filter((hit) => !exclude.has(hit.entry.id))
    }
  }

  let stageOne
  if (gate.open) {
    let lexical = recall({
      globalDb,
      workspaceDb,
      text,
      topK: config.recall.topK,
      exclude,
      extraTerms: matched,
      minStrength: config.recall.minStrength,
    })
    // 提到项目名是明确的信号，不否决。
    if (queryVec !== null && gate.reason !== 'project') {
      const { kept, vetoed } = vetoUnrelated(lexical, queryVec, dbs, vectorCfg)
      lexical = kept
      result.vetoed = vetoed.map(describeHit)
    }
    stageOne = vectorHits.length > 0 ? fuseRRF(lexical, vectorHits, { k: vectorCfg.rrfK, exclude }) : lexical
  } else {
    // 关键词门没有信号：只有语义足够接近才开门，而且只用语义这一路的结果，
    // 否则关键词检索的噪声会跟着混进来。
    stageOne = vectorHits.filter((hit) => hit.score >= vectorCfg.gateScore)
    if (stageOne.length === 0) return result
    result.gate = 'semantic'
  }

  const reranked = await rerankHits(stageOne, {
    enabled: config.recall.rerank.enabled,
    url: config.recall.rerank.url,
    timeoutMs: config.recall.rerank.timeoutMs,
    maxPicks: config.recall.rerank.maxPicks,
    query: text,
  })
  result.rerank = reranked.applied ? reranked.reason : null
  result.candidates = reranked.hits.slice(0, 5).map(describeHit)

  const kept = []
  for (const hit of reranked.hits) {
    if (isEcho(text, hit.entry)) result.echoes.push(describeHit(hit))
    else kept.push(hit)
  }
  const assembled = assembleHits(kept, {
    maxHits: config.inject.maxHitsPerTurn,
    maxCharsPerHit: config.inject.maxHitChars,
    budget: config.inject.hitBudget,
  })
  result.picked = assembled.picked
  result.outcome = assembled.picked.length > 0 ? 'injected_hit' : 'no_candidates'
  return result
}

/** 把一次运行结果变成人能读的说明（/mem-why 用）。 */
export function explainRecall(run) {
  const SKIP_TEXT = {
    short: '消息太短，不查记忆。',
    ack: '这是纯确认，不查记忆。',
    quota: '本会话的命中配额已用完，下次压缩前不再主动召回。',
    nosignal: '消息里没有触发词、项目名或记忆关键词，语义也不够接近，不注入。',
  }
  const GATE_TEXT = {
    nogate: '门控已关闭',
    trigger: '触发词',
    project: '项目名',
    keyword: '记忆关键词',
    semantic: '语义相似',
  }
  const lines = []
  if (run.outcome.startsWith('skip_')) lines.push(SKIP_TEXT[run.gate] ?? `没有开门（${run.gate}）。`)
  else lines.push(`开门依据：${GATE_TEXT[run.gate] ?? run.gate}。`)
  if (run.embedFailed) lines.push('向量服务不可用，这一轮只用了关键词。')
  if (run.candidates.length > 0) {
    lines.push('候选：')
    for (const item of run.candidates) lines.push(`  - ${item.title}（${item.via}，${item.score}）`)
  } else if (!run.outcome.startsWith('skip_')) {
    lines.push('没有尚未注入过的相关条目。')
  }
  if (run.vetoed.length > 0) lines.push(`关键词撞上但语义不相关，已排除：${run.vetoed.map((item) => item.title).join('、')}`)
  if (run.echoes.length > 0) lines.push(`用户正在复述，没有重复注入：${run.echoes.map((item) => item.title).join('、')}`)
  if (run.picked.length > 0) lines.push(`注入：${run.picked.map((item) => item.entry.title).join('、')}`)
  else if (!run.outcome.startsWith('skip_')) lines.push('这一轮没有注入。')
  if (run.alreadyInjected?.length > 0) lines.push(`其中 ${run.alreadyInjected.join('、')} 本会话已注入过，真实运行时不会重复。`)
  return lines.join('\n')
}
