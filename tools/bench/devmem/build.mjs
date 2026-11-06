#!/usr/bin/env node
/**
 * 生成 devmem 数据集并做质量审计。审计不过就不写文件：
 * 题目出错时分数不会报错，只会悄悄失真，所以这些检查必须先于跑分。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { generateNoise } from './noise.mjs'
import { FACTS, PROBES } from './probes.mjs'
import { SESSIONS } from './sessions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const QUESTION_DATE = '2026-10-30'
export const DEFAULT_NOISE = 240

/** 答案比对和 runner 用同一种归一化：忽略大小写、全半角和空白。 */
export const squash = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')

const sessionText = (session) => session.messages.map((message) => message.text).join('\n')
const hasGroup = (text, group) => group.some((key) => text.includes(squash(key)))
const hasAllKeys = (text, keys) => keys.length > 0 && keys.every((group) => hasGroup(text, group))
const cjkShare = (text) => {
  const chars = Array.from(String(text).replace(/\s+/g, ''))
  return chars.length === 0 ? 0 : chars.filter((ch) => /[\u4e00-\u9fff]/u.test(ch)).length / chars.length
}

/** 问句和证据的共享词：中文二字片段和三字符以上的拉丁词。项目名不算，它说明不了答案在哪。 */
const PROJECT_WORDS = new Set(['tidepool', 'lantern', 'quillmark'])
function lexicalUnits(text) {
  const units = new Set()
  const lower = String(text).normalize('NFKC').toLowerCase()
  for (const [word] of lower.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) if (!PROJECT_WORDS.has(word)) units.add(word)
  for (const [run] of lower.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const chars = Array.from(run)
    for (let i = 0; i + 1 < chars.length; i += 1) units.add(chars[i] + chars[i + 1])
  }
  return units
}

function evidenceIds(probe, facts) {
  return probe.expect.flatMap((name) => {
    const fact = facts.get(name)
    if (fact === undefined) return []
    return fact.label === 'updated' ? [fact.answer_from] : fact.evidence_sessions
  })
}

/** @returns {string[]} 问题清单，空数组表示通过。 */
export function auditDataset(dataset) {
  const issues = []
  const { sessions, gold } = dataset
  const facts = new Map(gold.facts.map((fact) => [fact.name, fact]))
  const texts = new Map(sessions.map((session) => [session.id, squash(sessionText(session))]))

  const seen = new Set()
  for (const id of [...sessions.map((session) => session.id), ...gold.probes.map((probe) => probe.id)]) {
    if (seen.has(id)) issues.push(`编号重复：${id}`)
    seen.add(id)
  }
  for (const fact of gold.facts) {
    for (const id of fact.evidence_sessions) if (!texts.has(id)) issues.push(`事实 ${fact.name} 引用了不存在的会话 ${id}`)
    if (fact.label === 'updated' && !fact.evidence_sessions.includes(fact.answer_from)) {
      issues.push(`事实 ${fact.name} 的 answer_from 不在证据会话里`)
    }
  }

  for (const probe of gold.probes) {
    const tag = (name) => (probe.tags ?? []).includes(name)
    const question = squash(probe.q)
    for (const name of probe.expect) if (!facts.has(name)) issues.push(`${probe.id}：事实 ${name} 不存在`)

    if (probe.expect.length === 0) {
      // 拒答题的答案不能藏在任何地方，否则「不该答」本身就是错的。
      for (const word of probe.absent ?? []) {
        for (const [id, text] of texts) if (text.includes(squash(word))) issues.push(`${probe.id}：拒答词「${word}」出现在 ${id}`)
      }
      continue
    }

    const evidence = new Set(evidenceIds(probe, facts))
    const pool = [...evidence].map((id) => texts.get(id) ?? '').join('\n')
    const memory = squash(probe.expect.map((name) => facts.get(name)?.description ?? '').join('\n'))
    if ((probe.keys ?? []).length === 0) issues.push(`${probe.id}：缺答案串`)
    for (const group of probe.keys ?? []) {
      if (!hasGroup(pool, group)) issues.push(`${probe.id}：答案串 ${group.join('/')} 不在证据会话里`)
      // gold 写入只有事实描述这一份文本，答案串对不上就会变成假的「没检索到」。
      if (!hasGroup(memory, group)) issues.push(`${probe.id}：答案串 ${group.join('/')} 不在事实描述里`)
      if (hasGroup(question, group)) issues.push(`${probe.id}：问句已经包含答案串 ${group.join('/')}`)
    }
    // 单个会话就能凑齐答案却没标成证据，说明这题还有别的正确来源，分数会算错。
    for (const [id, text] of texts) {
      if (!evidence.has(id) && hasAllKeys(text, probe.keys ?? [])) issues.push(`${probe.id}：答案串也出现在非证据会话 ${id}`)
    }
    for (const word of probe.stale ?? []) {
      if (hasGroup(pool, [word]) && probe.kind === 'knowledge-update') issues.push(`${probe.id}：旧值「${word}」出现在最新证据里`)
      if (![...texts.values()].some((text) => text.includes(squash(word)))) issues.push(`${probe.id}：旧值「${word}」在历史里不存在`)
    }

    const messages = sessions
      .filter((session) => evidence.has(session.id))
      .flatMap((session) => session.messages.map((message) => message.text))
    const bearing = messages.filter((text) => (probe.keys ?? []).some((group) => hasGroup(squash(text), group)))
    if (tag('lexical-gap')) {
      const asked = lexicalUnits(probe.q)
      for (const text of [...bearing, ...probe.expect.map((name) => facts.get(name)?.description ?? '')]) {
        const shared = [...lexicalUnits(text)].filter((unit) => asked.has(unit))
        if (shared.length > 0) issues.push(`${probe.id}：标了 lexical-gap，但和证据共享「${shared.join('、')}」`)
      }
    }
    if (tag('cross-lingual')) {
      const sameLanguage = bearing.some((text) => cjkShare(text) >= 0.3 === cjkShare(probe.q) >= 0.3)
      const allSame = bearing.length > 0 && bearing.every((text) => cjkShare(text) >= 0.3 === cjkShare(probe.q) >= 0.3)
      if (allSame || (sameLanguage && probe.kind !== 'multi-session')) issues.push(`${probe.id}：标了 cross-lingual，但证据和问句同语言`)
    }
  }

  const used = new Set(gold.probes.flatMap((probe) => [...probe.expect, ...(probe.expectFacts ?? [])]))
  for (const fact of gold.facts) {
    if (fact.label === 'superseded') {
      if (used.has(fact.name)) issues.push(`事实 ${fact.name} 已过时，不能当答案`)
    } else if (!used.has(fact.name)) {
      issues.push(`事实 ${fact.name} 没有题目引用`)
    }
  }
  return issues
}

/**
 * gold 写入用的「理想记忆」：事实描述（含被推翻的旧版本），加上每个噪声会话一条。
 * 一次性噪声不写，线上模型也不该记它。
 */
function buildMemories(sessions, facts) {
  const fromFacts = facts
    .filter((fact) => fact.label !== 'ephemeral')
    .map((fact) => ({
      session: fact.label === 'updated' ? fact.answer_from : fact.evidence_sessions[0],
      content: fact.description,
    }))
  const fromNoise = sessions
    .filter((session) => session.id.startsWith('n'))
    .map((session) => ({
      session: session.id,
      content: Array.from(`${session.messages[0].text} ${session.messages[1].text}`).slice(0, 280).join(''),
    }))
  return [...fromFacts, ...fromNoise]
}

export function buildDataset({ noise = DEFAULT_NOISE, seed = 20261, name = 'devmem' } = {}) {
  const sessions = [...SESSIONS, ...generateNoise(noise, { seed })].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  )
  return {
    name,
    persona: {
      name: 'fictional-backend-developer',
      stack: ['Go', 'PostgreSQL', 'TypeScript', 'Python'],
      workspaces: ['D:/work/tidepool', 'D:/work/lantern', 'D:/work/quillmark', 'D:/home'],
    },
    sessions,
    gold: {
      question_date: QUESTION_DATE,
      memories: buildMemories(sessions, FACTS),
      facts: FACTS,
      probes: PROBES.map(({ id, kind, q, expect, answer, keys, stale, absent, tags, expectFacts }) => ({
        id,
        kind,
        q,
        expect,
        answer,
        tags,
        ...(keys.length > 0 ? { keys } : {}),
        ...(stale === undefined ? {} : { stale }),
        ...(absent === undefined ? {} : { absent }),
        ...(expectFacts === undefined ? {} : { expectFacts }),
      })),
    },
  }
}

function main() {
  const args = process.argv.slice(2)
  const outDir = resolve(args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : join(HERE, '..', 'datasets'))
  const variants = [
    { file: 'devmem-lite.json', name: 'devmem-lite', noise: 0 },
    { file: 'devmem.json', name: 'devmem', noise: DEFAULT_NOISE },
  ]
  let failed = false
  for (const { file, name, noise } of variants) {
    const dataset = buildDataset({ name, noise })
    const issues = auditDataset(dataset)
    if (issues.length > 0) {
      failed = true
      console.error(`${file}：${issues.length} 个问题\n  ${issues.join('\n  ')}`)
      continue
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, file), `${JSON.stringify(dataset, null, 1)}\n`)
    console.log(`${file}：${dataset.sessions.length} 个会话，${dataset.gold.probes.length} 题，审计通过`)
  }
  if (failed) process.exit(1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
