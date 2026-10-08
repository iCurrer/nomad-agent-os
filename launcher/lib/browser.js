'use strict'

/**
 * 浏览器交接（Agent Screen）。
 *
 * 设计依据（见 docs/DECISIONS.md ADR-0012 / ADR-0022）：
 *   Nomad 是浏览器的所有者，而不是把开浏览器这件事留给 DSH：
 *   启动 DSH 时恒定传 `--no-open`，由启动器在**拿到带 token 的 URL 之后**
 *   再打开浏览器（`packages/bundle/web-app/src/index.ts:290` 的 URL 行）。
 *
 * ── 2026-10-08 修复（真实缺陷，非推测）────────────────────────────────────
 * 旧实现用 `spawn('explorer.exe', [url])`。**explorer.exe 不是"打开 URL"的接口**：
 * 它的参数解析器面向 shell 路径与开关，不是一个 URL 交接通道。实测表现有两个，
 * 与用户报告逐字对应：
 *   1. 它把 URL 当路径处理，另开一个「文件资源管理器」窗口（用户看到"自动打开
 *      文档管理器页面"）；
 *   2. 交给浏览器的 URL 丢掉 query，于是浏览器拿到裸 `http://127.0.0.1:<port>/`
 *      → DSH 的 browser-auth 直接 401，页面正文刚好是
 *      `dsh web authentication required; reopen the URL printed by dsh web.`
 *      （`packages/client/connection/src/browser-auth.ts:302-310`）。
 * 另一个独立缺陷：explorer.exe **无论成败都以退出码 1 收场**，所以旧实现"spawn
 * 没抛异常就算成功"的判定，本质上是无法判伪的假成功 —— 启动器会照打
 * 「（已交由系统浏览器打开）」，即使一个窗口都没开对。
 *
 * 现行策略：**按能力择一，且以退出码为判据**。
 *   A. 显式配置 `web.browser_path` → 直接拉起该可执行文件（不经任何 shell，
 *      参数零解析风险；最可靠，也是用户可自救的逃生舱）。
 *   B. Windows 默认 → `cmd.exe /c start "" <url>`：ShellExecute 语义、单参数、
 *      `start` 立即返回且**退出码有意义**（找不到协议处理器时为非 0）。
 *      经 `spawn(shell:false)` 传数组参数，不经 shell 拼接。
 *   C. B 不可用（URL 含 cmd 元字符，或 cmd 拉起失败）→ PowerShell
 *      `-EncodedCommand`（URL 被编进 base64 负载，不存在引号/元字符解析面）。
 *   三档都做了 URL 校验；无法安全交接时**明确报错**并给出 `nomad url` 手动通道，
 *   绝不假装成功。
 *
 * 边界（必须诚实声明）：**浏览器本身是宿主的**。它的历史、缓存、会话属于宿主
 * 浏览器进程，Nomad 接管不了。详见 docs/HOST_ISOLATION.md。
 */

const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { stripTrailingSep } = require('./paths.js')

/**
 * 直传型校验（A / C 档：参数不经 shell 解析）。
 * 只挡真正危险的形态：控制字符、空白、引号、反引号、反斜杠。
 */
const DIRECT_SAFE_URL = /^https?:\/\/[^\s"'`\\\u0000-\u001f\u007f]+$/i

/**
 * cmd 型校验（B 档：`cmd.exe /c start` 会二次解析整条命令行）。
 * 在直传型基础上再排除 cmd 元字符与变量展开符：
 *   `& | < > ^ ( )` 是命令分隔/重定向/转义；`%` 会触发 `%VAR%` 展开；
 *   `!` 在延迟展开下有意义。全部拒绝，宁可不走 B 档也不要冒注入风险。
 * 注意 `? = / : _ - .` 必须放行 —— DSH 的鉴权 URL 就是
 * `http://host:port/?token=<base64url>` 这个形态。
 */
const CMD_SAFE_URL = /^https?:\/\/[^\s"'`\\&|<>^()%!\u0000-\u001f\u007f]+$/i

/** 交接方式的字面标识（会进日志与状态文件，保持稳定）。 */
const METHOD = {
  configuredApp: 'configured-app',
  cmdStart: 'cmd-start',
  powershell: 'powershell-start-process',
  open: 'macos-open',
  xdg: 'xdg-open',
}

/**
 * 校验 URL 是否可安全交给某个交接档位。
 * @param {string} url - 目标 URL
 * @returns {{ ok: boolean, error?: string }} 结果
 */
function validateOpenUrl(url) {
  if (typeof url !== 'string' || url === '') {
    return { ok: false, error: 'URL 为空' }
  }
  if (!DIRECT_SAFE_URL.test(url)) {
    return {
      ok: false,
      error: `URL 形态不被接受（含控制字符/空白/引号/反斜杠）：${url.slice(0, 40)}…`,
    }
  }
  if (url.length > 4096) {
    return { ok: false, error: `URL 过长（${String(url.length)} 字符）` }
  }
  return { ok: true }
}

/**
 * 断言 URL 是否可用于 cmd 档（供测试与文档化用途）。
 * @param {string} url - 目标 URL
 * @returns {boolean} 可用于 `cmd.exe /c start`
 */
function isCmdSafeUrl(url) {
  return typeof url === 'string' && CMD_SAFE_URL.test(url)
}

/**
 * **纯函数**地推导"交给系统打开器的是什么命令"。
 *
 * 抽成纯函数的原因：这就是本次缺陷的现场。缺陷不是"调用失败"，而是
 * **参数在传递路上被吞掉** —— 这种问题只有把"最终命令"做成可断言的值，
 * 才能被单元测试守住（见 tests/browser.test.js 的回归断言）。
 *
 * @param {string} url - 目标 URL（须已通过 validateOpenUrl）
 * @param {{ browserPath?: string, platform?: string, powershellPath?: string }} [options]
 *   配置与平台（platform 可注入以便跨平台断言）
 * @returns {{ command: string, args: string[], method: string, kind: 'opener'|'app' } | { error: string }}
 *   命令描述；无法安全交接时返回 error
 */
function buildOpenCommand(url, options = {}) {
  const verdict = validateOpenUrl(url)
  if (!verdict.ok) return { error: verdict.error }

  const browserPath = typeof options.browserPath === 'string' ? options.browserPath.trim() : ''
  if (browserPath !== '') {
    // 直传：不经 shell、不做参数解析，URL 原样成为 argv[1]。
    return { command: browserPath, args: [url], method: METHOD.configuredApp, kind: 'app' }
  }

  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    if (isCmdSafeUrl(url)) {
      // start 的第一个参数是窗口标题（URL 可能被当成标题），故显式给空标题。
      return {
        command: 'cmd.exe',
        args: ['/c', 'start', '', url],
        method: METHOD.cmdStart,
        kind: 'opener',
      }
    }
    const powershell = options.powershellPath ?? defaultPowerShellPath()
    if (powershell === '') {
      return { error: 'URL 含 cmd 元字符，且未找到 PowerShell，无法安全交接（请用 nomad url 手动打开）' }
    }
    // 单引号定界；URL 内的单引号已被 DIRECT_SAFE_URL 挡掉。整段再用
    // -EncodedCommand（UTF-16LE base64）传递，命令行上不出现任何原文字符。
    const script = `Start-Process -FilePath '${url}'`
    return {
      command: powershell,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')],
      method: METHOD.powershell,
      kind: 'opener',
    }
  }

  if (platform === 'darwin') {
    return { command: 'open', args: [url], method: METHOD.open, kind: 'opener' }
  }
  return { command: 'xdg-open', args: [url], method: METHOD.xdg, kind: 'opener' }
}

/**
 * 取 Windows 上 PowerShell 的绝对路径（不依赖 PATH）。
 * @returns {string} 路径；找不到时返回空串
 */
function defaultPowerShellPath() {
  // 去尾分隔符后再拼（与 ADR-0028 同一类问题）：带上会拼出 `C:\WINDOWS\System32` 双反斜杠
  const root = stripTrailingSep(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows')
  const candidate = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  try {
    return fs.existsSync(candidate) ? candidate : ''
  } catch {
    return ''
  }
}

/**
 * 拉起系统默认浏览器打开 URL，并**以退出码为准**判定交接是否成立。
 *
 * @param {string} url - 目标 URL（须带 DSH 的 launch token）
 * @param {{ browserPath?: string, logger?: {warn: Function, info: Function}, graceMs?: number, spawnImpl?: Function }} [options]
 *   配置 / 日志器 / 等待退出码的宽限 / 可注入的 spawn（仅测试用，默认 node:child_process）
 * @returns {Promise<{ ok: boolean, method: string, error?: string, exitCode?: number }>} 结果
 */
function openBrowser(url, options = {}) {
  const logger = options.logger
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const verdict = validateOpenUrl(url)
  if (!verdict.ok) {
    logger?.warn?.(verdict.error)
    return Promise.resolve({ ok: false, method: 'none', error: verdict.error })
  }

  const built = buildOpenCommand(url, { browserPath: options.browserPath })
  if (built.error !== undefined) {
    logger?.warn?.(built.error)
    return Promise.resolve({ ok: false, method: 'none', error: built.error })
  }

  if (built.method === METHOD.configuredApp && !fs.existsSync(built.command)) {
    const error = `web.browser_path 指向的可执行文件不存在：${built.command}`
    logger?.warn?.(error)
    return Promise.resolve({ ok: false, method: built.method, error })
  }

  // 真实浏览器进程是长驻的：detach + unref，只观察 spawn 错误。
  // 短命 opener（cmd/open/xdg-open）则**等它给出退出码**，退出码非 0 即失败。
  const isApp = built.kind === 'app'
  const graceMs = Number.isFinite(options.graceMs) ? Number(options.graceMs) : (isApp ? 1200 : 4000)

  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    // 必须先声明为 let：spawn 同步抛错时 finish() 会在定时器创建**之前**被调用，
    // 若此时引用 const timer 会踩 TDZ 抛 ReferenceError（把"打开失败"变成崩溃）。
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      child = spawnImpl(built.command, built.args, {
        // 浏览器属宿主进程：这里刻意使用宿主环境，不套用隔离环境。
        detached: isApp,
        stdio: isApp ? 'ignore' : ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, method: built.method, error: error.message })
      return
    }
    if (child === null || typeof child !== 'object' || typeof child.on !== 'function') {
      finish({ ok: false, method: built.method, error: '打开器进程句柄无效' })
      return
    }
    if (typeof child.unref !== 'function') child.unref = () => {}

    if (isApp) child.unref()

    const graceTimer = setTimeout(() => {
      // 超时未退出：长驻应用属正常；短命 opener 卡住则视为"已发出、结果未知"，
      // 但**不谎报成功**（ok:false 会让上层打印自救提示）。
      if (isApp) {
        logger?.info?.(`已请求系统打开浏览器（${built.method}）`)
        finish({ ok: true, method: built.method })
        return
      }
      finish({ ok: false, method: built.method, error: `打开器 ${graceMs}ms 内未返回退出码` })
    }, graceMs)
    timer = graceTimer
    // 刻意**不** unref：这个定时器是"判定必须落地"的保证 —— 被 unref 掉之后，
    // 一旦父进程没有其它活跃句柄，Promise 就永远不会 settle（曾因此在单测里
    // 表现为 cancelledByParent，也意味着真机上可能静默丢掉交接结论）。
    // finish() 会 clearTimeout，所以不存在泄漏。

    if (!isApp && child.stderr !== null) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
    }

    child.on('error', (error) => {
      finish({ ok: false, method: built.method, error: error.message })
    })

    if (isApp) {
      // 长驻应用只要能活过宽限期就算交接成立（浏览器成功启动）。
      child.on('spawn', () => {
        setTimeout(() => {
          logger?.info?.(`已请求系统打开浏览器（${built.method}）`)
          finish({ ok: true, method: built.method })
        }, Math.min(graceMs, 300))
      })
      return
    }

    child.on('exit', (code) => {
      if (code === 0) {
        logger?.info?.(`已请求系统打开浏览器（${built.method}）`)
        finish({ ok: true, method: built.method, exitCode: 0 })
        return
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-2).join(' / ')
      finish({
        ok: false,
        method: built.method,
        exitCode: code ?? -1,
        error: `打开器退出码 ${String(code ?? -1)}${detail === '' ? '' : `：${detail}`}`,
      })
    })
  })
}

module.exports = {
  openBrowser,
  buildOpenCommand,
  validateOpenUrl,
  isCmdSafeUrl,
  METHOD,
  DIRECT_SAFE_URL,
  CMD_SAFE_URL,
}
