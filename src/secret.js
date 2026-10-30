/**
 * dsh-claude-mem · 密钥/凭据检测
 *
 * 两个用途（PLAN.md §8）：
 *  1. 写入时拒收（M4）；
 *  2. 迁移时把源库里带密钥的条目隔离，不导入（M1）。
 *
 * 只返回规则名，不在日志/报告里回显命中的秘文本身；redact 用于隔离表留档时
 * 去掉明文（审计要「有这条、为什么被拦」，不需要把密钥再存一份）。
 */

const RULES = [
  {
    name: 'secret-assignment',
    re: /(?:app[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=:]{6,}/gi,
  },
  {
    // 中文写法（2026-10-28 补）：「密码是 xxx / 密钥为 xxx / 口令：xxx」。
    // 英文规则只认 keyword=value，中文「密码」+「是/为/冒号」匹配不上，用户全程中文交流必踩。
    name: 'secret-assignment-zh',
    re: /(?:密码|密钥|口令|秘钥)\s*(?:是|为|等于|[:：])\s*["'「]?[A-Za-z0-9!@#$%^&*()_\-./+=:,;?~]{6,}/gi,
  },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'known-prefix', re: /\b(?:sk|ghp|gho|ghu|ghs|ghr|glpat)_[A-Za-z0-9_-]{16,}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'connection-string', re: /\b(?:mongodb|postgres|mysql|redis):\/\/[^\s"']{8,}/gi },
]

/** @returns {{hit:boolean, rules:string[]}} */
export function scanSecrets(text) {
  const source = String(text ?? '')
  const hits = []
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    if (re.test(source)) hits.push(rule.name)
  }
  return { hit: hits.length > 0, rules: hits }
}

export function redactSecrets(text) {
  let output = String(text ?? '')
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    output = output.replace(re, '[REDACTED]')
  }
  return output
}
