#!/usr/bin/env node
/**
 * dsh-claude-mem · 记忆基准评测
 *
 * 把公开数据集灌进临时库，走真实的写入校验、召回流水线和注入渲染，分三层出分：
 *   检索层：关掉门控直接查，Recall@k（证据会话有没有被找到）
 *   注入层：按各档位配置跑 runRecall，证据有没有进上下文、卡在哪一步
 *   端到端（--e2e）：带记忆/不带记忆作答，用 LongMemEval 官方模板判分
 *
 * 只碰系统临时目录里的库，不打开、不写入真实记忆库。说明见 tools/bench/README.md。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultConfig } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import { embedQuery, embedTexts } from '../src/embed.js'
import { entryEmbedText, textHash, upsertVector } from '../src/vector.js'
import { getEntry } from '../src/store.js'
import {
  LlmFatalError,
  RECALL_KS,
  answerAndJudge,
  buildProfile,
  createLlm,
  estimateCalls,
  ingestWorld,
  mapLimit,
  needsVectors,
  normalizeDataset,
  probeWorld,
  sampleProbes,
  summarizeAbstention,
  summarizeAnswers,
  summarizeE2e,
  summarizeInjection,
  summarizeRetrieval,
  validateWorlds,
} from './bench/lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const USAGE = `用法：node tools/bench-memory.mjs --data <数据集.json> [选项]

  --data <path>          LongMemEval（s_cleaned.json）或 harness-sessions（standard.json），自动识别
  --ingest raw|gold|llm  raw：按句切块直写，免 API（默认）；gold：写入数据集标注的理想记忆，免 API；
                         llm：模型模拟 mem_remember 写入
  --profiles <a,b>       default,no-gate,wide（默认），另有 vector,vector-wide（需本地向量服务）；
                         vector-h3-b700 这样的写法指定每轮条数和字数预算
  --e2e                  加跑端到端问答（需 API key）
  --n <num>              分层抽样题数，0 = 全量（默认 0）
  --seed <num>           抽样种子（默认 20261）
  --dry-run              只打印规模和预计 LLM 调用次数，不执行
  --out <dir>            结果目录（默认 bench-results）
  --model <name>         作答与提取模型（默认 deepseek-chat，或环境变量 BENCH_MODEL）
  --judge-model <name>   判分模型（默认同 --model）
  --base-url <url>       OpenAI 兼容地址（默认 https://api.deepseek.com）
  --vector-url <url>     向量服务地址（默认用插件配置的 127.0.0.1:8083）
  --concurrency <num>    LLM 并发（默认 4）
  --max-per-session <n>  每个会话最多写几条（默认 8）

API key 只从环境变量读：BENCH_API_KEY 或 DEEPSEEK_API_KEY。`

function parseArgs(argv) {
  const args = {
    ingest: 'raw',
    profiles: ['default', 'no-gate', 'wide'],
    e2e: false,
    n: 0,
    seed: 20261,
    dryRun: false,
    out: join(ROOT, 'bench-results'),
    model: process.env.BENCH_MODEL ?? 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    concurrency: 4,
    maxPerSession: 8,
  }
  const value = (index, flag) => {
    const next = argv[index + 1]
    if (next === undefined) throw new Error(`${flag} 缺少参数`)
    return next
  }
  const number = (index, flag) => {
    const parsed = Number(value(index, flag))
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} 需要非负整数`)
    return parsed
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') args.help = true
    else if (flag === '--e2e') args.e2e = true
    else if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--data') args.data = value(i++, flag)
    else if (flag === '--ingest') args.ingest = value(i++, flag)
    else if (flag === '--profiles') args.profiles = value(i++, flag).split(',').map((name) => name.trim()).filter(Boolean)
    else if (flag === '--n') args.n = number(i++, flag)
    else if (flag === '--seed') args.seed = number(i++, flag)
    else if (flag === '--out') args.out = resolve(value(i++, flag))
    else if (flag === '--model') args.model = value(i++, flag)
    else if (flag === '--judge-model') args.judgeModel = value(i++, flag)
    else if (flag === '--base-url') args.baseUrl = value(i++, flag)
    else if (flag === '--vector-url') args.vectorUrl = value(i++, flag)
    else if (flag === '--concurrency') args.concurrency = Math.max(1, number(i++, flag))
    else if (flag === '--max-per-session') args.maxPerSession = Math.max(1, number(i++, flag))
    else throw new Error(`未知参数：${flag}`)
  }
  if (!['raw', 'gold', 'llm'].includes(args.ingest)) throw new Error('--ingest 只能是 raw、gold 或 llm')
  return args
}

const pct = (value) => (value === null || value === undefined ? '  n/a' : `${(value * 100).toFixed(1).padStart(5)}%`)

/** 批量补向量。线上是写入后异步补，这里要等全部补完才能开始测。 */
async function embedAll(db, ids, vectorCfg) {
  const entries = ids.map((id) => getEntry(db, id)).filter((entry) => entry !== null)
  for (let start = 0; start < entries.length; start += 16) {
    const batch = entries.slice(start, start + 16)
    const texts = batch.map(entryEmbedText)
    const vectors = await embedTexts(texts, { url: vectorCfg.url, model: vectorCfg.model, timeoutMs: 60000 })
    if (vectors === null || vectors.length !== batch.length) throw new Error(`向量服务失败（${vectorCfg.url}）`)
    batch.forEach((entry, index) => {
      upsertVector(db, entry.id, vectors[index], { model: vectorCfg.model, textHash: textHash(texts[index]) })
    })
  }
}

/** 答案级结果：答案本身进没进上下文，比「命中证据会话」严格。 */
function printAnswers(report, line) {
  const { answers, abstention } = report
  const names = Object.keys(answers.profiles)
  line()
  line(`答案级（${answers.n} 题，答案串出现才算到手）`)
  line(`  检索 k   ${RECALL_KS.map((k) => String(k).padStart(6)).join(' ')}`)
  line(`  插件     ${RECALL_KS.map((k) => pct(answers.recallAtK[k])).join(' ')}`)
  line(`  BM25基线 ${RECALL_KS.map((k) => pct(answers.baselineAtK[k])).join(' ')}`)
  line()
  line('  档位          答案进上下文  只读到旧值 | 已注入 门控拦 没检索到 过滤/预算 当复述 被截断')
  for (const [name, item] of Object.entries(answers.profiles)) {
    const stage = item.stages
    line(
      `  ${name.padEnd(12)} ${pct(item.hit)}       ${pct(item.staleOnly)}    | ${String(stage.injected).padStart(5)} ${String(stage.gate_closed).padStart(6)} ${String(stage.not_retrieved).padStart(7)} ${String(stage.filtered_or_budget).padStart(8)} ${String(stage.echoed).padStart(6)} ${String(stage.clipped).padStart(6)}`,
    )
  }
  const table = (title, groups) => {
    line()
    line(`  ${title.padEnd(28)}   n  检索@5  ${names.map((name) => name.padStart(8)).join(' ')}`)
    for (const [key, item] of Object.entries(groups)) {
      line(`  ${key.padEnd(28)} ${String(item.n).padStart(3)}  ${pct(item.retrieved)}  ${names.map((name) => `  ${pct(item.injected[name])}`).join(' ')}`)
    }
  }
  table('按题型', answers.byType)
  if (Object.keys(answers.byTag).length > 0) table('按难点', answers.byTag)
  if (Object.keys(abstention).length > 0) {
    line()
    line(`  ${'拒答题注入率'.padEnd(26)}   n          ${names.map((name) => name.padStart(8)).join(' ')}`)
    for (const [key, item] of Object.entries(abstention)) {
      line(`  ${key.padEnd(28)} ${String(item.n).padStart(3)}          ${names.map((name) => `  ${pct(item.injected[name])}`).join(' ')}`)
    }
  }
}

function printReport(report) {
  const { retrieval, injection, e2e, ingest } = report
  const line = (text = '') => console.log(text)
  line()
  line(`写入：新增 ${ingest.inserted}，合并 ${ingest.merged}，拒收 ${Object.values(ingest.rejected).reduce((a, b) => a + b, 0)}，解析失败 ${ingest.parseFailed}，提取失败 ${ingest.extractFailed}`)
  for (const [reason, count] of Object.entries(ingest.rejected)) line(`  拒收 · ${reason}：${count}`)
  line()
  line(`检索层（关门控，${retrieval.n} 题，不含拒答题）`)
  line(`  k        ${RECALL_KS.map((k) => String(k).padStart(6)).join(' ')}`)
  line(`  任一证据 ${RECALL_KS.map((k) => pct(retrieval.any[k])).join(' ')}`)
  line(`  全部证据 ${RECALL_KS.map((k) => pct(retrieval.all[k])).join(' ')}`)
  line(`  MRR      ${retrieval.mrr === null ? 'n/a' : retrieval.mrr.toFixed(3)}`)
  line()
  line('注入层')
  line('  档位          开门率  证据进上下文  全部证据  拒答题注入  平均字数 | 已注入 门控拦 没检索到 过滤/预算')
  for (const [name, item] of Object.entries(injection)) {
    const stage = item.stages
    line(
      `  ${name.padEnd(12)} ${pct(item.gateOpen)}  ${pct(item.evidenceAny)}       ${pct(item.evidenceAll)}    ${pct(item.abstainInjected)}    ${String(Math.round(item.avgChars ?? 0)).padStart(5)}  | ${String(stage.injected).padStart(5)} ${String(stage.gate_closed).padStart(6)} ${String(stage.not_retrieved).padStart(7)} ${String(stage.filtered_or_budget).padStart(8)}`,
    )
    if (item.embedFailed > 0) line(`    警告：${item.embedFailed} 题向量查询失败，这些题退回了纯关键词`)
  }
  if (report.answers !== null) printAnswers(report, line)
  if (e2e !== null) {
    line()
    line('端到端')
    line('  条件          题型平均  总体    拒答    相对无记忆  未判出')
    const base = e2e.none?.taskAveraged ?? null
    for (const [name, item] of Object.entries(e2e)) {
      const lift = item.taskAveraged === null || base === null ? '   n/a' : `${((item.taskAveraged - base) * 100).toFixed(1).padStart(5)}pt`
      line(`  ${name.padEnd(12)} ${pct(item.taskAveraged)}  ${pct(item.overall)} ${pct(item.abstention)}  ${lift}      ${item.unjudged}`)
    }
  }
  line()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.data === undefined) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }

  const buffer = readFileSync(args.data)
  const dataHash = createHash('sha256').update(buffer).digest('hex').slice(0, 16)
  const { format, worlds: allWorlds } = normalizeDataset(JSON.parse(buffer.toString('utf8')))
  const issues = validateWorlds(allWorlds)
  if (issues.length > 0) throw new Error(`数据集校验失败：\n  ${issues.slice(0, 10).join('\n  ')}`)
  const worlds = sampleProbes(allWorlds, args.n, args.seed)

  const base = defaultConfig()
  if (args.vectorUrl !== undefined) base.recall.vector.url = args.vectorUrl
  const profiles = Object.fromEntries(args.profiles.map((name) => [name, buildProfile(name, base)]))
  const conditions = args.e2e ? args.profiles.length + 1 : 0
  const plan = estimateCalls(worlds, { ingest: args.ingest, e2e: args.e2e, conditions })
  console.log(`[bench] ${format} · ${plan.worlds} 个世界 · ${plan.probes} 题 · ${plan.uniqueSessions} 个不同会话`)
  console.log(`[bench] 写入 ${args.ingest} · 档位 ${args.profiles.join(', ')}${args.e2e ? ' · 端到端' : ''}`)
  console.log(`[bench] 预计 LLM 调用最多 ${plan.total} 次（提取 ${plan.extraction} + 问答判分 ${plan.qa}）`)
  if (args.dryRun) return

  let llm = null
  const judgeModel = args.judgeModel ?? args.model
  if (plan.total > 0) {
    const apiKey = process.env.BENCH_API_KEY ?? process.env.DEEPSEEK_API_KEY
    if (!apiKey) throw new Error('--ingest llm 和 --e2e 需要环境变量 BENCH_API_KEY 或 DEEPSEEK_API_KEY')
    llm = createLlm({ baseUrl: args.baseUrl, apiKey, model: args.model, cachePath: join(args.out, '.cache', 'llm.jsonl') })
  }

  const vectorCfg = base.recall.vector
  if (needsVectors(args.profiles)) {
    const probe = await embedQuery('ping', { url: vectorCfg.url, model: vectorCfg.model, timeoutMs: 5000 })
    if (probe === null) throw new Error(`连不上向量服务 ${vectorCfg.url}：先启动它，或去掉 vector 档位`)
  }

  const rows = []
  const ingestTotal = { inserted: 0, merged: 0, rejected: {}, parseFailed: 0, extractFailed: 0 }
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
  const startedAt = Date.now()
  let ftsMissing = 0
  try {
    for (let index = 0; index < worlds.length; index += 1) {
      const world = worlds[index]
      const opened = openMemoryDb(join(scratch, `world-${index}.db`))
      if (!opened.ok) throw new Error(`临时库打不开：${opened.error}`)
      if (!opened.fts) ftsMissing += 1
      const { db } = opened
      try {
        const { provenance, stats } = await ingestWorld({
          world,
          db,
          cfg: base,
          mode: args.ingest,
          llm,
          concurrency: args.concurrency,
          maxPerSession: args.maxPerSession,
        })
        ingestTotal.inserted += stats.inserted
        ingestTotal.merged += stats.merged
        ingestTotal.parseFailed += stats.parseFailed
        ingestTotal.extractFailed += stats.extractFailed
        for (const [reason, count] of Object.entries(stats.rejected)) ingestTotal.rejected[reason] = (ingestTotal.rejected[reason] ?? 0) + count

        if (needsVectors(args.profiles)) await embedAll(db, [...provenance.keys()], vectorCfg)
        const worldRows = await probeWorld({ world, db, cfg: base, provenance, profiles })

        if (args.e2e) {
          const jobs = worldRows.flatMap((row) => {
            const probe = world.probes.find((item) => item.id === row.id)
            row.e2e = {}
            const blocks = [['none', ''], ...Object.entries(row.injection).map(([name, item]) => [name, item.block])]
            return blocks.map(([condition, block]) => ({ row, probe, condition, block }))
          })
          await mapLimit(jobs, args.concurrency, async ({ row, probe, condition, block }) => {
            row.e2e[condition] = await answerAndJudge({ probe, block, llm, judgeModel })
          })
        }
        rows.push(...worldRows)
        const seconds = Math.round((Date.now() - startedAt) / 1000)
        console.log(`[${index + 1}/${worlds.length}] ${world.id}：${provenance.size} 条记忆，${world.probes.length} 题，累计 ${seconds}s`)
      } finally {
        db.close()
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  const report = {
    meta: {
      date: new Date().toISOString(),
      plugin: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
      dataset: basename(args.data),
      format,
      dataHash,
      ingest: args.ingest,
      profiles: args.profiles,
      n: rows.length,
      seed: args.seed,
      sampled: args.n > 0,
      model: llm === null ? null : args.model,
      judgeModel: args.e2e ? judgeModel : null,
      llmCalls: llm?.stats.calls ?? 0,
      llmCached: llm?.stats.cached ?? 0,
      ftsMissingWorlds: ftsMissing,
      avgEntriesPerWorld: rows.length === 0 ? 0 : Math.round(rows.reduce((sum, row) => sum + row.entries, 0) / rows.length),
    },
    ingest: ingestTotal,
    retrieval: summarizeRetrieval(rows),
    injection: Object.fromEntries(args.profiles.map((name) => [name, summarizeInjection(rows, name)])),
    answers: summarizeAnswers(rows, args.profiles),
    abstention: summarizeAbstention(rows, args.profiles),
    e2e: args.e2e ? Object.fromEntries(['none', ...args.profiles].map((name) => [name, summarizeE2e(rows, name)])) : null,
    rows,
  }
  printReport(report)
  if (ftsMissing > 0) console.log(`警告：${ftsMissing} 个世界没有 FTS，检索退化为 LIKE，分数不代表线上表现`)

  mkdirSync(args.out, { recursive: true })
  const stamp = report.meta.date.replace(/[:.]/g, '-')
  const file = join(args.out, `${basename(args.data).replace(/\.json$/i, '')}-${args.ingest}-${stamp}.json`)
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`结果：${file}`)
}

main().catch((error) => {
  console.error(error instanceof LlmFatalError ? `LLM 调用失败，已停止：${error.message}` : error instanceof Error ? error.message : error)
  process.exit(1)
})
