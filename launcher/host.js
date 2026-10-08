#!/usr/bin/env node
'use strict'

/**
 * Nomad Runtime Host —— 运行时监督进程。
 *
 * 为什么需要它（而不是让 CLI 直接拉 DSH）：
 *   1. 后台模式下 CLI 必须退出，但启动 URL 只出现在 DSH 的 stdout 上
 *      （`dsh web: <url>`，见 bundle/web-app/src/index.ts:290）→ 需要一个
 *      存活进程持有 stdout 管道；
 *   2. 优雅退出需要一个"还在场"的进程去把信号转给 DSH 并等待收敛；
 *   3. 状态文件（pid / 端口 / URL）需要一个明确的所有者。
 *
 * 它**不碰** Agent Loop / Session / Tool Runtime —— 只做进程与生命周期
 * （AGENTS.md 铁律 12、13）。
 *
 * 用法（由 launcher/nomad.js 拉起，不面向终端用户）：
 *   node launcher/host.js --root <dir> [--config <file>] [--no-browser] [--foreground]
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')

const { parseArgs, flagValue, flagBool } = require('./lib/args.js')
const { detectRoot } = require('./lib/root.js')
const { loadConfig } = require('./lib/config.js')
const { discoverRuntime } = require('./lib/runtime.js')
const { buildEnv, prependToPath } = require('./lib/env.js')
const { createLogger, redactEnv, localDate } = require('./lib/logger.js')
const { ensureDirs, buildArgv } = require('./lib/bootstrap.js')
const { ensureNomadProfile } = require('./lib/profile.js')
const { writeState, clearState, isAlive, HEARTBEAT_INTERVAL_MS } = require('./lib/state.js')
const { parseLaunchLine, sanitizeUrl } = require('./lib/dsh-url.js')
const { openBrowser } = require('./lib/browser.js')
const { verifyAuthHandshake } = require('./lib/web-auth.js')
const { startStatusServer } = require('./lib/status-server.js')

/** 启动前保留的诊断行数（启动失败时回放）。 */
const DIAGNOSTIC_LINES = 40

/**
 * 强制结束进程树（Windows 用 taskkill /T，POSIX 用 SIGKILL）。
 * @param {number} pid - 目标进程
 * @returns {void}
 */
function forceKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* 尽力而为 */
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 已退出 */
  }
}

/**
 * 入口。
 * @returns {void}
 */
function main() {
  const { flags } = parseArgs(process.argv.slice(2))
  const foreground = flagBool(flags, ['foreground', 'f'])
  const openBrowserEnabled = !flagBool(flags, ['no-browser'])

  const { root, source } = detectRoot({ explicit: flagValue(flags, 'root') })
  const config = loadConfig({ root, file: flagValue(flags, 'config') })
  ensureDirs(config)

  const runtime = discoverRuntime({ root, config })
  const logger = createLogger({
    dir: config.paths.logs,
    level: config.logging.level,
    maxFiles: config.logging.max_files,
    tag: 'runtime',
    mirror: foreground ? console : null,
  })

  logger.info(`Nomad Runtime Host 启动（NOMAD_ROOT=${root}，来源 ${source}）`)
  logger.info(`launcher=${require('./package.json').version}  node=${process.versions.node}  platform=${process.platform}`)

  for (const warning of runtime.warnings) logger.warn(warning)

  if (runtime.dsh.missing === true) {
    logger.error(`无法启动：${runtime.dsh.reason ?? 'DSH 运行时缺失'}`)
    logger.error('请把已构建的 @deepseek-ai/dsh 放到 runtime/dsh/<version>/，并让 runtime/dsh/current 指向它。')
    process.exitCode = 78 // EX_CONFIG
    return
  }

  // 隔离环境：只作用于子进程，绝不触碰宿主
  const built = buildEnv({ root, isolation: config.isolation })
  if (typeof runtime.node.source === 'string' && runtime.node.source.startsWith('bundled:')) {
    prependToPath(built.env, path.dirname(runtime.node.path))
  }
  if (config.isolation.enabled === false) {
    logger.warn('isolation.enabled = false：子进程将继承宿主环境，零污染无法保证。')
  }
  logger.info(`环境隔离：策略=${built.report.strategy} 继承=${String(built.report.inherited.length)} 丢弃=${String(built.report.dropped.length)} 覆盖=${built.report.overridden.join(', ')}`)
  logger.debug(`隔离后环境（已脱敏）：${JSON.stringify(redactEnv(built.env))}`)

  // profile 自举（幂等）：CLI 已做过一次，这里是**权威执行点** —— 真正组装启动命令的
  // 是 host，直接跑 host.js（或将来被别的入口拉起）时也必须保证 profile 已就绪。
  const profile = ensureNomadProfile({ root, config, logger })
  if (!profile.ok) {
    logger.error(profile.error ?? 'profile 自举失败')
    logger.error('拒绝以未就绪的 profile 启动 DSH（否则只会在 DSH 侧得到含糊的 did not activate）。')
    process.exitCode = 78 // EX_CONFIG
    return
  }

  const argv = buildArgv({ config, runtime })
  logger.info(`启动命令：${argv.display}`)
  logger.info(`工作目录：${argv.cwd}`)

  const rawLogFile = path.join(config.paths.logs, `dsh-${localDate()}.log`)
  const diagnostics = []
  let buffer = ''
  let announced = false
  let stopping = false
  /** 状态端点（只读、跟随 DSH 生命周期）。DSH 就绪后启动，退出时关闭。 */
  let statusServer = null

  const child = spawn(argv.command, argv.args, {
    cwd: argv.cwd,
    env: built.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  /** 状态快照：心跳定时器与各阶段共用同一份数据，避免字段互相覆盖。 */
  const stateData = {
    nomadRoot: root,
    supervisorPid: process.pid,
    dshPid: child.pid ?? 0,
    instanceId: randomUUID(),
    phase: 'starting',
    profile: typeof config.runtime.dsh.profile === 'string' ? config.runtime.dsh.profile : 'web',
    runtime: { name: runtime.dsh.name, version: runtime.dsh.version, entry: runtime.dsh.entry },
    command: argv.display,
    node: argv.command,
    startedAt: new Date().toISOString(),
    configFile: config.file,
  }

  /**
   * 合并并落盘状态。
   * @param {object} patch - 追加字段
   * @returns {void}
   */
  const persist = (patch) => {
    Object.assign(stateData, patch, { heartbeatAt: new Date().toISOString() })
    try {
      writeState(root, stateData)
    } catch (error) {
      logger.warn(`状态文件写入失败：${error.message}`)
    }
  }

  persist({ phase: 'starting' })

  // 心跳：让 `nomad stop` 能区分"这个 PID 真的是我们"与"PID 已被系统复用"。
  // 没有心跳时绝不能盲杀 PID —— 否则一旦复用，可能杀掉毫不相干的进程。
  const heartbeat = setInterval(() => {
    persist({})
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  /**
   * 处理一行 DSH 输出。
   *
   * 就绪后要做三件**有序**的事（顺序本身就是设计）：
   *   1. 落盘 url/port —— 让 CLI 的 waitForReady 尽快看到 phase=ready；
   *   2. 自检认证握手 —— 先证明"这条 URL 交给浏览器真能进去"，再交付；
   *   3. 交接浏览器 —— 并用**退出码**判定成败，把结果写回状态文件，
   *      让 `nomad start` 打印的是事实而不是"我以为开了"。
   * @param {string} line - 行文本
   * @returns {Promise<void>} 完成
   */
  const handleLine = async (line) => {
    if (line !== '') {
      diagnostics.push(line)
      if (diagnostics.length > DIAGNOSTIC_LINES) diagnostics.shift()
    }
    if (announced) return
    const launch = parseLaunchLine(line)
    if (launch === null) return
    announced = true
    // 脱敏地址用于日志；带 token 的 URL 只落盘内状态文件。
    logger.info(`Web 就绪：${sanitizeUrl(launch.url)}  (端口 ${String(launch.port)})`)
    persist({
      phase: 'ready',
      url: launch.url,
      publicUrl: sanitizeUrl(launch.url),
      port: launch.port,
      readyAt: new Date().toISOString(),
      browserHandoff: openBrowserEnabled ? { state: 'pending' } : { state: 'skipped' },
    })

    // ── 状态端点：DSH 就绪即起，端口 OS 协商，回写 state 供面板轮询 ──────────
    // 只读、只绑 127.0.0.1、不含 token；失败不阻断启动（面板退化为静态骨架）。
    if (statusServer === null) {
      try {
        statusServer = await startStatusServer({ root, source, config, runtime, logger })
        persist({ statusEndpoint: { host: '127.0.0.1', port: statusServer.port } })
      } catch (error) {
        logger.warn(`状态端点启动失败：${error instanceof Error ? error.message : String(error)}（面板状态区将不可用，其余功能不受影响）`)
      }
    }

    // ── 第 2 步：认证握手自检 ──────────────────────────────────────────
    // 没有这一步，"交接是否成功"就只能靠猜；有了它，2026-10-08 那次
    // "浏览器 401 / 打开器把 token 吞了"的事故会在**交付前**变成一条明确的诊断。
    let handshake = null
    try {
      handshake = await verifyAuthHandshake(launch.url)
    } catch (error) {
      handshake = { ok: false, steps: [], error: error.message }
    }
    persist({ webAuth: handshake })
    if (handshake.ok === true) {
      logger.info(`认证握手自检通过（303 → cookie → 200）`)
    } else {
      logger.warn(`认证握手自检未通过：${String(handshake.error ?? '未知原因')}`)
      logger.warn(`  地址本身形态：${sanitizeUrl(launch.url)}（含 token，只在盘内状态文件里）`)
      logger.warn('  这通常意味着实例尚未完全就绪；浏览器可能拿到 401，稍后可用 nomad open 重试。')
    }

    if (!openBrowserEnabled) {
      logger.info('web.open_browser = false：跳过打开浏览器；用 nomad url 取地址。')
      return
    }

    // ── 第 3 步：浏览器交接（以退出码为准） ────────────────────────────
    const result = await openBrowser(launch.url, { browserPath: config.web.browser_path, logger })
    persist({
      browserHandoff: result.ok
        ? { state: 'ok', method: result.method, at: new Date().toISOString() }
        : { state: 'failed', method: result.method, error: result.error, at: new Date().toISOString() },
    })
    if (result.ok) {
      logger.info(`浏览器交接成功（${result.method}）`)
    } else {
      logger.warn(`浏览器未打开（${result.method}）：${result.error ?? '未知原因'}`)
      logger.warn('  自救通道：`nomad open` 重试；`nomad url` 打印**含 token** 的完整地址，手动粘进浏览器即可通过鉴权。')
      logger.warn('  提示：若本机默认浏览器被安全软件拦截，可在 config/nomad.yaml 里设置 web.browser_path 指定浏览器可执行文件。')
    }
  }

  const attach = (stream, mirrorToConsole) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      const text = String(chunk)
      try {
        fs.appendFileSync(rawLogFile, text, 'utf8')
      } catch {
        /* 原始日志写失败不致命 */
      }
      if (mirrorToConsole) process.stdout.write(text)
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        // handleLine 在就绪那一行会转成异步（握手自检 + 浏览器交接），
        // 但该分支只可能触发一次，且不阻塞 stdout 继续被消费。
        void handleLine(line).catch((error) => {
          logger.warn(`就绪处理异常：${error instanceof Error ? error.message : String(error)}`)
        })
      }
    })
  }

  attach(child.stdout, foreground)
  attach(child.stderr, foreground)

  /**
   * 优雅停止：先 SIGTERM，超时后强杀进程树。
   * @param {string} reason - 触发原因
   * @returns {void}
   */
  const shutdown = (reason) => {
    if (stopping) return
    stopping = true
    const timeoutMs = Number(config.behavior.graceful_shutdown_timeout_ms) || 8000
    logger.warn(`收到停止请求（${reason}），向 DSH 发送 SIGTERM，等待至多 ${String(timeoutMs)}ms…`)
    try {
      child.kill('SIGTERM')
    } catch (error) {
      logger.warn(`发送 SIGTERM 失败：${error.message}`)
    }
    const timer = setTimeout(() => {
      if (isAlive(child.pid)) {
        logger.warn('优雅退出超时，强制结束进程树')
        forceKillTree(child.pid)
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  child.on('error', (error) => {
    logger.error(`DSH 进程启动失败：${error.message}`)
    clearState(root)
    process.exitCode = 70
  })

  child.on('exit', (code, signal) => {
    clearInterval(heartbeat)
    // 状态端点跟随 DSH 生命周期：DSH 退出即关，不留下游离的只读服务。
    if (statusServer !== null) {
      void statusServer.close().catch(() => { /* 关闭失败不阻断退出流程 */ })
      statusServer = null
    }
    if (!stopping) {
      const abnormal = code !== 0 && code !== null
      if (abnormal) {
        logger.error(`DSH 异常退出（code=${String(code)}, signal=${String(signal)}）。最近输出：`)
        for (const line of diagnostics) logger.error(`  | ${line}`)
      } else {
        logger.info(`DSH 已退出（code=${String(code)}, signal=${String(signal)}）`)
      }
    } else {
      logger.info(`DSH 已退出（code=${String(code)}, signal=${String(signal)}）`)
    }
    if (!clearState(root)) logger.warn('状态文件未能删除；下次 start 会先清理它。')
    process.exitCode = typeof code === 'number' ? code : 0
  })

  process.on('message', (message) => {
    if (message !== null && typeof message === 'object' && message.type === 'shutdown') shutdown('ipc')
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
}

main()
