#!/usr/bin/env node
/**
 * dsh-claude-mem · M4 端到端验收
 *
 * 用 fake ctx 真跑 apply，拿到真实的五个工具对象，然后在临时库里走完整链路：
 *   写一条 → 搜索到 → 读到 → 更新 → 项目索引里出现 → 密钥写入被拒 → 相似内容合并。
 *
 * 用法：node tools/e2e-tools.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

const results = []
function check(label, pass, detail = '') {
  results.push({ label, pass, detail })
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-e2e-'))
const workspace = join(tmpRoot, 'workspace')
const globalDbPath = join(tmpRoot, 'global.db')

const hooks = new Map()
const registeredTools = []
const registeredNames = []

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on(event, handler) {
    hooks.set(event, handler)
    return () => hooks.delete(event)
  },
  get() {
    return undefined
  },
  tools: {
    register(tool) {
      registeredTools.push(tool)
      registeredNames.push(tool.name)
      return () => {}
    },
  },
}

const disposers = []
const status = await apply(ctx, { globalDbPath })
disposers.push(status.dispose)

/** 真实调用某个已注册工具。 */
async function callTool(name, args) {
  const tool = registeredTools.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`工具未注册：${name}`)
  const exec = { agent: { session: { header: { cwd: workspace, id: 'e2e-session' } } } }
  return tool.execute(args, exec)
}

try {
  // ---- 1. 五个工具都注册上了 ----
  check(
    '五个工具都注册',
    registeredNames.length === 5 &&
      ['mem_remember', 'mem_search', 'mem_read', 'mem_update', 'mem_project'].every((n) => registeredNames.includes(n)),
    registeredNames.join(','),
  )
  check('status.tools 与注册一致', status.tools.length === registeredNames.length, status.tools.join(','))
  check('每个工具都有 name/description/parameters/execute', registeredTools.every(
    (t) => typeof t.name === 'string' && typeof t.description === 'string' && t.parameters !== undefined && typeof t.execute === 'function',
  ))

  // ---- 2. 写一条 ----
  const written = await callTool('mem_remember', {
    content: '用户要求改配置前先发回滚文件地址、先补一份改前备份，再动手。',
    level: 'fact',
    project: '记忆插件',
    keywords: ['回滚', '备份', '改配置', '回滚文件', '动手前', '安全', '用户要求', '流程'],
    importance: 3,
  })
  check('mem_remember 写入成功', written.ok === true && typeof written.id === 'string', JSON.stringify(written.id))
  check('返回短 id（6 位）', typeof written.short_id === 'string' && written.short_id.length === 6, written.short_id)
  check('未合并（首次写入是新增）', written.merged === false, String(written.merged))
  const shortId = written.short_id
  const fullId = written.id

  // ---- 3. 搜索到 ----
  const found = await callTool('mem_search', { query: '回滚 备份', k: 5 })
  check('mem_search 命中刚写的条目', found.ok === true && found.hits.some((h) => h.id === shortId), JSON.stringify(found.hits.map((h) => h.id)))
  check('搜索结果带短 id + 摘要', found.hits.length > 0 && typeof found.hits[0].summary === 'string', JSON.stringify(found.hits[0]?.summary))

  // ---- 4. 读到 ----
  const read = await callTool('mem_read', { id: shortId })
  check('mem_read 按短 id 取到全文', read.ok === true && read.full_id === fullId, String(read.full_id))
  check('正文与写入一致', read.body.includes('回滚文件地址'), String(read.body).slice(0, 40))
  check('关键词完整回读', Array.isArray(read.keywords) && read.keywords.length === 8, JSON.stringify(read.keywords))

  // ---- 5. 更新 ----
  const updated = await callTool('mem_update', {
    id: shortId,
    importance: 4,
    keywords: ['回滚', '备份', '改配置', '回滚文件', '动手前', '安全', '用户要求', '流程', '红线'],
  })
  check('mem_update 成功', updated.ok === true, JSON.stringify(updated.changed))
  const readAfter = await callTool('mem_read', { id: shortId })
  check('更新后 importance 生效', readAfter.importance === 4, String(readAfter.importance))
  check('更新后关键词生效（9 个）', readAfter.keywords.length === 9, String(readAfter.keywords.length))

  // ---- 6. 项目索引里出现 ----
  const overview = await callTool('mem_project', { project: '记忆插件' })
  check('mem_project 返回该项目', overview.ok === true && overview.project === '记忆插件', String(overview.project))
  check('mem_project 里能看到该条', (overview.lines ?? []).some((l) => l.id === shortId), JSON.stringify((overview.lines ?? []).map((l) => l.id)))
  check('mem_project 统计正确', overview.total >= 1, String(overview.total))

  // ---- 7. 密钥写入被拒 ----
  let secretErr = null
  try {
    await callTool('mem_remember', {
      content: '部署用的 api_key = sk_live_abcdefghijklmnop1234567890 请记住',
      level: 'fact',
      project: '记忆插件',
      keywords: ['部署', '密钥', 'api', 'token', '凭据', '配置', '服务', '账号'],
      importance: 2,
    })
  } catch (error) {
    secretErr = error instanceof Error ? error.message : String(error)
  }
  check('含 API key 的写入被拒收', secretErr !== null && secretErr.includes('密钥'), String(secretErr))
  check('拒收信息不回显秘文', secretErr !== null && !secretErr.includes('sk_live_abcdefghijklmnop'), String(secretErr))

  // 私钥块
  let pkErr = null
  try {
    await callTool('mem_remember', {
      content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----',
      level: 'fact',
      project: '记忆插件',
      keywords: ['私钥', '证书', '密钥', '部署', '服务', '配置', '账号', '安全'],
      importance: 2,
    })
  } catch (error) {
    pkErr = error instanceof Error ? error.message : String(error)
  }
  check('含私钥块的写入被拒收', pkErr !== null && pkErr.includes('密钥'), String(pkErr))

  // ---- 8. 超长拒收 ----
  let longErr = null
  try {
    await callTool('mem_remember', {
      content: '长'.repeat(120),
      level: 'fact',
      project: '记忆插件',
      keywords: ['超长', '正文', '上限', '拒收', '测试', '边界', '校验', '长度'],
      importance: 1,
    })
  } catch (error) {
    longErr = error instanceof Error ? error.message : String(error)
  }
  check('fact 超长正文被拒收', longErr !== null && longErr.includes('过长'), String(longErr))

  // ---- 9. 相似内容合并 ----
  const again = await callTool('mem_remember', {
    content: '用户要求改配置前先发回滚文件地址、先补一份改前备份，再动手。',
    level: 'fact',
    project: '记忆插件',
    keywords: ['回滚', '备份', '改配置', '回滚文件', '动手前', '安全', '用户要求', '流程'],
    importance: 3,
  })
  check('高度相似内容合并为一条（不新增）', again.merged === true, String(again.merged))
  check('合并后仍是同一条目', again.id === fullId, String(again.id))

  // ---- 10. 读不到时给出明确错误 ----
  let missingErr = null
  try {
    await callTool('mem_read', { id: 'zzzzzz' })
  } catch (error) {
    missingErr = error instanceof Error ? error.message : String(error)
  }
  check('读不存在的 id 抛明确错误', missingErr !== null && missingErr.includes('没找到'), String(missingErr))
} finally {
  for (const dispose of disposers) dispose()
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论
  }
}

const failed = results.filter((r) => !r.pass)
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail && !r.pass ? `  ← ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1
