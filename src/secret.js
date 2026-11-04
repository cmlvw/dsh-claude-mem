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
    // 关键字后可以跟引号，这样 JSON 写法 {"api_key": "..."} 也能拦住。
    name: 'secret-assignment',
    re: /(?:app[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=:]{6,}/gi,
  },
  {
    // token/secret 太常见（max_token=4096），所以要求是独立的词，且值里有数字、足够长。
    name: 'generic-token-assignment',
    re: /(?<![A-Za-z0-9_-])(?:token|secret|auth)["']?\s*[:=]\s*["']?(?=[A-Za-z0-9_\-./+=]*\d)[A-Za-z0-9_\-./+=]{12,}/gi,
  },
  {
    // 中文写法（2026-10-28 补）：「密码是 xxx / 密钥为 xxx / 口令：xxx」。
    // 英文规则只认 keyword=value，中文「密码」+「是/为/冒号」匹配不上，用户全程中文交流必踩。
    name: 'secret-assignment-zh',
    re: /(?:密码|密钥|口令|秘钥|令牌)\s*(?:是|为|等于|[:：])\s*["'「]?[A-Za-z0-9!@#$%^&*()_\-./+=:,;?~]{6,}/gi,
  },
  {
    // 只隔一个空格（「数据库密码 abcd1234」）时误报风险高，要求值里有数字。
    name: 'secret-spaced-zh',
    re: /(?:密码|密钥|口令|秘钥|令牌)\s+(?=[A-Za-z0-9!@#$%^&*_\-./+=]*\d)[A-Za-z0-9!@#$%^&*_\-./+=]{6,}/g,
  },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  // sk- 是 OpenAI、Anthropic、DeepSeek 等常用格式；要求含数字，避开 sk-learn 这类普通词。
  { name: 'sk-key', re: /\bsk[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/g },
  { name: 'known-prefix', re: /\b(?:ghp|gho|ghu|ghs|ghr|glpat)[_-][A-Za-z0-9_-]{16,}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi },
  { name: 'basic-auth-header', re: /\bAuthorization["']?\s*[:=]\s*["']?Basic\s+[A-Za-z0-9+/=]{8,}/gi },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: 'connection-string',
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?|mssql|sqlserver):\/\/[^\s"']{8,}/gi,
  },
  // 任意协议的 URL 里带账号密码，如 https://user:pass@host。
  { name: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s/@"']+@[^\s"']+/gi },
]

/** 身份证第 18 位校验码：前 17 位加权求和对 11 取余。 */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECK = '10X98765432'

function isValidIdCard(value) {
  const id = value.toUpperCase()
  const month = Number(id.slice(10, 12))
  const day = Number(id.slice(12, 14))
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  let sum = 0
  for (let i = 0; i < 17; i += 1) sum += Number(id[i]) * ID_WEIGHTS[i]
  return ID_CHECK[sum % 11] === id[17]
}

/**
 * 个人隐私（手机号、身份证）。和密钥分开：密钥一律不该存，隐私可以用配置放行。
 * 身份证要过校验码，普通的 18 位数字不算。
 * @returns {{hit:boolean, rules:string[]}}
 */
export function scanPii(text) {
  const source = String(text ?? '')
  const hits = []
  if (/(?<![0-9A-Za-z])(?:\+?86[- ]?)?1[3-9]\d(?:[- ]?\d{4}){2}(?![0-9A-Za-z])/.test(source)) hits.push('phone-cn')
  for (const match of source.matchAll(/(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g)) {
    if (isValidIdCard(match[0])) {
      hits.push('id-card-cn')
      break
    }
  }
  return { hit: hits.length > 0, rules: hits }
}

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
