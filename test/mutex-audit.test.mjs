/**
 * dsh-claude-mem · 互斥审计落盘测试（M6）
 *
 * 为什么单独测：headless profile 的 ctx.logger 是 no-op，互斥拒绝如果只记 logger，
 * 事后就没有任何凭证。appendAudit 是「可取证」这一验收标准的实现，必须钉住：
 *   1. 冲突时写 mutex.refused，带对手行与自身行；
 *   2. 通过时写 mutex.passed；
 *   3. 拿不到 loader 时写 mutex.unavailable；
 *   4. 写盘失败绝不抛错（fail-open）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { appendAudit } from '../src/index.js'

let tmpRoot

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-audit-'))
})

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论
  }
})

function readAudit(dataDir) {
  const file = join(dataDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('appendAudit：冲突事件带对手行与自身行，可事后核实', () => {
  const dataDir = join(tmpRoot, 'd1')
  const status = { paths: { dataDir } }
  appendAudit({}, status, 'mutex.refused', {
    reason: '检测到同时启用：dsh-meow-mem(dsh-meow-mem)',
    rivals: [{ id: 'dsh-meow-mem', pkg: 'dsh-meow-mem' }],
    self: [{ id: 'dsh-claude-mem', enabled: true }],
  })
  const rows = readAudit(dataDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, 'mutex.refused')
  assert.equal(rows[0].plugin, 'dsh-claude-mem')
  assert.match(rows[0].reason, /dsh-meow-mem/)
  assert.equal(rows[0].rivals[0].pkg, 'dsh-meow-mem')
  assert.equal(rows[0].self[0].id, 'dsh-claude-mem')
  assert.ok(typeof rows[0].at === 'string' && rows[0].at.endsWith('Z'), '要有时间戳')
})

test('appendAudit：通过/不可用事件也留痕（可区分「拒绝了」与「没检测」）', () => {
  const dataDir = join(tmpRoot, 'd2')
  const status = { paths: { dataDir } }
  appendAudit({}, status, 'mutex.passed', { reason: '未检测到启用的 meow 阵营插件' })
  appendAudit({}, status, 'mutex.unavailable', { reason: 'loader 不可用' })
  const rows = readAudit(dataDir)
  assert.deepEqual(rows.map((r) => r.event), ['mutex.passed', 'mutex.unavailable'])
})

test('appendAudit：多次调用是追加而不是覆盖', () => {
  const dataDir = join(tmpRoot, 'd3')
  const status = { paths: { dataDir } }
  appendAudit({}, status, 'mutex.refused', { reason: 'a' })
  appendAudit({}, status, 'mutex.refused', { reason: 'b' })
  assert.equal(readAudit(dataDir).length, 2)
})

test('appendAudit：dataDir 缺失 / 不可写都不抛错（fail-open）', () => {
  assert.doesNotThrow(() => appendAudit({}, {}, 'mutex.refused', {}))
  assert.doesNotThrow(() => appendAudit({}, { paths: {} }, 'mutex.refused', {}))
  assert.doesNotThrow(() => appendAudit({}, { paths: { dataDir: '' } }, 'mutex.refused', {}))
  // 指向一个必然失败的位置（Windows 上盘符不存在）
  assert.doesNotThrow(() => appendAudit({}, { paths: { dataDir: 'Z:\\nope\\nope' } }, 'mutex.refused', {}))
})
