#!/usr/bin/env node
/**
 * dsh-claude-mem · 加载验收（M0 证据来源）
 *
 * 用 fake ctx 真跑一遍 apply，检查四件事：
 *   1. apply 返回 ok，无异常冒泡；
 *   2. 钩子挂上了（agent/pre-step、agent/turn-stopping），且 pre-step 原样透传 decision；
 *   3. 全局库建得出来、schema 版本对、FTS 状态可知；
 *   4. 坏环境（空 ctx / logger 抛错 / enabled=false）下不 throw。
 *
 * 用法：node tools/load-check.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, Config, name } from '../src/index.js'

const results = []
function check(label, pass, detail = '') {
  results.push({ label, pass, detail })
}

/** 记录一切被调用的 fake ctx。 */
function makeFakeCtx(options = {}) {
  const hooks = new Map()
  const tools = []
  const sections = []
  const logs = []
  const ctx = {
    logger: options.logger ?? {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(event, handler) {
      if (options.throwOn) throw new Error(`boom on ${event}`)
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
    get(serviceName) {
      if (serviceName === 'systemPrompt') {
        if (options.noSystemPrompt) return undefined
        return {
          section(spec) {
            sections.push(spec)
            return () => {}
          },
        }
      }
      return undefined
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, hooks, tools, sections, logs }
}

const disposers = []
async function runApply(ctx, cfg) {
  const status = await apply(ctx, cfg)
  if (typeof status.dispose === 'function') disposers.push(status.dispose)
  return status
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-loadcheck-'))
const globalDbPath = join(tmpRoot, 'global.db')

try {
  // ---- 场景 1：正常加载 ----
  const a = makeFakeCtx()
  const status = await runApply(a.ctx, { globalDbPath })

  check('apply 返回 ok', status.ok === true, status.error ?? '')
  check('未标记 skipped（enabled 默认 true）', status.skipped !== true)
  check('pre-step 已挂载', a.hooks.has('agent/pre-step'), [...a.hooks.keys()].join(','))
  check('turn-stopping 已挂载', a.hooks.has('agent/turn-stopping'), [...a.hooks.keys()].join(','))
  check('guide section 已挂载', a.sections.length === 1 && a.sections[0].name === `${name}:guide`, JSON.stringify(a.sections.map((s) => s.name)))
  check('guide 文本 ≤600 字', a.sections[0] !== undefined && a.sections[0].text.length <= 600, `len=${a.sections[0]?.text.length}`)
  check('全局库已建立', status.db !== null && status.db.path === globalDbPath, JSON.stringify(status.db?.path))
  check('schema 版本 = 1', status.db?.stats?.schemaVersion === 1, String(status.db?.stats?.schemaVersion))
  check('FTS5 可用', status.db?.fts === true, String(status.db?.fts))
  check(
    'M4 注册五个工具',
    a.tools.length === 5 && ['mem_remember', 'mem_search', 'mem_read', 'mem_update', 'mem_project'].every((n) => a.tools.some((t) => t.name === n)),
    a.tools.map((t) => t.name).join(','),
  )

  // pre-step 必须原样透传（M0 不注入任何内容）
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }
  const preStep = a.hooks.get('agent/pre-step')
  const passed = await preStep({ agent: {}, messages: decision.messages, signal: new AbortController().signal }, async () => decision)
  check('pre-step 原样返回 decision', passed === decision)

  // ---- 场景 2：enabled=false → 跳过装配但返回 ok ----
  const b = makeFakeCtx()
  const statusOff = await runApply(b.ctx, { enabled: false, globalDbPath: join(tmpRoot, 'off.db') })
  check('enabled=false 时 ok 且 skipped', statusOff.ok === true && statusOff.skipped === true)
  check('enabled=false 时不挂钩子', b.hooks.size === 0, [...b.hooks.keys()].join(','))

  // ---- 场景 3：空 ctx（最坏情况：什么都没提供） ----
  const c = await runApply({}, { globalDbPath: join(tmpRoot, 'bare.db') })
  check('空 ctx 不 throw 且 ok', c.ok === true && Array.isArray(c.warnings), JSON.stringify(c.warnings))

  // ---- 场景 4：ctx.on 抛错 / systemPrompt 缺失 → fail-open ----
  const d1 = makeFakeCtx({ throwOn: true })
  const statusThrow = await runApply(d1.ctx, { globalDbPath: join(tmpRoot, 'throw.db') })
  check('ctx.on 抛错时仍 ok（fail-open）', statusThrow.ok === true && statusThrow.warnings.some((w) => w.includes('挂载失败')), JSON.stringify(statusThrow.warnings))

  const d2 = makeFakeCtx({ noSystemPrompt: true })
  const statusNoSp = await runApply(d2.ctx, { globalDbPath: join(tmpRoot, 'nosp.db') })
  check('systemPrompt 缺失时仍 ok', statusNoSp.ok === true)

  // ---- 场景 5：配置非法值 → schema 顶回默认，不 throw ----
  const bad = await runApply(makeFakeCtx().ctx, { globalDbPath: join(tmpRoot, 'bad.db'), inject: { maxIndexRows: 9999 } })
  check('非法配置被 schema 修正且不 throw', bad.ok === true && bad.config.inject.maxIndexRows === 12, `got=${bad.config?.inject?.maxIndexRows}`)

  // ---- 场景 6：Config 默认值对齐 §13 ----
  const defaults = Config({})
  check('精排默认关（§13-B）', defaults.recall.rerank.enabled === false)
  check('全局库默认在 D 盘（§13）', defaults.globalDbPath.startsWith('D:'), defaults.globalDbPath)
  check('数据目录名 .dsh-claude-mem', defaults.projectDir === '.dsh-claude-mem', defaults.projectDir)
  check('索引 12 行 × 60 字（§5）', defaults.inject.maxIndexRows === 12 && defaults.inject.maxIndexLineChars === 60)
  check('dream 门控 24h/5 会话（§7）', defaults.dream.minHours === 24 && defaults.dream.minSessions === 5)
} finally {
  for (const dispose of disposers) dispose()
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论
  }
}

const failed = results.filter((r) => !r.pass)
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail && !r.pass ? `  ← ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1
