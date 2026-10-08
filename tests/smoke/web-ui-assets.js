#!/usr/bin/env node
'use strict'

/**
 * Web UI Assets Probe —— **只读**巡检运行中实例的前端资源健康度。
 *
 * 为什么要有它（2026-10-08）：`real-runtime-smoke.js` 原先只断言「首页 200 + 非空」，
 * 这证明不了界面跑得起来 —— `index.html` 只是个壳，真正的 UI 由
 * `assets/*.js`（Vite 主包）+ `plugins/??…`（客户端模块总包，约 11MB）撑起来。
 * 其中任意一个取不到，浏览器就是**白屏**，而壳的 200 依旧漂亮。
 *
 * 与其它冒烟测试的关系：
 *   - 本探针**不启动、不停止**实例，不改写任何状态文件 → 有实例在跑时也能安全执行。
 *   - 只读 `data/run/nomad.state.json` 拿 token URL，随后只发 GET。
 *   - 无运行中实例时打印 `[SKIP]` 并以 0 退出 —— 那是**未执行，不是通过**。
 *
 * 用法：node tests/smoke/web-ui-assets.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const STATE = path.join(ROOT, 'data', 'run', 'nomad.state.json')

/**
 * 带 cookie 发一次 GET（不跟跳转，由调用方决定）。
 * @param {string} url - 目标 URL
 * @param {string|null} cookie - cookie 串
 * @returns {Promise<{ status: number, bytes: number, contentType: string, body: string, location: string|null, cookie: string|null }>}
 */
function get(url, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 30000, headers: cookie === null ? {} : { cookie } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        const setCookie = response.headers['set-cookie']
        resolve({
          status: response.statusCode ?? 0,
          bytes: Buffer.byteLength(body, 'utf8'),
          contentType: String(response.headers['content-type'] ?? ''),
          body,
          location: response.headers.location ?? null,
          cookie: Array.isArray(setCookie) ? setCookie.map((item) => item.split(';')[0]).join('; ') : cookie,
        })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error('HTTP 探测超时'))
    })
    request.on('error', reject)
  })
}

/**
 * 走 token URL 拿鉴权 cookie，再取回首页正文。
 * @param {string} tokenUrl - 带 token 的 URL
 * @returns {Promise<{ html: string, finalUrl: string, cookie: string|null, hops: object[] }>}
 */
async function fetchPage(tokenUrl) {
  const hops = []
  let current = tokenUrl
  let cookie = null
  for (let hop = 0; hop <= 4; hop += 1) {
    const response = await get(current, cookie)
    cookie = response.cookie
    hops.push({ status: response.status, location: response.location, bytes: response.bytes })
    if (response.status >= 300 && response.status < 400 && response.location !== null) {
      current = new URL(String(response.location), current).toString()
      continue
    }
    return { html: response.body, finalUrl: current, cookie, hops }
  }
  return { html: '', finalUrl: current, cookie, hops }
}

async function main() {
  if (!fs.existsSync(STATE)) {
    console.log('[SKIP] 没有状态文件（实例未运行）—— 这是未执行，不是通过。')
    return
  }
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  if (typeof state.url !== 'string' || !String(state.url).startsWith('http://127.0.0.1:')) {
    console.log('[SKIP] 状态文件里没有可用的 token URL —— 这是未执行，不是通过。')
    return
  }

  console.log(`实例  profile=${String(state.profile)}  port=${String(state.port)}  启动于 ${String(state.startedAt)}`)
  const page = await fetchPage(String(state.url))
  for (const hop of page.hops) {
    console.log(`      ${String(hop.status)}  ${String(hop.bytes)}B${hop.location === null ? '' : ` → ${hop.location}`}`)
  }
  assert.ok(page.html.length > 0, '首页正文为空 —— 疑似鉴权链路断了')
  console.log(`首页  ${String(Buffer.byteLength(page.html))}B  text/html\n`)

  // 抽出首页引用的全部资源（HTML 里 `&amp;` 要还原成 `&`，否则插件总包取不到）
  const refs = new Set()
  for (const match of page.html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = match[1].replaceAll('&amp;', '&')
    if (raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('//')) continue
    refs.add(raw)
  }
  assert.ok(refs.size >= 8, `首页只引用了 ${String(refs.size)} 个资源，疑似不是完整的 SPA 壳`)

  const bad = []
  let total = 0
  console.log('资源清单：')
  for (const ref of refs) {
    const target = new URL(ref, page.finalUrl).toString()
    const one = await get(target, page.cookie)
    total += one.bytes
    const mark = one.status === 200 ? 'OK ' : '!! '
    const label = ref.length > 78 ? `${ref.slice(0, 78)}…` : ref
    console.log(`  ${mark} ${String(one.status).padStart(3)}  ${String(one.bytes).padStart(9)}B  ${label}`)
    if (one.status !== 200) bad.push(`${String(one.status)}  ${ref}`)
  }

  console.log(`\n合计：${String(refs.size)} 个引用，${(total / 1024 / 1024).toFixed(1)}MB，非 200 的 ${String(bad.length)} 个`)
  assert.deepEqual(bad, [], `有资源取不到（浏览器会白屏）：\n${bad.join('\n')}`)
  console.log('结论：Web UI 资源完整，可正常渲染。')
}

main().catch((error) => {
  console.error(`\n[FAIL] ${error.message}`)
  process.exitCode = 1
})
