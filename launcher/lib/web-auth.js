'use strict'

/**
 * Web 认证握手自检。
 *
 * 为什么需要它（2026-10-08 真实事故）：
 *   用户看到浏览器正文是
 *     `dsh web authentication required; reopen the URL printed by dsh web.`
 *   这句话只可能来自一个地方 —— 请求 `/` 时**没有携带有效 token**，
 *   服务器按 `browser-auth.ts:302-310` 回了 401。也就是说：地址本身没问题，
 *   问题出在"交给浏览器的那条 URL 在路上把 token 丢了"。
 *
 *   旧实现无法回答"我交出去的 URL 到底能不能过鉴权"，因为它只检查
 *   `spawn()` 有没有抛异常。于是启动器一路绿灯，用户一路 401。
 *
 * 本模块把这件事变成**可以在交付前跑一次的真断言**：
 *   第 1 跳  带 token 的 GET `/`      → 期望 303 + `Set-Cookie: dsh-auth-…`
 *   第 2 跳  带 cookie 的 GET `./`    → 期望 200 + HTML
 * 两跳都成立，才说明"这条 URL 交给浏览器能进得去"。
 *
 * 证据链（本地源码）：
 *   packages/client/connection/src/browser-auth.ts:223-227  authenticatedUrl() 挂 token
 *   packages/client/connection/src/browser-auth.ts:246-279  根路径 token → 铸 cookie → 303
 *   packages/client/connection/src/browser-auth.ts:302-310  其余一律 401
 *   packages/client/connection/src/browser-auth.ts:135-137  cookie 名 = dsh-auth-<base64url>
 *
 * 副作用声明：**无**。cookie 是 HMAC 自校验的客户端凭据，服务端不落状态；
 * 该 GET 不消耗 token、不改变实例状态，可任意次重放。
 */

const http = require('node:http')
const https = require('node:https')

/** cookie 前缀，取自上游常量 COOKIE_PREFIX。 */
const COOKIE_PREFIX = 'dsh-auth-'

/** DSH 未鉴权时的正文（上游原文，用于识别"果然是 401"）。 */
const UNAUTHORIZED_BODY = 'dsh web authentication required'

/**
 * 单跳 GET，**不跟随重定向**。
 * @param {string} url - 目标 URL
 * @param {{ cookie?: string, timeoutMs?: number }} [options] - 携带的 cookie 与超时
 * @returns {Promise<{ status: number, location: string, setCookie: string[], contentType: string, bytes: number, body: string, error?: string }>} 响应摘要
 */
function getOnce(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000
  return new Promise((resolve) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      resolve({ status: 0, location: '', setCookie: [], contentType: '', bytes: 0, body: '', error: 'URL 无法解析' })
      return
    }
    const client = parsed.protocol === 'https:' ? https : http
    const headers = { 'user-agent': 'nomad-launcher' }
    if (typeof options.cookie === 'string' && options.cookie !== '') headers.cookie = options.cookie

    const request = client.request(parsed, { method: 'GET', timeout: timeoutMs, headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        const raw = response.headers['set-cookie']
        resolve({
          status: response.statusCode ?? 0,
          location: String(response.headers.location ?? ''),
          setCookie: Array.isArray(raw) ? raw : (raw === undefined ? [] : [String(raw)]),
          contentType: String(response.headers['content-type'] ?? ''),
          bytes: Buffer.byteLength(body, 'utf8'),
          body,
        })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error(`握手超时（${String(timeoutMs)}ms）`))
    })
    request.on('error', (error) => {
      resolve({ status: 0, location: '', setCookie: [], contentType: '', bytes: 0, body: '', error: error.message })
    })
    request.end()
  })
}

/**
 * 从 Set-Cookie 头里取出 `name=value` 形态（仅取第一段，属名值对）。
 * @param {string[]} setCookie - Set-Cookie 头数组
 * @returns {{ cookie: string, name: string }} cookie 串与 cookie 名
 */
function extractCookie(setCookie) {
  for (const item of setCookie) {
    const pair = item.split(';')[0].trim()
    const at = pair.indexOf('=')
    if (at === -1) continue
    return { cookie: pair, name: pair.slice(0, at) }
  }
  return { cookie: '', name: '' }
}

/**
 * 跑一次完整认证握手自检。
 * @param {string} url - **带 token** 的访问地址（state.url）
 * @param {{ timeoutMs?: number }} [options] - 单跳超时
 * @returns {Promise<{ ok: boolean, steps: Array<object>, cookieName?: string, error?: string }>} 结果
 */
async function verifyAuthHandshake(url, options = {}) {
  const steps = []
  const first = await getOnce(url, { timeoutMs: options.timeoutMs })
  steps.push({
    hop: 1,
    target: '根路径（带 token）',
    status: first.status,
    location: first.location,
    bytes: first.bytes,
  })
  if (first.error !== undefined) {
    return { ok: false, steps, error: `第 1 跳失败：${first.error}` }
  }
  if (first.status === 401) {
    return {
      ok: false,
      steps,
      error: '第 1 跳 401：服务器没收到有效 token（这正是浏览器上报的错）。'
        + '说明地址里的 `?token=…` 在交付途中丢掉了，而不是服务器有问题。',
    }
  }
  if (first.status !== 303 && first.status !== 302 && first.status !== 307) {
    if (first.status === 200) {
      // 上游实现在根路径带合法 token 时恒 303。直接 200 说明该构建的握手形态不同，
      // 不判失败，但要如实标注。
      return { ok: true, steps, error: undefined, cookieName: undefined, note: '根路径直接 200（未走 303 铸 cookie 路径）' }
    }
    return { ok: false, steps, error: `第 1 跳 HTTP ${String(first.status)}（期望 303 铸 cookie）` }
  }

  const { cookie, name } = extractCookie(first.setCookie)
  if (cookie === '') {
    return { ok: false, steps, error: '第 1 跳 303 但没有下发 Set-Cookie（浏览器会一直 401）' }
  }
  if (!name.startsWith(COOKIE_PREFIX)) {
    return { ok: false, steps, error: `第 1 跳的 cookie 名不是 ${COOKIE_PREFIX}… ：${name}` }
  }

  const second = await getOnce(new URL(first.location === '' ? './' : first.location, url).toString(), {
    cookie,
    timeoutMs: options.timeoutMs,
  })
  steps.push({
    hop: 2,
    target: '干净相对路径（带 cookie）',
    status: second.status,
    location: second.location,
    bytes: second.bytes,
  })
  if (second.error !== undefined) {
    return { ok: false, steps, cookieName: name, error: `第 2 跳失败：${second.error}` }
  }
  if (second.status !== 200) {
    return { ok: false, steps, cookieName: name, error: `第 2 跳 HTTP ${String(second.status)}（期望 200）` }
  }
  if (second.bytes === 0) {
    return { ok: false, steps, cookieName: name, error: '第 2 跳 200 但响应体为空' }
  }
  return { ok: true, steps, cookieName: name }
}

/**
 * 把握手结果渲染成一行可读文本（status / doctor 共用）。
 * @param {object|undefined|null} handshake - 握手结果
 * @returns {string} 描述
 */
function describeHandshake(handshake) {
  if (handshake === undefined || handshake === null) return '未自检'
  if (handshake.ok === true) {
    return `通过（303 铸 cookie${handshake.cookieName === undefined ? '' : ` ${handshake.cookieName.slice(0, 16)}…`} → 200）`
  }
  return `未通过：${String(handshake.error ?? '未知原因')}`
}

module.exports = {
  verifyAuthHandshake,
  describeHandshake,
  getOnce,
  extractCookie,
  COOKIE_PREFIX,
  UNAUTHORIZED_BODY,
}
