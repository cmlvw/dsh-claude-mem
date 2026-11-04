/**
 * dsh-claude-mem · 工作区记忆库的信任标记
 *
 * 工作区库存放在工作区目录里，可能随仓库一起被克隆过来。别人准备好的库如果被直接注入，
 * 里面的内容就成了长期生效的提示词注入，所以不是本机创建的库要先经用户信任才打开。
 *
 * 标记必须放在工作区之外（插件数据目录），库文件自己声明的信任不算数。
 * 目录写不了时退回「全部可信」：信任门控是安全网，不该让记忆功能整体失效。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { comparablePath } from './workspace.js'

export function createTrustStore(dir, { preTrusted = [] } = {}) {
  let usable = true
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    usable = false
  }
  const pre = new Set(preTrusted.filter(Boolean).map(comparablePath))
  const markerPath = (root) => join(dir, `${createHash('sha256').update(comparablePath(root)).digest('hex')}.json`)

  const isTrusted = (root) => {
    if (!usable || pre.has(comparablePath(root))) return true
    try {
      const marker = JSON.parse(readFileSync(markerPath(root), 'utf8'))
      return typeof marker?.trustedAt === 'number'
    } catch {
      return false
    }
  }

  const trust = (root, source = 'manual') => {
    if (!usable) return false
    try {
      const target = markerPath(root)
      const temp = `${target}.tmp`
      writeFileSync(temp, JSON.stringify({ path: root, trustedAt: Date.now(), source }, null, 1), 'utf8')
      renameSync(temp, target)
      return true
    } catch {
      return false
    }
  }

  return { isTrusted, trust }
}
