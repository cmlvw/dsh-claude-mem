import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { defaultConfig } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import {
  attributeAnswerLoss,
  containsAnswer,
  createBm25,
  ingestWorld,
  normalizeDataset,
  summarizeAnswers,
} from '../tools/bench/lib.mjs'
import { DEFAULT_NOISE, auditDataset, buildDataset } from '../tools/bench/devmem/build.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readDataset = (name) => JSON.parse(readFileSync(join(ROOT, 'tools/bench/datasets', name), 'utf8'))

/** 拷一份改坏，确认审计真的会报。 */
function tamper(edit) {
  const dataset = structuredClone(buildDataset({ noise: 0 }))
  edit(dataset)
  return auditDataset(dataset)
}
const probeOf = (dataset, id) => dataset.gold.probes.find((probe) => probe.id === id)
const sessionOf = (dataset, id) => dataset.sessions.find((session) => session.id === id)

describe('devmem 数据集', () => {
  it('审计通过，噪声不影响结论', () => {
    assert.deepEqual(auditDataset(buildDataset({ noise: 0 })), [])
    assert.deepEqual(auditDataset(buildDataset({ noise: DEFAULT_NOISE })), [])
  })

  it('入库的 JSON 和生成结果一致', () => {
    assert.deepEqual(readDataset('devmem-lite.json'), buildDataset({ name: 'devmem-lite', noise: 0 }))
    assert.deepEqual(readDataset('devmem.json'), buildDataset({ name: 'devmem', noise: DEFAULT_NOISE }))
  })

  it('同一种子生成结果不变', () => {
    assert.deepEqual(buildDataset({ noise: 30, seed: 7 }), buildDataset({ noise: 30, seed: 7 }))
    assert.notDeepEqual(buildDataset({ noise: 30, seed: 7 }).sessions, buildDataset({ noise: 30, seed: 8 }).sessions)
  })

  it('覆盖公开集的全部题型', () => {
    const kinds = new Set(buildDataset({ noise: 0 }).gold.probes.map((probe) => probe.kind))
    for (const kind of [
      'single-session-user',
      'single-session-assistant',
      'single-session-preference',
      'multi-session',
      'temporal-reasoning',
      'knowledge-update',
      'abstention',
    ]) {
      assert.ok(kinds.has(kind), kind)
    }
  })

  it('runner 能读，题号和扩展字段都保留', () => {
    const { format, worlds } = normalizeDataset(buildDataset({ noise: 0 }))
    assert.equal(format, 'harness-sessions')
    const [world] = worlds
    const probe = world.probes.find((item) => item.id === 'k01')
    assert.deepEqual(probe.evidence, [['s46']])
    assert.equal(probe.answer, '64')
    assert.ok(probe.stale.length > 0)
    assert.ok(probe.tags.includes('distractor'))
    assert.equal(probe.date, '2026-10-30')
    assert.ok(world.memories.length > 0)
  })
})

describe('devmem 审计', () => {
  it('拒答题的答案词混进会话时报错', () => {
    const issues = tamper((dataset) => {
      sessionOf(dataset, 's10').messages[0].text += ' UPS 买的是山特。'
    })
    assert.ok(issues.some((issue) => issue.startsWith('x04')), issues.join('\n'))
  })

  it('答案也出现在非证据会话时报错', () => {
    const issues = tamper((dataset) => {
      sessionOf(dataset, 's10').messages[0].text += ' 对了 03:17 这个时间不错。'
    })
    assert.ok(issues.some((issue) => issue.startsWith('u01') && issue.includes('s10')), issues.join('\n'))
  })

  it('答案串不在证据里时报错', () => {
    const issues = tamper((dataset) => {
      probeOf(dataset, 'u01').keys = [['不存在的答案']]
    })
    assert.ok(issues.some((issue) => issue.startsWith('u01') && issue.includes('不在证据会话')), issues.join('\n'))
  })

  it('问句泄露答案时报错', () => {
    const issues = tamper((dataset) => {
      probeOf(dataset, 'u01').q = '日结算是不是 03:17 启动？'
    })
    assert.ok(issues.some((issue) => issue.startsWith('u01') && issue.includes('问句')), issues.join('\n'))
  })

  it('换说法的题和证据撞词时报错', () => {
    const issues = tamper((dataset) => {
      probeOf(dataset, 'u02').q = '幂等键怎么拼？'
    })
    assert.ok(issues.some((issue) => issue.startsWith('u02') && issue.includes('lexical-gap')), issues.join('\n'))
  })

  it('跨语言的题证据同语言时报错', () => {
    const issues = tamper((dataset) => {
      probeOf(dataset, 'u08').q = '对账消费者的新主题是什么？'
    })
    assert.ok(issues.some((issue) => issue.startsWith('u08') && issue.includes('cross-lingual')), issues.join('\n'))
  })

  it('旧版本事实不能当答案', () => {
    const issues = tamper((dataset) => {
      probeOf(dataset, 'k02').expect.push('pool-initial')
    })
    assert.ok(issues.some((issue) => issue.includes('pool-initial') && issue.includes('已过时')), issues.join('\n'))
  })
})

describe('答案级判定', () => {
  it('外层都要有，内层任一写法', () => {
    assert.equal(containsAnswer('Astro 部署在 Cloudflare Pages', [['Astro'], ['cloudflare pages']]), true)
    assert.equal(containsAnswer('只有 Astro', [['Astro'], ['Cloudflare Pages']]), false)
    assert.equal(containsAnswer('中断 47 分钟', [['47 minutes', '47分钟']]), true)
    assert.equal(containsAnswer('随便什么', []), false)
  })

  it('损失按流水线顺序归因', () => {
    const base = { block: '', pickedBodies: [], echoedBodies: [], rankedBodies: [], keys: [['答案']] }
    const stage = (input) => attributeAnswerLoss({ ...base, outcome: 'injected_hit', ...input })
    assert.equal(stage({ block: '答案' }), 'injected')
    assert.equal(stage({ outcome: 'skip_nosignal', rankedBodies: ['答案'] }), 'gate_closed')
    assert.equal(stage({ pickedBodies: ['答案'] }), 'clipped')
    assert.equal(stage({ echoedBodies: ['答案'], rankedBodies: ['答案'] }), 'echoed')
    assert.equal(stage({ rankedBodies: ['答案'] }), 'filtered_or_budget')
    assert.equal(stage({}), 'not_retrieved')
  })

  it('没配答案串的数据集不出答案级结果', () => {
    assert.equal(summarizeAnswers([{ keyed: false, abstain: false }], ['default']), null)
  })

  it('BM25 让稀有词压过高频词', () => {
    const search = createBm25(['tidepool 周会', 'tidepool 值班', 'tidepool 部署', 'tidepool 用 Redis 缓存'])
    assert.equal(search('tidepool 的 Redis')[0], 'tidepool 用 Redis 缓存')
    assert.deepEqual(search('完全无关'), [])
  })
})

describe('gold 写入', () => {
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), 'devmem-test-'))
    const opened = openMemoryDb(join(dir, 'world.db'))
    assert.ok(opened.ok)
    return { db: opened.db, close: () => { opened.db.close(); rmSync(dir, { recursive: true, force: true }) } }
  }

  it('走真实校验写入，全部事实都进库', async () => {
    const [world] = normalizeDataset(buildDataset({ noise: 0 })).worlds
    const { db, close } = open()
    try {
      const { provenance, stats } = await ingestWorld({ world, db, cfg: defaultConfig(), mode: 'gold' })
      assert.deepEqual(stats.rejected, {})
      assert.equal(stats.inserted + stats.merged, world.memories.length)
      assert.ok(provenance.size > 0)
    } finally {
      close()
    }
  })

  it('一次性噪声不写进库', async () => {
    const [world] = normalizeDataset(buildDataset({ noise: 0 })).worlds
    assert.ok(!world.memories.some((memory) => memory.content.includes('ERR-TMP-7731')))
  })

  it('数据集没有标注记忆时报错', async () => {
    const world = { id: 'w', sessions: [], probes: [], memories: [] }
    const { db, close } = open()
    try {
      await assert.rejects(ingestWorld({ world, db, cfg: defaultConfig(), mode: 'gold' }), /gold\.memories/)
    } finally {
      close()
    }
  })
})

describe('devmem 全链路', () => {
  it('命令行能跑出答案级和切片结果', () => {
    const out = mkdtempSync(join(tmpdir(), 'devmem-cli-'))
    try {
      const stdout = execFileSync(
        process.execPath,
        ['tools/bench-memory.mjs', '--data', 'tools/bench/datasets/devmem-lite.json', '--ingest', 'gold', '--out', out],
        { cwd: ROOT, encoding: 'utf8' },
      )
      for (const text of ['答案级', 'BM25基线', '按题型', '按难点', '拒答题注入率', 'knowledge-update', 'lexical-gap']) {
        assert.ok(stdout.includes(text), text)
      }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
