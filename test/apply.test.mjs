import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { SCHEMA_VERSION } from '../src/db.js'
import { apply, Config, inject, name } from '../src/index.js'
import { createSnapshotMessage, isOwnSnapshot } from '../src/message.js'

let tmpRoot
before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-apply-'))
})
const disposers = []
after(() => {
  for (const dispose of disposers) dispose()
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** apply + 登记收尾：Windows 下不关句柄会锁住临时目录。 */
async function runApply(ctx, cfg) {
  const status = await apply(ctx, cfg)
  disposers.push(status.dispose)
  return status
}

function fakeCtx(options = {}) {
  const hooks = new Map()
  const tools = []
  const sections = []
  const ctx = {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    on(event, handler) {
      if (options.throwOn) throw new Error(`boom: ${event}`)
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
    get(serviceName) {
      if (serviceName !== 'systemPrompt' || options.noSystemPrompt) return undefined
      return {
        section(spec) {
          sections.push(spec)
          return () => {}
        },
      }
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, hooks, tools, sections }
}

let seq = 0
const dbPath = () => join(tmpRoot, `db-${(seq += 1)}.db`)

test('插件身份与依赖声明', () => {
  assert.equal(name, 'dsh-claude-mem')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof Config, 'function')
})

test('正常装配：ok、钩子齐全、guide 挂上、全局库建好', async () => {
  const { ctx, hooks, sections } = fakeCtx()
  const status = await runApply(ctx, { globalDbPath: dbPath() })
  assert.equal(status.ok, true)
  assert.equal(status.error, undefined)
  // M5 新增 session/event（压缩检测）；三个钩子缺一不可。
  assert.deepEqual([...hooks.keys()].sort(), ['agent/pre-step', 'agent/turn-stopping', 'session/event'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dsh-claude-mem:guide')
  assert.ok(sections[0].text.length <= 600)
  assert.equal(status.db.fts, true)
  assert.equal(status.db.stats.schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(
    [...status.tools].sort(),
    ['mem_project', 'mem_read', 'mem_remember', 'mem_review', 'mem_search', 'mem_update'],
  )
})

test('tools 服务缺失：不注册工具、不 throw、注入不受影响', async () => {
  const { ctx, hooks, sections } = fakeCtx()
  delete ctx.tools
  const status = await runApply(ctx, { globalDbPath: dbPath() })
  assert.equal(status.ok, true)
  assert.equal(status.tools.length, 0)
  // 注入链路（钩子 + guide）照常在，工具起不来不该把插件整体判死
  assert.ok(hooks.has('agent/pre-step'))
  assert.equal(sections.length, 1)
})

test('pre-step 在 M0 是纯透传（不改消息、不加内容）', async () => {
  const { ctx, hooks } = fakeCtx()
  await runApply(ctx, { globalDbPath: dbPath() })
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '把全局库挪到 D 盘' }] }] }
  const result = await hooks.get('agent/pre-step')({}, async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 1)
})

test('pre-step 下游抛错时不吞掉异常语义（M0 透传形态）', async () => {
  const { ctx, hooks } = fakeCtx()
  await runApply(ctx, { globalDbPath: dbPath() })
  // next() 抛错属于上游链路问题，钩子不该把它变成假成功；M0 允许抛出，
  // M2 真正注入时会改成 fail-open（返回原 decision）。
  await assert.rejects(() => hooks.get('agent/pre-step')({}, async () => {
    throw new Error('upstream')
  }))
})

test('turn-stopping 是同步 no-op，不抛错', async () => {
  const { ctx, hooks } = fakeCtx()
  await runApply(ctx, { globalDbPath: dbPath() })
  assert.doesNotThrow(() => hooks.get('agent/turn-stopping')({ agent: {}, turn: {} }))
})

test('enabled=false：跳过装配、返回 ok、不挂钩子', async () => {
  const { ctx, hooks, sections } = fakeCtx()
  const status = await runApply(ctx, { enabled: false, globalDbPath: dbPath() })
  assert.equal(status.ok, true)
  assert.equal(status.skipped, true)
  assert.equal(hooks.size, 0)
  assert.equal(sections.length, 0)
})

test('ctx 什么都缺也不 throw', async () => {
  const status = await runApply({}, { globalDbPath: dbPath() })
  assert.equal(status.ok, true)
  assert.ok(status.warnings.length >= 2, JSON.stringify(status.warnings))
})

test('ctx.on 抛错：fail-open，ok 且留 warning', async () => {
  const { ctx } = fakeCtx({ throwOn: true })
  const status = await runApply(ctx, { globalDbPath: dbPath() })
  assert.equal(status.ok, true)
  assert.ok(status.warnings.some((w) => w.includes('挂载失败')))
})

test('systemPrompt 晚就绪：立即重试逻辑不抛错（无服务则记 warning/等待）', async () => {
  const { ctx, sections } = fakeCtx({ noSystemPrompt: true })
  const status = await runApply(ctx, { globalDbPath: dbPath() })
  assert.equal(status.ok, true)
  assert.equal(sections.length, 0)
})

test('全局库路径不可写时仍 ok（全局层不可用但插件活着）', async () => {
  const status = await runApply(fakeCtx().ctx, { globalDbPath: join('\0bad', 'global.db') })
  assert.equal(status.ok, true)
  assert.equal(status.db, null)
  assert.ok(status.warnings.some((w) => w.includes('全局库打开失败')), JSON.stringify(status.warnings))
})

test('快照消息形状对齐 dsh-llm 的 createUserMessage', () => {
  const msg = createSnapshotMessage('长期记忆块内容', { injectionKind: 'first-turn' })
  assert.equal(msg.role, 'user')
  assert.equal(typeof msg.id, 'string')
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.content[0].text, '长期记忆块内容')
  assert.equal(msg.source.form, 'snapshot')
  assert.equal(msg.source.kind, 'plugin:dsh-claude-mem')
  assert.equal(msg.source.meta.injectionKind, 'first-turn')
  assert.equal(msg.source.plugin, 'dsh-claude-mem')
  assert.equal(msg.source.kind, 'plugin:dsh-claude-mem')
  assert.equal(msg.source.meta.injectionKind, 'first-turn')
  assert.equal(msg.source.sections[0].name, '长期记忆')
})

test('isOwnSnapshot 能认出自己的注入、不误认同类来源', () => {
  assert.equal(isOwnSnapshot(createSnapshotMessage('x')), true)
  assert.equal(isOwnSnapshot({ source: { kind: 'user' } }), false)
  assert.equal(isOwnSnapshot({}), false)
  assert.equal(isOwnSnapshot(null), false)
  assert.equal(isOwnSnapshot({ source: { kind: 'plugin:meow-memory' } }), false)
})
