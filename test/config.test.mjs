import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, DEFAULT_GLOBAL_DB_PATH, DEFAULT_PROJECT_DIR, defaultConfig, resolveConfig } from '../src/config.js'

test('默认值对齐 PLAN.md §13 的拍板', () => {
  const c = defaultConfig()
  assert.equal(c.enabled, true)
  assert.equal(c.projectDir, DEFAULT_PROJECT_DIR)
  assert.equal(c.projectDir, '.dsh-claude-mem')
  assert.equal(c.globalDbPath, DEFAULT_GLOBAL_DB_PATH)
  assert.ok(c.globalDbPath.startsWith('D:'), '全局库默认不放 C 盘')
})

test('预算与门控的默认值来自方案而不是随手写的', () => {
  const c = defaultConfig()
  // §5 注入硬上限
  assert.equal(c.inject.maxIndexRows, 12)
  assert.equal(c.inject.maxIndexLineChars, 60)
  assert.equal(c.inject.firstTurnBudget, 1600)
  assert.equal(c.inject.hitBudget, 450)
  assert.equal(c.inject.maxHitsPerTurn, 2)
  // §6 精排默认关
  assert.equal(c.recall.rerank.enabled, false)
  // §7 dream 门控（官方值）
  assert.equal(c.dream.minHours, 24)
  assert.equal(c.dream.minSessions, 5)
  assert.equal(c.dream.throttleMinutes, 10)
  // §7 写入纪律
  assert.equal(c.write.maxBodyChars, 400)
  assert.equal(c.write.keywordMin, 8)
  assert.equal(c.write.keywordMax, 13)
})

test('非法配置被 schema 顶回默认，resolveConfig 不 throw', () => {
  const resolved = resolveConfig({ inject: { maxIndexRows: 9999 }, dream: { minHours: -5 } })
  assert.equal(resolved.config.inject.maxIndexRows, 12)
  assert.equal(resolved.config.dream.minHours, 24)
})

test('resolveConfig 对 null/undefined 也安全', () => {
  assert.doesNotThrow(() => resolveConfig(undefined))
  assert.doesNotThrow(() => resolveConfig(null))
})

test('D 盘不可用时 auto 策略回落到 $DSH_HOME 并给出 warning', () => {
  const resolved = resolveConfig({ globalDbPath: 'Q:\\nope\\global.db', globalDbPolicy: 'auto' })
  assert.ok(resolved.globalDbPath.includes('dsh-claude-mem'), resolved.globalDbPath)
  assert.equal(resolved.warnings.length, 1)
  assert.match(resolved.warnings[0], /Q:\\/)
})

test('strict 策略下不改路径（即使盘符不在）', () => {
  const resolved = resolveConfig({ globalDbPath: 'Q:\\nope\\global.db', globalDbPolicy: 'strict' })
  assert.equal(resolved.globalDbPath, 'Q:\\nope\\global.db')
  assert.equal(resolved.warnings.length, 0)
})

test('全局库/工作区库路由：soul/user/rules 进全局', () => {
  const resolved = resolveConfig()
  for (const level of ['soul', 'user', 'rules']) {
    assert.equal(resolved.isGlobalLevel(level), true, level)
  }
  for (const level of ['project', 'fact', 'lesson', 'topic']) {
    assert.equal(resolved.isGlobalLevel(level), false, level)
  }
  // 显式 scope=global 的 fact/lesson 也进全局
  assert.equal(resolved.isGlobalLevel('fact', 'global'), true)
})

test('工作区路径落在 <workspace>/.dsh-claude-mem/', () => {
  const resolved = resolveConfig()
  const ws = 'C:\\work\\proj'
  assert.equal(resolved.workspaceDbPath(ws), 'C:\\work\\proj\\.dsh-claude-mem\\memory.db')
  assert.equal(resolved.workspaceDataDir(ws), 'C:\\work\\proj\\.dsh-claude-mem')
})

test('Config 可被当作 schema 直接调用（DSH 的用法）', () => {
  const v = Config({ projectDir: '.custom-mem' })
  assert.equal(v.projectDir, '.custom-mem')
  assert.equal(v.inject.maxIndexRows, 12)
})
