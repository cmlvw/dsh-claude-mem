/**
 * dsh-claude-mem · 配置 schema 与解析
 *
 * 设计要点（PLAN.md §3/§5/§7）：
 * - 只有 @deepseek-ai/schemastery 一个 peer 依赖，它在 DSH profile 里已存在（3.18.5 实测）。
 * - 默认值全部按 §13 的拍板写死：精排默认关、启用方式默认关（由 patch 的 disabled 控制）、
 *   全局库默认落 D 盘。
 * - resolveConfig 不再 throw：加载期必须 fail-open（§11 风险表第一行）。
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** 全局库默认位置。§13：不放 C 盘。 */
export const DEFAULT_GLOBAL_DB_PATH = 'D:\\dsh-claude-mem\\global.db'

/** 工作区库目录名（相对工作区根）。 */
export const DEFAULT_PROJECT_DIR = '.dsh-claude-mem'

/** 内存库 schema 版本。改表结构就 +1，并在 db.js 里补 migrate。 */
export const SCHEMA_VERSION = 1

export const Config = z.object({
  /** 总开关。false 时注入、工具、dream 全部停用，但数据保留。 */
  enabled: z.boolean().default(true),

  /** 工作区内数据目录名（相对工作区根）。 */
  projectDir: z.string().default(DEFAULT_PROJECT_DIR),

  /** 全局库路径（soul/user/rules 及 scope=global 的 fact/lesson）。 */
  globalDbPath: z.string().default(DEFAULT_GLOBAL_DB_PATH),

  /** 全局库定位策略：auto = 优先用 globalDbPath，盘不存在则回落 $DSH_HOME；strict = 严格按配置。 */
  globalDbPolicy: z.string().default('auto'),

  /** 文案语言（prompts/{zh,en}.json）。 */
  promptLang: z.string().default('zh'),

  /** 注入预算（§5 硬上限）。 */
  inject: z.object({
    /** 每项目索引最多几行。 */
    maxIndexRows: z.number().min(1).max(50).default(12),
    /** 每行索引最多几字。 */
    maxIndexLineChars: z.number().min(20).max(200).default(60),
    /** 会话首轮核心块预算（字）。 */
    firstTurnBudget: z.number().min(200).max(8000).default(1600),
    /** 每轮命中块预算（字）。 */
    hitBudget: z.number().min(0).max(2000).default(450),
    /** 每轮最多注入几条正文。 */
    maxHitsPerTurn: z.number().min(0).max(5).default(2),
    /** 单条正文注入上限（字）。 */
    maxHitChars: z.number().min(60).max(400).default(180),
  }),

  /** 召回（§6）。v1 只做规则版。 */
  recall: z.object({
    gate: z.object({
      /** 规则门开关：关掉则每条消息都走粗筛。 */
      enabled: z.boolean().default(true),
      /** 少于多少字的消息不查记忆。 */
      minChars: z.number().min(1).max(20).default(4),
      /** 单会话最多命中几次（防刷屏）。 */
      maxHitsPerSession: z.number().min(0).max(50).default(8),
    }),
    /** FTS5 粗筛取多少条进预算装配。 */
    topK: z.number().min(1).max(100).default(20),
    /** 语义精排：默认关，实测后再定（§13-B）。 */
    rerank: z.object({
      enabled: z.boolean().default(false),
      url: z.string().default('http://127.0.0.1:8080'),
      timeoutMs: z.number().min(100).max(5000).default(600),
      maxPicks: z.number().min(1).max(10).default(5),
    }),
  }),

  /** 写入纪律（§7）。 */
  write: z.object({
    maxBodyChars: z.number().min(50).max(2000).default(400),
    maxTitleChars: z.number().min(10).max(100).default(40),
    keywordMin: z.number().min(1).max(30).default(8),
    keywordMax: z.number().min(2).max(30).default(13),
    /** 相似度阈值：≥此值自动合并旧条而不是新增。 */
    dedupThreshold: z.number().min(0.5).max(1).default(0.9),
    /** 命中密钥/凭据则拒收。 */
    rejectSecrets: z.boolean().default(true),
  }),

  /** 周期整合（§7 dream）。门控照官方值。 */
  dream: z.object({
    enabled: z.boolean().default(true),
    minHours: z.number().min(1).max(720).default(24),
    minSessions: z.number().min(1).max(100).default(5),
    throttleMinutes: z.number().min(0).max(240).default(10),
    /**
     * 触发后做什么（R3 锁后交付：新能力默认关着）：
     *   observe = 只记 dream_runs 与 last_dream_at，把「本该触发」留证据，不推送任何 turn；
     *   push    = 额外用 agent.followup 推一轮整理指令。
     * 默认 observe：先跑观察，人工看过证据再决定开不开推送。
     */
    mode: z.union([z.const('observe'), z.const('push')]).default('observe'),
  }),

  /** 会话笔记（§7 M5）：**只写不注入**，先跑观察。 */
  notes: z.object({
    enabled: z.boolean().default(true),
    /** 少于多少字的用户消息不记（寒暄不写，防噪音）。 */
    minChars: z.number().min(2).max(200).default(12),
    /** 单条笔记正文上限（字）。 */
    maxChars: z.number().min(40).max(1000).default(200),
    /** 同一会话两次落笔记的最小间隔（毫秒），防每轮都写。 */
    minIntervalMs: z.number().min(0).max(600000).default(0),
  }),

  /** 与 meow-memory 互斥检测（§11）：检测到对方启用则不注入、不报错。 */
  mutexWithMeow: z.boolean().default(true),

  db: z.object({
    busyTimeoutMs: z.number().min(100).max(60000).default(5000),
    /** 建 FTS5 索引；关掉则召回退化为 LIKE。 */
    enableFts: z.boolean().default(true),
  }),
})

/** 默认配置实例（测试与 load-check 共用）。 */
export function defaultConfig() {
  return Config({})
}

function dshHome() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return home
  return join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.dsh')
}

/**
 * 把原始 config 解析成运行时配置。
 * 永不 throw：schema 校验失败时退回默认值，并把问题记进 warnings。
 */
export function resolveConfig(rawConfig = {}) {
  const warnings = []
  let config
  try {
    config = Config(rawConfig ?? {})
  } catch (error) {
    warnings.push(`config 校验失败，已退回默认值：${error instanceof Error ? error.message : String(error)}`)
    config = defaultConfig()
  }

  const home = dshHome()
  const projectDir = config.projectDir || DEFAULT_PROJECT_DIR

  // 全局库定位：auto 策略下盘符不存在就回落 $DSH_HOME（C 盘紧时不至于让插件整体不可用）。
  let globalDbPath = isAbsolute(config.globalDbPath)
    ? config.globalDbPath
    : resolve(config.globalDbPath)
  if (config.globalDbPolicy === 'auto') {
    const driveRoot = dirname(dirname(globalDbPath)) // D:\a\b.db -> D:\
    try {
      if (!existsSync(driveRoot)) {
        const fallback = join(home, 'dsh-claude-mem', 'global.db')
        warnings.push(
          `全局库盘符 ${driveRoot} 不可用（C 盘紧时全局库默认放 D 盘，见 PLAN.md §13），已回落到 ${fallback}；data/路径不属于项目记忆，建议修好盘符或显式配置 globalDbPath。`,
        )
        globalDbPath = fallback
      }
    } catch {
      // existsSync 自身异常不该影响加载
    }
  }

  return {
    config,
    warnings,
    home,
    projectDir,
    globalDbPath,
    /**
     * 插件的数据目录（审计等）。跟随 globalDbPath 所在目录：
     * 真机默认在 D:\dsh-claude-mem，测试/演练给临时库路径时天然隔离，
     * 不会往用户的真实 ~/.dsh 写测试残留。
     */
    dataDir: dirname(globalDbPath),
    /** 工作区库绝对路径。 */
    workspaceDbPath: (workspace) => join(workspace, projectDir, 'memory.db'),
    /** 工作区数据目录。 */
    workspaceDataDir: (workspace) => join(workspace, projectDir),
    /** 该 level 是否进全局库（§4.1）。 */
    isGlobalLevel: (level, scope) => scope === 'global' || level === 'soul' || level === 'user' || level === 'rules',
  }
}
