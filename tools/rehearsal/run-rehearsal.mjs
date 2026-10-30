#!/usr/bin/env node
/**
 * dsh-claude-mem · 真实回滚演练（M6，本卡核心验收）
 *
 * 为什么用隔离 profile 而不是 desktop：desktop profile 被 Electron 独占
 * （`dsh --profile desktop` 直接报 "managed exclusively by the Electron application"），
 * CLI 无法 boot 它。演练因此在**独立的 DSH_HOME + 独立 profile + 真实 DSH 进程**上做，
 * desktop 的 cordis.patch.yml 只读、一个字都不改。
 *
 * 演练链（每一步都留原始输出）：
 *   0. 环境准备：隔离 DSH_HOME、装 meow-memory、装本插件、种子数据
 *   1. 装完断言：dump-config 里 dsh-claude-mem 是 disabled: true（R3 默认关）
 *   2. 启用本插件 → 真机 boot → 断言模型收到【长期记忆】+ REHEARSAL 标记
 *   3. 跑 tools/rollback.ps1 → 断言补丁状态（meow on / 本插件 off）
 *   4. 真机 boot → 断言模型收到 meow 的长期记忆块、且**没有**我们的块
 *   5. 再次启用本插件 → 断言切回来（往返闭合，不是单向）
 *   6. 两家同时启用 → 断言我们拒绝装配 + 审计落盘 mutex.refused
 *
 * 用法：node tools/rehearsal/run-rehearsal.mjs
 * 退出码：0 = 全部断言通过；1 = 有失败（原始输出仍写进报告）
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..', '..')
const rehearsalRoot = join(projectRoot, '.rehearsal')
const dshHome = join(rehearsalRoot, 'dsh-home')
const profileDir = join(dshHome, 'profiles', 'headless')
const workspace = join(rehearsalRoot, 'ws-a')
const mockLog = join(rehearsalRoot, 'mock.jsonl')
const reportDir = join(rehearsalRoot, 'report')
const auditFile = join(dshHome, 'dsh-claude-mem', 'audit.jsonl')
const CLI = 'E:\\Program Files\\deepseek harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
const MOCK_PORT = 18777

const steps = []
function step(name, detail) {
  steps.push({ name, at: new Date().toISOString(), detail: typeof detail === 'string' ? detail : '' })
  console.log(`\n=== ${name} ===`)
  if (typeof detail === 'string' && detail !== '') console.log(detail)
}

/**
 * 跑 .cmd 必须经 shell：node 的 spawnSync 直接执行 .cmd 会得到 code=null
 *（Windows 上 .cmd 不是可执行二进制，是 cmd.exe 的脚本）。
 * 用 shell:true + 单字符串命令，路径加引号防空格。
 */
function run(command, args, options = {}) {
  const isCmd = /\.(cmd|bat)$/i.test(command)
  const joined = [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')
  const result = spawnSync(isCmd ? joined : command, isCmd ? [] : args, {
    cwd: options.cwd ?? workspace,
    env: { ...process.env, DSH_HOME: dshHome, REHEARSAL_API_KEY: 'rehearsal' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: isCmd,
  })
  return {
    command: joined,
    code: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error === undefined ? null : String(result.error.message),
  }
}

function mockRequests() {
  if (!existsSync(mockLog)) return []
  return readFileSync(mockLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** 主对话请求 = 带 system 且 messages > 3 的那些（标题请求只有 2 条）。 */
function mainRequests(rows) {
  return rows.filter((row) => row.messages.length > 3)
}

function lastMain() {
  const rows = mainRequests(mockRequests())
  return rows.length === 0 ? null : rows[rows.length - 1]
}

const OWN_BLOCK = '【长期记忆'
const MEOW_BLOCK = '===== 长期记忆 ====='
const OUR_MARKER = 'REHEARSAL-MARKER'
const MEOW_MARKER = 'MEOW-MARKER-ROUNDTRIP'

let failures = 0
/**
 * detail 只在**失败**时作为诊断附注打印——PASS 行不显示，避免
 * 「PASS 安装后 … 行存在 ← dump-config 里没有这一行」这种自相矛盾的行。
 */
function assert(label, pass, detail = '') {
  const line = `${pass ? 'PASS' : 'FAIL'}  ${label}${!pass && detail !== '' ? `  ← ${detail}` : ''}`
  console.log(line)
  steps[steps.length - 1].detail += `\n${line}`
  if (!pass) failures += 1
}

// ---------------------------------------------------------------- 环境准备
mkdirSync(reportDir, { recursive: true })

step('0. 环境：隔离 DSH_HOME + mock 模型')
// 每次演练前把 profile 的 patch 层恢复成「空白用户层」：
// 否则上一轮 rollback.ps1 写进去的管理块会让「默认 disabled 来自 bundle」
// 这条证据失效（那正是 check-default-disabled.mjs 抓到的）。
const pristinePatch = '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
  '# a top-level YAML array of loader patch entries (id-targeted config\n' +
  '# overrides, disables, and insert lists; `!!js` expressions allowed).\n' +
  '[]\n'
writeFileSync(join(profileDir, 'cordis.patch.yml'), pristinePatch, 'utf8')
// 审计也清掉：只保留本轮证据，免得旧记录混进「本轮拒绝了几次」的判断。
if (existsSync(auditFile)) rmSync(auditFile, { force: true })
if (!existsSync(join(dshHome, 'profiles', 'headless', 'package.json'))) {
  mkdirSync(join(dshHome, 'profiles'), { recursive: true })
  const src = 'C:\\Users\\User\\.dsh\\profiles\\headless'
  copyFileSync(join(src, 'package.json'), join(profileDir, 'package.json'))
  copyFileSync(join(src, 'cordis.yml'), join(profileDir, 'cordis.yml'))
  copyFileSync(join(src, 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))
  copyFileSync(join(src, 'pnpm-workspace.yaml'), join(profileDir, 'pnpm-workspace.yaml'))
}
console.log(`DSH_HOME = ${dshHome}`)
console.log(`profile  = ${profileDir}`)
console.log(`workspace= ${workspace}`)

/**
 * 起 mock 服务。
 * detached:true + 单独的进程组：Windows 上 spawn 的 node 会先起一个包装进程，
 * 只 kill 包装进程时真正的监听进程会活下来（实测端口一直被占）。
 * 所以收尾时按 PID 树整组杀。
 *
 * 注意顺序：先 freePort() 清掉上一轮残留，**再** spawn ——
 * 反过来会把本轮刚起的服务杀在摇篮里（这坑踩过一次）。
 */
freePort()
const mock = spawn('node', [join(here, 'mock-llm.mjs'), '--port', String(MOCK_PORT), '--log', mockLog], {
  cwd: projectRoot,
  stdio: 'ignore',
  detached: true,
  windowsHide: true,
})
mock.unref()

/** 杀掉 mock 的整棵进程树（Windows 用 taskkill /T，其它平台杀进程组）。 */
function stopMock() {
  const pid = mock.pid
  if (typeof pid !== 'number') return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      mock.kill('SIGKILL')
    } catch {
      // 已经退出
    }
  }
}

/** 兜底：按端口找监听者并杀掉（taskkill 万一没覆盖到）。 */
function freePort() {
  if (process.platform !== 'win32') return
  const find = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${MOCK_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`],
    { encoding: 'utf8' },
  )
  void find
}

writeFileSync(mockLog, '')

/** 等 mock 起来（最多 5 秒）。 */
async function waitMock() {  for (let i = 0; i < 50; i += 1) {
    const probe = spawnSync('node', ['-e', `fetch('http://127.0.0.1:${MOCK_PORT}/v1/models').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`], { encoding: 'utf8' })
    if (probe.status === 0) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const mockReady = await waitMock()
assert('mock 模型可访问', mockReady, `port=${MOCK_PORT}`)

step('0b. 种子：工作区库 + 全局库 + meow 库')
{
  // 工作区/全局种子
  const seed = run('node', [join(here, 'seed.mjs'), '--workspace', workspace, '--global', join(dshHome, 'dsh-claude-mem', 'global.db')])
  console.log(seed.stdout || seed.stderr)
  assert('种子写入（工作区 + 全局）', seed.code === 0 && seed.stdout.includes('"ok":true'), seed.stdout.slice(0, 200))
}

// ---------------------------------------------------------------- 1. 默认 disabled
step('1. install 后默认 disabled（R3 锁后交付）')
const dump0 = run(CLI, ['--profile', 'headless', '--dump-config'])
/**
 * 从 dump-config 里取某个 id 的最终 disabled 状态（按行结构解析，不做字符串猜）。
 * dump 里每条是 `- id: X` / `  name: X` / `  disabled: true|false`。
 */
function rowState(text, id) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== `- id: ${id}`) continue
    let disabled = false
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      if (/^\s*-\s+id:/.test(lines[j])) break // 下一条开始
      const match = lines[j].match(/^\s+disabled:\s*(true|false)\s*$/)
      if (match !== null) disabled = match[1] === 'true'
    }
    return { found: true, disabled }
  }
  return { found: false, disabled: null }
}

const ownRow = rowState(dump0.stdout, 'dsh-claude-mem')
const meowRow = rowState(dump0.stdout, 'meow-memory')
console.log(
  dump0.stdout
    .split('\n')
    .filter((line) => /^(-\s*id:|#\s*==).*?(dsh-claude-mem|meow-memory)/.test(line) || /disabled:/.test(line))
    .slice(-12)
    .join('\n'),
)
assert('安装后 dsh-claude-mem 行存在', ownRow.found, 'dump-config 里没有这一行')
assert('安装后 dsh-claude-mem 是 disabled: true', ownRow.disabled === true, `disabled=${ownRow.disabled}`)
assert('同一 dump 里 meow-memory 行存在', meowRow.found, `found=${meowRow.found}`)

// ---------------------------------------------------------------- 2. 启用 → 生效
step('2. 启用本插件 → 真机 boot → 断言注入')
writeFileSync(mockLog, '')
const boot1 = run(CLI, [
  '--profile', 'headless',
  '--patch', join(here, 'mock-model.patch.yml'),
  '--patch', join(here, 'enable-claude-mem.patch.yml'),
  '我们之前说好的备份规则是什么',
])
console.log(boot1.stdout)
if (boot1.stderr !== '') console.log(`[stderr] ${boot1.stderr.slice(0, 400)}`)
assert('boot 成功（exit 0）', boot1.code === 0, `code=${boot1.code}`)
assert('boot 无 "did not activate" 警告', !boot1.stderr.includes('did not activate'), boot1.stderr.slice(0, 200))

const m1 = lastMain()
assert('模型收到了请求', m1 !== null)
if (m1 !== null) {
  const own = m1.messages.filter((msg) => String(msg.content).includes(OWN_BLOCK))
  const texts = m1.messages.map((msg) => String(msg.content))
  console.log(texts.map((t, i) => `  [${i}] ${t.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n'))
  assert('出现本插件的【长期记忆】块', own.length === 1, `块数=${own.length}`)
  assert('块里含 REHEARSAL-MARKER（种子真的进了注入）', own[0] !== undefined && own[0].content.includes(OUR_MARKER))
  assert('没有 meow 的长期记忆块（互斥期）', !texts.some((t) => t.includes(MEOW_BLOCK)))
  const ownIdx = m1.messages.findIndex((msg) => String(msg.content).includes(OWN_BLOCK))
  const userIdx = m1.messages.findIndex((msg) => String(msg.content).startsWith('我们之前说好的'))
  assert('注入块排在真实用户消息之前', ownIdx >= 0 && userIdx > ownIdx, `own=${ownIdx}, user=${userIdx}`)
}

// ---------------------------------------------------------------- 3. 回滚
step('3. 跑 tools/rollback.ps1（真实执行，不是 dry-run）')
const rb = spawnSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'tools', 'rollback.ps1'), '-ProfileDir', profileDir],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
)
console.log(rb.stdout ?? '')
if ((rb.stderr ?? '') !== '') console.log(`[stderr] ${rb.stderr}`)
assert('回滚脚本 exit 0', rb.status === 0, `code=${rb.status}`)
assert('脚本打印了备份路径', /已备份：/.test(rb.stdout ?? ''))
assert('脚本自带校验 PASS', /PASS  回滚状态正确/.test(rb.stdout ?? ''))

const patchAfter = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
console.log('--- 回滚后的 cordis.patch.yml ---')
console.log(patchAfter)
assert('回滚后 YAML 不再有孤立 []（否则解析失败）', !/^\s*\[\]\s*$/m.test(patchAfter))

const dump1 = run(CLI, ['--profile', 'headless', '--dump-config'])
console.log(dump1.stdout.split('\n').filter((line) => /meow-memory|dsh-claude-mem/.test(line)).join('\n'))
assert('dump-config 还能正常合成（回滚没写坏 profile）', dump1.code === 0, `code=${dump1.code}`)

// ---------------------------------------------------------------- 4. 断回滚后 meow 接管
step('4. 回滚后真机 boot → 断言 meow 接管')
writeFileSync(mockLog, '')
const boot2 = run(CLI, ['--profile', 'headless', '--patch', join(here, 'mock-model.patch.yml'), '我们之前说好的备份规则是什么'])
console.log(boot2.stdout)
if (boot2.stderr !== '') console.log(`[stderr] ${boot2.stderr.slice(0, 400)}`)
assert('回滚后 boot 成功', boot2.code === 0, `code=${boot2.code}`)

const m2 = lastMain()
assert('回滚后模型收到请求', m2 !== null)
if (m2 !== null) {
  const texts = m2.messages.map((msg) => String(msg.content))
  console.log(texts.map((t, i) => `  [${i}] ${t.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n'))
  assert('出现 meow 的长期记忆块', texts.some((t) => t.includes(MEOW_BLOCK)))
  assert('meow 块里含 MEOW-MARKER（meow 真的在工作）', texts.some((t) => t.includes(MEOW_MARKER)))
  assert('没有本插件的【长期记忆】块', !texts.some((t) => t.includes(OWN_BLOCK)))
}

// ---------------------------------------------------------------- 5. 再次启用 → 切回
step('5. 再次启用本插件 → 断言切回来（往返闭合）')
writeFileSync(mockLog, '')
const boot3 = run(CLI, [
  '--profile', 'headless',
  '--patch', join(here, 'mock-model.patch.yml'),
  '--patch', join(here, 'enable-claude-mem.patch.yml'),
  '我们之前说好的备份规则是什么',
])
console.log(boot3.stdout)
assert('再次启用 boot 成功', boot3.code === 0, `code=${boot3.code}`)
const m3 = lastMain()
if (m3 !== null) {
  const texts = m3.messages.map((msg) => String(msg.content))
  assert('切回后本插件注入恢复', texts.some((t) => t.includes(OWN_BLOCK) && t.includes(OUR_MARKER)))
  assert('切回后没有 meow 块', !texts.some((t) => t.includes(MEOW_BLOCK)))
}

// ---------------------------------------------------------------- 6. 互斥
step('6. 两家同时启用 → 断言互斥拒绝 + 审计落盘')
writeFileSync(mockLog, '')
const bothPatch = join(here, 'both-enabled.patch.yml')
if (!existsSync(bothPatch)) {
  writeFileSync(bothPatch, '- id: meow-memory\n  disabled: false\n- id: dsh-claude-mem\n  disabled: false\n')
}
const boot4 = run(CLI, ['--profile', 'headless', '--patch', join(here, 'mock-model.patch.yml'), '--patch', bothPatch, 'both enabled'])
console.log(boot4.stdout)
assert('同时启用时 boot 不崩', boot4.code === 0, `code=${boot4.code}`)
const m4 = lastMain()
if (m4 !== null) {
  const texts = m4.messages.map((msg) => String(msg.content))
  console.log(texts.map((t, i) => `  [${i}] ${t.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n'))
  assert('互斥：没有本插件的注入块', !texts.some((t) => t.includes(OWN_BLOCK)))
  assert('互斥：本插件手册也没进 system prompt', !texts[0].includes('dsh-claude-mem'))
  assert('互斥：meow 仍正常注入', texts.some((t) => t.includes(MEOW_BLOCK)))
}

if (existsSync(auditFile)) {
  const audit = readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  console.log('--- audit.jsonl ---')
  for (const row of audit) console.log(JSON.stringify(row))
  const refused = audit.filter((row) => row.event === 'mutex.refused')
  assert('审计里有 mutex.refused（可事后取证）', refused.length >= 1, `条数=${refused.length}`)
  assert('审计记了对手包名', refused[0] !== undefined && String(refused[0].rivals?.[0]?.pkg).includes('meow'))
} else {
  assert('审计文件存在', false, auditFile)
}

// ---------------------------------------------------------------- 收尾
stopMock()
freePort()

// 恢复原状：演练过程把 profile 的 patch 层改成了「回滚态」（第 3 步），
// 不还原的话下一次 check-default-disabled 会在「用户层手写了 disabled」这条上失败
// ——那会让证据链看起来像坏了，其实只是上一轮没收拾。清回空白层。
writeFileSync(join(profileDir, 'cordis.patch.yml'), pristinePatch, 'utf8')
console.log('\n（收尾：profile patch 层已恢复为空白用户层）')

step('7. 汇总')
const summary = {
  at: new Date().toISOString(),
  ok: failures === 0,
  failures,
  steps: steps.map((s) => ({ name: s.name, at: s.at })),
}
writeFileSync(join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2))
writeFileSync(join(reportDir, 'transcript.md'), steps.map((s) => `## ${s.name}\n\n\`\`\`\n${String(s.detail ?? '').trim()}\n\`\`\`\n`).join('\n'))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}（报告：${reportDir}）`)
process.exitCode = failures === 0 ? 0 : 1
