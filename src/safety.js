/**
 * dsh-claude-mem · 写入内容的注入检测
 *
 * 记忆会在以后的会话里被注入，所以写入是提示注入的入口。这里只做「需要人看一眼」的判断：
 * 命中不拒收，而是走用户确认。正常的偏好也可能撞上规则（如「以后不用确认」），
 * 判断权留给用户；而用换种说法绕过规则的内容，由核心层的审批兜底。
 */

/** 不可见字符：零宽、双向控制、Unicode 标签字符，常用来藏指令。 */
const INVISIBLE_CODE_POINTS = [
  [0x200b, 0x200b],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xe0000, 0xe007f],
]

function hasInvisibleChars(text) {
  for (const char of text) {
    const code = char.codePointAt(0)
    if (INVISIBLE_CODE_POINTS.some(([from, to]) => code >= from && code <= to)) return true
  }
  return false
}

const RULES = [
  {
    name: 'override-instructions',
    re: /(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|system)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules?)\b/i,
  },
  {
    name: 'override-instructions-zh',
    re: /(?:忽略|无视|忘掉|忘记|覆盖)[^。\n]{0,20}(?:之前|此前|以上|上面|前面|所有|全部|系统)[^。\n]{0,12}(?:指令|指示|提示词?|规则|要求|设定)/,
  },
  { name: 'role-takeover', re: /\byou\s+are\s+now\b|\bact\s+as\s+(?:the\s+)?(?:system|developer|admin)/i },
  { name: 'role-takeover-zh', re: /(?:从现在起|从现在开始|接下来)[^。\n]{0,6}你(?:就)?是|你现在(?:的身份)?是(?:系统|管理员|开发者)/ },
  {
    name: 'prompt-leak',
    re: /\b(?:reveal|show|print|output|leak|expose|repeat)\b[^.\n]{0,30}\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  },
  {
    // 中文语序两种都常见：「输出系统提示词」和「把系统提示词输出给我」。
    name: 'prompt-leak-zh',
    re: /(?:输出|泄露|打印|显示|透露|复述)[^。\n]{0,15}(?:系统提示|系统指令|开发者指令)|(?:系统提示|系统指令|开发者指令)[^。\n]{0,12}(?:输出给|泄露|打印|透露|复述|发给|告诉)/,
  },
  {
    name: 'skip-confirmation',
    re: /\b(?:without|skip|bypass|never\s+ask\s+for|no\s+need\s+for)\b[^.\n]{0,20}\b(?:confirm(?:ation)?|approval|permission|review)\b/i,
  },
  { name: 'skip-confirmation-zh', re: /(?:不用|不必|无需|无须|不需要|不要|别|跳过|绕过)[^。\n]{0,8}(?:确认|审批|批准|授权|询问|征求)/ },
  { name: 'claimed-consent-zh', re: /用户(?:已经?|早已|之前已)(?:同意|授权|批准|确认)/ },
  { name: 'claimed-consent', re: /\b(?:user|owner|admin)\s+(?:has\s+)?(?:already\s+)?(?:approved|authorized|consented|agreed)\b/i },
  {
    name: 'exfiltration',
    re: /\b(?:send|upload|post|curl|wget|exfiltrate|forward)\b[^\n]{0,60}https?:\/\//i,
  },
  { name: 'exfiltration-zh', re: /(?:发送|发到|上传|提交|转发|传到)[^\n]{0,40}https?:\/\//i },
  {
    name: 'standing-action-zh',
    re: /(?:每次|每轮|每当)[^。\n]{0,10}(?:回答|回复|开始|启动)[^。\n]{0,6}(?:前|时)[^。\n]{0,6}(?:先)?(?:执行|运行|调用|发送|读取)/,
  },
]

const RELATIVE_DATE_RE = /昨天|昨日|今天|今日|明天|明日|前天|后天|上周|上星期|本周|这周|这星期|下周|下星期|上个?月|本月|这个月|下个?月|去年|今年|明年|前几天|上次发布|yesterday|today|tomorrow|last (?:week|month|year)|next (?:week|month|year)|this (?:week|month|year)/i
const ABSOLUTE_DATE_RE = /\b(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b|(?:19|20)\d{2}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*[日号]/

/** 文本里有相对日期，而且没有绝对日期帮助理解。 */
export function hasRelativeDate(text) {
  const source = String(text ?? '')
  return RELATIVE_DATE_RE.test(source) && !ABSOLUTE_DATE_RE.test(source)
}

/**
 * @param {string} text
 * @returns {{hit:boolean, rules:string[]}}
 */
export function scanDirective(text) {
  const source = String(text ?? '')
  const rules = RULES.filter((rule) => rule.re.test(source)).map((rule) => rule.name)
  if (hasInvisibleChars(source)) rules.push('invisible-chars')
  return { hit: rules.length > 0, rules }
}
