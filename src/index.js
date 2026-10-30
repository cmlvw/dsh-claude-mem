/**
 * dsh-claude-mem · cordis 入口
 *
 * 组装顺序（PLAN.md §3/§5）：
 *   1. 全局库（soul/user/rules）—— 打不开也只降级，不 throw；
 *   2. 工作区库按 cwd 懒加载、缓存、随插件卸载关闭；
 *   3. pre-step：首轮核心块 / 后续命中块，插在真实 user 消息**前面**，不改写它；
 *   4. turn-stopping：M5 的 dream 触发点（当前空实现）；
 *   5. systemPrompt.section：恒定记忆手册（缓存友好）。
 *
 * 一切注入逻辑都包在 try/catch 里 fail-open；next() 本身异常照常抛给上游，
 * 不把「上游坏了」伪装成「注入成功」。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Config, resolveConfig } from './config.js'
import { dbStats, openMemoryDb } from './db.js'
import { collectCore, estimateTokens, renderHitBlock } from './inject.js'
import { assembleHits, buildGateTerms, detectProject, matchGateTerms, recall, shouldRecall } from './recall.js'
import { rerankHits } from './rerank.js'
import { runDreamGate } from './dream.js'
import { checkMutex, createMutexGuard, describeConflict } from './mutex.js'
import { NOTE_KIND, shouldNoteUserAsk, summarizeForNote, writeNote } from './notes.js'
import {
  buildReinjection,
  classifyCompactionEvent,
  createReinjectScheduler,
  REINJECT_KIND,
} from './reinject.js'
import {
  hasCoreInjection,
  hitInjectionCount,
  injectedIds,
  listProjects,
  markInjected,
  markReinjected,
  shortId,
  touchSession,
} from './store.js'
import { createSnapshotMessage } from './message.js'
import { registerTools } from './tools.js'

export { Config }

export const name = 'dsh-claude-mem'

/** DSH 服务依赖：M4 注册工具时要 tools；systemPrompt 轮询获取，不硬依赖。 */
export const inject = ['tools']

const here = dirname(fileURLToPath(import.meta.url))

/** 读文案槽位；文件缺失/损坏时退回内置值，绝不因为缺文案加载失败。 */
function loadPrompts(lang) {
  const fallback = {
    guide: '记忆工具（dsh-claude-mem）：先看索引，需要细节再用 mem_read 拉正文。',
  }
  try {
    const raw = readFileSync(join(here, 'prompts', `${lang}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...fallback, ...parsed }
  } catch {
    try {
      const raw = readFileSync(join(here, 'prompts', 'zh.json'), 'utf8')
      return { ...fallback, ...JSON.parse(raw) }
    } catch {
      return fallback
    }
  }
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx?.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // 日志失败不影响任何逻辑
  }
}

/**
 * 安全事件落盘（互斥这类「该被事后核实」的事，光走 ctx.logger 不够）：
 * headless profile 的 logger 是 no-op，事件只留在内存里，事后无法取证。
 *
 * 落点跟随 dataDir（= globalDbPath 所在目录），而不是硬编码 $DSH_HOME：
 *   - 真机：默认 globalDbPath 是 D:\dsh-claude-mem\global.db，审计就在同一目录；
 *   - 测试/演练：给的是临时库路径，审计天然隔离，不会污染用户的真实目录。
 * 写盘失败绝不抛错。只记结构化安全事件，不做通用日志（通用日志走 ctx.logger）。
 */
export function appendAudit(ctx, status, event, detail) {
  try {
    const dataDir = status?.paths?.dataDir
    if (typeof dataDir !== 'string' || dataDir === '') return
    mkdirSync(dataDir, { recursive: true })
    const file = join(dataDir, 'audit.jsonl')
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), plugin: name, event, ...detail })}\n`,
      'utf8',
    )
  } catch {
    // 审计写盘失败不影响任何逻辑
  }
}

function safeClose(db) {
  try {
    if (db !== null && db !== undefined && typeof db.close === 'function') db.close()
  } catch {
    // 已经关了 / 已失效
  }
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
}

/** pre-step 消息数组里，最后一条真实用户消息的下标。 */
function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.source?.kind === 'user') return i
  }
  return -1
}

/** 会话事件数组（对齐 meow 的取法：优先 ownEvents()，其次 events）。 */
function sessionEventsOf(session) {
  if (typeof session?.ownEvents === 'function') {
    const events = session.ownEvents()
    return Array.isArray(events) ? events : []
  }
  const events = session?.events
  return Array.isArray(events) ? events : []
}

/**
 * 本轮最后一条**真实用户消息**的文本（会话笔记用）。
 * 只认 source.kind === 'user'：插件注入的 snapshot 也是 role:'user'，
 * 不去区分就会把自己的注入当成用户的话记进笔记。
 */
function lastUserTextOf(agent) {
  const events = sessionEventsOf(agent?.session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'turn/start') break
    if (event?.type !== 'user/message') continue
    if (event?.data?.source?.kind !== 'user') continue
    const text = messageText(event.data)
    if (text !== '') return text
  }
  return ''
}

/** dream 的推送轮（仅在 dream.mode='push' 时走；默认 observe 不推）。 */
function pushDreamTurn(ctx, agent, cfg) {
  const followup = agent?.followup
  if (typeof followup !== 'function') {
    safeLog(ctx, 'warn', `${name}: agent.followup 不可用，dream 只记录不推送`)
    return false
  }
  try {
    followup.call(agent, {
      type: 'text',
      text: '【记忆整理】本轮请整理本次会话中值得长期记住的内容，按原子记忆 → 话题 → 项目总结三轮推进，先查重再写入，不新增重复条目。若没有值得记住的，直接回复「无新增」。',
    })
    return true
  } catch (error) {
    safeLog(ctx, 'warn', `${name}: dream 推送失败（忽略）：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * cordis 把 apply 的返回值当 effect 处理（app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1139-1167）：
 * 只接受函数 / null / Promise / 可迭代对象，其它一律 `TypeError: Invalid effect` 并让整条插件
 * 「did not activate」。所以**真机上必须返回 undefined**（meow-memory 也是这个姿势）。
 *
 * 但 fake ctx（tools/load-check.mjs 与 node --test）需要拿到 status 做断言，所以：
 *   - ctx 上有 fiber（真 cordis 上下文）→ 返回 undefined；
 *   - 纯对象 fake ctx → 返回 status。
 * 判据用 fiber 而不是包名：fake ctx 里没有，真机一定有。
 */
export function hasFiber(ctx) {
  try {
    const fiber = ctx?.fiber
    return fiber !== undefined && fiber !== null
  } catch {
    return false
  }
}

export function isCordisContext(ctx) {
  return hasFiber(ctx) && typeof ctx?.effect === 'function'
}

export async function apply(ctx, rawConfig = {}) {
  const status = await applyPlugin(ctx, rawConfig)
  // 真机：不返回任何东西（返回值会被当 effect）。fake ctx：返回 status 给测试用。
  if (isCordisContext(ctx)) return undefined
  return status
}

/** 真正的装配逻辑。返回 status 供测试/诊断；cordis 语义由 apply() 负责。 */
export async function applyPlugin(ctx, rawConfig = {}) {
  const status = {
    plugin: name,
    ok: true,
    enabled: false,
    hooks: [],
    tools: [],
    sections: [],
    warnings: [],
    db: null,
    dispose: () => {},
  }

  try {
    const resolved = resolveConfig(rawConfig)
    status.warnings.push(...resolved.warnings)
    status.config = resolved.config
    status.paths = {
      home: resolved.home,
      globalDbPath: resolved.globalDbPath,
      projectDir: resolved.projectDir,
      dataDir: resolved.dataDir,
    }
    status.enabled = resolved.config.enabled

    if (!resolved.config.enabled) {
      safeLog(ctx, 'info', `${name}: 已在配置里 enabled=false，跳过装配（数据保留）`)
      status.skipped = true
      return status
    }

    // 1) 互斥（本卡 M6，PLAN.md §11）：meow 阵营仍启用就拒绝装配。
    //    位置在「建库之前」：拒绝时不留下任何副作用（不建库、不挂钩子、不注册工具）。
    //    反射拿不到 loader 时 checkMutex 返回 reflected=false，不阻断（fail-open）。
    const mutex = checkMutex(ctx, { enabled: resolved.config.mutexWithMeow })
    status.mutex = mutex
    if (mutex.conflict) {
      const message = describeConflict(mutex)
      status.skipped = true
      status.refusedByMutex = true
      status.warnings.push(message)
      safeLog(ctx, 'warn', `${name}: ${message}`)
      // 落盘审计：headless 的 ctx.logger 是 no-op，只记 logger 事后无凭证；
      // 互斥拒绝是「该被事后核实」的安全事件，必须有可读的原始记录。
      appendAudit(ctx, status, 'mutex.refused', {
        reason: mutex.reason,
        rivals: mutex.rivals.map((rival) => ({ id: rival.id, pkg: rival.pkg })),
        self: mutex.self,
      })
      return status
    }
    if (!mutex.reflected) {
      status.warnings.push(`互斥检测未生效：${mutex.reason}`)
      safeLog(ctx, 'info', `${name}: 互斥检测未生效（${mutex.reason}）`)
      appendAudit(ctx, status, 'mutex.unavailable', { reason: mutex.reason })
    } else {
      safeLog(ctx, 'info', `${name}: 互斥检测通过（${mutex.reason}）`)
      appendAudit(ctx, status, 'mutex.passed', { reason: mutex.reason, self: mutex.self })
    }

    // 1) 全局库：soul/user/rules 的家。建不出来也不致命，只是全局层不可用。
    const globalDb = openMemoryDb(resolved.globalDbPath, {
      busyTimeoutMs: resolved.config.db.busyTimeoutMs,
      enableFts: resolved.config.db.enableFts,
    })
    status.warnings.push(...globalDb.warnings)
    let global = null
    if (globalDb.ok) {
      global = globalDb.db
      status.db = { path: globalDb.path, fts: globalDb.fts, stats: dbStats(global) }
      safeLog(
        ctx,
        'info',
        `${name}: 全局库就绪 ${globalDb.path}（fts=${globalDb.fts}, entries=${status.db.stats.entries}）`,
      )
    } else {
      status.warnings.push(`全局库打开失败，全局层不可用：${globalDb.error}`)
      safeLog(ctx, 'warn', `${name}: 全局库打开失败（fail-open 继续）：${globalDb.error}`)
    }

    // 2) 工作区库缓存：一个进程可能同时开多个工作区。
    const workspaceDbs = new Map()
    const openWorkspaceDb = (workspace) => {
      if (typeof workspace !== 'string' || workspace === '') return null
      const cached = workspaceDbs.get(workspace)
      if (cached !== undefined) return cached
      const opened = openMemoryDb(resolved.workspaceDbPath(workspace), {
        busyTimeoutMs: resolved.config.db.busyTimeoutMs,
        enableFts: resolved.config.db.enableFts,
      })
      const record = opened.ok ? { db: opened.db, fts: opened.fts, warnings: opened.warnings } : null
      workspaceDbs.set(workspace, record)
      if (record === null) status.warnings.push(`工作区库打开失败（${workspace}）：${opened.error}`)
      else if (opened.warnings.length > 0) status.warnings.push(...opened.warnings)
      return record
    }

    const closeAll = () => {
      for (const record of workspaceDbs.values()) safeClose(record?.db)
      workspaceDbs.clear()
      safeClose(global)
    }
    let closed = false
    status.dispose = () => {
      if (closed) return
      closed = true
      closeAll()
    }
    trackDisposal(ctx, status.dispose)

    // 3) 会话状态：只放内存，进程退出即清（真正的去重靠 injections 表）。
    const sessionState = new Map()
    const stateOf = (sessionId) => {
      if (sessionState.size > 512) sessionState.clear()
      const found = sessionState.get(sessionId)
      if (found !== undefined) return found
      const created = { initialDone: false, lastNoteAt: 0 }
      sessionState.set(sessionId, created)
      return created
    }

    // 3b) 压缩重注入待办（M5）：压缩成功后挂起，下一轮 pre-step 取走并插块。
    const reinject = createReinjectScheduler()

    // 3c) 运行期互斥守卫（M6）：加载后才在 plugin-manager 里热启 meow 的情况。
    //     每 30s 最多反射一次；命中冲突当轮不注入，并按 10 分钟 cooldown 记日志。
    const mutexGuard = createMutexGuard(ctx, { enabled: resolved.config.mutexWithMeow })

    // 门控词表按工作区缓存：关键词变化（M4 写入）最多 60s 后生效，不必每条消息扫库。
    const gateTermCache = new Map()
    const GATE_TERMS_TTL_MS = 60 * 1000
    const gateTermsOf = (workspace, workspaceDb) => {
      const now = Date.now()
      const cached = gateTermCache.get(workspace)
      if (cached !== undefined && now - cached.at < GATE_TERMS_TTL_MS) return cached.terms
      const terms = buildGateTerms(global, workspaceDb)
      gateTermCache.set(workspace, { terms, at: now })
      return terms
    }

    // 4) pre-step 注入。
    registerHook(ctx, status, 'agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages) || decision.messages.length === 0) {
          return decision
        }
        const agent = payload?.agent
        const header = agent?.session?.header
        const sessionId = header?.id
        const workspace = header?.cwd
        if (typeof sessionId !== 'string' || typeof workspace !== 'string' || workspace === '') return decision
        if (header?.origin === 'subagent') return decision
        if (payload?.signal?.aborted === true) return decision

        const userIndex = lastUserIndex(decision.messages)
        if (userIndex < 0) return decision

        // M6 运行期互斥守卫：加载之后 meow 被热启用了就不再注入（当轮跳过，不抛错）。
        // 守卫本身每轮都判（带 TTL 缓存）；noteConflictOnce 只负责按 cooldown 节流日志。
        const guardResult = mutexGuard.check()
        if (guardResult.conflict) {
          if (mutexGuard.noteConflictOnce()) {
            safeLog(ctx, 'warn', `${name}: ${describeConflict(guardResult)}（运行期检测，本轮不注入）`)
            appendAudit(ctx, status, 'mutex.runtime_refused', {
              sessionId,
              reason: guardResult.reason,
              rivals: guardResult.rivals.map((rival) => ({ id: rival.id, pkg: rival.pkg })),
            })
          }
          return decision
        }

        const workspaceDb = openWorkspaceDb(workspace)
        if (workspaceDb === null) return decision
        const state = stateOf(sessionId)
        touchSession(workspaceDb.db, sessionId, workspace)

        const userText = messageText(decision.messages[userIndex])
        const projectNames = listProjects(workspaceDb.db, { limit: 20 }).map((row) => row.project)
        const guessedProject = detectProject(userText, projectNames)
        const matchedGateTerms = matchGateTerms(userText, gateTermsOf(workspace, workspaceDb.db))

        // M5 之 3：压缩后重注入。必须排在「首轮」判断之前——
        // 压缩会让首轮注入记录看起来还「在」，但上下文已经被摘要吃掉了。
        const pending = reinject.take(sessionId)
        if (pending !== null) {
          const built = buildReinjection(
            { collectCore },
            {
              globalDb: global,
              workspaceDb: workspaceDb.db,
              cfg: resolved.config,
              project: guessedProject,
              projectDetected: guessedProject !== null,
            },
          )
          if (built !== null) {
            decision.messages.splice(
              userIndex,
              0,
              createSnapshotMessage(built.text, {
                injectionKind: REINJECT_KIND,
                sections: [{ name: '长期记忆', text: built.text }],
                meta: { reinjectReason: pending.reason },
              }),
            )
            markReinjected(workspaceDb.db, sessionId, built.ids)
            state.initialDone = true
            safeLog(
              ctx,
              'info',
              `${name}: 压缩后重注入 ${built.chars} 字（${built.ids.length} 条，原因 ${pending.reason}）`,
            )
            return decision
          }
          safeLog(ctx, 'info', `${name}: 压缩后无可重注入内容，跳过`)
          return decision
        }

        const isFirst = !state.initialDone && !hasCoreInjection(workspaceDb.db, sessionId)
        if (isFirst) {
          const core = collectCore({
            globalDb: global,
            workspaceDb: workspaceDb.db,
            cfg: resolved.config,
            project: guessedProject,
            projectDetected: guessedProject !== null,
          })
          if (core.text !== '' && core.ids.length > 0) {
            decision.messages.splice(
              userIndex,
              0,
              createSnapshotMessage(core.text, { injectionKind: 'initial', sections: [{ name: '长期记忆', text: core.text }] }),
            )
            markInjected(workspaceDb.db, sessionId, core.ids, 'initial')
            state.initialDone = true
            safeLog(
              ctx,
              'info',
              `${name}: 首轮注入 ${core.chars} 字（≈${estimateTokens(core.chars)} tokens，${core.ids.length} 条，丢 ${core.dropped} 行）`,
            )
          }
          return decision
        }

        if (
          !shouldRecall(userText, {
            enabled: resolved.config.recall.gate.enabled,
            minChars: resolved.config.recall.gate.minChars,
            maxHitsPerSession: resolved.config.recall.gate.maxHitsPerSession,
            injectedCount: hitInjectionCount(workspaceDb.db, sessionId),
            projectNames,
            matchedTerms: matchedGateTerms,
          })
        ) {
          return decision
        }

        const exclude = injectedIds(workspaceDb.db, sessionId)
        const stageOne = recall({
          globalDb: global,
          workspaceDb: workspaceDb.db,
          text: userText,
          topK: resolved.config.recall.topK,
          exclude,
          extraTerms: matchedGateTerms,
        })
        // Stage 2 默认关（§13-B）：关着时直接返回 Stage 1 顺序，不碰网络。
        const reranked = await rerankHits(stageOne, {
          enabled: resolved.config.recall.rerank.enabled,
          url: resolved.config.recall.rerank.url,
          timeoutMs: resolved.config.recall.rerank.timeoutMs,
          maxPicks: resolved.config.recall.rerank.maxPicks,
          query: userText,
        })
        const assembled = assembleHits(reranked.hits, {
          maxHits: resolved.config.inject.maxHitsPerTurn,
          maxCharsPerHit: resolved.config.inject.maxHitChars,
          budget: resolved.config.inject.hitBudget,
        })
        if (assembled.picked.length === 0) return decision
        if (reranked.applied) safeLog(ctx, 'info', `${name}: 精排 ${reranked.reason}（${reranked.hits.length} 条）`)
        const block = renderHitBlock(assembled.picked)
        if (block === '') return decision
        const ids = assembled.picked.map((item) => item.entry.id)
        decision.messages.splice(
          userIndex,
          0,
          createSnapshotMessage(block, { injectionKind: 'hit', sections: [{ name: '记忆命中', text: block }] }),
        )
        markInjected(workspaceDb.db, sessionId, ids, 'hit')
        state.initialDone = true
        safeLog(
          ctx,
          'info',
          `${name}: 命中注入 ${block.length} 字（${ids.map(shortId).join(',')}）`,
        )
        return decision
      } catch (error) {
        safeLog(ctx, 'warn', `${name}: pre-step 注入失败（fail-open 放行原消息）：${error instanceof Error ? error.message : String(error)}`)
        return decision
      }
    })

    // 5) turn-stopping：M5 的 dream 门控 + 会话笔记。
    //    全程 fail-open：整理判定出问题只记日志，绝不影响回合收尾。
    registerHook(ctx, status, 'agent/turn-stopping', (payload) => {
      try {
        const agent = payload?.agent
        const header = agent?.session?.header
        const sessionId = header?.id
        const workspace = header?.cwd
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (header?.origin === 'subagent') return
        if (typeof workspace !== 'string' || workspace === '') return

        const workspaceDb = openWorkspaceDb(workspace)
        if (workspaceDb === null) return
        const db = workspaceDb.db

        // 5a) 会话笔记（只写不注入，先跑观察）。
        if (resolved.config.notes.enabled) {
          const state = stateOf(sessionId)
          const now = Date.now()
          if (now - state.lastNoteAt >= resolved.config.notes.minIntervalMs) {
            state.lastNoteAt = now
            const userText = lastUserTextOf(agent)
            if (shouldNoteUserAsk(userText, { minChars: resolved.config.notes.minChars })) {
              const written = writeNote(
                db,
                {
                  sessionId,
                  workspace,
                  kind: NOTE_KIND.userAsk,
                  body: summarizeForNote(userText, resolved.config.notes.maxChars),
                },
                now,
              )
              if (written.written) safeLog(ctx, 'info', `${name}: 会话笔记 +1（${shortId(written.id)}）`)
            }
          }
        }

        // 5b) dream 门控（24h + 5 会话 + 10 分钟节流，三者同时满足）。
        if (!resolved.config.dream.enabled) return
        const now = Date.now()
        const gate = runDreamGate(db, resolved.config.dream, now)
        if (!gate.trigger) {
          if (gate.reason !== 'throttle') {
            safeLog(ctx, 'info', `${name}: dream 不触发（${gate.reason}，会话 ${gate.sessions}）`)
          }
          return
        }
        safeLog(
          ctx,
          'info',
          `${name}: dream 门控打开（${gate.reason}，会话 ${gate.sessions}，run=${gate.runId}）`,
        )
        if (resolved.config.dream.mode === 'push') pushDreamTurn(ctx, agent, resolved.config)
      } catch (error) {
        safeLog(ctx, 'warn', `${name}: turn-stopping 处理失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // 5c) session/event：识别压缩事件，成功后挂起重注入（M5 之 3 的信号源）。
    registerHook(ctx, status, 'session/event', (session, event) => {
      try {
        const type = event?.type
        const action = classifyCompactionEvent(type, event?.data)
        if (action === 'ignore') return
        const sessionId = session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (action === 'arm') {
          reinject.arm(sessionId, 'compaction')
          safeLog(ctx, 'info', `${name}: 检测到压缩完成，已挂起重注入（${sessionId}）`)
        } else {
          reinject.disarm(sessionId)
        }
      } catch (error) {
        safeLog(ctx, 'warn', `${name}: 压缩事件处理失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // 6) 静态记忆手册：恒定文本，缓存友好。
    const prompts = loadPrompts(resolved.config.promptLang)
    registerGuideSection(ctx, status, prompts)

    // 7) 五个记忆工具（M4）。工具不可用时只记 warning，不影响注入。
    registerMemoryTools(ctx, status, {
      config: resolved.config,
      openWorkspaceDb,
      globalDbRef: () => global,
      isGlobalLevel: resolved.isGlobalLevel,
      prompts,
    })

    status.stats = status.db?.stats ?? null
    safeLog(ctx, 'info', `${name}: 装配完成（hooks=${status.hooks.length}, sections=${status.sections.length}）`)
    return status
  } catch (error) {
    status.ok = false
    status.error = error instanceof Error ? error.message : String(error)
    status.warnings.push(`apply 异常（已 fail-open）：${status.error}`)
    safeLog(ctx, 'warn', `${name}: apply 异常（已 fail-open，注入与工具均不生效）：${status.error}`)
    return status
  }
}

/**
 * 注册五个记忆工具。DSH 的 tools 服务可能在 apply 之后才就绪，与 systemPrompt 同样做短轮询；
 * 拿不到服务只记 warning——注入照常工作，不能因为工具起不来把插件整体判死。
 */
function registerMemoryTools(ctx, status, deps, attempt = 0) {
  const register = () => {
    try {
      // 真机上 ctx.tools 是直接挂着服务的（meow-memory 同款用法）；ctx.get('tools') 只作兜底。
      const direct = ctx?.tools
      const service =
        direct !== undefined && direct !== null && typeof direct.register === 'function'
          ? direct
          : typeof ctx?.get === 'function'
            ? ctx.get('tools')
            : undefined
      if (service === undefined || service === null || typeof service.register !== 'function') {
        if (attempt < 20) {
          const timer = setTimeout(() => registerMemoryTools(ctx, status, deps, attempt + 1), 1000)
          if (typeof timer?.unref === 'function') timer.unref()
        } else {
          status.warnings.push('tools 服务 20s 内未就绪，五个记忆工具未注册（注入不受影响）')
        }
        return
      }
      const registered = registerTools(service, deps, deps.prompts)
      status.tools.push(...registered)
      safeLog(ctx, 'info', `${name}: 已注册工具 ${registered.join(', ')}`)
    } catch (error) {
      status.warnings.push(`工具注册失败：${error instanceof Error ? error.message : String(error)}`)
      safeLog(ctx, 'warn', `${name}: 工具注册失败（已 fail-open）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  register()
}

function registerHook(ctx, status, event, handler) {
  try {
    if (typeof ctx?.on !== 'function') {
      status.warnings.push(`ctx.on 不可用，${event} 未挂载`)
      return
    }
    const dispose = ctx.on(event, handler)
    status.hooks.push(event)
    if (typeof dispose === 'function') status.hooks.push(`${event}:dispose`)
  } catch (error) {
    status.warnings.push(`${event} 挂载失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function registerGuideSection(ctx, status, prompts, attempt = 0) {
  const register = () => {
    try {
      const service = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : ctx?.systemPrompt
      if (service === undefined || service === null || typeof service.section !== 'function') {
        if (attempt < 20) {
          const timer = setTimeout(() => registerGuideSection(ctx, status, prompts, attempt + 1), 1000)
          if (typeof timer?.unref === 'function') timer.unref()
        } else {
          status.warnings.push('systemPrompt 20s 内未就绪，记忆手册未挂进 system prompt（工具不受影响）')
        }
        return
      }
      service.section({ name: `${name}:guide`, order: 130, text: prompts.guide })
      status.sections.push(`${name}:guide`)
    } catch (error) {
      status.warnings.push(`guide section 挂载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  register()
}

function trackDisposal(ctx, closeFn) {
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => closeFn())
    }
  } catch {
    // 生命周期登记失败不影响功能
  }
}
