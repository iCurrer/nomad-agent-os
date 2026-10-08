#!/usr/bin/env node
'use strict'

/**
 * 假 DSH —— 仅用于冒烟测试的替身运行时。
 *
 * 它**不是** DeepSeek Harness，也从不假装是：只复刻启动器依赖的三个外部可观测行为：
 *   1. 接受 `--profile/--host/--port/--no-open` 参数族（与真实 DSH 同形）；
 *   2. 绑定 HTTP 端口并打印 `dsh web: <url>` 启动行（含 token 形态）；
 *   3. 在 $DSH_HOME 下写会话（用于**实测**零污染，而不是口头声明）；
 *   4. 忽略 SIGTERM 之外的信号，收到 SIGTERM 后干净退出。
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

/**
 * 取参数值。
 * @param {string} name - 参数名
 * @param {string} fallback - 缺省值
 * @returns {string} 值
 */
function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const host = argValue('--host', '127.0.0.1')
const port = Number(argValue('--port', '0'))
const profile = argValue('--profile', 'web')

// ── 零污染实证：把会话写进 $DSH_HOME，把临时文件写进 $TEMP ──────────────
const dshHome = process.env.DSH_HOME
const temp = process.env.TEMP ?? process.env.TMP
if (typeof dshHome === 'string' && dshHome !== '') {
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true })
  fs.writeFileSync(
    path.join(dshHome, 'sessions', 'fake-session.jsonl'),
    `${JSON.stringify({ type: 'session/start', profile, pid: process.pid })}\n`,
    'utf8',
  )
}
if (typeof temp === 'string' && temp !== '') {
  fs.mkdirSync(temp, { recursive: true })
  fs.writeFileSync(path.join(temp, 'fake-tmp-probe'), 'ok', 'utf8')
}

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><html><body>fake dsh web</body></html>')
})

server.listen(port, host, () => {
  const address = server.address()
  const actual = typeof address === 'object' && address !== null ? address.port : port
  console.log(`fake-dsh: profile=${profile} 已绑定 ${host}:${String(actual)}`)
  console.log(`dsh web: http://${host}:${String(actual)}/?token=smoke-token`)
})

process.on('SIGTERM', () => {
  console.log('fake-dsh: 收到 SIGTERM，优雅退出')
  server.close(() => {
    process.exit(0)
  })
  setTimeout(() => {
    process.exit(0)
  }, 500)
})
process.on('SIGINT', () => {
  process.exit(0)
})
