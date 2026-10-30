/**
 * dsh-claude-mem · Stage 2 语义精排（可选，默认关 —— PLAN.md §6 / §13-B）
 *
 * 为什么默认关：装上就多一次本地模型调用，每条消息多几百毫秒；先实测「规则版够不够准」，
 * 再决定开不开。关着的时候这个模块**不碰网络**，返回原顺序，零额外延迟。
 *
 * 边界（照 Claude Code 官方值，§6）：
 * - 只喂 Top20 的「标题 + 60 字摘要」，让模型在候选里挑，不许它新增；
 * - 输出使用 JSON，最多 maxPicks 条；**不确定就返回空**（一条都不选也是合法答案）；
 * - 超时 / 连不上 / 返回不是合法 JSON / 模型抽风 → 原样退回 Stage 1 的分数，不重试。
 *
 * 注意：返回的 `applied=false` 表示「精排没生效，用的是 Stage 1 顺序」；
 * `applied=true` 且 `hits=[]` 表示「模型明确说不相关」，这是零注入，不是故障。
 */
const MAX_CANDIDATES = 20
const SUMMARY_CHARS = 60

function truncate(text, maxChars) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim())
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`
}

/** 候选列表 → 模型可读的编号清单。编号只是给人看的，回传用完整 id。 */
export function buildRerankPrompt(query, candidates, maxPicks = 5) {
  const lines = candidates.map((hit, index) => {
    const entry = hit.entry
    return `${index + 1}. id=${entry.id} | ${truncate(entry.title, 40)} | ${truncate(entry.body, SUMMARY_CHARS)}`
  })
  return [
    '你在为一个记忆召回系统做精排。下面是用户当前消息和候选记忆。',
    `用户消息：${String(query ?? '').trim()}`,
    '',
    '候选记忆：',
    ...lines,
    '',
    '只从候选里挑出**确实能帮助回答用户消息**的记忆，按相关度从高到低排序。',
    `最多挑 ${maxPicks} 条。`,
    '宁可少挑，不要凑数；如果不确定，返回空数组。',
    '只输出一个 JSON 对象，格式：{"ids":["完整id", ...]}，不要解释、不要代码块。',
  ].join('\n')
}

/**
 * 解析模型输出。容忍 ```json 围栏和前后废话，但只接受 {ids: string[]}。
 * @returns {string[] | null} null = 不合法，调用方应退回 Stage 1
 */
export function parseRerankIds(content) {
  if (typeof content !== 'string' || content.trim() === '') return null
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.ids)) return null
  return parsed.ids.filter((id) => typeof id === 'string' && id !== '')
}

/**
 * Stage 2：对 Stage 1 的 Top20 做精排。
 * @param {Array<{entry:object, score:number}>} hits Stage 1 结果（已按分数排序）
 * @param {{enabled?:boolean, url?:string, timeoutMs?:number, maxPicks?:number, query?:string, fetchImpl?:Function}} options
 * @returns {Promise<{hits:Array, applied:boolean, reason:string, pickedIds:string[]}>}
 */
export async function rerankHits(hits, options = {}) {
  const {
    enabled = false,
    url = 'http://127.0.0.1:8080',
    timeoutMs = 600,
    maxPicks = 5,
    query = '',
    fetchImpl = globalThis.fetch,
  } = options

  if (!enabled) return { hits, applied: false, reason: 'disabled', pickedIds: [] }
  if (!Array.isArray(hits) || hits.length === 0) return { hits: hits ?? [], applied: false, reason: 'empty-candidates', pickedIds: [] }
  if (typeof fetchImpl !== 'function') return { hits, applied: false, reason: 'no-fetch', pickedIds: [] }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { hits, applied: false, reason: 'no-timeout', pickedIds: [] }

  const candidates = hits.slice(0, MAX_CANDIDATES)
  const byId = new Map(candidates.map((hit) => [hit.entry.id, hit]))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${String(url).replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'local',
        temperature: 0,
        max_tokens: 256,
        messages: [
          { role: 'system', content: '你是记忆召回精排器，只输出 JSON。' },
          { role: 'user', content: buildRerankPrompt(query, candidates, maxPicks) },
        ],
      }),
    })
    if (!response || response.ok !== true) return { hits, applied: false, reason: 'http-error', pickedIds: [] }
    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content
    const ids = parseRerankIds(content)
    if (ids === null) return { hits, applied: false, reason: 'bad-json', pickedIds: [] }

    const pickedIds = []
    for (const id of ids) {
      if (pickedIds.length >= maxPicks) break
      if (byId.has(id) && !pickedIds.includes(id)) pickedIds.push(id)
    }
    // 模型可能返回空数组（明确判不相关），也可能全是候选外的 id（幻觉）。
    // 两种都按「没有可用的精排结果」处理：零注入，而不是把 Stage 1 的噪音塞回去。
    return { hits: pickedIds.map((id) => byId.get(id)), applied: true, reason: pickedIds.length === 0 ? 'model-empty' : 'ok', pickedIds }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'error'
    return { hits, applied: false, reason, pickedIds: [] }
  } finally {
    clearTimeout(timer)
  }
}
