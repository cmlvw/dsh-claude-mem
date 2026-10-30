#!/usr/bin/env node
/**
 * dsh-claude-mem · M3 召回评测（证据来源）
 *
 * 在**真实库**上跑 12 条来自我们记忆库场景的 query + 4 条负样本，
 * 输出「命中 / 误报 / 零注入」表。只读，不写库、不注入、不联网。
 *
 * 用法：
 *   node tools/recall-eval.mjs
 *   node tools/recall-eval.mjs --workspace "C:\Users\User\.dsh\profiles\desktop"
 *   node tools/recall-eval.mjs --verbose   # 打印每条 query 的候选和注入内容
 *   node tools/recall-eval.mjs --json
 *
 * 判定口径：
 * - 命中：期望命中的 query，注入里至少有一条相关条目（相关 = 标题/正文/关键词含任一 ground-truth 子串）。
 * - 误报：注入的条目里不含任何 ground-truth 子串的那些条数。
 * - 零注入：最终没有注入任何条目；对 expectZero 的 query 这是通过，对 expectHit 的是漏召回。
 */
import { resolveConfig } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import { estimateTokens, renderHitBlock } from '../src/inject.js'
import { assembleHits, buildGateTerms, matchGateTerms, recall, shouldRecall } from '../src/recall.js'
import { listProjects } from '../src/store.js'

function parseArgs(argv) {
  const args = { verbose: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') args.workspace = argv[++i]
    else if (argv[i] === '--verbose') args.verbose = true
    else if (argv[i] === '--no-gate') args.noGate = true
    else if (argv[i] === '--sweep') args.sweep = true
    else if (argv[i] === '--json') args.json = true
    else throw new Error(`未知参数：${argv[i]}`)
  }
  return args
}

/**
 * ground truth：前 12 条来自真实使用场景（我们的记忆库、项目文档、踩坑史），
 * 后 4 条是负样本——3 条门控就过不了，1 条门控过但库里确实没有对应记忆（验证零注入路径）。
 * `relevant` 用子串而不是 id：迁移/合并后 id 会变，子串仍能核对。
 */
const CASES = [
  { text: '精排默认开还是关', expect: 'hit', relevant: ['精排'], note: '方案拍板 §13-B' },
  { text: '记忆插件两层库怎么分的', expect: 'hit', relevant: ['两层库', '工作区库'], note: '§4.1 数据分层' },
  { text: '全局库放哪个盘', expect: 'hit', relevant: ['D 盘', 'global.db'], note: '§13 全局库位置' },
  { text: '召回三阶段是什么', expect: 'hit', relevant: ['三阶段', '规则门'], note: '§6 召回策略' },
  { text: 'DSH 启动失败怎么办', expect: 'hit', relevant: ['启动失败'], note: '踩坑 lesson' },
  { text: '周报数字能不能估算', expect: 'hit', relevant: ['不许估', '只能来自源表'], note: '用户红线' },
  { text: '本地模型 100K 上下文 KV 用哪个', expect: 'hit', relevant: ['q4_0', '100K'], note: 'qwen38 实测' },
  { text: '重启模板 STEP 6 验证', expect: 'hit', relevant: ['STEP 6', 'relaunch'], note: 'dsh-restart' },
  { text: '远程访问 18080 怎么配', expect: 'hit', relevant: ['18080', 'phone-bridge'], note: '远程访问' },
  { text: '密钥拦截正则漏了什么', expect: 'hit', relevant: ['sk-proj', '密钥正则'], note: 'M4 写入纪律前史' },
  { text: 'meow-memory 和我们的插件是什么关系', expect: 'hit', relevant: ['取代 meow-memory', '取代'], note: '方案目标' },
  { text: '旧卡为什么归档重新发卡', expect: 'hit', relevant: ['旧卡', '归档', '作废'], note: '迭代习惯（用户层在核心块）' },
  { text: '今天天气怎么样', expect: 'zero', relevant: [], note: '负样本：门控应拒' },
  { text: '帮我跑一下测试', expect: 'zero', relevant: [], note: '负样本：门控应拒' },
  { text: '那个事你记得吗', expect: 'zero', relevant: [], note: '负样本：门控应拒' },
  { text: '为什么量子纠缠会超光速', expect: 'zero', relevant: [], note: '负样本：门控过（为什么）、库里无对应记忆 → 零注入' },
]

function isRelevant(entry, relevant) {
  if (relevant.length === 0) return false
  const haystack = `${entry.title ?? ''}\n${entry.body ?? ''}\n${(entry.keywords ?? []).join(' ')}`
  return relevant.some((needle) => haystack.includes(needle))
}

const args = parseArgs(process.argv.slice(2))
const workspace = args.workspace ?? 'C:\\Users\\User\\.dsh\\profiles\\desktop'
const resolved = resolveConfig({})
const globalDb = openMemoryDb(resolved.globalDbPath, { enableFts: resolved.config.db.enableFts })
const workspaceDb = openMemoryDb(resolved.workspaceDbPath(workspace), { enableFts: resolved.config.db.enableFts })
if (!globalDb.ok) {
  console.error(`全局库打不开：${globalDb.error}`)
  process.exit(1)
}
if (!workspaceDb.ok) {
  console.error(`工作区库打不开：${workspaceDb.error}`)
  globalDb.db.close()
  process.exit(1)
}

try {
  const now = Date.now()
  const projectNames = listProjects(workspaceDb.db, { limit: 20 }).map((row) => row.project)
  const gateTerms = buildGateTerms(globalDb.db, workspaceDb.db)
  const rows = []
  let hitCases = 0
  let hitOk = 0
  let zeroCases = 0
  let zeroOk = 0
  let pickedTotal = 0
  let falsePositives = 0

  for (const testCase of CASES) {
    const matchedTerms = matchGateTerms(testCase.text, gateTerms)
    const gate = args.noGate
      ? true
      : shouldRecall(testCase.text, {
      enabled: resolved.config.recall.gate.enabled,
      minChars: resolved.config.recall.gate.minChars,
      maxHitsPerSession: resolved.config.recall.gate.maxHitsPerSession,
      injectedCount: 0,
      projectNames,
      matchedTerms,
    })
    const candidates = gate
      ? recall({
          globalDb: globalDb.db,
          workspaceDb: workspaceDb.db,
          text: testCase.text,
          topK: resolved.config.recall.topK,
          now,
          extraTerms: matchedTerms,
        })
      : []
    const assembled = assembleHits(candidates, {
      maxHits: resolved.config.inject.maxHitsPerTurn,
      maxCharsPerHit: resolved.config.inject.maxHitChars,
      budget: resolved.config.inject.hitBudget,
      now,
    })
    const picked = assembled.picked
    const scoreById = new Map(candidates.map((hit) => [hit.entry.id, hit.score]))
    const relevantFlags = picked.map((item) => isRelevant(item.entry, testCase.relevant))
    const relevantCount = relevantFlags.filter(Boolean).length
    const irrelevantCount = picked.length - relevantCount
    const zero = picked.length === 0

    let verdict
    if (testCase.expect === 'hit') {
      hitCases += 1
      if (relevantCount > 0) {
        hitOk += 1
        verdict = '命中'
      } else if (zero) {
        verdict = gate ? '漏召回（零注入）' : '漏召回（门控拒）'
      } else {
        verdict = '漏召回 + 误报'
      }
    } else {
      zeroCases += 1
      if (zero) {
        zeroOk += 1
        verdict = gate ? '零注入（过门控无命中）' : '零注入（门控拒）'
      } else {
        verdict = '误报（应零注入）'
      }
    }
    pickedTotal += picked.length
    falsePositives += irrelevantCount

    rows.push({
      query: testCase.text,
      expect: testCase.expect,
      gate,
      candidates: candidates.length,
      picked: picked.length,
      hit: relevantCount,
      falsePositives: irrelevantCount,
      zero,
      verdict,
      note: testCase.note,
      matchedTerms,
      relevant: testCase.relevant,
      candidatesAll: candidates.map((hit) => ({
        entry: hit.entry,
        score: Number(hit.score.toFixed(3)),
        relevant: isRelevant(hit.entry, testCase.relevant),
      })),
      pickedEntries: picked.map((item) => ({
        id: item.entry.id,
        title: item.entry.title,
        score: Number((scoreById.get(item.entry.id) ?? 0).toFixed(3)),
        relevant: isRelevant(item.entry, testCase.relevant),
      })),
      block: zero ? '' : renderHitBlock(picked, { now }),
      blockChars: zero ? 0 : Array.from(renderHitBlock(picked, { now })).length,
    })
  }

  const summary = {
    workspace,
    globalDb: resolved.globalDbPath,
    cases: CASES.length,
    hitCases,
    hitOk,
    zeroCases,
    zeroOk,
    pickedTotal,
    falsePositives,
    precision: pickedTotal === 0 ? null : Number(((pickedTotal - falsePositives) / pickedTotal).toFixed(3)),
    rerank: resolved.config.recall.rerank.enabled ? 'on' : 'off',
    topK: resolved.config.recall.topK,
  }

  if (args.json) {
    console.log(JSON.stringify({ summary, rows }, null, 2))
  } else {
    console.log(`工作区：${workspace}`)
    console.log(`全局库：${resolved.globalDbPath}｜精排：${summary.rerank}｜TopK：${summary.topK}｜门控词：${gateTerms.size}`)
    const header = ['query', 'gate', '候选', '注入', '命中', '误报', '零注入', '判定']
    const widths = [34, 5, 4, 4, 4, 4, 6, 0]
    const pad = (text, width) => {
      const chars = Array.from(String(text))
      const clipped = chars.length <= width ? chars.join('') : `${chars.slice(0, width - 1).join('')}…`
      return clipped + ' '.repeat(Math.max(0, width - Array.from(clipped).length))
    }
    console.log(header.map((name, index) => (widths[index] > 0 ? pad(name, widths[index]) : name)).join(' │ '))
    console.log('─'.repeat(86))
    for (const row of rows) {
      console.log(
        [
          pad(row.query, widths[0]),
          pad(row.gate ? 'Y' : 'n', widths[1]),
          pad(row.candidates, widths[2]),
          pad(row.picked, widths[3]),
          pad(row.hit, widths[4]),
          pad(row.falsePositives, widths[5]),
          pad(row.zero ? 'Y' : 'n', widths[6]),
          row.verdict,
        ].join(' │ '),
      )
    }
    console.log('─'.repeat(86))
    console.log(
      `命中 ${summary.hitOk}/${summary.hitCases}｜零注入正确 ${summary.zeroOk}/${summary.zeroCases}｜注入 ${summary.pickedTotal} 条，误报 ${summary.falsePositives} 条，精确率 ${summary.precision === null ? 'n/a' : `${(summary.precision * 100).toFixed(1)}%`}`,
    )
    if (args.sweep) {
      console.log('\n相对分数阈值扫描（只保留候选分数 ≥ 最高分 × 阈值；0 = 不筛）')
      console.log('阈值 │ 命中   │ 零注入正确 │ 注入   │ 误报   │ 精确率')
      console.log('─────┼────────┼────────────┼────────┼────────┼────────')
      for (const ratio of [0, 0.3, 0.5, 0.6, 0.7, 0.8]) {
        let hitOk2 = 0
        let hitN2 = 0
        let zeroOk2 = 0
        let zeroN2 = 0
        let picked2 = 0
        let fp2 = 0
        for (const row of rows) {
          const top = row.candidatesAll[0]?.score ?? 0
          const kept = top === 0 ? [] : row.candidatesAll.filter((item) => item.score >= top * ratio)
          const assembled2 = assembleHits(
            kept.map((item) => ({ entry: item.entry, score: item.score })),
            {
              maxHits: resolved.config.inject.maxHitsPerTurn,
              maxCharsPerHit: resolved.config.inject.maxHitChars,
              budget: resolved.config.inject.hitBudget,
              now,
            },
          )
          const relevantCount2 = assembled2.picked.filter((item) => isRelevant(item.entry, row.relevant)).length
          const pickedCount2 = assembled2.picked.length
          picked2 += pickedCount2
          fp2 += pickedCount2 - relevantCount2
          if (row.expect === 'hit') {
            hitN2 += 1
            if (relevantCount2 > 0) hitOk2 += 1
          } else {
            zeroN2 += 1
            if (pickedCount2 === 0) zeroOk2 += 1
          }
        }
        const precision2 = picked2 === 0 ? null : ((picked2 - fp2) / picked2) * 100
        console.log(
          `${ratio.toFixed(1)}  │ ${hitOk2}/${hitN2}  │ ${zeroOk2}/${zeroN2}      │ ${picked2}     │ ${fp2}     │ ${precision2 === null ? 'n/a' : `${precision2.toFixed(1)}%`}`,
        )
      }
    }

    if (args.verbose) {      for (const row of rows) {
        console.log(`\n### ${row.query}（${row.verdict}）`)
        console.log(`候选 ${row.candidates}｜注入 ${row.picked}｜块 ${row.blockChars} 字（≈${estimateTokens(row.blockChars)} tokens）｜门控词 ${row.matchedTerms.join(',') || '（无）'}`)
        for (const item of row.pickedEntries) {
          console.log(`  ${item.relevant ? '✓' : '✗'} ${item.id} ${item.title}（score=${item.score}）`)
        }
        if (row.block !== '') console.log(row.block)
      }
    }
  }
} finally {
  try {
    globalDb.db.close()
  } catch {}
  try {
    workspaceDb.db.close()
  } catch {}
}
