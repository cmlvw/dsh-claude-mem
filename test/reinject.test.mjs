import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildReinjection, classifyCompactionEvent, createReinjectScheduler, REINJECT_KIND } from '../src/reinject.js'

// ---------------------------------------------------------------- 事件归一化

test('classifyCompactionEvent：start/summary 解除，end 无 error 挂起', () => {
  assert.equal(classifyCompactionEvent('compaction/start', {}), 'disarm')
  assert.equal(classifyCompactionEvent('compaction/summary', {}), 'disarm')
  assert.equal(classifyCompactionEvent('compaction/end', {}), 'arm')
  assert.equal(classifyCompactionEvent('compaction/end', undefined), 'arm')
  assert.equal(classifyCompactionEvent('compaction/end', { error: null }), 'arm')
  assert.equal(classifyCompactionEvent('compaction/end', { error: '' }), 'arm')
})

test('classifyCompactionEvent：压缩失败不挂起重注入', () => {
  assert.equal(classifyCompactionEvent('compaction/end', { error: 'boom' }), 'disarm')
  assert.equal(classifyCompactionEvent('compaction/end', { error: new Error('x') }), 'disarm')
})

test('classifyCompactionEvent：无关事件一律 ignore', () => {
  for (const type of ['turn/start', 'turn/end', 'user/message', 'tool/start', undefined, null, '']) {
    assert.equal(classifyCompactionEvent(type, {}), 'ignore', String(type))
  }
})

// ---------------------------------------------------------------- 待办表

test('scheduler：arm → isPending → take 取走即清（不重复）', () => {
  const s = createReinjectScheduler()
  assert.equal(s.isPending('a'), false)
  assert.equal(s.arm('a'), true)
  assert.equal(s.isPending('a'), true)

  const first = s.take('a')
  assert.ok(first)
  assert.equal(first.reason, 'compaction')
  assert.equal(s.isPending('a'), false, 'take 后必须清掉')
  assert.equal(s.take('a'), null, '第二次 take 必须为 null（防重复注入）')
})

test('scheduler：disarm 能撤销待办（压缩失败/中断）', () => {
  const s = createReinjectScheduler()
  s.arm('a')
  assert.equal(s.disarm('a'), true)
  assert.equal(s.isPending('a'), false)
  assert.equal(s.take('a'), null)
})

test('scheduler：按会话隔离，各注各的', () => {
  const s = createReinjectScheduler()
  s.arm('a')
  s.arm('b')
  assert.equal(s.size(), 2)
  assert.equal(s.take('a') !== null, true)
  assert.equal(s.isPending('a'), false)
  assert.equal(s.isPending('b'), true)
})

test('scheduler：坏 sessionId 不挂起、不抛', () => {
  const s = createReinjectScheduler()
  assert.equal(s.arm(''), false)
  assert.equal(s.arm(null), false)
  assert.equal(s.arm(undefined), false)
  assert.equal(s.isPending(null), false)
  assert.equal(s.take(undefined), null)
  assert.equal(s.size(), 0)
})

test('scheduler：超过上限丢最旧的，不会无限增长', () => {
  const s = createReinjectScheduler({ maxEntries: 3 })
  s.arm('a')
  s.arm('b')
  s.arm('c')
  s.arm('d')
  assert.equal(s.size(), 3)
  assert.equal(s.isPending('a'), false, '最旧的被挤掉')
  assert.equal(s.isPending('d'), true)
})

// ---------------------------------------------------------------- 内容装配

test('buildReinjection：重新收集核心块，返回文本与 id 列表', () => {
  const calls = []
  const deps = {
    collectCore: (args) => {
      calls.push(args)
      return { text: '【长期记忆】\n内容', ids: ['id1', 'id2'], chars: 12, dropped: 0 }
    },
  }
  const built = buildReinjection(deps, {
    globalDb: 'g',
    workspaceDb: 'w',
    cfg: { inject: {} },
    project: 'projA',
    projectDetected: true,
  })
  assert.ok(built)
  assert.equal(built.text, '【长期记忆】\n内容')
  assert.deepEqual(built.ids, ['id1', 'id2'])
  assert.equal(built.chars, 12)
  // 参数要原样透传给 collectCore
  assert.equal(calls[0].globalDb, 'g')
  assert.equal(calls[0].workspaceDb, 'w')
  assert.equal(calls[0].project, 'projA')
  assert.equal(calls[0].projectDetected, true)
})

test('buildReinjection：collectCore 给空 → null（没有内容就不注）', () => {
  const none = { collectCore: () => ({ text: '', ids: [], chars: 0, dropped: 0 }) }
  assert.equal(buildReinjection(none, { cfg: {} }), null)

  const noIds = { collectCore: () => ({ text: '有字没id', ids: [], chars: 4 }) }
  assert.equal(buildReinjection(noIds, { cfg: {} }), null)

  const nullish = { collectCore: () => null }
  assert.equal(buildReinjection(nullish, { cfg: {} }), null)
})

test('buildReinjection：collectCore 抛错 → null（fail-open，不炸 pre-step）', () => {
  const deps = {
    collectCore: () => {
      throw new Error('db broken')
    },
  }
  assert.doesNotThrow(() => buildReinjection(deps, { cfg: {} }))
  assert.equal(buildReinjection(deps, { cfg: {} }), null)
})

test('REINJECT_KIND 常量稳定（injections 表靠它区分注入类型）', () => {
  assert.equal(REINJECT_KIND, 'reinject')
})
