'use strict'

/**
 * 状态文件与心跳判定测试。
 * 重点：心跳过期时必须判定为"不新鲜"——这是 `nomad stop` 拒绝误杀无关进程的依据。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  stateFile,
  readState,
  writeState,
  clearState,
  isAlive,
  isFresh,
  HEARTBEAT_MAX_AGE_MS,
} = require('../launcher/lib/state.js')

/** 建一个临时 NOMAD_ROOT（只含本测试需要的目录）。 */
function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-state-'))
}

test('写入 / 读取 / 清理 往返', () => {
  const root = tempRoot()
  assert.equal(readState(root), null)

  const file = writeState(root, { phase: 'ready', heartbeatAt: new Date().toISOString(), url: 'http://127.0.0.1:1/?token=t' })
  assert.equal(file, stateFile(root))
  assert.ok(fs.existsSync(file))

  const state = readState(root)
  assert.equal(state.phase, 'ready')
  assert.ok(state.url.includes('token=t'), '状态文件需要保存带 token 的 URL')

  clearState(root)
  assert.equal(readState(root), null)
})

test('损坏的状态文件不抛错，按缺失处理', () => {
  const root = tempRoot()
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true })
  fs.writeFileSync(stateFile(root), '{ 不是合法 JSON')
  assert.equal(readState(root), null)
})

test('新鲜心跳判定为新鲜', () => {
  const now = new Date().toISOString()
  assert.equal(isFresh({ heartbeatAt: now }), true)
  assert.equal(isFresh({ startedAt: now }), true)
})

test('过期心跳判定为陈旧（stop 的安全依据）', () => {
  const stale = new Date(Date.now() - HEARTBEAT_MAX_AGE_MS - 1000).toISOString()
  assert.equal(isFresh({ heartbeatAt: stale }), false)
})

test('缺少时间戳或为 null 时判定为陈旧（宁可保守）', () => {
  assert.equal(isFresh({}), false)
  assert.equal(isFresh(null), false)
  assert.equal(isFresh({ heartbeatAt: 'not-a-date' }), false)
})

test('isAlive 对不存在的 PID 返回 false，对本进程返回 true', () => {
  assert.equal(isAlive(0), false)
  assert.equal(isAlive(-1), false)
  assert.equal(isAlive(999999), false)
  assert.equal(isAlive(process.pid), true)
})
