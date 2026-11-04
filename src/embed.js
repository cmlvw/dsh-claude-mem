/**
 * dsh-claude-mem · 本地 embedding 客户端（M6）
 *
 * 后端是 llama.cpp 的 llama-server（--embedding，last-token pooling），
 * 模型 Qwen3-Embedding-4B。走 OpenAI 兼容的 /v1/embeddings。
 *
 * 铁律（与 rerank.js 同一条）：
 * - 永不 throw；连不上/超时/返回不对 → 返回 null，调用方退回纯关键词召回；
 * - 不重试（每条消息都等的路径上，重试只会更慢）；
 * - 向量出库即 L2 归一化，检索只做点积。
 */

export const DEFAULT_EMBED_URL = 'http://127.0.0.1:8083'
export const DEFAULT_EMBED_MODEL = 'Qwen3-Embedding-4B'

/** L2 归一化，原地返回 Float32Array。 */
export function normalize(vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i]
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return vec
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm
  return vec
}

/**
 * 批量取向量。
 * @returns {Promise<Float32Array[] | null>} null = 不可用（调用方必须降级）
 */
export async function embedTexts(texts, options = {}) {
  const {
    url = DEFAULT_EMBED_URL,
    model = DEFAULT_EMBED_MODEL,
    timeoutMs = 400,
    fetchImpl = globalThis.fetch,
    batchSize = 16,
  } = options

  const input = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? '').trim()).filter((t) => t !== '')
  if (input.length === 0) return []
  if (typeof fetchImpl !== 'function') return null
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null

  const out = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (let start = 0; start < input.length; start += batchSize) {
      const batch = input.slice(start, start + batchSize)
      const response = await fetchImpl(`${String(url).replace(/\/+$/, '')}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model, input: batch, encoding_format: 'float' }),
      })
      if (!response || response.ok !== true) return null
      const payload = await response.json()
      const rows = payload?.data
      if (!Array.isArray(rows) || rows.length !== batch.length) return null
      for (const row of rows) {
        const raw = row?.embedding
        if (!Array.isArray(raw) || raw.length === 0) return null
        const vec = Float32Array.from(raw)
        out.push(normalize(vec))
      }
    }
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 单条查询向量（query 可加指令前缀，见 config.recall.vector.queryPrefix）。 */
export async function embedQuery(text, options = {}) {
  const prefix = options.queryPrefix ?? ''
  const vectors = await embedTexts([`${prefix}${String(text ?? '').trim()}`], options)
  return vectors === null ? null : (vectors[0] ?? null)
}
