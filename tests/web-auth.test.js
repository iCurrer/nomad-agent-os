'use strict'

/**
 * Web 认证握手自检测试。
 *
 * 这里的假服务器**逐条复刻** DSH 上游的鉴权语义
 * （packages/client/connection/src/browser-auth.ts）：
 *   · 根路径 + 合法 token（且仅 1 个）→ 303 + `Set-Cookie: dsh-auth-…`，Location: ./
 *   · 带合法 cookie 的任意路径        → 200
 *   · 其余一切                        → 401 + 正文
 *       `dsh web authentication required; reopen the URL printed by dsh web.`
 *
 * 为什么值得为它写一套假服务器：这条 401 是用户实际看到的报错，而它与
 * 「服务器坏了」无关 —— 是**交付给浏览器的地址丢了 token**。把它固化成测试，
 * 以后再有人改动浏览器交接或 URL 拼装，都会在这里被拦下。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createHmac, randomBytes } = require('node:crypto')

const { verifyAuthHandshake, describeHandshake, COOKIE_PREFIX } = require('../launcher/lib/web-auth.js')

const UNAUTHORIZED_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.\n'

/**
 * 起一个复刻 DSH 鉴权语义的本地服务器。
 * @param {{ token?: string, omitCookie?: boolean, statusOverride?: number|null }} [options] - 剧本
 * @returns {Promise<{ url: string, close: Function, requests: object[] }>} 句柄
 */
function startFakeDsh(options = {}) {
  const token = options.token ?? 'launch-token-abc'
  const secret = randomBytes(32)
  const requests = []
  const cookieName = COOKIE_PREFIX + 'fakeauthority'

  const sign = (authority) => {
    const body = Buffer.from(JSON.stringify({ v: 1, authority }), 'utf8').toString('base64url')
    return `v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
  }

  const server = http.createServer((req, res) => {
    const authority = String(req.headers.host ?? '')
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll('token')
    const rawCookie = String(req.headers.cookie ?? '')
    const hasValidCookie = rawCookie.includes(`${cookieName}=`)
    requests.push({ path: url.pathname, tokens: tokens.length, hasValidCookie })

    if (options.statusOverride !== null && options.statusOverride !== undefined) {
      res.writeHead(options.statusOverride, { 'content-type': 'text/plain' })
      res.end('override')
      return
    }

    if (tokens.length === 1 && tokens[0] === token && req.method === 'GET' && url.pathname === '/') {
      if (options.omitCookie === true) {
        res.writeHead(303, { location: './' })
        res.end()
        return
      }
      res.writeHead(303, {
        location: './',
        'cache-control': 'no-store',
        'set-cookie': `${cookieName}=${sign(authority)}; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }
    if (hasValidCookie) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>ok</body></html>')
      return
    }
    res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end(UNAUTHORIZED_BODY)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${String(port)}/?token=${token}`,
        authority: `127.0.0.1:${String(port)}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

test('握手通过：303 铸 cookie → 带 cookie 取到 200', async () => {
  const fake = await startFakeDsh()
  try {
    const result = await verifyAuthHandshake(fake.url)
    assert.equal(result.ok, true, String(result.error))
    assert.equal(result.steps.length, 2)
    assert.equal(result.steps[0].status, 303)
    assert.equal(result.steps[1].status, 200)
    assert.ok(String(result.cookieName).startsWith(COOKIE_PREFIX), `cookie 名异常：${String(result.cookieName)}`)
  } finally {
    await fake.close()
  }
})

test('握手失败：token 不对 → 401，并且错误信息直接指向"token 丢了"这一根因', async () => {
  const fake = await startFakeDsh()
  try {
    const wrong = fake.url.replace('token=', 'token=WRONG-')
    const result = await verifyAuthHandshake(wrong)
    assert.equal(result.ok, false)
    assert.equal(result.steps[0].status, 401)
    assert.match(String(result.error), /401/)
    assert.match(String(result.error), /token/)
    // 这是给用户看的那句话：问题在地址，不在服务器
    assert.match(String(result.error), /丢/)
  } finally {
    await fake.close()
  }
})

test('握手失败：303 但没下发 Set-Cookie → 判失败（浏览器会一直 401）', async () => {
  const fake = await startFakeDsh({ omitCookie: true })
  try {
    const result = await verifyAuthHandshake(fake.url)
    assert.equal(result.ok, false)
    assert.match(String(result.error), /Set-Cookie/)
  } finally {
    await fake.close()
  }
})

test('握手失败：第 2 跳不是 200 → 判失败', async () => {
  const fake = await startFakeDsh({ statusOverride: 500 })
  try {
    const result = await verifyAuthHandshake(fake.url)
    assert.equal(result.ok, false)
    assert.match(String(result.error), /HTTP 500/)
  } finally {
    await fake.close()
  }
})

test('握手失败：地址不可达 → 判失败且带原因，不抛异常', async () => {
  const result = await verifyAuthHandshake('http://127.0.0.1:1/?token=x', { timeoutMs: 800 })
  assert.equal(result.ok, false)
  assert.ok(String(result.error).length > 0)
})

test('自检是只读的：两次握手对服务器产生的请求形态完全一致（不消耗 token）', async () => {
  const fake = await startFakeDsh()
  try {
    await verifyAuthHandshake(fake.url)
    const first = fake.requests.slice()
    await verifyAuthHandshake(fake.url)
    assert.deepEqual(fake.requests.slice(first.length), first, '两次自检的请求形态应完全一致')
  } finally {
    await fake.close()
  }
})

test('describeHandshake：未知/通过/未通过三种形态都可读', () => {
  assert.equal(describeHandshake(undefined), '未自检')
  assert.match(describeHandshake({ ok: true, cookieName: 'dsh-auth-abcdefghij' }), /^通过/)
  assert.match(describeHandshake({ ok: false, error: '第 1 跳 401' }), /未通过：第 1 跳 401/)
})
