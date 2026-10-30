#!/usr/bin/env node
/**
 * dsh-claude-mem · 回滚校验器（rollback.ps1 的静态闸门）
 *
 * 语法：node tools/_rollback-verify.mjs <cordis.patch.yml> [meowBundle]
 *
 * 不做「大致字符串匹配」，而是按 YAML 行结构解析出**每条 id 的最后一次 disabled 设定**
 * （后出现的覆盖先出现的，这与 loader 的 patch 语义一致），再断言：
 *   1. meow 阵营那一行最后是 disabled: false（恢复启用）；
 *   2. dsh-claude-mem 那一行最后是 disabled: true（关闭）。
 *
 * 退出码：0 = 通过；1 = 状态不对。
 */
import { readFileSync } from 'node:fs'

const [, , patchPath, meowArg] = process.argv
if (typeof patchPath !== 'string') {
  console.error('用法：node tools/_rollback-verify.mjs <cordis.patch.yml> [meowBundle]')
  process.exit(2)
}

const SELF = 'dsh-claude-mem'

/** 极简 YAML 行扫描：只关心顶层 "- id: X" 与其后的 disabled。 */
export function parseDisabledStates(text) {
  const states = new Map()
  let currentId = null
  const flush = () => {
    currentId = null
  }
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ')
    const idMatch = line.match(/^\s*-\s*id:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/)
    if (idMatch !== null) {
      currentId = idMatch[1] ?? idMatch[2] ?? idMatch[3] ?? null
      continue
    }
    // 顶层新的数组项（"- " 开头但不是 id）说明上一块结束
    if (/^\s*-\s+/.test(line) && !/^\s*-\s*id:/.test(line)) {
      flush()
      continue
    }
    if (currentId === null) continue
    const disabledMatch = line.match(/^\s+disabled:\s*(true|false)\s*$/)
    if (disabledMatch !== null) {
      states.set(currentId, disabledMatch[1] === 'true')
    }
  }
  return states
}

let text
try {
  text = readFileSync(patchPath, 'utf8')
} catch (error) {
  console.error(`读不到 ${patchPath}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const states = parseDisabledStates(text)
const meow = typeof meowArg === 'string' && meowArg !== '' ? meowArg : 'dsh-meow-mem'

const problems = []
if (!states.has(meow)) problems.push(`缺少 meow 行（${meow}）`)
else if (states.get(meow) !== false) problems.push(`${meow} 仍是 disabled: true（应恢复启用）`)

if (!states.has(SELF)) problems.push(`缺少 ${SELF} 行`)
else if (states.get(SELF) !== true) problems.push(`${SELF} 不是 disabled: true（应关闭）`)

const seen = [...states.entries()].map(([id, disabled]) => `${id}=${disabled ? 'off' : 'on'}`).join(', ')
if (problems.length > 0) {
  console.error(`FAIL  回滚状态不对：${problems.join('；')}`)
  console.error(`      解析到：${seen}`)
  process.exit(1)
}
console.log(`PASS  回滚状态正确：${meow}=on, ${SELF}=off（解析到：${seen}）`)
