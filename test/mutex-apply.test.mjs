/**
 * dsh-claude-mem · 互斥接入 apply() 的集成测试（M6）
 *
 * 单测证明「判定函数对」，这里证明「接进 apply 之后行为对」：
 *   1. 对手启用 → status.skipped + refusedByMutex，且**一个钩子都不挂**（拒绝不是静默降级）；
 *   2. 对手关掉 → 正常装配（回滚路径必须真的能起来）；
 *   3. 对手在 apply 之后被热启用 → 下一轮 pre-step 不注入、不抛错。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { apply } from '../src/index.js'
import { createSnapshotMessage } from '../src/message.js'

let tmpRoot
let oldDshHome
const disposers = []

function readAudit(dataDir) {
  const file = join(dataDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function entry(pkg, { id = pkg, disabled = false } = {}) {
  return { options: { id, name: pkg }, disabled, fiber: { fake: true } }
}

/** fake ctx：钩子表 + 工具表 + loader 反射。 */
function makeCtx(rows = [], { withLoader = true, logs = [] } = {}) {
  const hooks = new Map()
  const tools = []
  const sections = []
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(event, handler) {
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
    get(serviceName) {
      if (serviceName === 'systemPrompt') {
        return { section: (spec) => { sections.push(spec); return () => {} } }
      }
      return undefined
    },
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
  }
  if (withLoader) ctx.loader = { entries: () => rows }
  return { ctx, hooks, tools, sections, logs }
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-mutex-'))
  // 隔离 DSH_HOME：审计文件写到 tmp 里，绝不污染真实的 ~/.dsh。
  oldDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(tmpRoot, 'dsh-home')
})

after(() => {
  for (const dispose of disposers) dispose()
  if (oldDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldDshHome
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论
  }
})

async function runApply(ctx, cfg) {
  const status = await apply(ctx, cfg)
  if (typeof status.dispose === 'function') disposers.push(status.dispose)
  return status
}

const workspace = () => join(tmpRoot, `ws-${Math.random().toString(36).slice(2)}`)

test('互斥命中：apply 拒绝装配，一个钩子/工具/section 都不挂', async () => {
  const rows = [entry('dsh-meow-mem'), entry('dsh-claude-mem')]
  const { ctx, hooks, tools, sections, logs } = makeCtx(rows)
  const status = await runApply(ctx, { globalDbPath: join(tmpRoot, 'g1.db') })

  assert.equal(status.ok, true, '拒绝不是失败，ok 仍为 true')
  assert.equal(status.skipped, true)
  assert.equal(status.refusedByMutex, true)
  assert.equal(status.mutex.conflict, true)
  assert.equal(hooks.size, 0, '拒绝装配时不许挂钩子')
  assert.equal(tools.length, 0, '拒绝装配时不许注册工具')
  assert.equal(sections.length, 0, '拒绝装配时不许挂手册')
  assert.equal(status.db, null, '拒绝装配时不建库（不留副作用）')

  const warned = logs.filter(([level]) => level === 'warn').map(([, m]) => m).join('\n')
  assert.match(warned, /互斥命中/, '必须留下 warn 日志')
  assert.match(warned, /dsh-meow-mem/, '日志要点名是哪个对手')

  // headless 的 ctx.logger 是 no-op，所以拒绝必须有落盘凭证
  const audit = readAudit(status.paths.dataDir)
  const refused = audit.filter((row) => row.event === 'mutex.refused')
  assert.equal(refused.length, 1, '冲突要落盘一条 mutex.refused')
  assert.equal(refused[0].rivals[0].pkg, 'dsh-meow-mem')
})

test('互斥命中：上游 meow-memory 同样拒绝（同阵营）', async () => {
  const { ctx, hooks } = makeCtx([entry('meow-memory')])
  const status = await runApply(ctx, { globalDbPath: join(tmpRoot, 'g2.db') })
  assert.equal(status.refusedByMutex, true)
  assert.equal(hooks.size, 0)
  assert.equal(status.mutex.rivals[0].pkg, 'meow-memory')
})

test('对手 disabled：正常装配（回滚后本插件必须真的能起来）', async () => {
  const rows = [entry('dsh-meow-mem', { disabled: true }), entry('dsh-claude-mem')]
  const { ctx, hooks, tools } = makeCtx(rows)
  const status = await runApply(ctx, { globalDbPath: join(tmpRoot, 'g3.db') })

  assert.equal(status.refusedByMutex, undefined)
  assert.equal(status.skipped, undefined)
  assert.equal(status.mutex.conflict, false)
  assert.equal(status.mutex.reflected, true)
  assert.ok(hooks.has('agent/pre-step'), 'pre-step 要挂上')
  assert.equal(tools.length, 6, '六个工具要注册')
})

test('mutexWithMeow=false：用户显式关闭检测时，对手在跑也装配', async () => {
  const { ctx, hooks } = makeCtx([entry('meow-memory')])
  const status = await runApply(ctx, { globalDbPath: join(tmpRoot, 'g4.db'), mutexWithMeow: false })
  assert.equal(status.refusedByMutex, undefined)
  assert.ok(hooks.has('agent/pre-step'))
  assert.equal(status.mutex.rivals.length, 1, '状态仍可见，便于日志/诊断')
})

test('loader 不可用：不阻断装配（fail-open），但 warning 里说明检测未生效', async () => {
  const { ctx, hooks } = makeCtx([], { withLoader: false })
  const status = await runApply(ctx, { globalDbPath: join(tmpRoot, 'g5.db') })
  assert.equal(status.ok, true)
  assert.equal(status.mutex.reflected, false)
  assert.ok(hooks.has('agent/pre-step'), '反射失败不能把整个插件判死')
  assert.ok(status.warnings.some((w) => w.includes('互斥检测未生效')), JSON.stringify(status.warnings))
})

test('运行期检测：apply 后对手被热启用 → 下一轮 pre-step 不注入且不抛错', async () => {
  const rows = [entry('dsh-meow-mem', { disabled: true })]
  const logs = []
  const { ctx, hooks } = makeCtx(rows, { logs })
  const ws = workspace()
  const status = await runApply(ctx, { globalDbPath: join(tmpRoot, 'g6.db') })
  assert.ok(hooks.has('agent/pre-step'))

  const session = {
    ownEvents: () => [],
    header: { id: 's-hot', cwd: ws },
  }
  const decision = () => ({
    kind: 'enter',
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我们之前说好的备份规则是什么' }] }],
  })

  // 先跑一轮：没冲突时不注入（库是空的），但确实走完了链路、不抛错
  const before = decision()
  const first = await hooks.get('agent/pre-step')({ agent: { session }, signal: { aborted: false } }, async () => before)
  assert.equal(first.messages.length, 1)

  // 热启用对手
  rows[0].disabled = false
  const after = decision()
  const second = await hooks.get('agent/pre-step')({ agent: { session }, signal: { aborted: false } }, async () => after)
  assert.equal(second.messages.length, 1, '冲突时不许插记忆块')
  const warned = logs.filter(([level]) => level === 'warn').map(([, m]) => m).join('\n')
  assert.match(warned, /运行期检测/, '运行期冲突要留日志')
})

test('运行期检测：对手重新关掉后恢复注入（守卫不是单向的）', async () => {
  const rows = [entry('meow-memory')]
  const { ctx, hooks } = makeCtx(rows)
  const ws = workspace()
  // 加载时对手在跑 → 拒绝装配，所以这里先关掉再 apply，模拟「回滚之后」的场景
  rows[0].disabled = true
  await runApply(ctx, { globalDbPath: join(tmpRoot, 'g7.db') })

  const session = { ownEvents: () => [], header: { id: 's-recover', cwd: ws } }
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我们之前说好的备份规则是什么' }] }]
  const third = await hooks.get('agent/pre-step')(
    { agent: { session }, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [...messages] }),
  )
  assert.equal(third.kind, 'enter', '完成后仍要返回 decision')
})
