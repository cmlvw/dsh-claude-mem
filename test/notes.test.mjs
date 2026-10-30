import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { openMemoryDb } from '../src/db.js'
import {
  isSmallTalk,
  listNotes,
  NOTE_KIND,
  noteStats,
  shouldNoteUserAsk,
  summarizeForNote,
  writeNote,
} from '../src/notes.js'

let tmp
let seq = 0
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-claude-mem-notes-'))
})
after(() => {
  rmSync(tmp, { recursive: true, force: true })
})
const dbPath = () => join(tmp, `notes-${(seq += 1)}.db`)

test('小会话笔记：寒暄不记，有信息量才记', () => {
  assert.equal(isSmallTalk('好的'), true)
  assert.equal(isSmallTalk('嗯嗯'), true)
  assert.equal(isSmallTalk('继续'), true)
  assert.equal(isSmallTalk('OK'), true)
  assert.equal(isSmallTalk('这个方案我觉得可行'), false)

  assert.equal(shouldNoteUserAsk('好的'), false)
  assert.equal(shouldNoteUserAsk('嗯'), false)
  assert.equal(shouldNoteUserAsk('这个插件要用 node:sqlite'), true)
  // 纯空格/标点
  assert.equal(shouldNoteUserAsk('   '), false)
  // 门槛可调
  assert.equal(shouldNoteUserAsk('这是十个字的句子啊', { minChars: 20 }), false)
})

test('summarizeForNote：长文截断带省略号，短文本原样', () => {
  const long = '甲'.repeat(300)
  const out = summarizeForNote(long, 100)
  assert.equal(Array.from(out).length, 100)
  assert.ok(out.endsWith('…'))
  assert.equal(summarizeForNote('短句', 100), '短句')
  // 换行压成单空格（一行一条）
  assert.equal(summarizeForNote('第一行\n第二行', 100), '第一行 第二行')
})

test('writeNote：正常写入，能按键读回', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const r = writeNote(db, { sessionId: 's1', workspace: 'ws', kind: NOTE_KIND.userAsk, body: '讨论 M5 的 dream 门控' }, 1000)
    assert.equal(r.written, true)
    assert.ok(r.id)
    const rows = listNotes(db, 's1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].body, '讨论 M5 的 dream 门控')
    assert.equal(rows[0].kind, 'user-ask')
    assert.equal(rows[0].at, 1000)
    assert.equal(noteStats(db).count, 1)
  } finally {
    db.close()
  }
})

test('writeNote：命中密钥直接不写（笔记来自真实对话，必须拦）', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    const cases = [
      '我的 api_key: sk-abcdefghijklmnopqrstuvwx',
      '密钥是 Abc123Xyz789Qwe',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
      'github_pat_11ABCDEFG0123456789_abcdefghij',
    ]
    for (const body of cases) {
      const r = writeNote(db, { sessionId: 's-secret', workspace: 'ws', kind: NOTE_KIND.userAsk, body }, 1000)
      assert.equal(r.written, false, `应拒写：${body}`)
      assert.ok(String(r.reason).startsWith('secret:'), r.reason)
    }
    assert.equal(noteStats(db).count, 0, '被拦的一条都不该落库')
  } finally {
    db.close()
  }
})

test('writeNote：缺参数/坏库不 throw，只返回未写入', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    assert.equal(writeNote(null, { sessionId: 's', kind: 'x', body: '正文' }).written, false)
    assert.equal(writeNote(db, { sessionId: '', kind: 'x', body: '正文' }).written, false)
    assert.equal(writeNote(db, { sessionId: 's', kind: '', body: '正文' }).written, false)
    assert.equal(writeNote(db, { sessionId: 's', kind: 'x', body: '   ' }).written, false)
  } finally {
    db.close()
  }
  assert.equal(writeNote(db, { sessionId: 's', kind: 'x', body: '正文' }).written, false)
})

test('writeNote：正文按 maxChars 截断后入库', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    writeNote(db, { sessionId: 's-long', workspace: 'ws', kind: NOTE_KIND.userAsk, body: '长'.repeat(500) }, 1000)
    const rows = listNotes(db, 's-long')
    assert.equal(rows.length, 1)
    assert.equal(Array.from(rows[0].body).length, 200, '默认 200 字上限')
  } finally {
    db.close()
  }
})

test('listNotes：按会话隔离、按时间升序', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    writeNote(db, { sessionId: 'a', workspace: 'ws', kind: NOTE_KIND.userAsk, body: '第二条' }, 2000)
    writeNote(db, { sessionId: 'a', workspace: 'ws', kind: NOTE_KIND.userAsk, body: '第一条' }, 1000)
    writeNote(db, { sessionId: 'b', workspace: 'ws', kind: NOTE_KIND.userAsk, body: '别的会话' }, 1500)
    const rows = listNotes(db, 'a')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.body), ['第一条', '第二条'])
  } finally {
    db.close()
  }
})

test('noteStats：since 过滤生效', () => {
  const opened = openMemoryDb(dbPath())
  const db = opened.db
  try {
    writeNote(db, { sessionId: 's', kind: NOTE_KIND.userAsk, body: '旧笔记内容' }, 1000)
    writeNote(db, { sessionId: 's', kind: NOTE_KIND.userAsk, body: '新笔记内容' }, 5000)
    assert.equal(noteStats(db).count, 2)
    assert.equal(noteStats(db, { since: 3000 }).count, 1)
  } finally {
    db.close()
  }
})
