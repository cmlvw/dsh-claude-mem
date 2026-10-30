/**
 * dsh-claude-mem · 时间标签
 *
 * 模型不擅长算日期，所以注入里只给相对时间（PLAN.md §5）。
 * 「>1 天」才附新鲜度告警，避免每条记忆都挂一句免责声明变成噪音
 * （官方 memoryAge 的结论：≤1 天加警告是噪音）。
 */

export const DAY_MS = 24 * 60 * 60 * 1000

export function ageLabel(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '未知时间'
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return days === 1 ? '昨天' : `${days} 天前`
}

export function needsFreshnessWarning(ts, now = Date.now(), warnAfterDays = 1) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return false
  return now - ts > warnAfterDays * DAY_MS
}
