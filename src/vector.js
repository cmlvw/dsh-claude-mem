/**
 * dsh-claude-mem · 向量存储与语义召回（M6）
 *
 * 为什么不用 sqlite-vec：条目量级是「几百到几千」，暴力余弦一次全量扫
 * 也只有几毫秒；引入扩展意味着 ABI/平台依赖，和「数据全本机、加载期 fail-open」
 * 的约束不匹配。SQLite 只当 BLOB 仓库，相似度在 JS 里算。
 */
import { createHash } from 'node:crypto'

import { embedTexts } from './embed.js'
import { parseKeywords, rowToEntry } from './store.js'

/** 参与检索的层（与 recall.js 的 collect 保持一致：核心层已整段注入，不进召回）。 */
export const VECTOR_LEVELS = ['fact', 'lesson', 'topic', 'project']

/** 打包成 float32 小端 BLOB。 */
export function packVec(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

export function unpackVec(blob) {
  if (blob === null || blob === undefined) return null
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  if (buf.byteLength % 4 !== 0) return null
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

/** 点积；入库前已归一化，这里就是余弦相似度。 */
export function dot(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

/** 条目参与 embedding 文本：标题 + 关键词 + 正文（关键词是作者标的召回钩子，权重靠前）。 */
export function entryEmbedText(entry) {
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.join(' ') : String(entry.keywords ?? '')
  // 没填「何时用」时文本不变，旧条目的向量不必重算。
  const whenToUse = entry.when_to_use ? `\n${entry.when_to_use}` : ''
  return `${entry.title ?? ''}\n${keywords}\n${entry.body ?? ''}${whenToUse}`.trim()
}

export function textHash(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 32)
}

export function getVector(db, entryId) {
  if (!db) return null
  try {
    return db.prepare(`SELECT model, dim, text_hash, vec FROM entry_vectors WHERE entry_id = ?`).get(entryId) ?? null
  } catch {
    return null
  }
}

export function upsertVector(db, entryId, vec, { model, textHash: hash, now = Date.now() } = {}) {
  if (!db) return false
  try {
    db.prepare(
      `INSERT INTO entry_vectors(entry_id, model, dim, text_hash, vec, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET
         model = excluded.model, dim = excluded.dim, text_hash = excluded.text_hash,
         vec = excluded.vec, updated_at = excluded.updated_at`,
    ).run(entryId, model ?? 'unknown', vec.length, hash ?? '', packVec(vec), now)
    return true
  } catch {
    return false
  }
}

/**
 * 全量向量召回。限定层与状态，按点积排序。
 * @returns {Array<{entry:object, score:number, via:'vector'}>}
 */
export function searchVectors(db, queryVec, { limit = 30, minScore = 0.3, levels = VECTOR_LEVELS, model = null } = {}) {
  if (!db || !queryVec) return []
  let rows
  try {
    rows = db
      .prepare(
        `SELECT e.*, v.vec AS v_vec, v.model AS v_model FROM entries e
         JOIN entry_vectors v ON v.entry_id = e.id
         WHERE e.status = 'active' AND e.level IN (${levels.map(() => '?').join(',')})
           ${model ? 'AND v.model = ?' : ''}`,
      )
      .all(...levels, ...(model ? [model] : []))
  } catch {
    return []
  }
  const hits = []
  for (const row of rows) {
    const vec = unpackVec(row.v_vec)
    if (vec === null || vec.length !== queryVec.length) continue
    const score = dot(queryVec, vec)
    if (!Number.isFinite(score) || score < minScore) continue
    const { v_vec, v_model, ...rest } = row
    hits.push({ entry: rowToEntry(rest), score, via: 'vector' })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/** 给单条 id 补/刷向量。失败返回 false（不 throw）。 */
export async function embedEntryById(db, entryId, options = {}) {
  if (!db) return false
  let row
  try {
    row = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(entryId)
  } catch {
    return false
  }
  if (!row) return false
  const text = entryEmbedText({ title: row.title, keywords: parseKeywords(row.keywords), body: row.body, when_to_use: row.when_to_use })
  const hash = textHash(text)
  const existing = getVector(db, entryId)
  if (existing && existing.text_hash === hash && existing.model === (options.model ?? existing.model)) return true

  const vectors = await embedTexts([text], options)
  if (vectors === null || vectors.length === 0) return false
  return upsertVector(db, entryId, vectors[0], { model: options.model, textHash: hash, now: Date.now() })
}

/**
 * 写入后排队补向量：不阻塞写入路径，同一时刻只跑一条，失败只丢这一条。
 * db 若已被关闭，捕获后静默放弃（下一条消息的检索仍能降级）。
 */
const queue = { chain: Promise.resolve(), pending: 0 }

export function queueEmbed(db, entryId, options = {}) {
  if (!db || typeof entryId !== 'string' || entryId === '') return
  queue.pending += 1
  queue.chain = queue.chain
    .then(() => embedEntryById(db, entryId, options))
    .catch(() => false)
    .finally(() => {
      queue.pending -= 1
    })
}

export function embedQueueSize() {
  return queue.pending
}
