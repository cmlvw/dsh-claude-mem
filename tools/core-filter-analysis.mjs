/**
 * 一次性证据脚本（2026-10-28 快照，不是长期工具）：
 * 用「关键词相关性」模拟给 user/rules 层做过滤，量化「省字 vs 误丢跨任务约束」。
 * 分类是人工按当前库里的 11 条写的；数据变了要重新核对，不能直接当判据。
 */
import { DatabaseSync } from 'node:sqlite'

const globalPath = 'D:/dsh-claude-mem/global.db'
const workspacePath = 'C:/Users/User/.dsh/profiles/desktop/.dsh-claude-mem/memory.db'
const queries = [
  '精排默认开还是关', '记忆插件两层库怎么分的', '全局库放哪个盘', '召回三阶段是什么',
  'DSH 启动失败怎么办', '周报数字能不能估算', '本地模型 100K 上下文 KV 用哪个',
  '重启模板 STEP 6 验证', '远程访问 18080 怎么配', '密钥拦截正则漏了什么',
  'meow-memory 和我们的插件是什么关系', '旧卡为什么归档重新发卡',
]

// 人工分类：topical = 只在特定话题下有用；cross = 跨任务都该在的行为约束；safety = 红线
const CLASS = {
  q4imjw: 'safety',  // 不许删模型文件
  g7esto: 'cross',   // 信息边界
  rl2d04: 'safety',  // 写入前扫敏感信息
  '91kmck': 'topical', // 本机推理环境
  vf0wdw: 'cross',   // 先实测再定默认
  '01rchv': 'cross', // 本地模型分工
  g4wmz5: 'safety',  // 改环境前备份/回滚地址
  '6o2ycj': 'cross', // 要预防机制
  kin190: 'cross',   // 先验收再叫我
  as7bd2: 'topical', // 形象偏好
  egz9we: 'topical', // 归档旧卡
}

const gdb = new DatabaseSync(globalPath, { readOnly: true })
const rows = gdb.prepare("SELECT * FROM entries WHERE level IN ('user','rules') AND status='active' ORDER BY level, importance DESC").all()
const entries = rows.map((row) => {
  const body = row.body ?? ''
  const tokens = String(row.keywords ?? '').split(/\s+/).filter(Boolean)
  const grams = new Set()
  for (const token of tokens) {
    if (Array.from(token).length >= 3) grams.add(token)
    const chars = Array.from(token)
    for (let i = 0; i < chars.length - 1; i += 1) {
      if (/[\u4e00-\u9fff]/.test(chars[i]) && /[\u4e00-\u9fff]/.test(chars[i + 1])) grams.add(chars[i] + chars[i + 1])
    }
  }
  const id = String(row.id).slice(-6)
  return {
    id,
    level: row.level,
    chars: Array.from(body).length,
    class: CLASS[id] ?? 'cross',
    title: row.title,
    grams,
  }
})

console.log('条目：')
for (const entry of entries) console.log(`  ${entry.level}/${entry.id} ${entry.class} ${entry.chars}字 ${entry.title.slice(0, 30)}`)

const totalChars = entries.reduce((sum, entry) => sum + entry.chars, 0)
const topical = entries.filter((entry) => entry.class === 'topical')
console.log(`\nuser/rules 正文合计 ${totalChars} 字；其中 topical（形象/硬件/迭代）${topical.reduce((s, e) => s + e.chars, 0)} 字`)

console.log('\n按 query 做「关键词相关性」过滤的结果：')
console.log('query'.padEnd(34), '保留条数', '省字', '丢掉非topical条数')
let saveSum = 0
let dropCross = 0
for (const query of queries) {
  const kept = []
  const dropped = []
  for (const entry of entries) {
    const hit = [...entry.grams].some((gram) => query.includes(gram))
    if (hit) kept.push(entry)
    else dropped.push(entry)
  }
  const saved = dropped.reduce((sum, entry) => sum + entry.chars, 0)
  const crossDropped = dropped.filter((entry) => entry.class !== 'topical')
  saveSum += saved
  dropCross += crossDropped.length
  console.log(
    query.padEnd(34),
    String(kept.length).padStart(6),
    String(saved).padStart(6),
    String(crossDropped.length).padStart(6),
    crossDropped.length > 0 ? `（${crossDropped.map((e) => e.id).join(',')}）` : '',
  )
}
console.log(`\n平均每条 query 省 ${Math.round(saveSum / queries.length)} 字；平均误丢非 topical 条目 ${(dropCross / queries.length).toFixed(1)} 条`)
gdb.close()
