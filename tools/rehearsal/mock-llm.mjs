#!/usr/bin/env node
/**
 * dsh-claude-mem · 演练用假模型（M6 回滚演练的基础设施）
 *
 * 为什么需要它：演练要证明「插件真的往里注入了记忆块」，而注入块最终体现在
 * 模型收到的 messages 里。本机 127.0.0.1:8080 没有在跑，且真模型每次都有随机性；
 * 假模型把**每次请求的 messages 原样**追加到 jsonl，光凭日志就能逐字断言。
 *
 * 协议：OpenAI 兼容（dsh-llm-pi-ai 的 api=openai-completions 走这个）。
 *   GET  /v1/models        → 模型清单
 *   POST /v1/chat/completions → 非流式 JSON / 流式 SSE 都支持（DSH 可能带 stream:true）
 *
 * 用法：
 *   node tools/rehearsal/mock-llm.mjs --port 18777 --log <path.jsonl>
 */
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

function parseArgs(argv) {
  const args = { port: 18777, log: 'mock-llm.jsonl', model: 'rehearsal-mock' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') args.port = Number(argv[++i])
    else if (argv[i] === '--log') args.log = argv[++i]
    else if (argv[i] === '--model') args.model = argv[++i]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
writeFileSync(args.log, '')

function record(payload) {
  appendFileSync(args.log, `${JSON.stringify(payload)}\n`)
}

function replyText() {
  return 'rehearsal-ack'
}

/** 非流式响应。 */
function nonStreaming(id, model, text) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

/** 流式 SSE：先 delta 文本，再 stop，最后 [DONE]。 */
function streamBody(id, model, text) {
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return (
    chunk({ role: 'assistant', content: '' }) +
    chunk({ content: text }) +
    chunk({}, 'stop') +
    'data: [DONE]\n\n'
  )
}

const server = createServer((req, res) => {
  const url = req.url ?? '/'
  if (req.method === 'GET' && url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: args.model, object: 'model', owned_by: 'rehearsal' }] }))
    return
  }

  if (req.method !== 'POST' || !url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${url}` } }))
    return
  }

  const chunks = []
  req.on('data', (piece) => chunks.push(piece))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = { raw: Buffer.concat(chunks).toString('utf8') }
    }
    const id = `chatcmpl-rehearsal-${Date.now()}`
    const model = body.model ?? args.model
    record({ at: new Date().toISOString(), model, stream: body.stream === true, messages: body.messages ?? [] })

    const text = replyText()
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.end(streamBody(id, model, text))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(nonStreaming(id, model, text)))
    }
  })
})

server.listen(args.port, '127.0.0.1', () => {
  console.log(`mock-llm listening on http://127.0.0.1:${args.port} (log: ${args.log})`)
})
