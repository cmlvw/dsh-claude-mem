/**
 * dsh-claude-mem · 工作区定位：把会话的 cwd 映射到记忆库所在的目录
 *
 * 直接按 cwd 建库会把同一个项目的记忆拆散：在子目录里开会话得到一个新的空库，
 * 从机器人或代理的工作目录发起的会话也看不到项目记忆。定位顺序：
 *   1. 配置的 aliases：显式指定，最长前缀优先；
 *   2. autoRoot：从 cwd 往上找最近的「已有记忆库」或 Git 根目录；
 *   3. 都没有就用 cwd 本身。
 *
 * 已有记忆库优先于更外层的 Git 根目录，所以开启本功能不会让任何现有的库失联。
 * 用户主目录和 $DSH_HOME 不算项目根：它们下面的目录彼此无关，不该共用一个库。
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** 比较用的路径形式：绝对路径、去掉结尾分隔符，Windows 上不分大小写。 */
export function comparablePath(path) {
  const absolute = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function isSameOrInside(child, parent) {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

/** 清洗 aliases：丢掉不完整或相对路径的项，并把问题记进 warnings。 */
export function normalizeAliases(aliases, warnings = []) {
  const valid = []
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const from = typeof alias?.from === 'string' ? alias.from.trim() : ''
    const to = typeof alias?.to === 'string' ? alias.to.trim() : ''
    if (from === '' || to === '' || !isAbsolute(from) || !isAbsolute(to)) {
      warnings.push(`workspace.aliases 里有无效项（from/to 都必须是绝对路径），已忽略：${JSON.stringify(alias)}`)
      continue
    }
    valid.push({ from: comparablePath(from), to: resolve(to) })
  }
  // 最长前缀优先：子目录可以单独映射到别的库。
  return valid.sort((a, b) => b.from.length - a.from.length)
}

/**
 * 定位工作区根目录。永不 throw：文件系统探测出问题就退回 cwd。
 * @param {string} cwd 会话工作目录
 * @param {{aliases?:Array<{from:string,to:string}>, autoRoot?:boolean, projectDir:string, stopAt?:string[]}} options
 *   aliases 需先经过 normalizeAliases。
 * @returns {{root:string, via:'alias'|'existing-db'|'git'|'cwd'}}
 */
export function resolveWorkspaceRoot(cwd, options) {
  const { aliases = [], autoRoot = true, projectDir, stopAt = [] } = options
  const current = comparablePath(cwd)
  for (const alias of aliases) {
    if (isSameOrInside(current, alias.from)) return { root: alias.to, via: 'alias' }
  }
  if (!autoRoot) return { root: cwd, via: 'cwd' }

  const stops = new Set(stopAt.filter(Boolean).map(comparablePath))
  try {
    let dir = resolve(cwd)
    while (true) {
      if (stops.has(comparablePath(dir))) break
      if (existsSync(join(dir, projectDir, 'memory.db'))) {
        return comparablePath(dir) === current ? { root: cwd, via: 'cwd' } : { root: dir, via: 'existing-db' }
      }
      if (existsSync(join(dir, '.git'))) {
        return comparablePath(dir) === current ? { root: cwd, via: 'cwd' } : { root: dir, via: 'git' }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // 探测失败不影响加载，退回 cwd
  }
  return { root: cwd, via: 'cwd' }
}
