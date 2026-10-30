/**
 * dsh-claude-mem · 快照消息构造
 *
 * 为什么自己造：@deepseek-ai/dsh-llm 在 profile 的 node_modules 里不可解析
 * （它被 esbuild 打进各插件的 bundle），本包又是「零第三方运行时依赖」。所以
 * 这里按 dsh-llm createUserMessage 的产出形状手造等价对象：
 *   { id:uuid, role:'user', content:[{type:'text',text}], source:{...} }
 * 与 meow 一致的地方是 form:'snapshot' + sections，让它成为「插件附带的一段
 * 上下文」而不是用户说的话（注入绝不改用户 prompt，§5 末行）。
 */
import { randomUUID } from 'node:crypto'

export const PLUGIN_NAME = 'dsh-claude-mem'
export const PLUGIN_KIND = `plugin:${PLUGIN_NAME}`

/**
 * @param {string} text 注入正文
 * @param {{injectionKind?: string, sections?: Array<{name:string,text:string}>, meta?: object}} [opts]
 *   注意 source.kind 是「插件身份」，不拿它表示注入类型（两者共用一个字段会互相覆盖，
 *   meow 的姿势也是把注入类型放进 meta/sections）。注入类型放 meta.injectionKind。
 */
export function createSnapshotMessage(text, opts = {}) {
  const sections = Array.isArray(opts.sections) ? opts.sections : [{ name: '长期记忆', text }]
  const meta = {
    ...(opts.meta === undefined ? {} : opts.meta),
    ...(opts.injectionKind === undefined ? {} : { injectionKind: opts.injectionKind }),
  }
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: PLUGIN_KIND,
      plugin: PLUGIN_NAME,
      form: 'snapshot',
      sections,
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
    },
  }
}

/** 判断一条消息是不是本插件注入的（去重、压缩重注入检测都要用）。 */
export function isOwnSnapshot(message) {
  const source = message?.source
  if (source === null || typeof source !== 'object') return false
  return source.kind === PLUGIN_KIND || (source.kind === 'plugin' && source.plugin === PLUGIN_NAME)
}
