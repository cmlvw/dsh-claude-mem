import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildRerankPrompt, parseRerankIds, rerankHits } from '../src/rerank.js'

function hit(id, title, body = '正文') {
  return { entry: { id, title, body }, score: 1 }
}

const HITS = [hit('a', '全局库放 D 盘', '全局库默认位置'), hit('b', '精排默认关', '语义精排默认关闭'), hit('c', 'KV q4_0', '显存实测')]

function fakeResponse(content, ok = true) {
  return { ok, json: async () => ({ choices: [{ message: { content } }] }) }
}

test('默认关：一次网络都不发，顺序原样返回', async () => {
  let calls = 0
  const result = await rerankHits(HITS, {
    enabled: false,
    fetchImpl: async () => {
      calls += 1
      return fakeResponse('{"ids":["b"]}')
    },
  })
  assert.equal(calls, 0)
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'disabled')
  assert.deepEqual(result.hits.map((h) => h.entry.id), ['a', 'b', 'c'])
})

test('开启后按模型返回重排，并过滤候选外 id、按 maxPicks 截断', async () => {
  let body
  const result = await rerankHits(HITS, {
    enabled: true,
    maxPicks: 2,
    query: '精排默认开还是关',
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body)
      return fakeResponse('{"ids":["b","c","a","不存在"]}')
    },
  })
  assert.equal(result.applied, true)
  assert.equal(result.reason, 'ok')
  assert.deepEqual(result.hits.map((h) => h.entry.id), ['b', 'c'])
  assert.match(body.messages[1].content, /精排默认开还是关/)
  assert.match(body.messages[1].content, /id=a/)
  assert.equal(body.max_tokens, 256)
  assert.equal(body.temperature, 0)
})

test('模型明确返回空数组 = 零注入，而不是退回 Stage 1 噪音', async () => {
  const result = await rerankHits(HITS, { enabled: true, fetchImpl: async () => fakeResponse('{"ids":[]}') })
  assert.equal(result.applied, true)
  assert.equal(result.reason, 'model-empty')
  assert.deepEqual(result.hits, [])
})

test('模型只返回候选外 id（幻觉）→ 零注入', async () => {
  const result = await rerankHits(HITS, { enabled: true, fetchImpl: async () => fakeResponse('{"ids":["zzz"]}') })
  assert.equal(result.applied, true)
  assert.deepEqual(result.hits, [])
})

test('失败/超时/坏 JSON/HTTP 错 → 原样退回 Stage 1，不重试', async () => {
  const badJson = await rerankHits(HITS, { enabled: true, fetchImpl: async () => fakeResponse('抱歉我不会') })
  assert.equal(badJson.applied, false)
  assert.equal(badJson.reason, 'bad-json')
  assert.deepEqual(badJson.hits.map((h) => h.entry.id), ['a', 'b', 'c'])

  let attempts = 0
  const httpError = await rerankHits(HITS, {
    enabled: true,
    fetchImpl: async () => {
      attempts += 1
      return fakeResponse('', false)
    },
  })
  assert.equal(attempts, 1)
  assert.equal(httpError.applied, false)
  assert.equal(httpError.reason, 'http-error')

  const thrown = await rerankHits(HITS, { enabled: true, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(thrown.applied, false)
  assert.equal(thrown.reason, 'error')

  const timeout = await rerankHits(HITS, {
    enabled: true,
    timeoutMs: 10,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  })
  assert.equal(timeout.applied, false)
  assert.equal(timeout.reason, 'timeout')
  assert.deepEqual(timeout.hits.map((h) => h.entry.id), ['a', 'b', 'c'])
})

test('没有候选时不发请求；fetch 不可用时 fail-open', async () => {
  let calls = 0
  const empty = await rerankHits([], { enabled: true, fetchImpl: async () => { calls += 1; return fakeResponse('{"ids":[]}') } })
  assert.equal(calls, 0)
  assert.equal(empty.reason, 'empty-candidates')

  const noFetch = await rerankHits(HITS, { enabled: true, fetchImpl: null })
  assert.equal(noFetch.applied, false)
  assert.equal(noFetch.reason, 'no-fetch')
})

test('解析：容忍 ```json 围栏和前后废话，只接受 {ids: string[]}', () => {
  assert.deepEqual(parseRerankIds('```json\n{"ids":["a","b"]}\n```'), ['a', 'b'])
  assert.deepEqual(parseRerankIds('好的：{"ids":["a"]} 以上'), ['a'])
  assert.equal(parseRerankIds('{"ids":"a"}'), null)
  assert.equal(parseRerankIds(''), null)
  assert.equal(parseRerankIds('not json'), null)
})

test('候选项提示词只带标题 + 60 字摘要，防止 token 膨胀', () => {
  const long = hit('x', '标题', '长'.repeat(200))
  const prompt = buildRerankPrompt('查询', [long], 5)
  assert.match(prompt, /id=x/)
  assert.equal(Array.from(prompt).length < 400, true)
})
