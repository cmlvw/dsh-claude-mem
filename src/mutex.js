/**
 * dsh-claude-mem · 与 meow 阵营互斥（PLAN.md §11，本卡 M6）
 *
 * 为什么需要：meow-memory 与 dsh-claude-mem 都走「agent/pre-step 插 snapshot」注入，
 * 同时启用就是同一轮里两份记忆块、两套工具、两套 dream 推送。互斥不是可选项。
 *
 * 判定依据：**插件的启用状态能从 loader 反射出来**，不必读 profile 文件。
 * 现网实证（dsh-better-sidebar/lib/index.js:9178-9196）：
 *   for (const entry of ctx.loader.entries()) entry.options.id / entry.options.name / entry.disabled
 * 这条路径的好处：plugin-manager 热启停会立刻反映到 entries，不需要重读 YAML；
 * 也不依赖我们能不能找到 profile 目录（跨 profile 挂载时依然正确）。
 *
 * 阵营（本卡拍板「两者任一启用即冲突」）：
 *   - meow-memory   上游包；
 *   - dsh-meow-mem  fork，PLUGIN_NAME 仍是 "meow-memory"，同一份注入姿势。
 * 两个都算「meow 在跑」。
 *
 * 降级策略：拿不到 loader（fake ctx / 老内核 / 权限受限）时**不阻断**，
 * 只把 reflected=false 记进结果——互斥是防重复注入的安全网，不是加载的硬前置；
 * 硬阻断一个没装 meow 的用户，比漏检更糟。
 */

/** meow 阵营的包名（同一份注入姿势，视为同一家）。 */
export const MEOW_PACKAGES = ['meow-memory', 'dsh-meow-mem']

/** 本包名，用于在日志里区分「我们自己的行」。 */
export const SELF_PACKAGE = 'dsh-claude-mem'

const RIVAL_SET = new Set(MEOW_PACKAGES)

/** 行是否处于启用态。loader entry 上 disabled 可能挂在自己身上，也可能在 options 里。 */
export function isEntryEnabled(entry) {
  if (entry === null || typeof entry !== 'object') return false
  if (entry.disabled === true) return false
  const options = entry.options
  if (options !== null && typeof options === 'object' && options.disabled === true) return false
  return true
}

/** 取行的包名：真机上在 options.name，个别内核挂在 name 上。 */
function entryPackageName(entry) {
  const options = entry?.options
  if (options !== null && typeof options === 'object' && typeof options.name === 'string') return options.name
  if (typeof entry?.name === 'string') return entry.name
  return ''
}

/** 取行 id：日志要能指到具体哪一行（同一个包可能被挂两次）。 */
function entryId(entry) {
  const options = entry?.options
  if (options !== null && typeof options === 'object' && typeof options.id === 'string') return options.id
  if (typeof entry?.id === 'string') return entry.id
  return ''
}

/** 包名归一：去掉 scope 前缀与子路径（`@x/y` / `pkg/sub` 都要能认出来）。 */
export function normalizePackageName(name) {
  if (typeof name !== 'string' || name === '') return ''
  const parts = name.split('/')
  // `@scope/pkg/sub` → `@scope/pkg`；`pkg/sub` → `pkg`。
  if (name.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0]
}

/**
 * 从 loader 取所有插件行；拿不到就返回 null（调用方据此标记 reflected=false）。
 * 任何异常都吞掉：反射失败绝不能让插件加载失败。
 */
export function readLoaderEntries(ctx) {
  try {
    const loader = ctx?.loader
    if (loader === undefined || loader === null || typeof loader.entries !== 'function') return null
    const entries = loader.entries()
    if (entries === null || entries === undefined) return null
    const list = []
    for (const entry of entries) list.push(entry)
    return list
  } catch {
    return null
  }
}

/**
 * 纯函数：从已取到的插件行里找启用的 meow 阵营。
 * @param {unknown[]} entries loader.entries() 的结果
 * @returns {{id: string, name: string, pkg: string}[]} 启用中的对手行（空数组 = 无冲突）
 */
export function findEnabledMeow(entries) {
  const rivals = []
  if (!Array.isArray(entries)) return rivals
  for (const entry of entries) {
    const name = entryPackageName(entry)
    if (name === '') continue
    const pkg = normalizePackageName(name)
    if (!RIVAL_SET.has(pkg)) continue
    if (!isEntryEnabled(entry)) continue
    rivals.push({ id: entryId(entry), name, pkg })
  }
  return rivals
}

/**
 * 一并算出「我们自己的行」（诊断用：能确认反射真的看到了我们）。
 * 老内核按 name 找，bundle 里我们的行 id 是 dsh-claude-mem。
 */
export function findSelfEntries(entries) {
  const found = []
  if (!Array.isArray(entries)) return found
  for (const entry of entries) {
    const pkg = normalizePackageName(entryPackageName(entry))
    if (pkg !== SELF_PACKAGE) continue
    found.push({ id: entryId(entry), enabled: isEntryEnabled(entry) })
  }
  return found
}

/**
 * 互斥判定（一次反射）。
 * @returns {{conflict: boolean, rivals: object[], reflected: boolean, reason: string, self: object[]}}
 */
export function checkMutex(ctx, options = {}) {
  const enabled = options.enabled !== false
  const entries = readLoaderEntries(ctx)
  if (entries === null) {
    return { conflict: false, rivals: [], reflected: false, self: [], reason: 'loader 不可用，互斥检测跳过（fail-open）' }
  }
  const rivals = findEnabledMeow(entries)
  const self = findSelfEntries(entries)
  if (!enabled) {
    return { conflict: false, rivals, reflected: true, self, reason: 'mutexWithMeow=false，用户显式关闭互斥检测' }
  }
  if (rivals.length === 0) {
    return { conflict: false, rivals, reflected: true, self, reason: '未检测到启用的 meow 阵营插件' }
  }
  const list = rivals.map((rival) => (rival.id === '' ? rival.pkg : `${rival.id}(${rival.pkg})`)).join('、')
  return { conflict: true, rivals, reflected: true, self, reason: `检测到同时启用：${list}` }
}

/** 日志文案（加载期与运行期共用一个措辞，方便 grep）。 */
export function describeConflict(result) {
  if (!result.conflict) return ''
  return (
    `互斥命中：meow 阵营插件仍在启用（${result.reason}）。` +
    '为防双重注入，dsh-claude-mem 拒绝装配注入/工具/dream；' +
    '请先停用 meow-memory 或 dsh-meow-mem，再启用本插件。'
  )
}

/**
 * 运行期守卫：apply 之后用户可能在 plugin-manager 里热启 meow。
 * 每次都 reflect 太浪费，按 TTL 缓存；命中冲突时**当轮不注入**并节流记日志。
 *
 * 返回 { check(): result, noteConflictOnce(): boolean }
 * noteConflictOnce 只在「状态从无冲突转为冲突」或超过 cooldown 时返回 true，
 * 避免每轮刷一条同样的 warn。
 */
export function createMutexGuard(ctx, options = {}) {
  // 默认 ttl=0：每轮都反射。loader.entries() 只是遍历内存里的行对象（几十个），
  // 成本可忽略；而「热启用 meow 后 30 秒内仍在双重注入」是不可接受的。
  // 需要省这点开销时再显式传 ttlMs。
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : 0
  const cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs >= 0 ? options.cooldownMs : 10 * 60_000
  const enabled = options.enabled !== false
  let cached = null
  let cachedAt = 0
  let lastLoggedAt = 0
  let lastState = null

  const check = () => {
    const now = Date.now()
    if (cached !== null && now - cachedAt < ttlMs) return cached
    cached = checkMutex(ctx, { enabled })
    cachedAt = now
    return cached
  }

  const noteConflictOnce = () => {
    const result = check()
    const state = result.conflict ? 'conflict' : 'ok'
    const now = Date.now()
    const changed = lastState !== state
    // 先更新状态再判断返回：否则「冲突解除」永远不会被记成 ok。
    lastState = state
    if (!result.conflict) return false
    if (changed || now - lastLoggedAt >= cooldownMs) {
      lastLoggedAt = now
      return true
    }
    return false
  }

  return {
    check,
    noteConflictOnce,
    /** 测试用：清缓存。 */
    reset: () => {
      cached = null
      cachedAt = 0
      lastLoggedAt = 0
      lastState = null
    },
    get state() {
      return lastState
    },
  }
}
