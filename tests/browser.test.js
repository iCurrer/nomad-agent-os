'use strict'

/**
 * 浏览器交接回归测试。
 *
 * 守住的是 2026-10-08 的真实事故：
 *   浏览器正文 = `dsh web authentication required; reopen the URL printed by dsh web.`
 *   根因 = 旧实现把 URL 交给 `explorer.exe`，它既不是"打开 URL"的接口（另开了一个
 *   文件资源管理器窗口 = 用户看到的"自动打开文档管理器页面"），又让 URL 在传递途中
 *   丢掉 query，浏览器于是拿到裸 `http://127.0.0.1:<port>/` → DSH 按 browser-auth
 *   回 401（`packages/client/connection/src/browser-auth.ts:302-310`）。
 *
 * 这类缺陷的特点是**返回值看不出问题**：spawn 不抛异常、explorer.exe 恒返回退出码 1，
 * 于是旧实现"没抛异常 = 成功"的判定永远为真。所以判定必须换成两条硬判据：
 *   (a) 组装出的命令里，带 token 的 URL 必须是**完整的那一个参数**（纯函数，可断言）；
 *   (b) 打开器的**退出码**必须参与判定（0 才叫成功）。
 *
 * 测试全程**不真的开浏览器**：openBrowser 走可注入的 spawnImpl。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  openBrowser,
  buildOpenCommand,
  validateOpenUrl,
  isCmdSafeUrl,
  METHOD,
} = require('../launcher/lib/browser.js')

/** DSH 真实产生的 URL 形态（browser-auth.ts:223-227）。 */
const TOKEN_URL = 'http://127.0.0.1:4850/?token=f8H3Q7ElvtBS6XK537AhExhA1OG1AULdXmR5UNmKmX8'

/**
 * 造一个假的子进程：可按脚本给出退出码 / spawn 错误 / 永不退出。
 * @param {{ exitCode?: number|null, emitError?: string|null, silent?: boolean }} plan - 剧本
 * @returns {{ impl: Function, calls: object[] }} spawn 替身与调用记录
 */
function fakeSpawn(plan = {}) {
  const calls = []
  const impl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stderr.setEncoding = () => {}
    child.unref = () => {}
    child.pid = 4242
    child.stdout = null
    if (plan.emitError !== undefined && plan.emitError !== null) {
      setImmediate(() => child.emit('error', new Error(plan.emitError)))
      return child
    }
    if (plan.silent === true) return child // 永不退出，用于验证"超时不谎报"
    setImmediate(() => {
      if (plan.stderr !== undefined) child.stderr.emit('data', String(plan.stderr))
      child.emit('exit', plan.exitCode === null || plan.exitCode === undefined ? 0 : plan.exitCode)
    })
    return child
  }
  return { impl, calls }
}

test('回归：Windows 默认走 cmd /c start，且 URL 完整保留为单个参数', () => {
  const built = buildOpenCommand(TOKEN_URL, { platform: 'win32' })
  assert.equal(built.method, METHOD.cmdStart)
  assert.equal(built.command, 'cmd.exe')
  // 本次缺陷的守卫：URL 必须原封不动躺在 argv 里，含 ?token=
  assert.ok(built.args.includes(TOKEN_URL), `URL 未被完整保留：${JSON.stringify(built.args)}`)
  assert.deepEqual(built.args, ['/c', 'start', '', TOKEN_URL])
  // 绝不能再回到 explorer
  assert.ok(!built.command.toLowerCase().includes('explorer'), '不得再用 explorer.exe 打开 URL')
})

test('回归：三个平台都不得拆分 URL（query 必须留在同一参数内）', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const built = buildOpenCommand(TOKEN_URL, { platform })
    assert.ok(built.args.includes(TOKEN_URL), `${platform}：URL 被拆开了 → ${JSON.stringify(built.args)}`)
    for (const arg of built.args) {
      assert.ok(!arg.endsWith('token='), `${platform}：出现被截断的 token 参数：${arg}`)
      assert.ok(!arg.includes('?token=') || arg === TOKEN_URL, `${platform}：token 参数被改写：${arg}`)
    }
  }
})

test('win32：URL 含 cmd 元字符时降级到 PowerShell，且命令行上不出现 token 原文', () => {
  const tricky = 'http://127.0.0.1:4850/a?token=x&b=y'
  // 含 `&` → 不可走 cmd（会被当成命令分隔符）
  assert.equal(isCmdSafeUrl(tricky), false)
  const built = buildOpenCommand(tricky, { platform: 'win32' })
  assert.equal(built.error, undefined)
  assert.equal(built.method, METHOD.powershell)
  const encoded = built.args[built.args.indexOf('-EncodedCommand') + 1]
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.ok(decoded.includes(tricky), `被编码的负载里丢了 URL：${decoded}`)
  assert.equal(built.args.some((arg) => arg.includes('token=')), false, '命令行上不应出现 token 原文')
})

test('显式 browser_path：直接拉起该可执行文件（不经 shell，参数零解析）', () => {
  const built = buildOpenCommand(TOKEN_URL, {
    platform: 'win32',
    browserPath: 'C:\\Program Files\\Browser\\browser.exe',
  })
  assert.equal(built.method, METHOD.configuredApp)
  assert.equal(built.command, 'C:\\Program Files\\Browser\\browser.exe')
  assert.deepEqual(built.args, [TOKEN_URL])
  assert.equal(built.kind, 'app', '真实浏览器是长驻进程，不能拿它的退出码当判据')
})

test('macOS / Linux 分别用 open / xdg-open', () => {
  assert.deepEqual(
    buildOpenCommand(TOKEN_URL, { platform: 'darwin' }),
    { command: 'open', args: [TOKEN_URL], method: METHOD.open, kind: 'opener' },
  )
  assert.deepEqual(
    buildOpenCommand(TOKEN_URL, { platform: 'linux' }),
    { command: 'xdg-open', args: [TOKEN_URL], method: METHOD.xdg, kind: 'opener' },
  )
})

test('URL 校验：拒绝注入面与畸形串，且拒绝时必给原因', () => {
  assert.equal(validateOpenUrl(TOKEN_URL).ok, true)
  const rejected = [
    '',
    'not a url',
    'file:///C:/Windows/System32/calc.exe',
    'http://127.0.0.1:4850/?token=a b',
    'http://127.0.0.1:4850/?token=a"b',
    "http://127.0.0.1:4850/?token=a'b",
    'http://127.0.0.1:4850/?token=a`b',
    'http://127.0.0.1:4850/?token=a\\b',
    'http://127.0.0.1:4850/?token=a\nb',
    `http://127.0.0.1:4850/?token=${'x'.repeat(5000)}`,
  ]
  for (const url of rejected) {
    const verdict = validateOpenUrl(url)
    assert.equal(verdict.ok, false, `本应拒绝：${JSON.stringify(url.slice(0, 30))}`)
    assert.ok(String(verdict.error).length > 0, '拒绝时必须给出原因')
  }
})

test('openBrowser：打开器退出码 0 → 成功，判据来自退出码而非"没抛异常"', async () => {
  const { impl, calls } = fakeSpawn({ exitCode: 0 })
  const result = await openBrowser(TOKEN_URL, {
    // 用真实存在的可执行文件路径：本用例验证的是退出码判据，不是路径校验
    browserPath: process.execPath,
    spawnImpl: impl,
  })
  assert.equal(result.ok, true)
  assert.equal(result.method, METHOD.configuredApp)
  // 交给打开器的必须是完整的带 token URL
  assert.deepEqual(calls[0].args, [TOKEN_URL])
})

test('openBrowser：打开器退出码非 0 → ok=false（这是旧实现永远发现不了的那一类）', async () => {
  const { impl } = fakeSpawn({ exitCode: 1, stderr: '系统找不到指定的文件。' })
  // 借 linux 分支的 opener 语义（会等退出码）；命令不存在也无所谓，spawn 被替身接管
  const result = await openBrowser(TOKEN_URL, { spawnImpl: impl, graceMs: 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.match(String(result.error), /退出码 1/)
  assert.match(String(result.error), /系统找不到指定的文件/, '应带上打开器的报错片段以便定位')
})

test('openBrowser：打开器卡住不退出 → ok=false，不谎报成功', async () => {
  const { impl } = fakeSpawn({ silent: true })
  const result = await openBrowser(TOKEN_URL, { spawnImpl: impl, graceMs: 120 })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /未返回退出码/)
})

test('openBrowser：spawn 失败（如无默认浏览器）→ ok=false 且带原因', async () => {
  const { impl } = fakeSpawn({ emitError: 'EACCES' })
  const result = await openBrowser(TOKEN_URL, { spawnImpl: impl, graceMs: 1000 })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /EACCES/)
})

test('openBrowser：browser_path 指向不存在的文件 → 立刻失败，不启动任何进程', async () => {
  const { impl, calls } = fakeSpawn({ exitCode: 0 })
  const result = await openBrowser(TOKEN_URL, { browserPath: 'Z:\\不存在的浏览器.exe', spawnImpl: impl })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /不存在/)
  assert.equal(calls.length, 0, '不应在配置非法时还去拉起进程')
})

test('openBrowser：spawn 同步抛错 → ok=false 且不崩（TDZ 回归守卫）', async () => {
  // 这条盯的是一个真实存在过的实现缺陷：finish() 会在定时器创建**之前**被调用，
  // 若那时引用 `const timer` 就会踩 TDZ 抛 ReferenceError —— 即"打开失败"被放大成崩溃。
  const result = await openBrowser(TOKEN_URL, {
    spawnImpl: () => {
      throw new Error('EPERM: 拒绝访问')
    },
  })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /EPERM/)
})

test('openBrowser：spawn 返回无效句柄 → ok=false 且不崩', async () => {
  const result = await openBrowser(TOKEN_URL, { spawnImpl: () => null })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /句柄无效/)
})

test('openBrowser：畸形 URL 直接拒绝，method=none，不启动任何进程', async () => {
  const { impl, calls } = fakeSpawn({ exitCode: 0 })
  const result = await openBrowser('file:///etc/passwd', { spawnImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.method, 'none')
  assert.equal(calls.length, 0)
})

test('openBrowser：长驻应用（configured-app）只等 spawn 成功，不等退出码', async () => {
  const { impl, calls } = fakeSpawn({ silent: true })
  const result = await openBrowser(TOKEN_URL, {
    browserPath: process.execPath,
    spawnImpl: impl,
    graceMs: 200,
  })
  assert.equal(result.ok, true, '浏览器长驻是正常现象，不能因"没退出"判失败')
  assert.equal(calls[0].options.detached, true, '长驻应用必须 detach，否则会随监管进程一起死')
})
