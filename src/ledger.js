/**
 * dsh-claude-mem · 召回账本
 *
 * 回答「记忆注入了多少、为什么没想起来、有没有用」。只存按天聚合的计数，
 * 不存用户原话和记忆内容，所以不受笔记保留期限制，也不怕被人翻到。写失败绝不影响注入。
 */

/** 结果名到说明的映射。新增结果要加在这里，/mem-stats 才会显示。 */
export const OUTCOME_LABELS = {
  skip_short: '消息太短',
  skip_ack: '纯确认',
  skip_quota: '本会话配额已满',
  skip_nosignal: '没有相关信号',
  open_trigger: '开门：触发词',
  open_project: '开门：项目名',
  open_keyword: '开门：记忆关键词',
  open_semantic: '开门：语义相似',
  open_nogate: '开门：门控已关闭',
  no_candidates: '开门后没有足够相关的条目',
  veto_dropped: '关键词撞上但语义不相关（条）',
  echo_dropped: '用户在复述，不重复注入（条）',
  injected_hit: '命中注入',
  injected_core: '首轮核心块',
  injected_reinject: '压缩后重注入',
  embed_failed: '向量服务不可用',
  feedback_good: '反馈：有用',
  feedback_bad: '反馈：没用',
}

const dayOf = (now) => new Date(now).toISOString().slice(0, 10)

export function recordOutcome(db, outcome, { count = 1, chars = 0, now = Date.now() } = {}) {
  if (db === null || db === undefined) return
  try {
    db.prepare(
      `INSERT INTO recall_stats(day, outcome, count, chars) VALUES(?, ?, ?, ?)
       ON CONFLICT(day, outcome) DO UPDATE SET count = count + excluded.count, chars = chars + excluded.chars`,
    ).run(dayOf(now), outcome, count, chars)
  } catch {
    // 账本只是观测手段
  }
}

/** @returns {{days:number, rows:Array<{outcome:string, label:string, count:number, chars:number}>}} */
export function readLedger(db, { days = 7, now = Date.now() } = {}) {
  if (db === null || db === undefined) return { days, rows: [] }
  try {
    const since = dayOf(now - (days - 1) * 24 * 60 * 60 * 1000)
    const rows = db
      .prepare(`SELECT outcome, SUM(count) AS count, SUM(chars) AS chars FROM recall_stats WHERE day >= ? GROUP BY outcome`)
      .all(since)
      .map((row) => ({ outcome: row.outcome, label: OUTCOME_LABELS[row.outcome] ?? row.outcome, count: Number(row.count), chars: Number(row.chars) }))
    return { days, rows }
  } catch {
    return { days, rows: [] }
  }
}

/** 没有向量的召回层条目数：向量服务宕机时写入的条目不会自动补。 */
export function countMissingVectors(db) {
  if (db === null || db === undefined) return 0
  try {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM entries e LEFT JOIN entry_vectors v ON v.entry_id = e.id
         WHERE e.status = 'active' AND e.level IN ('fact','lesson','topic','project') AND v.entry_id IS NULL`,
      )
      .get().n
  } catch {
    return 0
  }
}

export function formatLedger(ledger, { missingVectors = 0, vectorEnabled = false } = {}) {
  const by = new Map(ledger.rows.map((row) => [row.outcome, row]))
  const count = (outcome) => by.get(outcome)?.count ?? 0
  const lines = [`最近 ${ledger.days} 天的召回记录（当前工作区）：`]
  if (ledger.rows.length === 0) {
    lines.push('  还没有记录。')
  } else {
    const order = Object.keys(OUTCOME_LABELS)
    const rows = [...ledger.rows].sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome))
    for (const row of rows) {
      lines.push(`  ${row.label}：${row.count}${row.chars > 0 ? `（共 ${row.chars} 字）` : ''}`)
    }
    const rated = count('feedback_good') + count('feedback_bad')
    if (rated > 0) lines.push(`  有用率：${Math.round((100 * count('feedback_good')) / rated)}%（${rated} 次反馈）`)
  }
  if (vectorEnabled) {
    if (count('embed_failed') > 0) lines.push('提示：向量服务有失败记录，失败时只能靠关键词召回。请检查服务是否在运行。')
    if (missingVectors > 0) lines.push(`提示：有 ${missingVectors} 条记忆没有向量，语义召回找不到它们。可以用 mem-admin embed 补齐。`)
  }
  return lines.join('\n')
}
