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
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { normalizeAliases, resolveWorkspaceRoot } from './workspace.js'

/** 全局库默认位置。§13：不放 C 盘。 */
export const DEFAULT_GLOBAL_DB_PATH = 'D:\\dsh-claude-mem\\global.db'

/** 工作区库目录名（相对工作区根）。 */
export const DEFAULT_PROJECT_DIR = '.dsh-claude-mem'

/** 内存库 schema 版本由 db.js 统一定义。 */
export { SCHEMA_VERSION } from './db.js'

export const Config = z.object({
  /** 总开关。false 时注入、工具、dream 全部停用，但数据保留。 */
  enabled: z.boolean().default(true),

  /** 工作区内数据目录名（相对工作区根）。 */
  projectDir: z.string().default(DEFAULT_PROJECT_DIR),

  /** 会话目录到记忆库目录的映射（见 workspace.js）。 */
  workspace: z.object({
    /** 从 cwd 往上找最近的已有记忆库或 Git 根目录；false = 严格按 cwd 建库。 */
    autoRoot: z.boolean().default(true),
    /** 显式映射：from 及其子目录下的会话都使用 to 目录的记忆库。两者都必须是绝对路径。 */
    aliases: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
    /** 不是本插件创建的工作区库（如随仓库带来的）要先经用户信任才会被打开。 */
    requireTrust: z.boolean().default(true),
    /** 预先信任的目录（绝对路径）。aliases 的目标目录自动视为可信。 */
    trusted: z.array(z.string()).default([]),
  }),

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
    /** 核心块每层（soul/user/rules）最多取几条；实际注入量仍受 firstTurnBudget 约束。 */
    maxCorePerLevel: z.number().min(1).max(100).default(30),
  }),

  /** 召回（§6）。v1 只做规则版。 */
  recall: z.object({
    gate: z.object({
      /** 规则门开关：关掉则每条消息都走粗筛。 */
      enabled: z.boolean().default(true),
      /** 少于多少字的消息不查记忆。 */
      minChars: z.number().min(1).max(20).default(4),
      /** 单会话最多命中几轮（防刷屏）；压缩后归零。 */
      maxHitsPerSession: z.number().min(0).max(50).default(8),
    }),
    /** FTS5 粗筛取多少条进预算装配。 */
    topK: z.number().min(1).max(100).default(20),
    /** 候选进入主动注入的最低信号强度（不含重要度和新鲜度）；0 = 不过滤。mem_search 不受影响。 */
    minStrength: z.number().min(0).max(10).default(0.8),
    /** 向量召回（M6）：本地 Qwen3-Embedding-4B。默认关，先观察再开（R3 锁后交付）。 */
    vector: z.object({
      enabled: z.boolean().default(false),
      url: z.string().default('http://127.0.0.1:8083'),
      model: z.string().default('Qwen3-Embedding-4B'),
      timeoutMs: z.number().min(100).max(3000).default(400),
      /** 向量侧候选数，融合前单独截断。 */
      topK: z.number().min(1).max(100).default(30),
      /** 余弦下限；低于它的直接丢（宁缺勿噪）。 */
      minScore: z.number().min(0).max(1).default(0.55),
      /**
       * 语义开门分：关键词门没有信号时，最高相似度达到它也算信号，这样换种说法也能召回。
       * 比 minScore 高，因为这时只有语义一路证据；调到 1 等于关闭。
       * 0.68 来自 Qwen3-Embedding-4B 的实测（见 README），换模型要重新校准。
       */
      gateScore: z.number().min(0).max(1).default(0.68),
      /** 语义否决分：关键词撞上了，但相似度低于它的条目不注入。调到 0 等于关闭。 */
      vetoScore: z.number().min(0).max(1).default(0.4),
      /** 关键词信号最强的条目达到这个强度就不被否决：它是直接证据。调高可以关闭。 */
      vetoProtectStrength: z.number().min(0).max(100).default(3),
      /** 查询侧指令前缀（Qwen3-Embedding 支持 instruct）；空串 = 不加。 */
      queryPrefix: z.string().default(''),
      /** RRF 融合常数，越大越平缓。 */
      rrfK: z.number().min(1).max(200).default(60),
    }),

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
    /** 命中手机号、身份证则拒收。确实需要记时可以关掉。 */
    rejectPii: z.boolean().default(true),
    /** 内容疑似提示注入时要用户确认，不直接生效（所有层级）。 */
    detectInjection: z.boolean().default(true),
    /**
     * 保护 soul/user/rules：这几层每次会话都会注入，一旦被恶意内容写入影响长期存在。
     * 关掉后，写入和修改这几层都不再要求确认。
     */
    protectCoreLevels: z.boolean().default(true),
    /**
     * 如何确认核心层写入：
     *   ask    = 弹宿主审批；拒绝则不写，宿主没有审批通道（如无头运行）时进待确认区；
     *   intent = 按用户当前消息的关键词判断，有意图直接生效，否则进待确认区。
     */
    coreApproval: z.union([z.const('ask'), z.const('intent')]).default('ask'),
  }),

  /** 周期整合（§7 dream）。门控照官方值。 */
  dream: z.object({
    enabled: z.boolean().default(true),
    minHours: z.number().min(1).max(720).default(24),
    minSessions: z.number().min(1).max(100).default(5),
    throttleMinutes: z.number().min(0).max(240).default(10),
    /**
     * 门控打开后做什么：
     *   observe = 只记 dream_runs 与 last_dream_at，不打扰模型；
     *   suggest = 下一轮附一句提醒，由模型在合适时调用 mem_review，不额外占用一轮；
     *   push    = 用 agent.followup 推一轮整理指令。
     */
    mode: z.union([z.const('observe'), z.const('suggest'), z.const('push')]).default('suggest'),
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
    /** 笔记保留天数：笔记含用户原话，不该无限期留存。 */
    retentionDays: z.number().min(1).max(3650).default(30),
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
    const driveRoot = parse(globalDbPath).root // D:\a\b\c.db -> D:\
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

  const aliases = normalizeAliases(config.workspace.aliases, warnings)
  const userHome = process.env.USERPROFILE ?? process.env.HOME
  const preTrusted = [...config.workspace.trusted, ...aliases.map((alias) => alias.to)]

  return {
    config,
    warnings,
    home,
    projectDir,
    globalDbPath,
    /** 会话 cwd → 记忆库所在目录（别名 > 最近的已有库或 Git 根 > cwd）。 */
    resolveWorkspace: (cwd) =>
      resolveWorkspaceRoot(cwd, {
        aliases,
        autoRoot: config.workspace.autoRoot,
        projectDir,
        stopAt: [home, userHome],
      }),
    /** 配置里预先信任的目录（含 aliases 的目标）。 */
    preTrusted,
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
