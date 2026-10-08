'use strict'

/**
 * DSH 启动行解析与脱敏测试。
 * 格式来自 bundle/web-app/src/index.ts:290（本地源码证据）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseLaunchLine, sanitizeUrl } = require('../launcher/lib/dsh-url.js')

test('解析带 token 的启动行', () => {
  const parsed = parseLaunchLine('dsh web: http://127.0.0.1:38321/?token=abc123')
  assert.notEqual(parsed, null)
  assert.equal(parsed.url, 'http://127.0.0.1:38321/?token=abc123')
  assert.equal(parsed.port, 38321)
  assert.equal(parsed.lanUrl, undefined)
})

test('解析带 LAN 后缀的启动行', () => {
  const parsed = parseLaunchLine('dsh web: http://127.0.0.1:3080/?token=xyz (LAN: http://192.168.1.7:3080/?token=xyz)')
  assert.equal(parsed.url, 'http://127.0.0.1:3080/?token=xyz')
  assert.equal(parsed.lanUrl, 'http://192.168.1.7:3080/?token=xyz')
  assert.equal(parsed.port, 3080)
})

test('非启动行返回 null（不误吞普通输出）', () => {
  for (const line of ['', 'dsh web: opening the default browser; pass --no-open to disable', 'random output']) {
    assert.equal(parseLaunchLine(line), null, `不应解析：${line}`)
  }
})

test('端口 0 形态（OS 协商后的实际端口由该行给出）', () => {
  const parsed = parseLaunchLine('dsh web: http://127.0.0.1:51234/?token=t')
  assert.equal(parsed.port, 51234)
})

test('脱敏：去掉 query 与 hash，绝不外泄 token', () => {
  assert.equal(sanitizeUrl('http://127.0.0.1:38321/?token=abc123'), 'http://127.0.0.1:38321/')
  assert.equal(sanitizeUrl('http://127.0.0.1:3080/ui/?token=abc#frag'), 'http://127.0.0.1:3080/ui/')
  assert.equal(sanitizeUrl('not a url'), '(unparsable)')
})
