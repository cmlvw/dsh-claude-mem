#!/usr/bin/env node
/**
 * dsh-claude-mem · 注入预览（M2 证据来源）
 *
 * 在真实库上算一遍首轮核心块（可选再算一次命中块），只读、不写库、不注入。
 *
 * 用法：
 *   node tools/inject-preview.mjs --workspace "C:\Users\User\.dsh\profiles\desktop"
 *   node tools/inject-preview.mjs --workspace ... --text "上次说的备份要求是什么"
 *   node tools/inject-preview.mjs --workspace ... --json
 */
import { isAbsolute, resolve } from 'node:path'

import { resolveConfig } from '../src/config.js'
import { openMemoryDb } from '../src/db.js'
import { collectCore, estimateTokens, renderHitBlock } from '../src/inject.js'
import { assembleHits, buildGateTerms, detectProject, matchGateTerms, recall, shouldRecall } from '../src/recall.js'
import { listProjects } from '../src/store.js'

function parseArgs(argv) {
  const args = { json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--workspace') args.workspace = argv[++i]
    else if (arg === '--project') args.project = argv[++i]
    else if (arg === '--text') args.text = argv[++i]
    else if (arg === '--json') args.json = true
    else throw new Error(`未知参数：${arg}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const workspace = args.workspace ?? process.env.DSH_PROFILE_DIR ?? process.cwd()
const resolved = resolveConfig({})

const global = openMemoryDb(resolved.globalDbPath, { enableFts: resolved.config.db.enableFts })
if (!global.ok) {
  console.error(`全局库打不开：${global.error}`)
  process.exit(1)
}
const workspaceDb = openMemoryDb(resolved.workspaceDbPath(workspace), { enableFts: resolved.config.db.enableFts })
if (!workspaceDb.ok) {
  console.error(`工作区库打不开：${workspaceDb.error}`)
  global.db.close()
  process.exit(1)
}

try {
  const now = Date.now()
  const projects = listProjects(workspaceDb.db, { limit: 20 }).map((row) => row.project)
  const detected = args.project ?? detectProject(args.text ?? '', projects) ?? null
  const project = detected ?? projects[0] ?? null
  const core = collectCore({
    globalDb: global.db,
    workspaceDb: workspaceDb.db,
    cfg: resolved.config,
    project,
    projectDetected: detected !== null,
    now,
  })

  const report = {
    workspace,
    globalDb: resolved.globalDbPath,
    project,
    projects,
    core: { chars: core.chars, tokens: estimateTokens(core.chars), entries: core.ids.length, dropped: core.dropped, budget: resolved.config.inject.firstTurnBudget },
  }

  if (typeof args.text === 'string' && args.text !== '') {
    const gateTerms = buildGateTerms(global.db, workspaceDb.db)
    const matchedTerms = matchGateTerms(args.text, gateTerms)
    const gate = shouldRecall(args.text, {
      enabled: resolved.config.recall.gate.enabled,
      minChars: resolved.config.recall.gate.minChars,
      maxHitsPerSession: resolved.config.recall.gate.maxHitsPerSession,
      injectedCount: 0,
      projectNames: projects,
      matchedTerms,
    })
    const hits = gate ? recall({ globalDb: global.db, workspaceDb: workspaceDb.db, text: args.text, topK: resolved.config.recall.topK, now, extraTerms: matchedTerms }) : []
    const assembled = assembleHits(hits, {
      maxHits: resolved.config.inject.maxHitsPerTurn,
      maxCharsPerHit: resolved.config.inject.maxHitChars,
      budget: resolved.config.inject.hitBudget,
      now,
    })
    const block = renderHitBlock(assembled.picked, { now })
    const scoreById = new Map(hits.map((hit) => [hit.entry.id, hit.score]))
    report.recall = {
      gate,
      matchedTerms,
      candidates: hits.length,
      picked: assembled.picked.map((item) => ({
        id: item.entry.id,
        title: item.entry.title,
        score: Number((scoreById.get(item.entry.id) ?? 0).toFixed(3)),
      })),
      block,
      chars: block.length,
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(core.text)
    console.log('')
    console.log(`--- 核心块 ${report.core.chars} 字（≈${report.core.tokens} tokens）· ${report.core.entries} 条 · 丢 ${report.core.dropped} 行 · 预算 ${report.core.budget}`)
    if (report.recall) {
      console.log(`--- 召回 gate=${report.recall.gate} 候选=${report.recall.candidates} 选中=${report.recall.picked.length} 字数=${report.recall.chars}`)
      if (report.recall.block) console.log(report.recall.block)
      else console.log('（无命中，不注入）')
    }
  }
} finally {
  try {
    global.db.close()
  } catch {}
  try {
    workspaceDb.db.close()
  } catch {}
}
