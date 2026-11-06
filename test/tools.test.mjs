import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { apply } from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import {
  keywordRange,
  maxBodyChars,
  projectOverview,
  readMemory,
  rememberInto,
  searchMemory,
  summaryOf,
  updateMemory,
  validateRemember,
} from '../src/tools.js'

const cfg = defaultConfig()

let tmpRoot
const disposers = []
before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-tools-'))
})
after(() => {
  for (const dispose of disposers) dispose()
  rmSync(tmpRoot, { recursive: true, force: true })
})

let seq = 0
function freshDb() {
  const opened = openMemoryDb(join(tmpRoot, `tools-${(seq += 1)}.db`))
  assert.equal(opened.ok, true, opened.error)
  disposers.push(() => opened.db.close())
  return opened.db
}

const KEYWORDS = ['回滚', '备份', '改配置', '回滚文件', '动手前', '安全', '用户要求', '流程']

// ---------------------------------------------------------------- 纯校验

test('validateRemember：正文为空 / level 非法 / project 层缺项目 → 拒收', () => {
  assert.equal(validateRemember({ content: '', project: 'p', keywords: KEYWORDS }, cfg).ok, false)
  assert.equal(validateRemember({ content: 'x', level: 'nope', project: 'p', keywords: KEYWORDS }, cfg).ok, false)
  const bad = validateRemember({ content: 'x', level: 'project', project: '', keywords: KEYWORDS }, cfg)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /project 必填/)
})

test('validateRemember：subcategory 非法 → 拒收', () => {
  const result = validateRemember(
    { content: 'x', level: 'project', project: 'p', subcategory: 'nope', keywords: KEYWORDS },
    cfg,
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /subcategory 非法/)
})

test('validateRemember：关键词少于 8 个 → 拒收（PLAN §7 硬规则）', () => {
  const result = validateRemember({ content: 'x', project: 'p', keywords: ['一', '二'] }, cfg)
  assert.equal(result.ok, false)
  assert.match(result.error, /keywords 太少/)
  assert.equal(keywordRange(cfg).min, 8)
})

test('validateRemember：各层正文上限（fact 60 / topic 300 / 其它 400）', () => {
  assert.equal(maxBodyChars('fact', cfg), 60)
  assert.equal(maxBodyChars('lesson', cfg), 60)
  assert.equal(maxBodyChars('topic', cfg), 300)
  assert.equal(maxBodyChars('project', cfg), 400)
  assert.equal(validateRemember({ content: '长'.repeat(61), project: 'p', keywords: KEYWORDS }, cfg).ok, false)
  assert.equal(validateRemember({ content: '长'.repeat(60), project: 'p', keywords: KEYWORDS }, cfg).ok, true)
})

test('validateRemember：密钥优先于长度——又长又含密钥仍按密钥拒收', () => {
  const content = `api_key = sk_live_abcdefghijklmnop1234567890 ${'长'.repeat(200)}`
  const result = validateRemember({ content, project: 'p', keywords: KEYWORDS }, cfg)
  assert.equal(result.ok, false)
  assert.match(result.error, /密钥/)
  assert.doesNotMatch(result.error, /过长/)
})

test('validateRemember：各类凭据 5/5 被拒，且不回显秘文', () => {
  const samples = [
    'api_key = abcdefghij123456',
    'password: hunter2hunter2',
    '-----BEGIN RSA PRIVATE KEY----- 内容',
    'Bearer abcdefghijklmnopqrstuvwxyz123456',
    'mongodb://admin:pass@host:27017/db',
  ]
  for (const content of samples) {
    const result = validateRemember({ content, project: 'p', keywords: KEYWORDS }, cfg)
    assert.equal(result.ok, false, `应拒收：${content}`)
    assert.match(result.error, /密钥/)
    assert.doesNotMatch(result.error, /hunter2|abcdefghij123456|mongodb:\/\//)
  }
})

test('validateRemember：rejectSecrets=false 时放行（开关有效）', () => {
  const off = { ...cfg, write: { ...cfg.write, rejectSecrets: false } }
  const result = validateRemember({ content: 'api_key = abcdefghij123456', project: 'p', keywords: KEYWORDS }, off)
  assert.equal(result.ok, true)
})

test('validateRemember：绝对路径/端口只给软警告，不拒收', () => {
  const result = validateRemember({ content: '配置在 D:\\x\\y.yml，端口 8080', project: 'p', keywords: KEYWORDS }, cfg)
  assert.equal(result.ok, true)
  assert.equal(result.warnings.length >= 1, true)
})

// ---------------------------------------------------------------- 落库链路

test('rememberInto：写入 → 搜索 → 读取 全链路', () => {
  const db = freshDb()
  const written = rememberInto(db, { content: '用户要求改配置前先发回滚文件地址再动手。', project: 'p', keywords: KEYWORDS }, cfg)
  assert.equal(written.ok, true)
  assert.equal(written.merged, false)
  assert.equal(written.short_id.length, 6)

  const found = searchMemory(null, db, { query: '回滚文件', k: 5 }, cfg)
  assert.equal(found.ok, true)
  assert.ok(found.hits.some((hit) => hit.id === written.short_id))

  const read = readMemory(null, db, { id: written.short_id })
  assert.equal(read.ok, true)
  assert.equal(read.full_id, written.id)
  assert.deepEqual(read.keywords, KEYWORDS)
})

test('rememberInto：相似内容合并成一条，不新增', () => {
  const db = freshDb()
  const body = '用户要求改配置前先发回滚文件地址再动手。'
  const first = rememberInto(db, { content: body, project: 'p', keywords: KEYWORDS }, cfg)
  const second = rememberInto(db, { content: body, project: 'p', keywords: KEYWORDS }, cfg)
  assert.equal(second.merged, true)
  assert.equal(second.id, first.id)
  const count = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n
  assert.equal(count, 1)
})

test('searchMemory：空 query 报错而不是空查', () => {
  const db = freshDb()
  const result = searchMemory(null, db, { query: '  ' }, cfg)
  assert.equal(result.ok, false)
  assert.match(result.error, /query 不能为空/)
})

test('updateMemory：正文+关键词一起改后 FTS 同步，旧词查不到新词查得到', () => {
  const db = freshDb()
  const written = rememberInto(db, { content: '旧内容关于回滚备份流程。', project: 'p', keywords: KEYWORDS }, cfg)
  // 关键词也必须一起换：2 字词（回滚）走 LIKE 兜底时会命中 keywords 列，
  // 只改正文而留着旧关键词，就等于没验证到 FTS 的同步。
  const updated = updateMemory(
    null,
    db,
    { id: written.short_id, content: '新内容关于部署校验流程。', keywords: ['部署', '校验', '流程', '新内容', '发布', '验证', '步骤', '检查'] },
    cfg,
  )
  assert.equal(updated.ok, true)
  assert.equal(searchMemory(null, db, { query: '回滚备份', k: 5 }, cfg).hits.length, 0)
  assert.ok(searchMemory(null, db, { query: '部署校验', k: 5 }, cfg).hits.length >= 1)
})

test('updateMemory：status=archived 后不再出现在搜索结果里', () => {
  const db = freshDb()
  const written = rememberInto(db, { content: '临时内容待归档。', project: 'p', keywords: KEYWORDS }, cfg)
  assert.equal(updateMemory(null, db, { id: written.short_id, status: 'archived' }, cfg).ok, true)
  assert.equal(searchMemory(null, db, { query: '临时内容归档', k: 5 }, cfg).hits.length, 0)
})

test('updateMemory：没有给任何字段 → 明确报错', () => {
  const db = freshDb()
  const written = rememberInto(db, { content: 'x内容', project: 'p', keywords: KEYWORDS }, cfg)
  const result = updateMemory(null, db, { id: written.short_id }, cfg)
  assert.equal(result.ok, false)
  assert.match(result.error, /没有要更新的字段/)
})

test('updateMemory：改正文成含密钥 → 拒收', () => {
  const db = freshDb()
  const written = rememberInto(db, { content: '正常内容。', project: 'p', keywords: KEYWORDS }, cfg)
  const result = updateMemory(null, db, { id: written.short_id, content: 'password: hunter2hunter2' }, cfg)
  assert.equal(result.ok, false)
  assert.match(result.error, /密钥/)
})

test('readMemory：不存在的 id 报「没找到」，短 id 有歧义时提示', () => {
  const db = freshDb()
  assert.match(readMemory(null, db, { id: 'zzzzzz' }).error, /没找到/)
  assert.match(readMemory(null, db, { id: '' }).error, /id 不能为空/)
})

test('projectOverview：按项目给全景，每行带短 id；未知项目返回空而不是抛错', () => {
  const db = freshDb()
  const written = rememberInto(
    db,
    { content: '项目总体目标。', level: 'project', subcategory: 'overview', project: 'p', keywords: KEYWORDS },
    cfg,
  )
  const overview = projectOverview(db, null, { project: 'p' }, cfg)
  assert.equal(overview.ok, true)
  assert.equal(overview.project, 'p')
  assert.ok(overview.lines.some((line) => line.id === written.short_id))
  assert.ok(overview.groups.some((group) => group.kind === 'overview'))

  const empty = projectOverview(db, null, { project: '不存在的项目' }, cfg)
  assert.equal(empty.ok, true)
  assert.equal(empty.total, 0)
})

test('projectOverview：没指定项目时给出最近活跃项目名', () => {
  const db = freshDb()
  rememberInto(db, { content: '某项目的记忆。', level: 'fact', project: 'proj-alpha', keywords: KEYWORDS }, cfg)
  const overview = projectOverview(db, null, {}, cfg)
  assert.equal(overview.ok, true)
  assert.equal(overview.project, 'proj-alpha')
})

test('summaryOf：超长截断带省略号，短文本原样', () => {
  assert.equal(summaryOf('短文本'), '短文本')
  assert.match(summaryOf('长'.repeat(100)), /…$/)
})

// ---------------------------------------------------------------- 工具注册

test('apply 注册六个工具，且能真实调用（fake ctx 走通）', async () => {
  const workspace = join(tmpRoot, 'ws')
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  const status = await apply(ctx, { globalDbPath: join(tmpRoot, 'apply-global.db') })
  disposers.push(status.dispose)
  assert.equal(tools.length, 6)

  const exec = { agent: { session: { header: { cwd: workspace, id: 'session-x' } } } }
  const written = await tools.find((t) => t.name === 'mem_remember').execute(
    { content: '工具层跑通的内容。', level: 'fact', project: 'p', keywords: KEYWORDS },
    exec,
  )
  assert.equal(written.ok, true)
  const read = await tools.find((t) => t.name === 'mem_read').execute({ id: written.short_id }, exec)
  assert.equal(read.ok, true)
})

test('工具在无 cwd 的会话里抛明确错误（不静默失败）', async () => {
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  const status = await apply(ctx, { globalDbPath: join(tmpRoot, 'no-cwd.db') })
  disposers.push(status.dispose)
  const tool = tools.find((t) => t.name === 'mem_search')
  await assert.rejects(() => tool.execute({ query: 'x' }, { agent: { session: { header: {} } } }), /无法确定工作区/)
})
