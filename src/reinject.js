/**
 * dsh-claude-mem · 压缩后重注入（M5）
 *
 * 场景：会话被压缩（compaction）后，早期的注入块被摘要吃掉，模型手里没有首轮核心块了。
 * 做法（对齐 meow-memory 的实测姿势，见 lib/index.js:4918-4929）：
 *   1. `session/event` 里识别 `compaction/start` / `compaction/summary` / `compaction/end`；
 *      start/summary 时先解除待办，end 且无 error 时「挂起重注入」；
 *   2. 下一个 `agent/pre-step` 真正插块，**取走即清标记**。
 *
 * 防重复靠「时间维度」，不是内容维度：
 *   - 压缩把首轮块吃掉了，那些条目**正是**要补回来的，所以不能按「已注入过」排除
 *     （那会把该补的全排掉，实测会退化成 0 条）；
 *   - 真正的重复风险是「同一轮 pre-step 被调多次 / 连续每轮都插」，因此：
 *     a. take() 取走即清（内存标记，同进程）；
 *     b. 插完在 injections 表落 `kind='reinject'`，便于观测与跨进程核对；
 *     c. 标记只在压缩成功后挂起一次，消费掉就没了——不消费就不会重复插。
 */

export const REINJECT_KIND = 'reinject'

/**
 * 压缩事件归一化：只关心「要不要挂起重注入」。
 * @param {string} type session/event 的事件名
 * @param {unknown} data 事件 data
 * @returns {'arm'|'disarm'|'ignore'}
 *   arm    = 压缩成功结束，下轮要重注入
 *   disarm = 压缩开始/中途或失败（先解除，等下一个成功信号）
 *   ignore = 无关事件
 */
export function classifyCompactionEvent(type, data) {
  if (type === 'compaction/start' || type === 'compaction/summary') return 'disarm'
  if (type === 'compaction/end') {
    const err = data?.error
    const failed = err !== undefined && err !== null && err !== ''
    return failed ? 'disarm' : 'arm'
  }
  return 'ignore'
}

/**
 * 重注入待办表：纯内存、按 sessionId 记「压缩完了，等下一轮插块」。
 * 用工厂而不是模块级 Map：测试各自隔离，插件实例互不串味。
 */
export function createReinjectScheduler({ maxEntries = 512 } = {}) {
  /** @type {Map<string, {at:number, reason:string}>} */
  const pending = new Map()

  return {
    arm(sessionId, reason = 'compaction', now = Date.now()) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (pending.size >= maxEntries && !pending.has(sessionId)) {
        const oldest = pending.keys().next().value
        if (oldest !== undefined) pending.delete(oldest)
      }
      pending.set(sessionId, { at: now, reason })
      return true
    },
    disarm(sessionId) {
      if (typeof sessionId !== 'string') return false
      return pending.delete(sessionId)
    },
    isPending(sessionId) {
      return typeof sessionId === 'string' && pending.has(sessionId)
    },
    /** 消费：取走标记（消费即清，防重复的第一重保险）。 */
    take(sessionId) {
      const found = pending.get(sessionId)
      if (found === undefined) return null
      pending.delete(sessionId)
      return found
    },
    size() {
      return pending.size
    },
    clear() {
      pending.clear()
    },
  }
}

/**
 * 装配重注入内容：重新收集一份核心块（含当前项目索引）。
 *
 * 刻意不复用首轮 block 的原始文本：压缩后再逐字复读没意义，
 * 但核心块（soul/user/rules + 项目索引）本来就是「结论层」，重建一份即可。
 *
 * @param {{collectCore:Function}} deps
 * @returns {{text:string, ids:string[], chars:number, dropped:number} | null} null = 没什么可注
 */
export function buildReinjection(deps, args) {
  const { collectCore } = deps
  const { globalDb, workspaceDb, cfg, project, projectDetected, now } = args
  try {
    const core = collectCore({ globalDb, workspaceDb, cfg, project, projectDetected, now })
    if (!core || typeof core.text !== 'string' || core.text === '') return null
    if (!Array.isArray(core.ids) || core.ids.length === 0) return null
    return {
      text: core.text,
      ids: core.ids,
      bodyIds: core.bodyIds ?? core.ids,
      indexIds: core.indexIds ?? [],
      chars: core.chars,
      dropped: core.dropped ?? 0,
    }
  } catch {
    return null
  }
}
