/**
 * dsh-claude-mem · 互斥检测单测（M6）
 *
 * 断言的重点不是「能读 loader」，而是三件容易写错的事：
 *   1. disabled 的 meow 行**不算**冲突（否则回滚后本插件永远起不来）；
 *   2. fork（dsh-meow-mem）与上游（meow-memory）**都算**冲突（同阵营）；
 *   3. 拿不到 loader 时**不阻断**（fail-open），但要把 reflected=false 透出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkMutex,
  createMutexGuard,
  describeConflict,
  findEnabledMeow,
  findSelfEntries,
  isEntryEnabled,
  MEOW_PACKAGES,
  normalizePackageName,
  readLoaderEntries,
} from '../src/mutex.js'

/** 造一条 loader entry（形状照真机：options 里放 id/name，disabled 在 entry 上）。 */
function entry(pkg, { id = pkg, disabled = false, disabledInOptions = false } = {}) {
  const options = { id, name: pkg }
  if (disabledInOptions) options.disabled = true
  return { options, disabled, fiber: { fake: true } }
}

/** 造一个只有 loader 的 fake ctx。 */
function loaderCtx(entries) {
  return { loader: { entries: () => entries } }
}

test('normalizePackageName：scope 与子路径都能归一', () => {
  assert.equal(normalizePackageName('meow-memory'), 'meow-memory')
  assert.equal(normalizePackageName('@scope/pkg'), '@scope/pkg')
  assert.equal(normalizePackageName('@scope/pkg/sub'), '@scope/pkg')
  assert.equal(normalizePackageName('dsh-claude-mem/src'), 'dsh-claude-mem')
  assert.equal(normalizePackageName(''), '')
  assert.equal(normalizePackageName(null), '')
})

test('isEntryEnabled：disabled 在 entry 上或在 options 里都算关闭', () => {
  assert.equal(isEntryEnabled({ disabled: true }), false)
  assert.equal(isEntryEnabled({ options: { disabled: true } }), false)
  assert.equal(isEntryEnabled({ disabled: false }), true)
  assert.equal(isEntryEnabled({}), true, '没有 disabled 字段默认启用')
  assert.equal(isEntryEnabled(null), false)
})

test('findEnabledMeow：只挑启用中的 meow 阵营', () => {
  const entries = [
    entry('meow-memory', { disabled: true }),
    entry('dsh-meow-mem'),
    entry('@deepseek-ai/dsh-llm'),
  ]
  const rivals = findEnabledMeow(entries)
  assert.equal(rivals.length, 1)
  assert.equal(rivals[0].pkg, 'dsh-meow-mem')
  assert.equal(rivals[0].id, 'dsh-meow-mem')
})

test('findEnabledMeow：上游与 fork 都认（本卡拍板：两者任一启用即冲突）', () => {
  assert.deepEqual(MEOW_PACKAGES, ['meow-memory', 'dsh-meow-mem'])
  const both = findEnabledMeow([entry('meow-memory'), entry('dsh-meow-mem')])
  assert.equal(both.length, 2)
})

test('findEnabledMeow：名字前缀相近但不同包的（dsh-meow-mem-foo）不算', () => {
  const rivals = findEnabledMeow([entry('dsh-meow-mem-foo'), entry('meow-memory-tools')])
  assert.equal(rivals.length, 0)
})

test('checkMutex：对手启用 → conflict=true，且 reason 带行 id', () => {
  const result = checkMutex(loaderCtx([entry('dsh-meow-mem'), entry('dsh-claude-mem')]))
  assert.equal(result.conflict, true)
  assert.equal(result.reflected, true)
  assert.match(result.reason, /dsh-meow-mem/)
  assert.equal(result.rivals.length, 1)
})

test('checkMutex：对手 disabled → 不冲突（回滚后本插件能起来）', () => {
  const result = checkMutex(loaderCtx([entry('dsh-meow-mem', { disabled: true }), entry('dsh-claude-mem')]))
  assert.equal(result.conflict, false)
  assert.equal(result.reflected, true)
  assert.equal(result.rivals.length, 0)
})

test('checkMutex：对手 disabled 写在 options 里也不冲突', () => {
  const result = checkMutex(loaderCtx([entry('meow-memory', { disabledInOptions: true })]))
  assert.equal(result.conflict, false)
})

test('checkMutex：loader 不可用 → 不阻断，但 reflected=false 且 reason 说明', () => {
  for (const ctx of [{}, { loader: {} }, { loader: { entries: () => { throw new Error('boom') } } }]) {
    const result = checkMutex(ctx)
    assert.equal(result.conflict, false, '反射失败不能阻断加载')
    assert.equal(result.reflected, false)
    assert.match(result.reason, /跳过/)
  }
})

test('checkMutex：mutexWithMeow=false 时即使对手在跑也不冲突（用户显式关闭）', () => {
  const result = checkMutex(loaderCtx([entry('meow-memory')]), { enabled: false })
  assert.equal(result.conflict, false)
  assert.equal(result.rivals.length, 1, '仍要能看到对手状态，供日志用')
  assert.match(result.reason, /mutexWithMeow=false/)
})

test('findSelfEntries：认出自己那一行（诊断反射是否真的看到了我们）', () => {
  const self = findSelfEntries([entry('dsh-claude-mem', { id: 'dsh-claude-mem' }), entry('meow-memory')])
  assert.equal(self.length, 1)
  assert.equal(self[0].id, 'dsh-claude-mem')
  assert.equal(self[0].enabled, true)
})

test('readLoaderEntries：entries 是 iterable 也吃', () => {
  const entries = new Set([entry('meow-memory')])
  assert.equal(readLoaderEntries({ loader: { entries: () => entries } }).length, 1)
})

test('describeConflict：无冲突返回空串，有冲突带「拒绝装配」与处置建议', () => {
  assert.equal(describeConflict({ conflict: false }), '')
  const text = describeConflict({ conflict: true, reason: '检测到同时启用：dsh-meow-mem(dsh-meow-mem)' })
  assert.match(text, /互斥命中/)
  assert.match(text, /拒绝装配/)
  assert.match(text, /停用/)
})

test('createMutexGuard：TTL 内不重复反射，冲突时 noteConflictOnce 只放行一次日志', () => {
  let calls = 0
  const ctx = { loader: { entries: () => { calls += 1; return [entry('dsh-meow-mem')] } } }
  const guard = createMutexGuard(ctx, { ttlMs: 60_000, cooldownMs: 60_000 })
  assert.equal(guard.check().conflict, true)
  assert.equal(guard.check().conflict, true)
  assert.equal(calls, 1, 'TTL 内只反射一次')
  assert.equal(guard.noteConflictOnce(), true, '首次冲突要记日志')
  assert.equal(guard.noteConflictOnce(), false, 'cooldown 内不重复刷日志')
  assert.equal(guard.check().conflict, true, '节流只影响日志，不影响守卫判定')
})

test('createMutexGuard：对手关掉后状态回到 ok（guard.state 可观测）', () => {
  const rows = [entry('dsh-meow-mem')]
  const ctx = { loader: { entries: () => rows } }
  const guard = createMutexGuard(ctx, { ttlMs: 0 })
  assert.equal(guard.noteConflictOnce(), true)
  assert.equal(guard.state, 'conflict')
  rows[0].disabled = true
  assert.equal(guard.noteConflictOnce(), false)
  assert.equal(guard.state, 'ok')
})
