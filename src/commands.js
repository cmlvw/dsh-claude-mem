/**
 * dsh-claude-mem · 用户斜杠命令
 *
 * 这些命令只能由用户本人发起，模型调用不了，所以信任工作区、批准待确认记忆都走这里：
 * 即使模型被工具输出里的内容误导，也无法替用户完成确认。
 */
import { listPendingEntries, resolveEntry, shortId, updateEntry } from './store.js'
import { buildReviewReport, formatReviewText } from './review.js'

const cwdOf = (invocation) => {
  const cwd = invocation?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

const sessionIdOf = (invocation) => {
  const id = invocation?.agent?.session?.header?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** 批准或拒绝：`all` 处理全部待确认条目，否则按 id 处理。只接受待确认状态的条目。 */
function settlePending(dbs, rawInput, status) {
  const token = String(rawInput ?? '').trim()
  if (token === '') return { error: '请给出条目 id，或用 all 处理全部。' }

  const settled = []
  if (token.toLowerCase() === 'all') {
    for (const db of dbs) {
      for (const entry of listPendingEntries(db)) {
        updateEntry(db, entry.id, { status })
        settled.push(entry)
      }
    }
    return { settled }
  }

  for (const db of dbs) {
    const { entry, ambiguous } = resolveEntry(db, token)
    if (ambiguous) return { error: `id 有歧义：${token}，请给更长的 id。` }
    if (entry === null) continue
    if (entry.status !== 'pending') return { error: `${shortId(entry.id)} 不是待确认状态（当前 ${entry.status}）。` }
    updateEntry(db, entry.id, { status })
    settled.push(entry)
    return { settled }
  }
  return { error: `没找到 id=${token} 的条目。` }
}

/**
 * @param {{dbsFor:(cwd:string|null)=>object[], globalDb:()=>object|null, workspaceDbFor:(cwd:string|null)=>object|null,
 *          trustWorkspace:(cwd:string)=>{ok:boolean, root:string, already:boolean}, audit:(event:string, detail:object)=>void,
 *          keywordMax:number}} deps
 */
export function createCommandDefinitions(deps) {
  const settleCommand = (name, status, verb, hint) => ({
    name,
    description: `${verb}待确认的记忆（soul/user/rules 在用户没有明确要求时写入的条目）。`,
    input: { hint },
    handler(invocation) {
      const cwd = cwdOf(invocation)
      const result = settlePending(deps.dbsFor(cwd), invocation?.rawInput, status)
      if (result.error) return { kind: 'error', text: `/${name}：${result.error}` }
      if (result.settled.length === 0) return { kind: 'success', text: '没有待确认的记忆。' }
      deps.audit(`memory.${status === 'active' ? 'approved' : 'rejected'}`, { ids: result.settled.map((entry) => entry.id) })
      const lines = result.settled.map((entry) => `  - ${shortId(entry.id)} [${entry.level}] ${entry.title}`)
      return { kind: 'success', text: `已${verb} ${result.settled.length} 条：\n${lines.join('\n')}` }
    },
  })

  return [
    {
      name: 'mem-trust',
      description: '信任当前工作区的记忆库。不是本机创建的库在信任前不会被打开或注入。',
      handler(invocation) {
        const cwd = cwdOf(invocation)
        if (cwd === null) return { kind: 'error', text: '/mem-trust 无法确定当前工作区。' }
        const { ok, root, already } = deps.trustWorkspace(cwd)
        if (already) return { kind: 'success', text: `${root} 的记忆库已在信任名单中。` }
        if (!ok) return { kind: 'error', text: '/mem-trust 写入信任标记失败，请检查插件数据目录的权限。' }
        deps.audit('workspace.trusted', { root, source: 'mem-trust' })
        return { kind: 'success', text: `已信任 ${root} 的记忆库，下一条消息起生效。` }
      },
    },
    {
      name: 'mem-review',
      description: '查看记忆库状态：待确认、疑似重复、缺少原因和长期未使用的条目。',
      handler(invocation) {
        const cwd = cwdOf(invocation)
        const report = buildReviewReport({
          globalDb: deps.globalDb(),
          workspaceDb: deps.workspaceDbFor(cwd),
          keywordMax: deps.keywordMax,
        })
        return { kind: 'success', text: formatReviewText(report) }
      },
    },
    settleCommand('mem-approve', 'active', '批准', '<id|all>'),
    settleCommand('mem-reject', 'archived', '拒绝', '<id|all>'),
    {
      name: 'mem-why',
      description: '解释记忆为什么被想起或没被想起。不带参数看上一轮，带一句话就试运行这句话（不注入、不改数据）。',
      input: { hint: '[要试运行的消息]' },
      async handler(invocation) {
        const cwd = cwdOf(invocation)
        if (cwd === null) return { kind: 'error', text: '/mem-why 无法确定当前工作区。' }
        const text = String(invocation?.rawInput ?? '').trim()
        if (text !== '') {
          const run = await deps.dryRun(cwd, sessionIdOf(invocation), text)
          if (run === null) return { kind: 'error', text: '/mem-why：工作区记忆库不可用。' }
          return { kind: 'success', text: `试运行（不会注入）：\n${deps.explain(run)}` }
        }
        const last = deps.lastRun(sessionIdOf(invocation))
        if (last === null) return { kind: 'success', text: '这个会话还没有召回记录。可以加一句话试运行：/mem-why <消息>' }
        return { kind: 'success', text: `上一轮：\n${deps.explain(last)}` }
      },
    },
    {
      name: 'mem-stats',
      description: '查看记忆召回记录：注入了多少、为什么没注入、向量服务是否正常。',
      input: { hint: '[天数，默认 7]' },
      handler(invocation) {
        const cwd = cwdOf(invocation)
        if (cwd === null) return { kind: 'error', text: '/mem-stats 无法确定当前工作区。' }
        const raw = Number(String(invocation?.rawInput ?? '').trim() || 7)
        const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.round(raw))) : 7
        return { kind: 'success', text: deps.stats(cwd, days) }
      },
    },
    {
      name: 'mem-feedback',
      description: '评价上一轮注入的记忆有没有用，结果计入 /mem-stats 的有用率。',
      input: { hint: 'good|bad' },
      handler(invocation) {
        const cwd = cwdOf(invocation)
        if (cwd === null) return { kind: 'error', text: '/mem-feedback 无法确定当前工作区。' }
        const verdict = String(invocation?.rawInput ?? '').trim().toLowerCase()
        if (verdict !== 'good' && verdict !== 'bad') return { kind: 'error', text: '用法：/mem-feedback good 或 /mem-feedback bad' }
        const last = deps.lastRun(sessionIdOf(invocation))
        if (last === null || last.picked.length === 0) return { kind: 'error', text: '上一轮没有注入记忆，没有可评价的内容。' }
        if (last.rated) return { kind: 'success', text: '上一轮已经评价过了。' }
        last.rated = true
        deps.recordFeedback(cwd, verdict === 'good' ? 'feedback_good' : 'feedback_bad')
        return { kind: 'success', text: `已记录：${last.picked.map((item) => item.entry.title).join('、')}` }
      },
    },
  ]
}
