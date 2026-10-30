/**
 * dsh-claude-mem · 五个记忆工具（M4）
 *
 * 设计（PLAN.md §7）：
 * - 工具只做「参数校验 + 路由到 store.js 已有能力」，不重写检索/去重逻辑；
 *   recall 的规则门是「要不要主动注入」的判断，用户显式调用 mem_search 时不该被门挡住，
 *   所以这里直接走 store.searchEntries（Stage 1 同等能力），不经过 shouldRecall。
 * - 校验集中在纯函数里（validateRemember 等），便于单测；execute 只负责取库和落库。
 * - 一切失败都抛 Error（工具层用抛错表达拒绝），不返回「假成功」。
 * - 密钥拒收：扫 title+body+keywords，命中就拒，且报错信息不回显秘文本身。
 */
import { scanSecrets } from './secret.js'
import {
  LEVELS,
  SUBCATEGORIES,
  deriveTitle,
  formatIndexLine,
  getEntry,
  insertEntry,
  listByLevel,
  listProjects,
  parseKeywords,
  projectIndexFor,
  resolveEntry,
  rowToEntry,
  searchEntries,
  shortId,
  updateEntry,
  upsertEntry,
} from './store.js'
import { ageLabel } from './time.js'

const GLOBAL_PROJECT = '全局'

/** 各层正文长度上限（PLAN §4.2 / §7）。topic 更短。 */
export function maxBodyChars(level, cfg) {
  const base = cfg?.write?.maxBodyChars ?? 400
  if (level === 'topic') return Math.min(base, 300)
  if (level === 'fact' || level === 'lesson') return Math.min(base, 60)
  return base
}

export function maxTitleChars(cfg) {
  return cfg?.write?.maxTitleChars ?? 40
}

/** 关键词数量区间（PLAN §7：8–13）。 */
export function keywordRange(cfg) {
  return {
    min: cfg?.write?.keywordMin ?? 8,
    max: cfg?.write?.keywordMax ?? 13,
  }
}

function charLen(text) {
  return Array.from(String(text ?? '')).length
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * mem_remember 的纯校验。返回 {ok:true, entry} 或 {ok:false, error, hint}。
 * 不碰数据库——单测可以直接跑。
 */
export function validateRemember(args, cfg) {
  const raw = args ?? {}
  const level = clean(raw.level) === '' ? 'fact' : clean(raw.level)
  if (!LEVELS.includes(level)) {
    return { ok: false, error: `level 非法：${level}`, hint: `可选：${LEVELS.join(' / ')}` }
  }

  const content = clean(raw.content)
  if (content === '') return { ok: false, error: 'content 不能为空' }

  // 密钥/凭据：**第一道闸**。必须在长度检查之前——否则一条又长又含密钥的内容
  // 会被「过长」这个次要原因拒掉，安全红线就没真正生效。
  if (cfg?.write?.rejectSecrets !== false) {
    const scanned = scanSecrets([clean(raw.title), content, parseKeywords(raw.keywords).join(' ')].join('\n'))
    if (scanned.hit) {
      return {
        ok: false,
        error: '内容疑似含密钥/凭据，已拒收',
        hint: `命中规则：${scanned.rules.join(', ')}。记忆库会长期留档并可能被注入后续会话，凭据一律不进记忆；需要时只写「见某凭证文件」。`,
      }
    }
  }

  const limit = maxBodyChars(level, cfg)
  if (charLen(content) > limit) {
    return {
      ok: false,
      error: `正文过长：${charLen(content)} 字，${level} 层上限 ${limit} 字`,
      hint: '拆成多条，或降级为 topic 分条记录；不要硬塞一条超长正文。',
    }
  }

  const project = clean(raw.project)
  if (level === 'project' && project === '') {
    return { ok: false, error: 'level=project 时 project 必填' }
  }

  const subcategory = clean(raw.subcategory)
  if (subcategory !== '' && !SUBCATEGORIES.includes(subcategory)) {
    return {
      ok: false,
      error: `subcategory 非法：${subcategory}`,
      hint: `可选：${SUBCATEGORIES.join(' / ')}`,
    }
  }

  // 关键词：接受数组或分隔符字符串；不足下限时拒收（PLAN §7 硬规则）。
  const keywords = parseKeywords(raw.keywords)
  const range = keywordRange(cfg)
  if (keywords.length === 0) {
    return {
      ok: false,
      error: 'keywords 不能为空',
      hint: `请给 ${range.min}–${range.max} 个检索关键词：想清楚用户说什么话时这条该被翻出来。`,
    }
  }
  if (keywords.length < range.min) {
    return {
      ok: false,
      error: `keywords 太少：${keywords.length} 个，至少 ${range.min} 个`,
      hint: `补到 ${range.min}–${range.max} 个。`,
    }
  }
  if (keywords.length > range.max) {
    return {
      ok: false,
      error: `keywords 太多：${keywords.length} 个，最多 ${range.max} 个`,
      hint: `删减到 ${range.min}–${range.max} 个最有区分度的词。`,
    }
  }

  const importanceRaw = Number(raw.importance)
  const importance = Number.isFinite(importanceRaw) ? Math.max(1, Math.round(importanceRaw)) : 1

  const title = clean(raw.title)
  if (charLen(title) > maxTitleChars(cfg)) {
    return { ok: false, error: `title 过长：${charLen(title)} 字，上限 ${maxTitleChars(cfg)} 字` }
  }

  // 软提示（不拒收）：绝对路径 / 端口 / 版本号这类「读文件就能知道」的信息。
  const warnings = []
  if (/(?:[A-Za-z]:\\|\/Users\/|\/home\/)/.test(content)) {
    warnings.push('正文里含绝对路径：按信息边界，代码/配置能查到的路径不该进记忆，建议只写「看哪个文件」。')
  }
  if (/\b\d{2,5}\s*端口|port\s*[:=]?\s*\d{2,5}/i.test(content)) {
    warnings.push('正文里含端口号：建议只记「看哪个配置文件」。')
  }

  const entry = {
    level,
    scope: cfg?.isGlobalLevel?.(level) === true ? 'global' : undefined,
    project: project === '' ? null : project,
    subcategory: subcategory === '' ? null : subcategory,
    goal: clean(raw.goal) === '' ? null : clean(raw.goal),
    title: title === '' ? undefined : title,
    body: content,
    keywords,
    importance,
    status: 'active',
  }
  return { ok: true, entry, warnings }
}

/**
 * mem_remember 落库：先校验，再 upsert（相似合并）。
 * @returns {{ok:true, id, short_id, level, merged, keywords, project, warnings} | {ok:false, error, hint}}
 */
export function rememberInto(db, args, cfg, now = Date.now()) {
  const checked = validateRemember(args, cfg)
  if (!checked.ok) return checked
  const result = upsertEntry(db, checked.entry, { dedupThreshold: cfg?.write?.dedupThreshold ?? 0.9 }, now)
  return {
    ok: true,
    id: result.entry.id,
    short_id: shortId(result.entry.id),
    level: result.entry.level,
    merged: result.action === 'merged',
    keywords: result.entry.keywords,
    project: result.entry.project ?? null,
    importance: result.entry.importance,
    warnings: checked.warnings,
  }
}

/** mem_search：直接走 store 的混合检索，不受 Stage 0 规则门限制。 */
export function searchMemory(globalDb, workspaceDb, args, cfg, now = Date.now()) {
  const query = clean(args?.query)
  if (query === '') {
    return { ok: false, error: 'query 不能为空（想浏览项目全貌请用 mem_project）' }
  }
  const levelsRaw = clean(args?.level)
  const levels = levelsRaw === ''
    ? undefined
    : levelsRaw.split(',').map((s) => s.trim()).filter((s) => LEVELS.includes(s))
  if (levels !== undefined && levels.length === 0) {
    return { ok: false, error: `level 无有效值：${levelsRaw}` }
  }
  const project = clean(args?.project)
  const kRaw = Number(args?.k)
  const k = Number.isFinite(kRaw) ? Math.max(1, Math.min(50, Math.round(kRaw))) : 10

  const merged = new Map()
  for (const db of [globalDb, workspaceDb]) {
    if (db === null || db === undefined) continue
    for (const hit of searchEntries(db, query, {
      limit: k,
      levels,
      project: project === '' ? undefined : project,
      now,
    })) {
      const existing = merged.get(hit.entry.id)
      if (existing === undefined || hit.score > existing.score) merged.set(hit.entry.id, hit)
    }
  }

  const hits = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((hit) => ({
      id: shortId(hit.entry.id),
      full_id: hit.entry.id,
      level: hit.entry.level,
      subcategory: hit.entry.subcategory ?? null,
      project: hit.entry.project ?? null,
      title: hit.entry.title,
      summary: summaryOf(hit.entry.body, 60),
      keywords: hit.entry.keywords,
      importance: hit.entry.importance,
      score: Number(hit.score.toFixed(3)),
      updated_at: hit.entry.updated_at,
      age: ageLabel(hit.entry.updated_at, now),
    }))
  return { ok: true, query, hits, note: hits.length === 0 ? '没有命中；换个词或直接 mem_project 看项目全景。' : undefined }
}

/** 摘要：超长截断，保留可读性。 */
export function summaryOf(body, maxChars = 60) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join('')}…`
}

/** mem_read：短 id 或完整 id 取全文。两个库都找（工作区优先）。 */
export function readMemory(globalDb, workspaceDb, args) {
  const token = clean(args?.id)
  if (token === '') return { ok: false, error: 'id 不能为空' }
  for (const db of [workspaceDb, globalDb]) {
    if (db === null || db === undefined) continue
    const resolved = resolveEntry(db, token)
    if (resolved.entry !== null) {
      const entry = resolved.entry
      return {
        ok: true,
        id: shortId(entry.id),
        full_id: entry.id,
        level: entry.level,
        subcategory: entry.subcategory ?? null,
        project: entry.project ?? null,
        goal: entry.goal ?? null,
        title: entry.title,
        body: entry.body,
        keywords: entry.keywords,
        importance: entry.importance,
        status: entry.status,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        age: ageLabel(entry.updated_at, Date.now()),
      }
    }
    if (resolved.ambiguous) {
      return { ok: false, error: `id 有歧义：${token} 匹配到多条，请给更长的 id` }
    }
  }
  return { ok: false, error: `没找到 id=${token} 的条目` }
}

/**
 * mem_update：按短/完整 id 更新。先校验新正文（密钥/超长），再按需改字段。
 */
export function updateMemory(globalDb, workspaceDb, args, cfg, now = Date.now()) {
  const token = clean(args?.id)
  if (token === '') return { ok: false, error: 'id 不能为空' }

  let db = null
  let entry = null
  for (const candidate of [workspaceDb, globalDb]) {
    if (candidate === null || candidate === undefined) continue
    const resolved = resolveEntry(candidate, token)
    if (resolved.entry !== null) {
      db = candidate
      entry = resolved.entry
      break
    }
    if (resolved.ambiguous) {
      return { ok: false, error: `id 有歧义：${token} 匹配到多条，请给更长的 id` }
    }
  }
  if (entry === null) return { ok: false, error: `没找到 id=${token} 的条目` }

  const patch = {}
  const warnings = []

  if (args?.content !== undefined) {
    const content = clean(args.content)
    if (content === '') return { ok: false, error: '新 content 不能为空' }
    const limit = maxBodyChars(entry.level, cfg)
    if (charLen(content) > limit) {
      return { ok: false, error: `正文过长：${charLen(content)} 字，${entry.level} 层上限 ${limit} 字` }
    }
    if (cfg?.write?.rejectSecrets !== false && scanSecrets(content).hit) {
      return {
        ok: false,
        error: '内容疑似含密钥/凭据，已拒收',
        hint: `命中规则：${scanSecrets(content).rules.join(', ')}`,
      }
    }
    patch.body = content
  }

  if (args?.title !== undefined) {
    const title = clean(args.title)
    if (charLen(title) > maxTitleChars(cfg)) return { ok: false, error: 'title 过长' }
    patch.title = title === '' ? undefined : title
  } else if (patch.body !== undefined && entry.title === deriveTitle(entry.body)) {
    // 正文改了、标题还是从旧正文派生出来的 → 一起重派生，否则索引行和 FTS 都留在旧内容上。
    // 用户显式设过标题（!= 旧正文派生值）时不覆盖。
    patch.title = deriveTitle(patch.body)
  }

  if (args?.importance !== undefined) {
    const value = Number(args.importance)
    if (!Number.isFinite(value)) return { ok: false, error: 'importance 必须是数字' }
    patch.importance = Math.max(1, Math.round(value))
  }

  if (args?.keywords !== undefined) {
    const keywords = parseKeywords(args.keywords)
    const range = keywordRange(cfg)
    if (keywords.length < range.min) {
      return { ok: false, error: `keywords 太少：${keywords.length} 个，至少 ${range.min} 个` }
    }
    if (keywords.length > range.max) {
      return { ok: false, error: `keywords 太多：${keywords.length} 个，最多 ${range.max} 个` }
    }
    patch.keywords = keywords
  }

  if (args?.status !== undefined) {
    const status = clean(args.status)
    if (!['active', 'stale', 'archived'].includes(status)) {
      return { ok: false, error: `status 非法：${status}`, hint: '可选：active / stale（完结）/ archived（作废）' }
    }
    patch.status = status
  }

  if (args?.project !== undefined) patch.project = clean(args.project) === '' ? null : clean(args.project)
  if (args?.subcategory !== undefined) {
    const subcategory = clean(args.subcategory)
    if (subcategory !== '' && !SUBCATEGORIES.includes(subcategory)) {
      return { ok: false, error: `subcategory 非法：${subcategory}` }
    }
    patch.subcategory = subcategory === '' ? null : subcategory
  }
  if (args?.goal !== undefined) patch.goal = clean(args.goal) === '' ? null : clean(args.goal)

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: '没有要更新的字段（content/importance/keywords/status/title/project/subcategory/goal 至少给一个）' }
  }

  // 更新必须按最终候选值整体扫描，避免只扫 content 而 title/keywords 把凭据带入库。
  if (cfg?.write?.rejectSecrets !== false) {
    const candidateTitle = Object.prototype.hasOwnProperty.call(patch, 'title') ? patch.title : entry.title
    const candidateBody = Object.prototype.hasOwnProperty.call(patch, 'body') ? patch.body : entry.body
    const candidateKeywords = Object.prototype.hasOwnProperty.call(patch, 'keywords') ? patch.keywords : entry.keywords
    const scanned = scanSecrets([candidateTitle, candidateBody, parseKeywords(candidateKeywords).join(' ')].join('\n'))
    if (scanned.hit) {
      return { ok: false, error: '内容疑似含密钥/凭据，已拒收', hint: `命中规则：${scanned.rules.join(', ')}` }
    }
  }

  const updated = updateEntry(db, entry.id, patch, now)
  if (updated === null) return { ok: false, error: `更新失败：没找到 id=${token}` }
  return {
    ok: true,
    id: shortId(updated.id),
    full_id: updated.id,
    level: updated.level,
    title: updated.title,
    changed: Object.keys(patch),
    importance: updated.importance,
    status: updated.status,
    keywords: updated.keywords,
    warnings,
  }
}

/**
 * mem_project：项目全景。复用 projectIndexFor（与注入同一套投影规则），
 * 但这里给的是「全量可读」：每行都带短 id，可直接接 mem_read。
 */
export function projectOverview(workspaceDb, globalDb, args, cfg, now = Date.now()) {
  if (workspaceDb === null || workspaceDb === undefined) {
    return { ok: false, error: '工作区库不可用' }
  }
  const requested = clean(args?.project)
  const names = listProjects(workspaceDb, { limit: 50 }).map((row) => row.project)
  const project = requested !== '' ? requested : names[0] ?? null
  if (project === null) {
    return { ok: true, project: null, projects: [], note: '工作区里还没有任何项目记忆。' }
  }

  const maxRowsRaw = Number(args?.maxRows)
  const maxRows = Number.isFinite(maxRowsRaw) ? Math.max(1, Math.min(200, Math.round(maxRowsRaw))) : 40
  const index = projectIndexFor(workspaceDb, project, {
    maxRows,
    maxLineChars: cfg?.inject?.maxIndexLineChars ?? 60,
    now,
  })

  // 按子类分组，便于一眼看出「决策/待办/原话」各有什么。
  const groups = new Map()
  for (const entry of index.entries ?? []) {
    const key = entry.level === 'project' ? entry.subcategory ?? 'project' : entry.level
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({
      id: shortId(entry.id),
      level: entry.level,
      title: entry.title,
      kind: entry.level === 'project' ? 'project' : entry.level,
      importance: entry.importance,
      age: ageLabel(entry.updated_at, now),
      line: formatIndexLine(entry, { maxLineChars: cfg?.inject?.maxIndexLineChars ?? 60, now }),
    })
  }

  return {
    ok: true,
    project,
    total: index.total,
    hidden: index.hidden,
    projects: names,
    lines: (index.entries ?? []).map((entry) => ({
      id: shortId(entry.id),
      line: formatIndexLine(entry, { maxLineChars: cfg?.inject?.maxIndexLineChars ?? 60, now }),
    })),
    groups: [...groups.entries()].map(([kind, items]) => ({ kind, items })),
  }
}

// ---------------------------------------------------------------- DSH 工具对象

/** 统一取会话上下文：workspace 决定用哪个工作区库，sessionId 记来源。 */
function contextOf(exec) {
  const header = exec?.agent?.session?.header ?? {}
  const workspace = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null
  const sessionId = typeof header.id === 'string' && header.id.length > 0 ? header.id : null
  return { workspace, sessionId }
}

/**
 * 注册五个工具。
 * @param {{register:Function}} tools 服务
 * @param {object} deps { config, openWorkspaceDb, globalDb }
 * @returns {string[]} 已注册的工具名
 */
export function registerTools(tools, deps, prompts) {
  const { config, openWorkspaceDb, globalDbRef, isGlobalLevel } = deps
  const t = prompts?.tools ?? {}
  const registered = []

  /** 每个工具执行时现取库：工作区库按 cwd 懒加载（与注入同一套缓存）。 */
  const withDbs = (exec, fn) => {
    const { workspace, sessionId } = contextOf(exec)
    if (workspace === null) {
      throw new Error('无法确定工作区（会话无 cwd），记忆工具不可用')
    }
    const workspaceDb = openWorkspaceDb(workspace)
    if (workspaceDb === null || workspaceDb.db === undefined) {
      throw new Error(`工作区库不可用：${workspace}`)
    }
    return fn({
      workspaceDb: workspaceDb.db,
      globalDb: typeof globalDbRef === 'function' ? globalDbRef() : globalDbRef,
      workspace,
      sessionId,
    })
  }

  const push = (tool) => {
    tools.register(tool)
    registered.push(tool.name)
  }

  push({
    name: 'mem_remember',
    description: t.remember?.description ?? '写入一条跨会话记忆。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'project', 'keywords'],
      properties: {
        content: { type: 'string', description: t.remember?.param?.content ?? '正文。' },
        level: {
          type: 'string',
          enum: LEVELS,
          default: 'fact',
          description: t.remember?.param?.level ?? '层级。',
        },
        project: { type: 'string', description: t.remember?.param?.project ?? '归属项目；全局填「全局」。' },
        title: { type: 'string', description: t.remember?.param?.title ?? '标题（≤40 字）。' },
        subcategory: { type: 'string', description: t.remember?.param?.subcategory ?? '仅 level=project 时用。' },
        goal: { type: 'string', description: t.remember?.param?.goal ?? '仅 level=topic 时用。' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          minItems: 8,
          maxItems: 13,
          description: t.remember?.param?.keywords ?? '8–13 个检索关键词。',
        },
        importance: { type: 'integer', minimum: 1, maximum: 4, default: 1, description: t.remember?.param?.importance ?? '重要性 1–4。' },
        corrected: { type: 'boolean', default: false, description: t.remember?.param?.corrected ?? '是否来自纠正。' },
      },
    },
    async execute(args, exec) {
      return withDbs(exec, ({ workspaceDb, globalDb, sessionId }) => {
        const level = clean(args?.level) === '' ? 'fact' : clean(args?.level)
        const project = clean(args?.project)
        const globalTarget = typeof isGlobalLevel === 'function'
          ? isGlobalLevel(level, args?.scope) || project === GLOBAL_PROJECT
          : level === 'soul' || level === 'user' || level === 'rules' || project === GLOBAL_PROJECT
        const targetDb = globalTarget ? globalDb : workspaceDb
        if (targetDb === null || targetDb === undefined) throw new Error('全局记忆库不可用，未写入')
        const result = rememberInto(targetDb, args, { ...config, isGlobalLevel: () => globalTarget })
        if (!result.ok) throw new Error(`mem_remember 拒收：${result.error}${result.hint ? `（${result.hint}）` : ''}`)
        if (sessionId !== null) updateEntry(targetDb, result.id, { source_session: sessionId }, Date.now())
        return result
      })
    },
  })

  push({
    name: 'mem_search',
    description: t.search?.description ?? '按关键词检索记忆。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: t.search?.param?.query ?? '检索词。' },
        level: { type: 'string', description: t.search?.param?.level ?? '限定层级（逗号分隔）。' },
        project: { type: 'string', description: t.search?.param?.project ?? '限定项目名。' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: t.search?.param?.k ?? '返回条数。' },
      },
    },
    async execute(args, exec) {
      return withDbs(exec, ({ workspaceDb, globalDb }) => {
        const result = searchMemory(globalDb, workspaceDb, args, config)
        if (!result.ok) throw new Error(`mem_search：${result.error}`)
        return result
      })
    },
  })

  push({
    name: 'mem_read',
    description: t.read?.description ?? '按短 id 读取记忆全文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: t.read?.param?.id ?? '短 id 或完整 id。' },
      },
    },
    async execute(args, exec) {
      return withDbs(exec, ({ workspaceDb, globalDb }) => {
        const result = readMemory(globalDb, workspaceDb, args)
        if (!result.ok) throw new Error(`mem_read：${result.error}`)
        return result
      })
    },
  })

  push({
    name: 'mem_update',
    description: t.update?.description ?? '更新一条已有记忆。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: t.update?.param?.id ?? '短 id 或完整 id。' },
        content: { type: 'string', description: t.update?.param?.content ?? '新正文。' },
        title: { type: 'string', description: t.update?.param?.title ?? '新标题。' },
        importance: { type: 'integer', minimum: 1, maximum: 4, description: t.update?.param?.importance ?? '新重要性。' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: t.update?.param?.keywords ?? '新关键词。',
        },
        status: { type: 'string', enum: ['active', 'stale', 'archived'], description: t.update?.param?.status ?? '新状态。' },
        project: { type: 'string', description: t.update?.param?.project ?? '改归属项目。' },
        subcategory: { type: 'string', description: t.update?.param?.subcategory ?? '改项目子类。' },
        goal: { type: 'string', description: t.update?.param?.goal ?? '改 topic 目标句。' },
      },
    },
    async execute(args, exec) {
      return withDbs(exec, ({ workspaceDb, globalDb }) => {
        const result = updateMemory(globalDb, workspaceDb, args, config)
        if (!result.ok) throw new Error(`mem_update 拒收：${result.error}${result.hint ? `（${result.hint}）` : ''}`)
        return result
      })
    },
  })

  push({
    name: 'mem_project',
    description: t.project?.description ?? '取项目记忆全景。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: t.project?.param?.project ?? '项目名。' },
        maxRows: { type: 'integer', minimum: 1, maximum: 200, default: 40, description: t.project?.param?.maxRows ?? '最多几行。' },
      },
    },
    async execute(args, exec) {
      return withDbs(exec, ({ workspaceDb, globalDb }) => {
        const result = projectOverview(workspaceDb, globalDb, args, config)
        if (!result.ok) throw new Error(`mem_project：${result.error}`)
        return result
      })
    },
  })

  return registered
}
