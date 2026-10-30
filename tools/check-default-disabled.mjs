#!/usr/bin/env node
/**
 * dsh-claude-mem · 「install_bundle 后默认 disabled」的证据生成器（M6 验收 2）
 *
 * 单独一个工具，是为了让「默认关」这条能被独立复跑，而不是混在演练脚本里。
 * 它证明三件事：
 *   1. 我们的 cordis.patch.yml 里那一行**自带** disabled: true（包自己的行为）；
 *   2. profile 的 cordis.patch.yml（用户层）里**没有**手写我们的 disabled:true ——
 *      也就是说「默认关」不是谁手写上去的，是 bundle patch 带来的；
 *   3. 真机 --dump-config 合成后，该行确实是 disabled: true。
 *
 * 用法：node tools/check-default-disabled.mjs --profile-dir <dir> [--patch <我们的 cordis.patch.yml>]
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile-dir') args.profileDir = argv[++i]
    else if (argv[i] === '--patch') args.patch = argv[++i]
  }
  return args
}

/** 从 YAML 文本里取 id 的最终 disabled（后出现的覆盖先出现的）。 */
export function stateOf(text, id) {
  let seen = false
  let disabled = null
  let currentId = null
  for (const rawLine of String(text).split(/\r?\n/)) {
    const idMatch = rawLine.match(/^\s*-\s*id:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/)
    if (idMatch !== null) {
      currentId = idMatch[1] ?? idMatch[2] ?? idMatch[3] ?? null
      if (currentId === id) seen = true
      continue
    }
    if (currentId !== id) continue
    const disabledMatch = rawLine.match(/^\s+disabled:\s*(true|false)\s*$/)
    if (disabledMatch !== null) disabled = disabledMatch[1] === 'true'
  }
  return { seen, disabled }
}

const args = parseArgs(process.argv.slice(2))
const results = []
function check(label, pass, detail = '') {
  results.push({ label, pass, detail })
}

const bundlePatchPath = args.patch ?? join(projectRoot, 'cordis.patch.yml')
if (!existsSync(bundlePatchPath)) {
  console.error(`找不到 bundle patch：${bundlePatchPath}`)
  process.exit(2)
}
const bundleText = readFileSync(bundlePatchPath, 'utf8')
const bundleState = stateOf(bundleText, 'dsh-claude-mem')
check('包自带的 cordis.patch.yml 里 disabled: true', bundleState.seen && bundleState.disabled === true, `seen=${bundleState.seen}, disabled=${bundleState.disabled}`)

if (typeof args.profileDir === 'string') {
  const profilePatch = join(args.profileDir, 'cordis.patch.yml')
  if (existsSync(profilePatch)) {
    const profileText = readFileSync(profilePatch, 'utf8')
    const profileState = stateOf(profileText, 'dsh-claude-mem')
    check(
      '用户 profile 层没有手写我们的 disabled（默认关来自 bundle，不是手写的）',
      profileState.seen === false,
      `profile 层该行 seen=${profileState.seen}`,
    )
  } else {
    check('用户 profile 层没有手写我们的 disabled', true, '（profile 里没有 cordis.patch.yml）')
  }

  // 真机合成结果
  const CLI = 'E:\\Program Files\\deepseek harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
  const profileName = args.profileDir.split(/[\\/]/).filter(Boolean).pop()
  const dump = spawnSync(`"${CLI}" --profile ${profileName} --dump-config`, [], {
    encoding: 'utf8',
    shell: true,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  })
  const text = dump.stdout ?? ''
  // dump 里行形状是 `- id: dsh-claude-mem` + `  name: ...` + `  disabled: true`
  const lines = text.split(/\r?\n/)
  let found = false
  let effective = null
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '- id: dsh-claude-mem') continue
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      if (/^\s*-\s+id:/.test(lines[j])) break
      const match = lines[j].match(/^\s+disabled:\s*(true|false)\s*$/)
      if (match !== null) {
        found = true
        effective = match[1] === 'true'
      }
    }
    if (found) break
  }
  check('真机 --dump-config 合成后是 disabled: true', found && effective === true, `found=${found}, effective=${effective}`)
}

const failed = results.filter((r) => !r.pass)
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail && !r.pass ? `  ← ${r.detail}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1
