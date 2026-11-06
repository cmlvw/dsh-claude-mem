import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { defaultConfig } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import {
  LlmFatalError,
  attributeLoss,
  buildProfile,
  needsVectors,
  buildReaderPrompt,
  chunkText,
  createLlm,
  deriveKeywords,
  estimateCalls,
  ingestWorld,
  judgePrompt,
  normalizeDataset,
  parseBenchDate,
  parseExtraction,
  parseVerdict,
  probeWorld,
  sampleProbes,
  scoreRanking,
  summarizeE2e,
  summarizeInjection,
  validateWorlds,
  worldShift,
} from '../tools/bench/lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'longmemeval-mini.json')
const CLI = join(HERE, '..', 'tools', 'bench-memory.mjs')
const loadFixture = () => normalizeDataset(JSON.parse(readFileSync(FIXTURE, 'utf8')))

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-test-'))
  const opened = openMemoryDb(join(dir, 'test.db'))
  assert.equal(opened.ok, true)
  return Promise.resolve(fn(opened.db)).finally(() => {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

const harness = {
  name: 'h',
  sessions: [
    { id: 1, date: '2026-10-01', messages: [{ role: 'user', text: '部署目标是 fly.io' }] },
    { id: 2, date: '2026-10-05', messages: [{ role: 'user', text: '部署目标改成 k8s' }] },
  ],
  gold: {
    facts: [
      { name: 'deploy', label: 'updated', evidence_sessions: [1, 2], answer_from: 2, description: '部署到 k8s' },
      { name: 'other', label: 'durable', evidence_sessions: [1, 2], description: '两处都提到' },
    ],
    probes: [
      { q: '部署到哪?', expect: ['deploy'], kind: 'knowledge-update' },
      { q: '两处事实?', expect: ['other'], kind: 'single-hop' },
      { q: '数据库密码?', expect: [], kind: 'abstention' },
    ],
  },
}

describe('数据集归一', () => {
  it('解析两种日期格式', () => {
    assert.equal(parseBenchDate('2023/05/20 (Sat) 02:21'), Date.UTC(2023, 4, 20, 2, 21))
    assert.equal(parseBenchDate('2026-10-01'), Date.UTC(2026, 9, 1))
    assert.equal(parseBenchDate('昨天'), null)
  })

  it('LongMemEval 一题一个世界，拒答题没有证据', () => {
    const { format, worlds } = loadFixture()
    assert.equal(format, 'longmemeval')
    assert.equal(worlds.length, 4)
    assert.deepEqual(worlds[1].probes[0].evidence, [['b_first'], ['b_second']])
    assert.equal(worlds[3].probes[0].abstain, true)
    assert.deepEqual(worlds[3].probes[0].evidence, [])
  })

  it('harness 被推翻的事实只认 answer_from，普通事实任一会话都算', () => {
    const { format, worlds } = normalizeDataset(harness)
    assert.equal(format, 'harness-sessions')
    assert.equal(worlds.length, 1)
    assert.deepEqual(worlds[0].probes[0].evidence, [['2']])
    assert.deepEqual(worlds[0].probes[1].evidence, [['1', '2']])
    assert.equal(worlds[0].probes[2].abstain, true)
  })

  it('证据指向不存在的会话时报出来', () => {
    const { worlds } = loadFixture()
    worlds[0].probes[0].evidence = [['ghost']]
    assert.equal(validateWorlds(worlds).length, 1)
  })

  it('字段名对不上导致证据或历史为空时报出来，不静默得零分', () => {
    const records = JSON.parse(readFileSync(FIXTURE, 'utf8')).map(({ answer_session_ids, ...rest }) => rest)
    const issues = validateWorlds(normalizeDataset(records).worlds)
    assert.equal(issues.length, 3)
    assert.match(issues[0], /没有证据会话/)
    const noHistory = JSON.parse(readFileSync(FIXTURE, 'utf8')).map(({ haystack_sessions, ...rest }) => rest)
    assert.ok(validateWorlds(normalizeDataset(noHistory).worlds).some((issue) => issue.includes('没有会话历史')))
  })

  it('认不出的格式直接报错', () => {
    assert.throws(() => normalizeDataset({ foo: 1 }), /认不出/)
  })
})

describe('分层抽样', () => {
  const worlds = Array.from({ length: 100 }, (_, index) => ({
    id: `w${index}`,
    sessions: [],
    probes: [{ id: `p${index}`, type: index < 70 ? 'a' : index < 95 ? 'b' : 'c', abstain: false, evidence: [] }],
  }))
  const ids = (list) => list.flatMap((world) => world.probes.map((probe) => probe.id)).sort()

  it('总数严格等于 n，且同一种子结果不变', () => {
    const first = sampleProbes(worlds, 10, 7)
    assert.equal(first.length, 10)
    assert.deepEqual(ids(first), ids(sampleProbes(worlds, 10, 7)))
    assert.notDeepEqual(ids(first), ids(sampleProbes(worlds, 10, 8)))
  })

  it('小层也至少有一题', () => {
    const types = new Set(sampleProbes(worlds, 10, 7).map((world) => world.probes[0].type))
    assert.deepEqual([...types].sort(), ['a', 'b', 'c'])
  })

  it('n=0 全量，n 超过总数也不重复', () => {
    assert.equal(sampleProbes(worlds, 0, 7).length, 100)
    assert.equal(sampleProbes(worlds, 500, 7).length, 100)
  })
})

describe('切块与关键词', () => {
  it('块不超长，内容不丢', () => {
    const text = '第一句话。'.repeat(100)
    const chunks = chunkText(text, 50)
    assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 50))
    assert.equal(chunks.join(''), text)
  })

  it('超长单句硬切', () => {
    const chunks = chunkText('x'.repeat(120), 50)
    assert.deepEqual(chunks.map((chunk) => chunk.length), [50, 50, 20])
  })

  it('关键词优先取世界内稀有的词，去掉停用词', () => {
    const docFreq = new Map([['machine', 9], ['breville', 1]])
    const keywords = deriveKeywords('the machine from Breville', docFreq, 2)
    assert.deepEqual(keywords, ['breville', 'machine'])
  })
})

describe('打分', () => {
  const s = (...ids) => new Set(ids)

  it('any 与 all 分开：多会话题只找到一半不算全部', () => {
    const score = scoreRanking([s('x'), s('a'), s('y'), s('b')], [['a'], ['b']], [1, 2, 4])
    assert.deepEqual(score.any, { 1: false, 2: true, 4: true })
    assert.deepEqual(score.all, { 1: false, 2: false, 4: true })
    assert.equal(score.rr, 0.5)
  })

  it('组内任一会话都算这条事实到手', () => {
    const score = scoreRanking([s('b')], [['a', 'b']], [1])
    assert.equal(score.all[1], true)
  })

  it('没有证据的题不会被算成全部命中', () => {
    const score = scoreRanking([s('a')], [], [1])
    assert.equal(score.all[1], false)
    assert.equal(score.rr, 0)
  })

  it('损失归因按流水线顺序', () => {
    assert.equal(attributeLoss({ outcome: 'injected_hit', injectedAny: true, retrievedAny: true }), 'injected')
    assert.equal(attributeLoss({ outcome: 'skip_nosignal', injectedAny: false, retrievedAny: true }), 'gate_closed')
    assert.equal(attributeLoss({ outcome: 'injected_hit', injectedAny: false, retrievedAny: true }), 'filtered_or_budget')
    assert.equal(attributeLoss({ outcome: 'no_candidates', injectedAny: false, retrievedAny: false }), 'not_retrieved')
  })

  it('判不出来的题不进分母', () => {
    const rows = [
      { abstain: false, type: 'a', e2e: { x: { correct: true } } },
      { abstain: false, type: 'b', e2e: { x: { correct: false } } },
      { abstain: false, type: 'b', e2e: { x: { correct: null } } },
      { abstain: true, type: 'a', e2e: { x: { correct: true } } },
    ]
    const summary = summarizeE2e(rows, 'x')
    assert.equal(summary.unjudged, 1)
    assert.equal(summary.n, 3)
    assert.equal(summary.taskAveraged, 0.5)
    assert.equal(summary.abstention, 1)
  })

  it('判分词只认开头的 yes/no', () => {
    assert.equal(parseVerdict('Yes.'), true)
    assert.equal(parseVerdict('no'), false)
    assert.equal(parseVerdict('I cannot say yes'), null)
    assert.equal(parseVerdict(''), null)
  })

  it('作答 prompt 去掉随机短 id，相同内容的 prompt 完全相同', () => {
    const probe = { date: 'd', question: 'q' }
    const first = buildReaderPrompt(probe, '【记忆命中】\n- [话题·abc123] 内容 [备注·保留]（3 天前）')
    const second = buildReaderPrompt(probe, '【记忆命中】\n- [话题·zzz999] 内容 [备注·保留]（3 天前）')
    assert.equal(first, second)
    assert.ok(first.includes('- [话题] 内容 [备注·保留]'))
  })

  it('判分模板不解释回答里的替换符', () => {
    const prompt = judgePrompt({ abstain: false, type: 'x', question: 'q', answer: 'a' }, 'cost $& {answer}')
    assert.ok(prompt.includes('cost $& {answer}'))
  })
})

describe('提取解析', () => {
  it('接受裸数组、代码块和 memories 包装', () => {
    assert.deepEqual(parseExtraction('[{"content":"x"}]'), [{ content: 'x' }])
    assert.deepEqual(parseExtraction('```json\n[]\n```'), [])
    assert.deepEqual(parseExtraction('{"memories":[{"content":"x"}]}'), [{ content: 'x' }])
    assert.deepEqual(parseExtraction('好的：\n[{"content":"x"}]\n以上'), [{ content: 'x' }])
  })

  it('解析不了返回 null，和空数组区分开', () => {
    assert.equal(parseExtraction('抱歉我做不到'), null)
  })
})

describe('时间平移', () => {
  it('最后一个时间点落在 now，相对间隔不变', () => {
    const world = { sessions: [{ ts: 1000 }, { ts: 2000 }], probes: [{ ts: 5000 }] }
    assert.equal(worldShift(world, 9000), 4000)
  })

  it('全无时间时不平移', () => {
    assert.equal(worldShift({ sessions: [{ ts: null }], probes: [{ ts: null }] }, 9000), 0)
  })
})

describe('写入与召回（真实库）', () => {
  it('raw 写入后能按来源会话找回证据', async () => {
    await withDb(async (db) => {
      const cfg = defaultConfig()
      const world = loadFixture().worlds[0]
      const { provenance, stats } = await ingestWorld({ world, db, cfg, mode: 'raw' })
      assert.equal(stats.inserted, 4)
      const rows = await probeWorld({ world, db, cfg, provenance, profiles: { wide: buildProfile('wide', cfg) } })
      assert.equal(rows[0].retrieval.any[20], true)
      assert.equal(rows[0].injection.wide.injectedAny, true)
      assert.equal(rows[0].injection.wide.stage, 'injected')
    })
  })

  it('平移后会话时间相对现在保持原有间隔', async () => {
    await withDb(async (db) => {
      const cfg = defaultConfig()
      const world = loadFixture().worlds[0]
      const now = Date.UTC(2030, 0, 1)
      await ingestWorld({ world, db, cfg, mode: 'raw', now })
      const newest = db.prepare('SELECT MAX(created_at) AS at FROM entries').get().at
      assert.equal(now - newest, world.probes[0].ts - world.sessions[1].ts)
    })
  })

  it('llm 写入走真实校验：不合规的被拒收并计数，核心层不写', async () => {
    await withDb(async (db) => {
      const cfg = defaultConfig()
      const world = { ...loadFixture().worlds[0], sessions: loadFixture().worlds[0].sessions.slice(1) }
      const keywords = ['espresso', 'machine', 'breville', 'kitchen', 'coffee', 'bought', 'brand', 'appliance']
      const llm = {
        chat: async () =>
          JSON.stringify([
            { level: 'fact', content: 'Bought a Breville espresso machine', keywords },
            { level: 'fact', content: 'no keywords here', keywords: [] },
            { level: 'user', content: 'likes coffee', keywords },
          ]),
      }
      const { provenance, stats } = await ingestWorld({ world, db, cfg, mode: 'llm', llm })
      assert.equal(stats.inserted, 1)
      assert.equal(stats.rejected['keywords 不能为空'], 1)
      assert.equal(stats.rejected['level 不可召回：user'], 1)
      assert.deepEqual([...provenance.values()][0], new Set(['a_answer']))
    })
  })

  it('相似内容合并后保留两个来源会话', async () => {
    await withDb(async (db) => {
      const cfg = defaultConfig()
      const keywords = ['gym', 'membership', 'plan', 'annual', 'fitness', 'contract', 'subscription', 'club']
      const world = loadFixture().worlds[2]
      const llm = { chat: async () => JSON.stringify([{ level: 'topic', content: 'The gym membership plan of the user is annual', keywords }]) }
      const { provenance, stats } = await ingestWorld({ world, db, cfg, mode: 'llm', llm })
      assert.equal(stats.merged, 1)
      assert.deepEqual([...provenance.values()][0], new Set(['c_old', 'c_new']))
    })
  })

  it('提取解析失败与 API 失败分别计数，致命错误直接抛出', async () => {
    await withDb(async (db) => {
      const cfg = defaultConfig()
      const world = loadFixture().worlds[0]
      const bad = await ingestWorld({ world, db, cfg, mode: 'llm', llm: { chat: async () => 'not json' } })
      assert.equal(bad.stats.parseFailed, 2)
      const down = await ingestWorld({ world, db, cfg, mode: 'llm', llm: { chat: async () => { throw new Error('boom') } } })
      assert.equal(down.stats.extractFailed, 2)
      await assert.rejects(
        ingestWorld({ world, db, cfg, mode: 'llm', llm: { chat: async () => { throw new LlmFatalError('401') } } }),
        LlmFatalError,
      )
    })
  })

  it('拒答题的注入单独统计', async () => {
    await withDb(async (db) => {
      const cfg = defaultConfig()
      const world = loadFixture().worlds[3]
      const { provenance } = await ingestWorld({ world, db, cfg, mode: 'raw' })
      const rows = await probeWorld({ world, db, cfg, provenance, profiles: { wide: buildProfile('wide', cfg) } })
      assert.equal(rows[0].injection.wide.stage, null)
      assert.equal(summarizeInjection(rows, 'wide').n, 0)
    })
  })
})

describe('档位', () => {
  it('不改动基础配置', () => {
    const cfg = defaultConfig()
    const wide = buildProfile('wide', cfg)
    assert.equal(wide.recall.gate.enabled, false)
    assert.equal(wide.inject.maxHitsPerTurn, 5)
    assert.equal(cfg.recall.gate.enabled, true)
    assert.equal(cfg.inject.maxHitsPerTurn, 2)
  })

  it('未知档位报错', () => {
    assert.throws(() => buildProfile('turbo', defaultConfig()), /未知档位/)
    assert.throws(() => buildProfile('wide-h3', defaultConfig()), /未知档位/)
  })

  it('h 和 b 只改条数和预算，其余沿用基础档位', () => {
    const cfg = defaultConfig()
    const tuned = buildProfile('vector-h3-b700', cfg)
    assert.equal(tuned.inject.maxHitsPerTurn, 3)
    assert.equal(tuned.inject.hitBudget, 700)
    assert.equal(tuned.inject.maxHitChars, cfg.inject.maxHitChars)
    assert.equal(tuned.recall.vector.enabled, true)
    assert.equal(tuned.recall.gate.enabled, true)
    const keywordOnly = buildProfile('default-h3', cfg)
    assert.equal(keywordOnly.recall.vector.enabled, false)
    assert.equal(keywordOnly.inject.hitBudget, cfg.inject.hitBudget)
  })

  it('带条数的向量档位也算需要向量服务', () => {
    assert.equal(needsVectors(['default', 'vector-h3']), true)
    assert.equal(needsVectors(['default-h3']), false)
  })
})

describe('LLM 客户端', () => {
  const ok = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) })
  const options = { baseUrl: 'http://x', apiKey: 'test', model: 'm', retryDelayMs: 1 }

  it('相同请求只调一次，缓存落盘后新实例也能命中', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-llm-'))
    const cachePath = join(dir, 'c', 'llm.jsonl')
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return ok('hi')
    }
    const first = createLlm({ ...options, cachePath, fetchImpl })
    assert.equal(await first.chat([{ role: 'user', content: 'q' }]), 'hi')
    assert.equal(await first.chat([{ role: 'user', content: 'q' }]), 'hi')
    const second = createLlm({ ...options, cachePath, fetchImpl })
    assert.equal(await second.chat([{ role: 'user', content: 'q' }]), 'hi')
    assert.equal(calls, 1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('429 重试，401 立刻停', async () => {
    let calls = 0
    const flaky = createLlm({
      ...options,
      fetchImpl: async () => {
        calls += 1
        return calls < 3 ? { ok: false, status: 429 } : ok('done')
      },
    })
    assert.equal(await flaky.chat([{ role: 'user', content: 'q' }]), 'done')
    assert.equal(calls, 3)

    calls = 0
    const denied = createLlm({
      ...options,
      fetchImpl: async () => {
        calls += 1
        return { ok: false, status: 401 }
      },
    })
    await assert.rejects(denied.chat([{ role: 'user', content: 'q' }]), LlmFatalError)
    assert.equal(calls, 1)
  })

  it('空回复不进缓存', async () => {
    let calls = 0
    const llm = createLlm({
      ...options,
      fetchImpl: async () => {
        calls += 1
        return ok('')
      },
    })
    await llm.chat([{ role: 'user', content: 'q' }])
    await llm.chat([{ role: 'user', content: 'q' }])
    assert.equal(calls, 2)
  })
})

describe('成本估算', () => {
  it('提取按去重后的会话算', () => {
    const session = { date: 'd', messages: [{ role: 'user', text: 'x' }] }
    const worlds = [
      { sessions: [session], probes: [{}] },
      { sessions: [session], probes: [{}] },
    ]
    const plan = estimateCalls(worlds, { ingest: 'llm', e2e: true, conditions: 2 })
    assert.equal(plan.extraction, 1)
    assert.equal(plan.qa, 8)
    assert.equal(plan.total, 9)
  })
})

/** 假的 OpenAI 兼容服务：够 CLI 走完提取、作答、判分全链路。 */
function startMockLlm() {
  const seen = { auth: new Set(), count: 0 }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      seen.count += 1
      seen.auth.add(request.headers.authorization)
      const messages = JSON.parse(body).messages
      const prompt = messages.map((message) => message.content).join('\n')
      let content
      if (messages[0].role === 'system') {
        const line = prompt.split('\n').find((text) => text.startsWith('USER:')) ?? 'USER: nothing'
        const words = 'alpha bravo charlie delta echo foxtrot golf hotel'.split(' ')
        const keywords = [...line.toLowerCase().match(/[a-z]{4,}/g), ...words].slice(0, 13)
        content = JSON.stringify([{ level: 'topic', content: line.slice(6, 200), keywords: [...new Set(keywords)] }])
      } else if (prompt.startsWith('Current date')) content = prompt.includes('Memories') ? 'Breville' : "I don't know"
      else content = prompt.includes('Model Response: Breville') ? 'yes' : 'no'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })))
}

/** 假的向量服务：词袋哈希成定长向量，共享词越多余弦越高。 */
function startMockEmbed() {
  const embed = (text) => {
    const vec = new Array(64).fill(0)
    for (const word of String(text).toLowerCase().match(/[a-z]{3,}/g) ?? []) {
      let hash = 0
      for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) % 64
      vec[hash] += 1
    }
    return vec
  }
  const seen = { count: 0 }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      seen.count += 1
      const data = JSON.parse(body).input.map((text) => ({ embedding: embed(text) }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })))
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, BENCH_API_KEY: '', DEEPSEEK_API_KEY: '', ...env },
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('close', (code) => resolve({ code, output }))
  })
}

describe('CLI', () => {
  const resultOf = (dir) => JSON.parse(readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith('.json'))), 'utf8'))

  it('raw 全流程免 API，结果落到 --out', async () => {
    const out = mkdtempSync(join(tmpdir(), 'bench-cli-'))
    const { code, output } = await runCli(['--data', FIXTURE, '--out', out])
    assert.equal(code, 0, output)
    const result = resultOf(out)
    assert.equal(result.rows.length, 4)
    assert.equal(result.retrieval.n, 3)
    assert.equal(result.meta.llmCalls, 0)
    assert.deepEqual(Object.keys(result.injection), ['default', 'no-gate', 'wide'])
    rmSync(out, { recursive: true, force: true })
  })

  it('--dry-run 不写结果也不要 key', async () => {
    const out = mkdtempSync(join(tmpdir(), 'bench-cli-'))
    const { code, output } = await runCli(['--data', FIXTURE, '--ingest', 'llm', '--e2e', '--dry-run', '--out', out])
    assert.equal(code, 0, output)
    assert.match(output, /预计 LLM 调用最多 40 次/)
    assert.equal(readdirSync(out).length, 0)
    rmSync(out, { recursive: true, force: true })
  })

  it('缺 key 时在跑之前失败', async () => {
    const { code, output } = await runCli(['--data', FIXTURE, '--e2e'])
    assert.equal(code, 1)
    assert.match(output, /BENCH_API_KEY/)
  })

  it('未知参数报错', async () => {
    const { code, output } = await runCli(['--data', FIXTURE, '--nope'])
    assert.equal(code, 1)
    assert.match(output, /未知参数/)
  })

  it('vector 档位：条目补完向量后查询能走语义路径', async () => {
    const { server, seen, port } = await startMockEmbed()
    const out = mkdtempSync(join(tmpdir(), 'bench-cli-'))
    try {
      const { code, output } = await runCli(['--data', FIXTURE, '--profiles', 'vector-wide', '--out', out, '--vector-url', `http://127.0.0.1:${port}`])
      assert.equal(code, 0, output)
      const result = resultOf(out)
      assert.equal(result.injection['vector-wide'].embedFailed, 0)
      assert.ok(seen.count > 4)
      assert.ok(result.injection['vector-wide'].evidenceAny > 0)
    } finally {
      server.close()
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('向量服务连不上时在跑之前失败', async () => {
    const { code, output } = await runCli(['--data', FIXTURE, '--profiles', 'vector', '--vector-url', 'http://127.0.0.1:9'])
    assert.equal(code, 1)
    assert.match(output, /连不上向量服务/)
  })

  it('llm + e2e 全链路：带记忆的条件比无记忆高，缓存让重跑零调用', async () => {
    const { server, seen, port } = await startMockLlm()
    const out = mkdtempSync(join(tmpdir(), 'bench-cli-'))
    const args = ['--data', FIXTURE, '--ingest', 'llm', '--e2e', '--profiles', 'wide', '--out', out, '--base-url', `http://127.0.0.1:${port}`]
    try {
      const first = await runCli(args, { BENCH_API_KEY: 'test-key' })
      assert.equal(first.code, 0, first.output)
      const result = resultOf(out)
      assert.deepEqual([...seen.auth], ['Bearer test-key'])
      assert.equal(result.e2e.none.overall, 0)
      assert.ok(result.e2e.wide.overall > 0)
      assert.ok(existsSync(join(out, '.cache', 'llm.jsonl')))
      assert.ok(result.ingest.inserted > 0)

      const before = seen.count
      const second = await runCli(args, { BENCH_API_KEY: 'test-key' })
      assert.equal(second.code, 0, second.output)
      assert.equal(seen.count, before)
    } finally {
      server.close()
      rmSync(out, { recursive: true, force: true })
    }
  })
})
