// 回归测试：命中噪声与配额、核心层上限、工作区映射、压缩后恢复。
// 全部使用临时目录，不碰真实记忆库。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { apply } from '../src/index.js'
import { buildGateTerms, matchGateTerms, recall, shouldRecall } from '../src/recall.js'
import { collectCore } from '../src/inject.js'
import { Config } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import { insertEntry } from '../src/store.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-test-'))
const openDbs = []
after(() => {
  // Windows 上句柄不关就删不掉临时目录。
  for (const db of openDbs) db.close()
  rmSync(TMP, { recursive: true, force: true })
})

let seq = 0
const tempDir = () => {
  const dir = join(TMP, `d${(seq += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const openDb = () => {
  const opened = openMemoryDb(join(tempDir(), 'm.db'))
  assert.equal(opened.ok, true)
  openDbs.push(opened.db)
  return opened.db
}

const FILLER = ['甲词', '乙词', '丙词', '丁词', '戊词', '己词', '庚词', '辛词']
const keywords = (...words) => [...words, ...FILLER].slice(0, 13)

// 彼此没有共同片段的条目，避免被写入去重合并。
const LESSONS = [
  ['缓存穿透', '缓存穿透要用布隆过滤器拦截'],
  ['连接池上限', '连接池上限别超过数据库配额'],
  ['日志轮转', '日志轮转按天并压缩归档旧文件'],
  ['证书续期', '证书续期提前两周安排提醒'],
  ['灰度发布', '灰度发布先放百分之五流量观察'],
  ['消息重试', '消息重试需要指数退避加抖动'],
  ['索引重建', '索引重建放在凌晨低峰窗口执行'],
  ['时区转换', '时区转换统一存协调世界时'],
  ['磁盘告警', '磁盘告警阈值定在百分之八十'],
  ['接口限流', '接口限流用令牌桶按租户隔离'],
  ['备份校验', '备份校验每月做一次恢复演练'],
  ['编码规范', '编码规范统一交给格式化工具'],
]

function fakeCtx() {
  const hooks = new Map()
  const registered = []
  return {
    hooks,
    registered,
    on(event, fn) {
      hooks.set(event, fn)
      return () => hooks.delete(event)
    },
    tools: { register: (tool) => registered.push(tool) },
    logger: { info() {}, warn() {}, debug() {} },
    get: () => ({ section() {} }),
  }
}

async function preStep(ctx, text, sessionId, cwd) {
  const user = { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  const payload = { agent: { session: { header: { id: sessionId, cwd } } } }
  const decision = await ctx.hooks.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: [user] }))
  const injected = decision.messages.filter((message) => message !== user)
  // 注入块必须都排在真实用户消息前面。
  assert.equal(decision.messages.at(-1), user)
  return injected.map((message) => message.content[0].text).join('\n')
}

async function setupPlugin(config = {}) {
  const ctx = fakeCtx()
  // 这组测试关注召回，信任和写入保护在 hardening.test.mjs 里单独测。
  const status = await apply(ctx, {
    globalDbPath: join(tempDir(), 'global.db'),
    write: { protectCoreLevels: false },
    ...config,
    workspace: { requireTrust: false, ...config.workspace },
  })
  const remember = async (args, cwd) => {
    const tool = ctx.registered.find((item) => item.name === 'mem_remember')
    return tool.execute(args, { agent: { session: { header: { id: 'seed', cwd } } } })
  }
  return { ctx, status, remember }
}

const seedLessons = async (remember, cwd) => {
  await remember({ level: 'user', project: '全局', content: '用户偏好中文回答', keywords: keywords('中文回答') }, cwd)
  for (const [key, body] of LESSONS) {
    await remember({ level: 'lesson', project: '全局', title: key, content: body, keywords: keywords(key) }, cwd)
  }
}

describe('门控与最低信号强度', () => {
  it('英文关键词按整词匹配，不被更长的单词触发', () => {
    const db = openDb()
    insertEntry(db, { level: 'fact', project: 'p', body: 'x', keywords: ['logrotate', 'nginx'] })
    const terms = buildGateTerms(null, db)
    assert.deepEqual(matchGateTerms('reload nginx now', terms), ['nginx'])
    assert.deepEqual(matchGateTerms('my nginxconf is odd', terms), [])
  })

  it('长关键词切出的单个片段打不开门，两个片段才算', () => {
    const db = openDb()
    insertEntry(db, { level: 'fact', project: 'p', body: 'x', keywords: ['向量网关', '超时处理'] })
    const terms = buildGateTerms(null, db)
    assert.deepEqual(matchGateTerms('网关今天还好吗', terms), [])
    assert.ok(matchGateTerms('网关的超时还好吗', terms).length >= 2)
    assert.ok(matchGateTerms('向量网关还好吗', terms).includes('向量网关'))
  })

  it('2 字整词关键词依然有效，通用词被挡住', () => {
    const db = openDb()
    insertEntry(db, { level: 'fact', project: 'p', body: 'x', keywords: ['精排', '页面'] })
    const terms = buildGateTerms(null, db)
    assert.deepEqual(matchGateTerms('精排怎么开', terms), ['精排'])
    assert.deepEqual(matchGateTerms('帮我改一下这个页面', terms), [])
  })

  it('出现在太多条目里的关键词不当信号', () => {
    const db = openDb()
    for (let i = 0; i < 100; i += 1) {
      insertEntry(db, { level: 'fact', project: 'p', body: `条目${i}`, keywords: ['泛滥词语', `专属词语${i}`] })
    }
    const terms = buildGateTerms(null, db)
    assert.equal(terms.has('泛滥词语'), false)
    assert.equal(terms.has('专属词语7'), true)
  })

  it('只撞上信号词的无关候选不进入主动注入', () => {
    const db = openDb()
    insertEntry(db, { level: 'fact', project: 'p', title: '选型', body: '为什么选 SQLite：零依赖', keywords: keywords('选型') })
    const text = '为什么今天的天气这么好'
    assert.equal(shouldRecall(text, { matchedTerms: [] }), true)
    assert.equal(recall({ globalDb: null, workspaceDb: db, text, minStrength: 0.8 }).length, 0)
    assert.equal(recall({ globalDb: null, workspaceDb: db, text }).length, 1)
  })

  it('命中条目自己的关键词时能通过最低强度', () => {
    const db = openDb()
    const target = insertEntry(db, { level: 'lesson', project: 'p', body: '布隆过滤器拦截', keywords: keywords('缓存穿透') })
    const text = '缓存穿透又出现了'
    const extraTerms = matchGateTerms(text, buildGateTerms(null, db))
    const hits = recall({ globalDb: null, workspaceDb: db, text, extraTerms, minStrength: 0.8 })
    assert.deepEqual(hits.map((hit) => hit.entry.id), [target.id])
  })

  /** 库里 count 条都带同一个词，模拟项目名；gate 词表滤不掉，因为总量足够大。 */
  const seedCommonWord = (count) => {
    const db = openDb()
    for (let i = 0; i < count; i += 1) {
      insertEntry(db, { level: 'fact', project: 'p', body: `tidepool 第${i}条事实`, keywords: ['tidepool', `专属词语${i}`] })
    }
    for (let i = 0; i < 300; i += 1) {
      insertEntry(db, { level: 'fact', project: 'p', body: `无关内容${i}`, keywords: [`其他词语${i}`] })
    }
    return db
  }

  it('只撞上高频词的条目过不了最低强度', () => {
    const db = seedCommonWord(16)
    const hits = recall({ globalDb: null, workspaceDb: db, text: 'tidepool 用的集群有几个节点', extraTerms: ['tidepool'], minStrength: 0.8 })
    assert.deepEqual(hits, [])
  })

  it('高频词加上稀有词时能通过，并排在只撞高频词的条目前面', () => {
    const db = seedCommonWord(16)
    const target = insertEntry(db, { level: 'fact', project: 'p', body: 'tidepool 的周会在周四', keywords: ['tidepool', '周会'] })
    const hits = recall({ globalDb: null, workspaceDb: db, text: 'tidepool 周会几点', extraTerms: ['tidepool', '周会'], minStrength: 0.8 })
    assert.deepEqual(hits.map((hit) => hit.entry.id), [target.id])
  })

  it('高频词加上一个短词也算两个信号，不打折', () => {
    const db = seedCommonWord(16)
    const target = insertEntry(db, { level: 'fact', project: 'p', body: 'tidepool 的 CI 在内网', keywords: ['tidepool'] })
    const hits = recall({ globalDb: null, workspaceDb: db, text: 'Which CI does tidepool use', extraTerms: ['tidepool'], minStrength: 0.8 })
    assert.deepEqual(hits.map((hit) => hit.entry.id), [target.id])
  })

  it('条目不多的词不打折：小项目提一下名字仍能召回', () => {
    const db = seedCommonWord(3)
    const hits = recall({ globalDb: null, workspaceDb: db, text: 'tidepool 最近怎么样', extraTerms: ['tidepool'], minStrength: 0.8 })
    assert.equal(hits.length, 3)
  })

  it('搜索词里的 LIKE 通配符按字面算', () => {
    const db = seedCommonWord(16)
    const hits = recall({ globalDb: null, workspaceDb: db, text: '100%_done 是什么', extraTerms: ['100%_done'], minStrength: 0 })
    assert.ok(Array.isArray(hits))
  })
})

describe('命中配额按轮计算', () => {
  it('一轮注入多条只消耗一轮配额', async () => {
    const cwd = tempDir()
    const { ctx, status, remember } = await setupPlugin({ recall: { gate: { maxHitsPerSession: 2 } } })
    await seedLessons(remember, cwd)
    await preStep(ctx, '先开始今天的工作内容', 's', cwd)
    const twoAtOnce = await preStep(ctx, '缓存穿透和日志轮转都出问题了', 's', cwd)
    assert.ok(twoAtOnce.includes('布隆') && twoAtOnce.includes('归档'))
    assert.ok((await preStep(ctx, '证书续期也要看看', 's', cwd)).includes('提醒'))
    assert.equal(await preStep(ctx, '灰度发布也要看看', 's', cwd), '')
    status.dispose()
  })
})

describe('核心层上限', () => {
  const addCore = (db, level, count, prefix) => {
    for (let i = 0; i < count; i += 1) {
      insertEntry(db, { level, scope: 'global', body: `${prefix}${i}`, keywords: keywords() })
    }
  }
  const config = (inject) => {
    const cfg = Config({})
    return { ...cfg, inject: { ...cfg.inject, ...inject } }
  }

  it('18 条 rules 在预算足够时全部注入', () => {
    const globalDb = openDb()
    addCore(globalDb, 'rules', 18, '准则正文')
    const core = collectCore({ globalDb, workspaceDb: openDb(), cfg: config({ firstTurnBudget: 3800 }) })
    assert.equal(core.ids.length, 18)
    assert.equal(core.hiddenCore, 0)
    assert.equal(core.text.includes('未显示'), false)
  })

  it('超过每层上限时告诉模型还有多少条', () => {
    const globalDb = openDb()
    addCore(globalDb, 'rules', 18, '准则正文')
    const core = collectCore({ globalDb, workspaceDb: openDb(), cfg: config({ maxCorePerLevel: 12, firstTurnBudget: 3800 }) })
    assert.equal(core.ids.length, 12)
    assert.ok(core.text.includes('另有 6 条核心记忆未显示'))
  })

  it('预算不足时也给出提示，并给项目索引留位置', () => {
    const globalDb = openDb()
    const workspaceDb = openDb()
    for (let i = 0; i < 30; i += 1) {
      insertEntry(globalDb, { level: 'rules', scope: 'global', body: `准则${i}`.padEnd(150, '长'), keywords: keywords() })
    }
    insertEntry(workspaceDb, { level: 'project', subcategory: 'overview', project: 'demo', title: '项目概述', body: '概述', keywords: keywords() })
    const budget = 1600
    const core = collectCore({ globalDb, workspaceDb, cfg: config({ firstTurnBudget: budget }), project: 'demo', projectDetected: true })
    assert.ok(core.hiddenCore > 0)
    assert.ok(core.text.includes(`另有 ${core.hiddenCore} 条核心记忆未显示`))
    assert.ok(core.text.includes('项目「demo」'))
    assert.ok(core.chars <= budget, `chars=${core.chars}`)
  })
})

describe('工作区映射', () => {
  const dbPathOf = (root) => join(root, '.dsh-claude-mem', 'memory.db')
  const sessionCount = (root) => {
    const db = new DatabaseSync(dbPathOf(root), { readOnly: true })
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions').get()
    db.close()
    return n
  }

  it('aliases 让其他目录的会话用上项目记忆，子目录同样生效', async () => {
    const project = tempDir()
    const botDir = tempDir()
    const sub = join(botDir, 'nested')
    mkdirSync(sub)
    const { ctx, status, remember } = await setupPlugin({
      workspace: { aliases: [{ from: botDir, to: project }] },
    })
    await remember({ level: 'user', project: '全局', content: '用户偏好中文回答', keywords: keywords('中文回答') }, project)
    await remember({ level: 'project', subcategory: 'decisions', project: 'demo', title: '存储决策', content: '存储选 SQLite', keywords: keywords('存储选型') }, project)
    const injected = await preStep(ctx, 'demo 开工', 's', sub)
    assert.ok(injected.includes('存储决策'))
    assert.equal(sessionCount(project), 1)
    status.dispose()
  })

  it('子目录会话自动归到 Git 根目录，不再新建空库', async () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    const { ctx, status } = await setupPlugin()
    await preStep(ctx, '随便说一句话', 's', sub)
    assert.equal(sessionCount(repo), 1)
    status.dispose()
  })

  it('已有记忆库优先于更外层的 Git 根目录', async () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const pkg = join(repo, 'packages', 'a')
    mkdirSync(pkg, { recursive: true })
    openMemoryDb(dbPathOf(pkg)).db.close()
    const deeper = join(pkg, 'src')
    mkdirSync(deeper)
    const { ctx, status } = await setupPlugin()
    await preStep(ctx, '随便说一句话', 's', deeper)
    assert.equal(sessionCount(pkg), 1)
    status.dispose()
  })

  it('autoRoot=false 时严格按 cwd 建库', async () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'src')
    mkdirSync(sub)
    const { ctx, status } = await setupPlugin({ workspace: { autoRoot: false } })
    await preStep(ctx, '随便说一句话', 's', sub)
    assert.equal(sessionCount(sub), 1)
    status.dispose()
  })

  it('不把用户主目录当项目根', async () => {
    const home = tempDir()
    mkdirSync(join(home, '.git'))
    const project = join(home, 'work')
    mkdirSync(project)
    const previous = process.env.USERPROFILE
    const previousHome = process.env.HOME
    process.env.USERPROFILE = home
    process.env.HOME = home
    try {
      const { ctx, status } = await setupPlugin()
      await preStep(ctx, '随便说一句话', 's', project)
      assert.equal(sessionCount(project), 1)
      status.dispose()
    } finally {
      process.env.USERPROFILE = previous
      process.env.HOME = previousHome
    }
  })

  it('相对路径的 alias 被忽略并给出警告，不影响加载', async () => {
    const { status } = await setupPlugin({ workspace: { aliases: [{ from: 'relative', to: 'also-relative' }] } })
    assert.equal(status.ok, true)
    assert.ok(status.warnings.some((warning) => warning.includes('workspace.aliases')))
    status.dispose()
  })
})

describe('压缩后恢复', () => {
  const compact = (ctx, sessionId, data = {}) => ctx.hooks.get('session/event')({ id: sessionId }, { type: 'compaction/end', data })

  it('压缩后，同一个问题能再次命中', async () => {
    const cwd = tempDir()
    const { ctx, status, remember } = await setupPlugin()
    await seedLessons(remember, cwd)
    await preStep(ctx, '先开始今天的工作内容', 's', cwd)
    assert.ok((await preStep(ctx, '缓存穿透怎么处理来着', 's', cwd)).includes('布隆'))
    assert.equal((await preStep(ctx, '缓存穿透怎么处理来着', 's', cwd)).includes('布隆'), false)
    compact(ctx, 's')
    const after = await preStep(ctx, '缓存穿透怎么处理来着', 's', cwd)
    assert.ok(after.includes('长期记忆'), '应重注入核心块')
    assert.ok(after.includes('布隆'), '压缩后第一条消息就应命中')
    assert.ok(after.indexOf('长期记忆') < after.indexOf('记忆命中'))
    status.dispose()
  })

  it('压缩后配额归零', async () => {
    const cwd = tempDir()
    const { ctx, status, remember } = await setupPlugin({ recall: { gate: { maxHitsPerSession: 1 } } })
    await seedLessons(remember, cwd)
    await preStep(ctx, '先开始今天的工作内容', 's', cwd)
    assert.ok((await preStep(ctx, '缓存穿透怎么处理', 's', cwd)).includes('布隆'))
    assert.equal(await preStep(ctx, '日志轮转怎么处理', 's', cwd), '')
    compact(ctx, 's')
    assert.ok((await preStep(ctx, '日志轮转怎么处理', 's', cwd)).includes('归档'))
    status.dispose()
  })

  it('压缩失败时不释放命中记录', async () => {
    const cwd = tempDir()
    const { ctx, status, remember } = await setupPlugin()
    await seedLessons(remember, cwd)
    await preStep(ctx, '先开始今天的工作内容', 's', cwd)
    await preStep(ctx, '缓存穿透怎么处理来着', 's', cwd)
    compact(ctx, 's', { error: 'failed' })
    assert.equal((await preStep(ctx, '缓存穿透怎么处理来着', 's', cwd)).includes('布隆'), false)
    status.dispose()
  })
})
