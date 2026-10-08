#!/usr/bin/env node
'use strict'

/**
 * Nomad CLI —— 生命周期控制层。
 *
 * 职责边界（AGENTS.md 第 1 节、`docs/ARCHITECTURE.md`）：
 *   CLI **只**做 lifecycle / diagnostics / runtime / project 管理。
 *   它不复制 Agent Loop，不碰 Session，不实现任何 Agent 能力。
 *
 * 命令：
 *   nomad [start]              启动（默认后台）
 *   nomad start --foreground   前台启动（Ctrl+C 停止，便于调试）
 *   nomad start --dry-run      只打印启动计划，不真的启动
 *   nomad stop [--force]       停止（force 走强杀路径）
 *   nomad restart              停止后重启
 *   nomad status [--json]      状态（退出码：0 运行中 / 3 未运行）
 *   nomad doctor [--json]      体检（退出码：0 全通过 / 1 有 FAIL）
 *   nomad env                  打印隔离环境计划
 *   nomad paths                打印解析后的路径与运行时
 *   nomad profile              查看自建 profile（--ensure 时自举到位）
 *   nomad profile list         列出盘内全部 profile
 *   nomad profile create <name> [--template T]   从内置模板创建骨架
 *   nomad profile validate <name>                深度校验单个 profile
 *   nomad start [--profile <name>]   覆盖本次启动使用的 profile（默认仍 nomad）
 *   nomad logs [--raw] [--lines N]
 *   nomad url                  打印带 token 的访问地址（敏感）
 *   nomad open                 重新用浏览器打开当前实例
 *   nomad version
  nomad rollback [<version>] [--to <version>] [--force]   回滚 DSH 运行时（改写 current 指针）
  nomad backup [--include-config] [--to <dir>]            备份盘内用户数据到 data/backups/
  nomad restore <backup-dir> [--force]                   从备份恢复盘内用户数据
  nomad projects                                         列出已持久化的 DSH 工作区（项目）
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const { parseArgs, flagValue, flagBool } = require('./lib/args.js')
const { detectRoot } = require('./lib/root.js')
const { loadConfig } = require('./lib/config.js')
const { discoverRuntime } = require('./lib/runtime.js')
const { applyRollback, listDshVersions } = require('./lib/runtime-rollback.js')
const { createBackup, restoreBackup } = require('./lib/backup.js')
const { parseWorkspaces } = require('./lib/projects.js')
const { buildEnv, describePlan } = require('./lib/env.js')
const { redactEnv, localDate } = require('./lib/logger.js')
const { ensureDirs, buildArgv } = require('./lib/bootstrap.js')
const { ensureNomadProfile, inspectNomadProfile, listProfiles, createProfile, validateProfileDir, validateProfileName } = require('./lib/profile.js')
const { readState, clearState, isAlive, isFresh, stateFile } = require('./lib/state.js')
const { sanitizeUrl } = require('./lib/dsh-url.js')
const { probeHttp } = require('./lib/probe.js')
const { openBrowser } = require('./lib/browser.js')
const { describeHandshake } = require('./lib/web-auth.js')
const { runDoctor, renderDoctor } = require('./lib/doctor.js')

/** 启动器版本。 */
const LAUNCHER_VERSION = require('./package.json').version

/** 默认等待就绪超时（DSH 首次启动可能要做初始化）。 */
const DEFAULT_READY_TIMEOUT_MS = 120000

/**
 * 就绪后等待"浏览器交接结果"落盘的上限。
 * 打开器退出码通常在百毫秒级；给到 6s 是为了容忍宿主安全软件弹窗拦截等慢路径，
 * 超过即如实报"进行中"，不假装成功。
 */
const HANDOFF_WAIT_MS = 6000

const HELP = `Nomad — Portable Agent OS（Launcher ${LAUNCHER_VERSION}）

用法：nomad [命令] [选项]

命令：
  start                启动 Nomad（默认后台运行后返回）
  stop                 停止当前实例
  restart              停止后重新启动
  status               查看实例状态
  doctor               体检（路径 / 隔离 / 运行时 / 端口 / 宿主探针）
  env                  打印将要注入子进程的隔离环境计划
  paths                打印解析后的路径与运行时入口
  profile              查看自建 profile 状态（只读）
  profile --ensure     把自建 profile 自举到位（幂等；start 也会自动做）
  logs                 查看最近日志
  url                  打印带 token 的访问地址（敏感，勿外传）
  open                 用系统浏览器重新打开当前实例
  version              打印版本信息
  rollback              回滚 DSH 运行时版本（改写 current 指针，影响下次启动）
  backup               备份盘内用户数据（会话/项目/配置）到 data/backups/
  restore              从备份恢复盘内用户数据
  projects             列出已持久化的 DSH 工作区（项目）

选项：
  -f, --foreground     前台运行（Ctrl+C 停止，便于调试）
  -d, --background     后台运行（默认）
      --dry-run        只打印启动计划，不启动任何进程
      --no-browser     不自动打开浏览器
      --root <dir>     显式指定 NOMAD_ROOT
      --config <file>  显式指定配置文件
      --timeout <ms>   等待就绪的超时（默认 ${String(DEFAULT_READY_TIMEOUT_MS)}）
      --lines <n>      logs 显示行数（默认 60）
      --raw            logs 查看 DSH 原始输出
      --json           以 JSON 输出（status / doctor）

硬约束：构建期与运行期分离；用户机零编译；启动路径不出现 npx；一切路径从 NOMAD_ROOT 派生。
`

/**
 * 同步睡眠。
 * @param {number} ms - 毫秒
 * @returns {void}
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 异步睡眠。
 * @param {number} ms - 毫秒
 * @returns {Promise<void>} 完成
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 强制结束进程树。
 * @param {number} pid - 进程号
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
 * 解析上下文（根 / 配置 / 运行时）。
 * @param {Record<string, string|boolean>} flags - 命令行 flag
 * @returns {{ root: string, source: string, config: object, runtime: object }} 上下文
 */
function resolveContext(flags) {
  const { root, source } = detectRoot({ explicit: flagValue(flags, 'root') })
  const config = loadConfig({ root, file: flagValue(flags, 'config') })
  const runtime = discoverRuntime({ root, config })
  return { root, source, config, runtime }
}

/**
 * 读取 VERSION 文件中的某个字段（`KEY=VALUE` 格式）。
 * @param {string} root - NOMAD_ROOT
 * @param {string} key - 字段名
 * @returns {string} 值；缺失返回 'unknown'
 */
function readVersionField(root, key) {
  try {
    const text = fs.readFileSync(path.join(root, 'VERSION'), 'utf8')
    const matched = new RegExp(`^${key}=(.+)$`, 'm').exec(text)
    if (matched !== null) return matched[1].trim()
    return text.trim().split(/\r?\n/)[0] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 读取 Nomad 版本。
 * @param {string} root - NOMAD_ROOT
 * @returns {string} 版本
 */
function readNomadVersion(root) {
  return readVersionField(root, 'NOMAD_VERSION')
}

/**
 * 打印启动计划（dry-run）。
 * @param {object} ctx - 上下文
 * @param {{ openBrowser: boolean }} options - 选项
 * @returns {void}
 */
function printPlan(ctx, options) {
  const { root, source, config, runtime } = ctx
  const built = buildEnv({ root, isolation: config.isolation })
  console.log('── Nomad 启动计划（dry-run，未启动任何进程）──')
  console.log(`NOMAD_ROOT   ${root}`)
  console.log(`  来源       ${source}`)
  console.log(`配置文件     ${config.file}`)
  console.log(`版本         Nomad ${readNomadVersion(root)} / launcher ${LAUNCHER_VERSION}`)
  console.log('')
  console.log('运行时：')
  console.log(`  Node       ${runtime.node.path}  (${runtime.node.version ?? '版本未探测'}，来源 ${runtime.node.source})`)
  if (runtime.dsh.missing === true) {
    console.log(`  DSH        ✗ ${runtime.dsh.reason ?? '缺失'}`)
  } else {
    console.log(`  DSH        ${runtime.dsh.name} ${runtime.dsh.version}`)
    console.log(`  入口       ${runtime.dsh.entry}（来自 ${runtime.dsh.entrySource}）`)
  }
  console.log('')
  if (runtime.dsh.missing === true) {
    console.log('启动命令     跳过（缺 DSH 运行时）')
  } else {
    const argv = buildArgv({ config, runtime })
    console.log('启动命令：')
    console.log(`  ${argv.display}`)
    console.log(`  cwd = ${argv.cwd}`)
  }
  console.log('')
  console.log('DSH profile（start 时自举，只写盘内）：')
  try {
    const info = inspectNomadProfile({ root, config })
    console.log(`  名称       ${info.spec.name}（派生自内置模板 ${info.spec.template}）`)
    console.log(`  目录       ${info.spec.dir}`)
    console.log(`  自研层     ${info.spec.bundleSpec}`)
    const state = info.exists
      ? (info.bundleLast ? '已就绪（自研层在末位）' : '已存在但自研层缺失/不在末位 → start 会补正')
      : '尚未初始化 → start 会创建'
    console.log(`  状态       ${state}`)
    for (const problem of info.problems) console.log(`  ⚠ ${problem}`)
  } catch (error) {
    console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`)
  }
  console.log('')
  console.log('宿主隔离：')
  for (const line of describePlan(built.report, config.isolation.override, root)) console.log(`  ${line}`)
  console.log('')
  console.log(`浏览器        ${options.openBrowser ? '启动就绪后由 Nomad 打开（DSH 恒定 --no-open）' : '不打开'}`)
  console.log(`状态文件      ${stateFile(root)}`)
  if (config.warnings.length > 0) {
    console.log('')
    console.log('配置警告：')
    for (const warning of config.warnings) console.log(`  ⚠ ${warning}`)
  }
}

/**
 * 等待实例进入 ready。
 * @param {string} root - NOMAD_ROOT
 * @param {number} timeoutMs - 超时
 * @param {number} supervisorPid - 监管进程 pid
 * @returns {Promise<{ ok: boolean, state: object|null, reason?: string }>} 结果
 */
async function waitForReady(root, timeoutMs, supervisorPid) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = readState(root)
    if (state !== null && state.phase === 'ready') return { ok: true, state }
    if (!isAlive(supervisorPid)) return { ok: false, state, reason: '监管进程已退出' }
    if (Date.now() >= deadline) return { ok: false, state, reason: `等待就绪超时（${String(timeoutMs)}ms）` }
    await sleep(300)
  }
}

/**
 * 读取日志尾部。
 * @param {object} config - 配置
 * @param {{ raw: boolean, lines: number }} options - 选项
 * @returns {string} 文本
 */
function tailLogs(config, options) {
  const dir = config.paths.logs
  const prefix = options.raw ? 'dsh-' : 'runtime-'
  let newest = null
  try {
    const candidates = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.log'))
      .sort()
      .map((name) => path.join(dir, name))
    newest = candidates[candidates.length - 1] ?? null
  } catch {
    return `日志目录不可读：${dir}`
  }
  if (newest === null) return `没有找到 ${prefix}*.log（目录 ${dir}）`
  const content = fs.readFileSync(newest, 'utf8').split(/\r?\n/)
  const tail = content.slice(Math.max(0, content.length - options.lines))
  return `# ${newest}\n${tail.join('\n')}`
}

/**
 * 等待监管进程把"浏览器交接结果"写进状态文件。
 *
 * 为什么需要等：交接要等打开器的**退出码**才能定真假（见 lib/browser.js），
 * 这必然晚于 phase=ready。若不等，`nomad start` 就会在结果未知时抢先输出，
 * 又回到"假成功"的老路。等待有界，超时则如实报"未完成"。
 *
 * @param {string} root - NOMAD_ROOT
 * @param {number} supervisorPid - 监管进程 pid
 * @param {number} timeoutMs - 等待上限
 * @returns {Promise<object|null>} 状态对象
 */
async function waitForHandoff(root, supervisorPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = readState(root)
    const handoff = state?.browserHandoff
    if (handoff !== undefined && handoff.state !== 'pending') return state
    if (!isAlive(supervisorPid)) return state
    if (Date.now() >= deadline) return state
    await sleep(200)
  }
}

/**
 * 渲染浏览器交接结果（一行，供 start / status 共用）。
 * @param {object|undefined} handoff - state.browserHandoff
 * @returns {string} 描述
 */
function describeHandoff(handoff) {
  if (handoff === undefined || handoff === null) return '未记录'
  switch (handoff.state) {
    case 'ok':
      return `已交由系统浏览器打开（${String(handoff.method)}）`
    case 'failed':
      return `**未打开**（${String(handoff.method)}：${String(handoff.error ?? '未知原因')}）→ 执行 nomad open，或用 nomad url 取含令牌地址手动打开`
    case 'skipped':
      return '未打开（--no-browser）'
    case 'pending':
      return '进行中（结果未在等待窗口内落盘）'
    default:
      return `未知状态：${String(handoff.state)}`
  }
}

/**
 * `nomad start`。
 * @param {Record<string, string|boolean>} flags - flag
 * @returns {Promise<number|null>} 退出码；null 表示保持运行（前台模式）
 */
async function cmdStart(flags) {
  const ctx = resolveContext(flags)
  // Phase 3.1：CLI 级 profile 覆盖（优先于 config.runtime.dsh.profile）。
  // 只影响本次启动；校验复用 profile.js 的守卫（保留名/路径分隔符一律拒绝）。
  const profileOverride = flagValue(flags, 'profile')
  if (profileOverride !== undefined) {
    try {
      validateProfileName(profileOverride)
    } catch (error) {
      console.error(`启动中止：${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
    ctx.config.runtime.dsh.profile = profileOverride
  }
  const foreground = flagBool(flags, ['foreground', 'f'])
  const openBrowser = !flagBool(flags, ['no-browser'])
  const timeoutMs = Number(flagValue(flags, 'timeout')) || DEFAULT_READY_TIMEOUT_MS

  if (flagBool(flags, ['dry-run', 'dry'])) {
    printPlan(ctx, { openBrowser })
    return 0
  }

  ensureDirs(ctx.config)

  const existing = readState(ctx.root)
  if (existing !== null && (isAlive(existing.supervisorPid) || isAlive(existing.dshPid))) {
    console.log('Nomad 已在运行。')
    console.log(`  地址  ${existing.publicUrl ?? sanitizeUrl(existing.url ?? '')}`)
    console.log(`  认证  ${describeHandshake(existing.webAuth)}`)
    console.log(`  浏览器 ${describeHandoff(existing.browserHandoff)}`)
    console.log(`  DSH   pid=${String(existing.dshPid)}  版本=${String(existing.runtime?.version ?? '未知')}`)
    console.log('  如需重新开始，先执行 nomad stop。')
    return 0
  }
  if (existing !== null) {
    clearState(ctx.root)
    console.log('已清理上一次运行遗留的状态文件。')
  }

  // 自举 DSH profile：把自研 bundle 追加进 $DSH_HOME/profiles/<name>/。
  // 必须在拉起监管进程**之前**做，否则失败会以「DSH 一句含糊的 did not activate」形式出现。
  const profile = ensureNomadProfile({ root: ctx.root, config: ctx.config })
  if (!profile.ok) {
    console.error(`启动中止：${profile.error}`)
    console.error('  提示：检查 config/nomad.yaml 的 runtime.dsh.profile / profile_template / bundle_source；')
    console.error('        用 `nomad start --dry-run` 看计划，或 `nomad doctor` 看 profile 巡检结果。')
    return 1
  }
  if (profile.action === 'created' || profile.action === 'updated') {
    console.log(`DSH profile「${profile.name}」已${profile.action === 'created' ? '创建' : '更新'}（自研层 ${profile.bundleSpec}）`)
  }

  const hostArgs = [path.join(__dirname, 'host.js'), '--root', ctx.root]
  const configFlag = flagValue(flags, 'config')
  if (configFlag !== undefined) hostArgs.push('--config', configFlag)
  if (!openBrowser) hostArgs.push('--no-browser')
  if (foreground) hostArgs.push('--foreground')

  const child = spawn(process.execPath, hostArgs, {
    cwd: ctx.root,
    detached: !foreground,
    // 后台模式刻意**不建立 IPC 通道**：一个打开的 IPC 通道会把启动器的事件循环
    // 一直钉住，导致 `nomad start` 打印完就绪信息后无法退出（进程"假活"）。
    // 后台停止走状态文件 + 心跳校验，不需要 IPC；前台模式才保留 IPC。
    stdio: foreground ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })

  if (foreground) {
    console.log(`Nomad 前台启动中…（监管进程 pid=${String(child.pid)}，Ctrl+C 停止）`)
    child.on('exit', (code) => {
      process.exitCode = typeof code === 'number' ? code : 0
    })
    // 安全网：中断后若监管进程仍未退出，兜底强杀（不会先于优雅退出触发）。
    process.on('SIGINT', () => {
      const timeoutMsGraceful = Number(ctx.config.behavior.graceful_shutdown_timeout_ms) || 8000
      console.log('\n收到中断，等待运行时优雅退出…')
      setTimeout(() => {
        if (isAlive(child.pid)) {
          console.log('监管进程未在预期时间内退出，强制结束进程树。')
          forceKillTree(child.pid)
        }
      }, timeoutMsGraceful + 5000)
    })
    return null
  }

  child.unref()
  console.log(`Nomad 启动中…（监管进程 pid=${String(child.pid)}）`)
  const ready = await waitForReady(ctx.root, timeoutMs, child.pid)
  if (!ready.ok) {
    console.error(`启动失败：${ready.reason ?? '未知原因'}`)
    console.error('')
    console.error(tailLogs(ctx.config, { raw: false, lines: 30 }))
    if (isAlive(child.pid)) forceKillTree(child.pid)
    clearState(ctx.root)
    return 1
  }

  const state = await waitForHandoff(ctx.root, child.pid, openBrowser ? HANDOFF_WAIT_MS : 0) ?? ready.state
  const handoff = state.browserHandoff
  console.log('')
  console.log('Nomad 已就绪。')
  console.log(`  地址   ${state.publicUrl ?? sanitizeUrl(state.url)}`)
  console.log(`  端口   ${String(state.port)}${ctx.config.web.port === 0 ? '（由 OS 协商，非写死）' : ''}`)
  console.log(`  浏览器 ${describeHandoff(handoff)}`)
  console.log(`  认证   ${describeHandshake(state.webAuth)}`)
  console.log(`  运行时 DSH ${String(state.runtime?.version ?? '未知')} / Nomad ${readNomadVersion(ctx.root)}`)
  console.log(`  进程   监管 pid=${String(state.supervisorPid)}  DSH pid=${String(state.dshPid)}`)
  console.log(`  日志   ${ctx.config.paths.logs}`)
  console.log('  提示   浏览器上一页显示 "authentication required" 时，用 `nomad open` 重开（会带上令牌）；')
  console.log('         手动访问用 `nomad url`（打印含令牌的完整地址，敏感勿外传）；停止用 `nomad stop`')
  if (handoff?.state === 'failed') {
    console.log('')
    console.log('  ⚠ 自动打开浏览器未成功，但实例已就绪可正常使用（见上行「浏览器」）。')
    console.log('    自救：`nomad open` → `nomad url` 手动粘地址 → 配 web.browser_path 指定浏览器。')
  }
  // 退出码只回答"实例是否就绪"这一件事。浏览器交接失败不影响实例可用性
  // （nomad open / nomad url 都能救），所以不把它编码成非 0 —— 那会让 restart
  // 之类的链路误判"启动失败"。交接结果已由上面的「浏览器」一行如实打印。
  return 0
}

/**
 * `nomad stop`。
 * @param {Record<string, string|boolean>} flags - flag
 * @returns {number} 退出码
 */
function cmdStop(flags) {
  const ctx = resolveContext(flags)
  const force = flagBool(flags, ['force'])
  const state = readState(ctx.root)
  if (state === null) {
    console.log('Nomad 未在运行。')
    return 0
  }

  const supervisorPid = Number(state.supervisorPid) || 0
  const dshPid = Number(state.dshPid) || 0
  const aliveSupervisor = isAlive(supervisorPid)
  const aliveDsh = isAlive(dshPid)

  if (!aliveSupervisor && !aliveDsh) {
    clearState(ctx.root)
    console.log('Nomad 未在运行（已清理陈旧状态文件）。')
    return 0
  }

  // 安全闸：没有新鲜心跳时**绝不按 PID 杀进程**。
  // PID 会被系统复用，陈旧状态里的 pid 可能已指向毫不相干的进程。
  if (!isFresh(state)) {
    clearState(ctx.root)
    console.error('检测到陈旧状态（心跳已过期），已跳过停止操作以避免误杀无关进程。')
    console.error(`  状态文件记录的监管进程 pid=${String(supervisorPid)}，DSH pid=${String(dshPid)}。`)
    console.error('  这些 PID 可能已被操作系统复用。若确认仍有 Nomad 残留进程，请自行核对后手动结束。')
    return 1
  }

  const timeoutMs = Number(ctx.config.behavior.graceful_shutdown_timeout_ms) || 8000

  if (process.platform === 'win32') {
    // Windows 上无 POSIX 信号语义：Node 的 kill 即 TerminateProcess，
    // 且 detached 子进程没有可用的 IPC 通道，因此统一走 taskkill 进程树。
    // 这条限制是真实存在的，已写入 docs/PHASE1_LAUNCHER.md 与 ADR-0012。
    if (!force) console.log('Windows 平台将以 taskkill 结束进程树（无 POSIX 优雅信号语义）。')
    if (aliveDsh) {
      spawnSync('taskkill', ['/PID', String(dshPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
    if (aliveSupervisor) {
      spawnSync('taskkill', ['/PID', String(supervisorPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
  } else {
    try {
      process.kill(supervisorPid, 'SIGTERM')
    } catch {
      /* 已退出 */
    }
    const deadline = Date.now() + timeoutMs + 2000
    while (isAlive(supervisorPid) && Date.now() < deadline) sleepSync(200)
    if (isAlive(dshPid)) forceKillTree(dshPid)
    if (isAlive(supervisorPid)) forceKillTree(supervisorPid)
  }

  const cleared = clearState(ctx.root)
  if (!cleared) {
    console.warn(`注意：状态文件未能删除（${stateFile(ctx.root)}）。`)
    console.warn('      它含本次运行的启动 URL（权限 0600）；下次 start 会先自动清理，不影响使用。')
  }
  const stillAlive = isAlive(supervisorPid) || isAlive(dshPid)
  console.log(stillAlive ? '停止请求已发出，但仍有进程存活（请检查 nomad status）。' : '已停止 Nomad。')
  return stillAlive ? 1 : 0
}

/**
 * `nomad status`。
 * @param {Record<string, string|boolean>} flags - flag
 * @returns {Promise<number>} 退出码（0 运行中 / 3 未运行）
 */
async function cmdStatus(flags) {
  const ctx = resolveContext(flags)
  const state = readState(ctx.root)
  if (state === null) {
    if (flagBool(flags, ['json'])) console.log(JSON.stringify({ running: false }, null, 2))
    else console.log('状态：未运行')
    return 3
  }

  const aliveSupervisor = isAlive(Number(state.supervisorPid))
  const aliveDsh = isAlive(Number(state.dshPid))
  const running = aliveSupervisor && aliveDsh
  const probe = state.publicUrl === undefined && state.url === undefined
    ? { reachable: false, status: undefined }
    : await probeHttp(state.url ?? state.publicUrl, { timeoutMs: 1500 })

  if (flagBool(flags, ['json'])) {
    console.log(JSON.stringify({
      running,
      publicUrl: state.publicUrl === undefined ? null : state.publicUrl,
      port: state.port ?? null,
      supervisorPid: state.supervisorPid ?? null,
      dshPid: state.dshPid ?? null,
      runtime: state.runtime ?? null,
      startedAt: state.startedAt ?? null,
      http: probe.reachable ? probe.status : null,
      // 这两项回答"浏览器为什么进不去"：交接是否真的成功、URL 本身能否通过鉴权。
      browserHandoff: state.browserHandoff ?? null,
      webAuth: state.webAuth === undefined
        ? null
        : { ok: state.webAuth.ok === true, error: state.webAuth.error ?? null },
    }, null, 2))
    return running ? 0 : 3
  }

  console.log(`状态：${running ? '运行中' : '已退出（状态文件残留）'}`)
  console.log(`  地址     ${state.publicUrl ?? sanitizeUrl(state.url ?? '')}`)
  console.log(`  HTTP     ${probe.reachable ? `可达（${String(probe.status)}）` : '不可达'}`)
  console.log(`  认证     ${describeHandshake(state.webAuth)}`)
  console.log(`  浏览器   ${describeHandoff(state.browserHandoff)}`)
  console.log(`  监管进程 pid=${String(state.supervisorPid)} ${aliveSupervisor ? '存活' : '已退出'}`)
  console.log(`  DSH 进程 pid=${String(state.dshPid)} ${aliveDsh ? '存活' : '已退出'}`)
  console.log(`  运行时   ${String(state.runtime?.name ?? '?')} ${String(state.runtime?.version ?? '?')}`)
  console.log(`  profile  ${String(state.profile ?? '?')}`)
  console.log(`  启动于   ${String(state.startedAt ?? '?')}`)
  console.log(`  日志     ${ctx.config.paths.logs}`)
  return running ? 0 : 3
}

/**
 * `nomad rollback [<version>]` / `nomad rollback --to <version>`。
 *
 * 只改写 current 指针（ADR-0016：回滚 = 改一行 entry），影响**下一次启动**；
 * 运行中的实例不受影响，因此实例存活时拒绝（除非 --force），避免"切了但当前实例没变"的错觉。
 *
 * @param {Record<string, string|boolean>} flags - flag
 * @returns {number} 退出码
 */
function cmdRollback(flags, positionals) {
  const ctx = resolveContext(flags)
  const target = flagValue(flags, 'to') ?? positionals[1]

  if (target === undefined) {
    const available = listDshVersions(ctx.root, ctx.config)
    const current = (() => {
      try {
        const { manifest } = require('./lib/runtime-rollback.js').readCurrentManifest(ctx.root, ctx.config)
        return manifest.version ?? '(未知)'
      } catch {
        return '(未知)'
      }
    })()
    console.log(`当前 DSH 版本：${current}`)
    console.log(`已安装版本：${available.join(', ') || '(仅 current)'}`)
    console.log('')
    console.log('用法：nomad rollback <version>    （如 nomad rollback 0.2.1-alpha.1）')
    console.log('      回滚只影响下次启动；正在运行的实例不受影响，请先 nomad stop。')
    return 0
  }

  const state = readState(ctx.root)
  const alive = state !== null && (isAlive(Number(state.supervisorPid)) || isAlive(Number(state.dshPid)))
  if (alive && !flagBool(flags, ['force'])) {
    console.error('Nomad 正在运行，拒绝回滚 current 指针（回滚只影响下次启动，当前实例不会变）。')
    console.error('  请先执行 `nomad stop`，或在命令后加 --force 强制改写指针（当前运行实例仍不受影响）。')
    return 1
  }

  try {
    const result = applyRollback(ctx.root, ctx.config, target)
    console.log(`已回滚 DSH 运行时：${result.from} → ${result.to}`)
    console.log(`  指针文件 ${result.file}`)
    console.log('  下次启动将使用该版本。当前运行实例不受影响，需要切换请先 nomad stop 再 nomad start。')
    return 0
  } catch (error) {
    console.error(`回滚失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/**
 * `nomad backup`。
 * @param {Record<string, string|boolean>} flags - flag
 * @returns {number} 退出码
 */
function cmdBackup(flags) {
  const ctx = resolveContext(flags)
  const includeConfig = flagBool(flags, ['include-config'])
  const to = flagValue(flags, 'to')
  const state = readState(ctx.root)
  const alive = state !== null && (isAlive(Number(state.supervisorPid)) || isAlive(Number(state.dshPid)))
  try {
    const result = createBackup(ctx.root, ctx.config, { includeConfig, to })
    console.log(`已备份到：${result.dir}`)
    for (const item of result.manifest.items) {
      console.log(`  + ${item.relPath}（${String(item.files)} 个文件）`)
    }
    for (const warning of result.warnings) console.log(`  ⚠ ${warning}`)
    if (alive) {
      console.log('')
      console.log('  ⚠ Nomad 正在运行，本次为运行期快照，可能捕获到写入中途的文件。')
      console.log('    需要一致性快照时，请先 `nomad stop` 再备份。')
    }
    return 0
  } catch (error) {
    console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/**
 * `nomad restore <backup-dir>`。
 * @param {Record<string, string|boolean>} flags - flag
 * @param {string[]} positionals - 位置参数
 * @returns {number} 退出码
 */
function cmdRestore(flags, positionals) {
  const ctx = resolveContext(flags)
  const backupDir = flagValue(flags, 'dir') ?? positionals[1]
  if (backupDir === undefined) {
    console.error('用法：nomad restore <backup-dir>   （如 nomad restore data/backups/nomad-backup-20261008-193400）')
    return 64
  }
  const state = readState(ctx.root)
  const alive = state !== null && (isAlive(Number(state.supervisorPid)) || isAlive(Number(state.dshPid)))
  if (alive && !flagBool(flags, ['force'])) {
    console.error('Nomad 正在运行，拒绝恢复（恢复会覆盖盘内数据，且当前实例可能正在写这些文件）。')
    console.error('  请先执行 `nomad stop`，或加 --force 强制恢复（不保证运行期一致）。')
    return 1
  }
  try {
    const result = restoreBackup(ctx.root, ctx.config, backupDir)
    console.log(`已从 ${backupDir} 恢复 ${String(result.restored)} 个文件（合并复制：覆盖已有、不删除多余）。`)
    return 0
  } catch (error) {
    console.error(`恢复失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/**
 * `nomad projects`：列出已持久化的 DSH 工作区（项目）。
 * @param {Record<string, string|boolean>} flags - flag
 * @returns {number} 退出码
 */
function cmdProjects(flags) {
  const ctx = resolveContext(flags)
  let parsed
  try {
    parsed = parseWorkspaces(ctx.root, ctx.config)
  } catch (error) {
    console.error(`projects: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (parsed === null) {
    console.log('尚未发现任何持久化的工作区（DSH 可能还未初始化过项目）。')
    console.log(`  清单预期位置：${path.join(ctx.config.paths.dsh_home, 'storages', 'workspace.json')}`)
    return 0
  }
  console.log(`已持久化工作区：${String(parsed.workspaces.length)} 个，共 ${String(parsed.totalSessions)} 个会话`)
  console.log(`（数据位于盘内 ${ctx.config.paths.dsh_home}，runtime 升级不丢失）`)
  console.log('')
  for (const ws of parsed.workspaces) {
    const mark = ws.id === parsed.defaultId ? ' [默认]' : ''
    console.log(`• ${ws.title}${mark}`)
    console.log(`    路径     ${ws.path}`)
    console.log(`    会话数   ${String(ws.sessionCount)}`)
    if (ws.updatedAt !== null) console.log(`    更新于   ${String(ws.updatedAt)}`)
  }
  return 0
}

/**
 * 主分派。
 * @returns {Promise<void>} 完成
 */
async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const command = positionals[0]
    ?? (flagBool(flags, ['help', 'h']) ? 'help' : flagBool(flags, ['version', 'V']) ? 'version' : 'start')

  let code = 0
  switch (command) {
    case 'start':
    case 'up': {
      const result = await cmdStart(flags)
      if (result === null) return // 前台模式：交给进程事件收敛
      code = result
      break
    }
    case 'stop':
    case 'down':
      code = cmdStop(flags)
      break
    case 'restart': {
      cmdStop(flags)
      code = (await cmdStart(flags)) ?? 0
      break
    }
    case 'rollback':
      code = cmdRollback(flags, positionals)
      break
    case 'backup':
      code = cmdBackup(flags)
      break
    case 'restore':
      code = cmdRestore(flags, positionals)
      break
    case 'projects':
      code = cmdProjects(flags)
      break
    case 'status':
      code = await cmdStatus(flags)
      break
    case 'doctor': {
      const ctx = resolveContext(flags)
      const report = await runDoctor(ctx)
      if (flagBool(flags, ['json'])) console.log(JSON.stringify(report, null, 2))
      else console.log(renderDoctor(report))
      code = report.summary.fail > 0 ? 1 : 0
      break
    }
    case 'env': {
      const ctx = resolveContext(flags)
      const built = buildEnv({ root: ctx.root, isolation: ctx.config.isolation })
      console.log('隔离环境计划：')
      for (const line of describePlan(built.report, ctx.config.isolation.override, ctx.root)) console.log(`  ${line}`)
      console.log('')
      console.log('实际注入子进程的环境（已脱敏）：')
      console.log(JSON.stringify(redactEnv(built.env), null, 2))
      break
    }
    case 'paths': {
      const ctx = resolveContext(flags)
      console.log(`NOMAD_ROOT  ${ctx.root}（来源 ${ctx.source}）`)
      console.log('路径：')
      for (const [key, value] of Object.entries(ctx.config.paths)) console.log(`  ${key.padEnd(10)} ${value}`)
      console.log(`Node  ${ctx.runtime.node.path}（${ctx.runtime.node.version ?? '版本未探测'}，${ctx.runtime.node.source}）`)
      try {
        const info = inspectNomadProfile({ root: ctx.root, config: ctx.config })
        console.log(`profile  ${info.spec.name} → ${info.spec.dir}（模板 ${info.spec.template}，自研层 ${info.spec.bundleSpec}）`)
      } catch (error) {
        console.log(`profile  ✗ ${error instanceof Error ? error.message : String(error)}`)
      }
      if (ctx.runtime.dsh.missing === true) {
        console.log(`DSH   ✗ ${ctx.runtime.dsh.reason ?? '缺失'}`)
      } else {
        console.log(`DSH   ${ctx.runtime.dsh.name} ${ctx.runtime.dsh.version}`)
        console.log(`入口  ${ctx.runtime.dsh.entry}（${ctx.runtime.dsh.entrySource}）`)
      }
      break
    }
    case 'profile': {
      const ctx = resolveContext(flags)
      // 与 rollback/restore 同约定：positionals[0] 是命令本身，子命令从 [1] 起。
      const sub = positionals[1]

      // -- profile list：列出盘内全部 profile（Phase 3.1）
      if (sub === 'list') {
        const scan = listProfiles({ root: ctx.root, config: ctx.config })
        console.log(`profile 根目录  ${scan.base}`)
        console.log(`启动默认        ${scan.defaultName}`)
        console.log(`内置保留名（模板，不在盘内列举）  ${scan.reserved.join(' / ')}`)
        if (scan.profiles.length === 0) {
          console.log('盘内暂无 profile —— start 会按模板自动创建。')
          break
        }
        console.log('')
        for (const item of scan.profiles) {
          const tag = item.kind === 'default' ? ' [启动默认]' : ''
          const state = item.problems.length === 0 ? '有效' : `⚠ ${item.problems.length} 个问题`
          console.log(`${item.name}${tag}  ${state}`)
          for (const problem of item.problems) console.log(`    - ${problem}`)
        }
        break
      }

      // -- profile create <name> [--template <内置名>]：创建骨架（绝不覆盖已有内容）
      if (sub === 'create') {
        const name = positionals[2]
        if (typeof name !== 'string' || name === '') {
          console.error('用法：nomad profile create <name> [--template acp|web|headless|sdk|sdk-minimal]')
          code = 1
          break
        }
        const template = flagValue(flags, 'template') ?? 'web'
        const result = createProfile({ root: ctx.root, config: ctx.config }, name, template)
        if (!result.ok) {
          console.error(`创建失败：${result.error}`)
          code = 1
          break
        }
        console.log(`profile「${result.name}」已创建（派生自 ${result.template}）：${result.dir}`)
        console.log(`  bundles: ${result.bundles.join(', ')}`)
        for (const file of result.created) console.log(`  + ${file}`)
        break
      }

      // -- profile validate <name>：深度校验单个 profile
      if (sub === 'validate') {
        const name = positionals[2]
        if (typeof name !== 'string' || name === '') {
          console.error('用法：nomad profile validate <name>')
          code = 1
          break
        }
        const dir = path.join(ctx.config.paths.dsh_home, 'profiles', name)
        const check = validateProfileDir(dir)
        if (!check.exists) {
          console.error(`profile「${name}」不存在：${check.dir}`)
          code = 1
          break
        }
        console.log(`profile ${name}  ${check.dir}`)
        console.log(`  bundles(${check.bundles.length}): ${check.bundles.join(', ') || '(无)'}`)
        if (check.problems.length === 0) {
          console.log('  结论：有效')
        } else {
          console.log('  结论：存在问题')
          for (const problem of check.problems) console.log(`    - ${problem}`)
          code = 1
        }
        break
      }

      if (sub !== undefined) {
        console.error(`未知子命令「${sub}」。可用：list / create <name> / validate <name>；无参数 = 查看 ${ctx.config.runtime?.dsh?.profile ?? 'nomad'} 自建层。`)
        code = 1
        break
      }

      if (flagBool(flags, ['ensure'])) {
        const result = ensureNomadProfile({ root: ctx.root, config: ctx.config, logger: console })
        if (!result.ok) {
          console.error(`profile 自举失败：${result.error ?? '未知原因'}`)
          code = 1
          break
        }
        console.log(`自举结果：${result.action}${result.action === 'skipped' ? `（${String(result.reason)}）` : ''}`)
      }

      let info
      try {
        info = inspectNomadProfile({ root: ctx.root, config: ctx.config })
      } catch (error) {
        console.error(`profile 解析失败：${error instanceof Error ? error.message : String(error)}`)
        console.error('  检查 config/nomad.yaml 的 runtime.dsh.profile / profile_template / bundle_source。')
        code = 1
        break
      }
      console.log('')
      console.log(`profile      ${info.spec.name}（派生自内置模板 ${info.spec.template}）`)
      console.log(`目录         ${info.spec.dir}`)
      console.log(`自研 bundle  ${info.spec.bundleSpec}`)
      console.log(`             → ${info.spec.bundleSourceDir}`)
      console.log(`清单         ${info.exists ? (info.manifestValid ? '存在且可解析' : '存在但不可解析（JSON 坏了）') : '不存在'}`)
      if (info.exists && info.manifestValid) {
        for (const [index, bundle] of info.bundles.entries()) {
          console.log(`  ${String(index + 1)}. ${bundle}${bundle === info.spec.bundleSpec ? '   ← 自研层' : ''}`)
        }
      }
      console.log(`补丁层       ${info.patchExists ? info.spec.patchPath : '(缺失 —— start 会补)'}`)
      console.log(`结论         ${info.problems.length === 0 ? '就绪：自研层已在 bundles 末位' : info.problems.join('；')}`)
      break
    }
    case 'logs': {
      const ctx = resolveContext(flags)
      const lines = Number(flagValue(flags, 'lines')) || 60
      console.log(tailLogs(ctx.config, { raw: flagBool(flags, ['raw']), lines }))
      break
    }
    case 'url': {
      const ctx = resolveContext(flags)
      const state = readState(ctx.root)
      if (state === null || state.url === undefined) {
        console.error('没有可用的访问地址（实例未运行）。')
        code = 3
        break
      }
      console.log(state.url)
      console.error('# 该地址含本次启动令牌（用于给浏览器铸 cookie），请勿外传或截图。')
      break
    }
    case 'open': {
      const ctx = resolveContext(flags)
      const state = readState(ctx.root)
      if (state === null || state.url === undefined) {
        console.error('实例未运行，无地址可打开。')
        code = 3
        break
      }
      // 这是浏览器 401 之后的**第一自救通道**：重开时必须带 token，
      // 并且如实报告打开器退出码，不谎报成功。
      // 这里把 info 静音（结果的呈现由本命令统一负责），只保留 warn 直通 stderr。
      const result = await openBrowser(state.url, {
        browserPath: ctx.config.web.browser_path,
        logger: { warn: (message) => console.error(message), info: () => {} },
      })
      if (!result.ok) {
        console.error(`打开失败（${result.method}）：${result.error ?? '未知原因'}`)
        console.error('  备用通道：执行 `nomad url` 拿到**含 token** 的完整地址，手动粘进浏览器地址栏。')
        console.error('  若浏览器被安全软件拦截，可在 config/nomad.yaml 设置 web.browser_path 指向浏览器可执行文件。')
        code = 1
      } else {
        console.log(`已请求系统打开浏览器（${result.method}）。`)
        console.log(`  地址（脱敏）${state.publicUrl ?? sanitizeUrl(state.url)}`)
        console.log('  若浏览器仍显示 "authentication required"，只有两种可能，逐一排除：')
        console.log('    ① 地址没带令牌 —— 同一地址**不带** `?token=…` 必然 401，这是 DSH 的鉴权设计，请在地址栏确认 query 还在；')
        console.log('    ② 浏览器拒收 cookie —— 该会话 cookie 是 `dsh-auth-…`（HttpOnly + SameSite=Strict，无 Secure）。')
        console.log('       在无痕窗口里重开一次可排除"扩展/隐私策略拦 cookie"；企业策略也可能拦 127.0.0.1 的 cookie。')
      }
      break
    }
    case 'version': {
      const { root } = detectRoot({ explicit: flagValue(flags, 'root') })
      console.log(`Nomad        ${readNomadVersion(root)}`)
      console.log(`Launcher     ${LAUNCHER_VERSION}`)
      console.log(`Node         ${process.versions.node}（${process.execPath}）`)
      console.log(`Platform     ${process.platform} ${process.arch}`)
      console.log(`今天         ${localDate()}`)
      break
    }
    case 'help':
      console.log(HELP)
      break
    default:
      console.error(`未知命令：${command}`)
      console.error('')
      console.error(HELP)
      code = 64
  }
  process.exitCode = code
}

main().catch((error) => {
  console.error(`nomad: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 70
})
