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
 *   nomad skill list           列出已安装 skill（user-dsh 根：data/dsh-home/skills/）
 *   nomad skill add <path>     安装本地 skill（目录束或 .md 文件；不碰网络下载）
 *   nomad skill remove <name>  卸载 skill（装/删均热生效，无需重启实例）
 *   nomad start [--profile <name>]   覆盖本次启动使用的 profile（默认仍 nomad）
 *   nomad logs [--raw] [--lines N]
 *   nomad url                  打印带 token 的访问地址（敏感）
 *   nomad open                 重新用浏览器打开当前实例
 *   nomad version
  nomad rollback [<version>] [--to <version>] [--force]   回滚 DSH 运行时（改写 current 指针）
  nomad update [--check] [--yes] [--force]                检查/执行 DSH 升级（--yes 才动手，绝不自动）
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
const { createBackup, restoreBackup, lastBackupInfo } = require('./lib/backup.js')
const { parseWorkspaces } = require('./lib/projects.js')
const { buildEnv, describePlan } = require('./lib/env.js')
const { storageReport, clean, humanBytes } = require('./lib/dataman.js')
const { redactEnv, localDate } = require('./lib/logger.js')
const { ensureDirs, buildArgv } = require('./lib/bootstrap.js')
const { ensureNomadProfile, inspectNomadProfile, listProfiles, createProfile, validateProfileDir, validateProfileName } = require('./lib/profile.js')
const { listSkills, addSkill, removeSkill, skillsDir } = require('./lib/skills.js')
const { loadPermissions, selfCheckNever, describePermissions } = require('./lib/permissions.js')
const { readState, clearState, isAlive, isFresh, stateFile } = require('./lib/state.js')
const { sanitizeUrl } = require('./lib/dsh-url.js')
const { probeHttp } = require('./lib/probe.js')
const { openBrowser } = require('./lib/browser.js')
const { describeHandshake } = require('./lib/web-auth.js')
const { runDoctor, renderDoctor } = require('./lib/doctor.js')
const ui = require('./lib/cli-ui.js')

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

/** 备份提示阈值（天）：start 时上次备份超过该天数则提示，不自动执行（3.5）。 */
const BACKUP_HINT_DAYS = 30

/** 帮助文本（Linux man 页风格：品牌头 + 分区标题 + 等宽命令列）。 */
function buildHelp() {
  const g = ui.glyphs()
  const cmd = (names, desc) => `  ${ui.bold(ui.padEnd(names, 20))} ${desc}`
  const lines = [
    `${g.brand} ${ui.bold('Nomad')} ${ui.dim('—')} ${ui.cyan('Portable Agent OS')} ${ui.dim(`(Launcher ${LAUNCHER_VERSION})`)}`,
    '',
    `${ui.dim('用法')}   nomad ${ui.dim('[命令] [选项]')}`,
    '',
    ui.title('命令'),
    cmd('start', '启动 Nomad（默认后台运行后返回）'),
    cmd('stop', '停止当前实例'),
    cmd('restart', '停止后重新启动'),
    cmd('status', '查看实例状态'),
    cmd('doctor', '体检（路径 / 隔离 / 运行时 / 端口 / 宿主探针）'),
    cmd('env', '打印将要注入子进程的隔离环境计划'),
    cmd('paths', '打印解析后的路径与运行时入口'),
    cmd('profile', '查看自建 profile 状态（只读）'),
    cmd('profile --ensure', '把自建 profile 自举到位（幂等；start 也会自动做）'),
    cmd('skill', `管理 Agent 技能（user-dsh 根：${ui.dim('data/dsh-home/skills/')}，rank 400）`),
    cmd('skill list', '列出已安装 skill（含无效项的问题与被忽略项）'),
    cmd('skill add <path>', '安装本地 skill（<name>/SKILL.md 目录束 或 <name>.md 扁平文件）'),
    cmd('skill remove <name>', '卸载 skill（热生效：DSH 文件 watch，无需重启实例）'),
    cmd('storage', '数据全景报告（各目录体积/文件数，区分长期与可清理）'),
    cmd('storage clean', `清理可清理白名单（data/tmp、dsh-home/tmp）—— ${ui.dim('--dry-run 预览')}`),
    `  ${ui.padEnd('', 20)} ${ui.dim('实际清理必须 --yes；--min-age=<分钟> 调整「多久没动才算陈旧」（默认 120）')}`,
    cmd('logs', '查看最近日志'),
    cmd('url', '打印带 token 的访问地址（敏感，勿外传）'),
    cmd('open', '用系统浏览器重新打开当前实例'),
    cmd('version', '打印版本信息'),
    cmd('rollback', '回滚 DSH 运行时版本（改写 current 指针，影响下次启动）'),
    cmd('update', '检查 DSH 新版本（默认 --check 只读；--yes 才实际升级）'),
    cmd('backup', '备份盘内用户数据（会话/项目/配置）到 data/backups/'),
    cmd('restore', '从备份恢复盘内用户数据'),
    cmd('projects', '列出已持久化的 DSH 工作区（项目）'),
    '',
    ui.title('选项'),
    cmd('-f, --foreground', '前台运行（Ctrl+C 停止，便于调试）'),
    cmd('-d, --background', '后台运行（默认）'),
    cmd('--dry-run', '只打印启动计划，不启动任何进程'),
    cmd('--no-browser', '不自动打开浏览器'),
    cmd('--root <dir>', '显式指定 NOMAD_ROOT'),
    cmd('--config <file>', '显式指定配置文件'),
    cmd('--timeout <ms>', `等待就绪的超时（默认 ${String(DEFAULT_READY_TIMEOUT_MS)}）`),
    cmd('--lines <n>', 'logs 显示行数（默认 60）'),
    cmd('--raw', 'logs 查看 DSH 原始输出'),
    cmd('--json', '以 JSON 输出（status / doctor）'),
    '',
    ui.dim('硬约束：构建期与运行期分离；用户机零编译；启动路径不出现 npx；一切路径从 NOMAD_ROOT 派生。'),
  ]
  return lines.join('\n')
}

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
  const g = ui.glyphs()
  console.log(`${g.brand} ${ui.bold('Nomad 启动计划')} ${ui.dim('（dry-run，未启动任何进程）')}`)
  console.log('')
  console.log(ui.kv('NOMAD_ROOT', ui.dim(root)))
  console.log(`  ${ui.kv('来源', ui.dim(source))}`)
  console.log(ui.kv('配置文件', ui.dim(config.file)))
  console.log(ui.kv('版本', `Nomad ${readNomadVersion(root)} / launcher ${LAUNCHER_VERSION}`))
  console.log('')
  console.log(ui.title('运行时'))
  console.log(`  ${ui.kv('Node', `${ui.dim(runtime.node.path)} ${ui.dim(`(${runtime.node.version ?? '版本未探测'}，来源 ${runtime.node.source})`)}`)}`)
  if (runtime.dsh.missing === true) {
    console.log(`  ${ui.kv('DSH', `${g.fail} ${runtime.dsh.reason ?? '缺失'}`)}`)
  } else {
    console.log(`  ${ui.kv('DSH', `${runtime.dsh.name} ${runtime.dsh.version}`)}`)
    console.log(`  ${ui.kv('入口', `${ui.dim(runtime.dsh.entry)} ${ui.dim(`（来自 ${runtime.dsh.entrySource}）`)}`)}`)
  }
  console.log('')
  if (runtime.dsh.missing === true) {
    console.log(ui.kv('启动命令', `${g.fail} 跳过（缺 DSH 运行时）`))
  } else {
    const argv = buildArgv({ config, runtime })
    console.log(ui.title('启动命令'))
    console.log(`  ${argv.display}`)
    console.log(`  ${ui.kv('cwd', ui.dim(argv.cwd))}`)
  }
  console.log('')
  console.log(ui.title('DSH profile（start 时自举，只写盘内）'))
  try {
    const info = inspectNomadProfile({ root, config })
    console.log(`  ${ui.kv('名称', `${info.spec.name} ${ui.dim(`（派生自内置模板 ${info.spec.template}）`)}`)}`)
    console.log(`  ${ui.kv('目录', ui.dim(info.spec.dir))}`)
    console.log(`  ${ui.kv('自研层', info.spec.bundleSpec)}`)
    const state = info.exists
      ? (info.bundleLast ? '已就绪（自研层在末位）' : '已存在但自研层缺失/不在末位 → start 会补正')
      : '尚未初始化 → start 会创建'
    console.log(`  ${ui.kv('状态', info.exists && info.bundleLast ? ui.tone.ok(state) : state)}`)
    for (const problem of info.problems) console.log(`  ${g.warn} ${problem}`)
  } catch (error) {
    console.log(`  ${g.fail} ${error instanceof Error ? error.message : String(error)}`)
  }
  console.log('')
  console.log(ui.title('宿主隔离'))
  for (const line of describePlan(built.report, config.isolation.override, root)) console.log(`  ${line}`)
  console.log('')
  // 权限档位（3.4）：只读展示模板 + never 自证；禁止自造桥接到上游权限体系（3.0-C）。
  try {
    const perm = loadPermissions({ root })
    const checks = selfCheckNever(perm, { config, envReport: built.report, runtime })
    console.log(ui.title('权限档位（config/permissions.yaml，契约展示）'))
    for (const line of describePermissions(perm, checks)) console.log(`  ${line}`)
    if (perm.problems.length > 0) {
      console.log(`  ${g.warn} 模板问题: ${perm.problems.join('；')}`)
    }
    console.log('')
  } catch (error) {
    console.log(`${g.fail} ${error instanceof Error ? error.message : String(error)}`)
    console.log('')
  }
  console.log(ui.kv('浏览器', options.openBrowser ? '启动就绪后由 Nomad 打开（DSH 恒定 --no-open）' : '不打开'))
  console.log(ui.kv('状态文件', ui.dim(stateFile(root))))
  if (config.warnings.length > 0) {
    console.log('')
    console.log(ui.title('配置警告'))
    for (const warning of config.warnings) console.log(`  ${g.warn} ${warning}`)
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
    const g = ui.glyphs()
    console.log(`${g.dot} ${ui.bold('Nomad 已在运行')}`)
    console.log(`  ${ui.kv('地址', ui.dim(existing.publicUrl ?? sanitizeUrl(existing.url ?? '')))}`)
    console.log(`  ${ui.kv('认证', describeHandshake(existing.webAuth))}`)
    console.log(`  ${ui.kv('浏览器', describeHandoff(existing.browserHandoff))}`)
    console.log(`  ${ui.kv('DSH', `pid=${String(existing.dshPid)}  版本=${String(existing.runtime?.version ?? '未知')}`)}`)
    console.log(`  ${ui.dim('如需重新开始，先执行 nomad stop。')}`)
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
  const g = ui.glyphs()
  console.log(`${ui.dim('◌')} Nomad 启动中… ${ui.dim(`（监管进程 pid=${String(child.pid)}）`)}`)
  const ready = await waitForReady(ctx.root, timeoutMs, child.pid)
  if (!ready.ok) {
    console.error(`${g.fail} 启动失败：${ready.reason ?? '未知原因'}`)
    console.error('')
    console.error(tailLogs(ctx.config, { raw: false, lines: 30 }))
    if (isAlive(child.pid)) forceKillTree(child.pid)
    clearState(ctx.root)
    return 1
  }

  const state = await waitForHandoff(ctx.root, child.pid, openBrowser ? HANDOFF_WAIT_MS : 0) ?? ready.state
  const handoff = state.browserHandoff
  console.log('')
  console.log(`${g.brand} ${ui.tone.ok(ui.bold('Nomad 已就绪'))}`)
  console.log(`  ${ui.kv('地址', ui.dim(state.publicUrl ?? sanitizeUrl(state.url)))}`)
  console.log(`  ${ui.kv('端口', `${String(state.port)}${ctx.config.web.port === 0 ? ui.dim('（由 OS 协商，非写死）') : ''}`)}`)
  console.log(`  ${ui.kv('浏览器', describeHandoff(handoff))}`)
  console.log(`  ${ui.kv('认证', describeHandshake(state.webAuth))}`)
  console.log(`  ${ui.kv('运行时', `DSH ${String(state.runtime?.version ?? '未知')} / Nomad ${readNomadVersion(ctx.root)}`)}`)
  console.log(`  ${ui.kv('进程', `监管 pid=${String(state.supervisorPid)}  DSH pid=${String(state.dshPid)}`)}`)
  console.log(`  ${ui.kv('日志', ui.dim(ctx.config.paths.logs))}`)
  console.log(`  ${ui.dim('提示   浏览器上一页显示 "authentication required" 时，用 `nomad open` 重开（会带上令牌）；')}`)
  console.log(`  ${ui.dim('       手动访问用 `nomad url`（打印含令牌的完整地址，敏感勿外传）；停止用 `nomad stop`')}`)
  // 3.5 备份提示：只提示不自动执行（备份永远由维护者显式触发）。
  try {
    const backupInfo = lastBackupInfo(ctx.config)
    if (backupInfo.last === null) {
      console.log(`  ${ui.kv('备份', `${ui.tone.warn('尚未备份过')} ${ui.dim('—— 建议先 `nomad backup` 再开始正式使用（sessions 是唯一事实源）。')}`)}`)
    } else if (backupInfo.ageDays >= BACKUP_HINT_DAYS) {
      console.log(`  ${ui.kv('备份', `${ui.tone.warn(`上次备份已是 ${backupInfo.ageDays} 天前`)} ${ui.dim(`（${backupInfo.last}）—— 建议 \`nomad backup\` 一次。`)}`)}`)
    }
  } catch { /* 提示失败不影响启动 */ }
  if (handoff?.state === 'failed') {
    console.log('')
    console.log(`  ${ui.glyphs().warn} 自动打开浏览器未成功，但实例已就绪可正常使用（见上行「浏览器」）。`)
    console.log(`    ${ui.dim('自救：`nomad open` → `nomad url` 手动粘地址 → 配 web.browser_path 指定浏览器。')}`)
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
    console.log(`${ui.glyphs().ring} Nomad 未在运行。`)
    return 0
  }

  const supervisorPid = Number(state.supervisorPid) || 0
  const dshPid = Number(state.dshPid) || 0
  const aliveSupervisor = isAlive(supervisorPid)
  const aliveDsh = isAlive(dshPid)

  if (!aliveSupervisor && !aliveDsh) {
    clearState(ctx.root)
    console.log(`${ui.glyphs().ring} Nomad 未在运行（已清理陈旧状态文件）。`)
    return 0
  }

  // 安全闸：没有新鲜心跳时**绝不按 PID 杀进程**。
  // PID 会被系统复用，陈旧状态里的 pid 可能已指向毫不相干的进程。
  if (!isFresh(state)) {
    clearState(ctx.root)
    console.error(`${ui.glyphs().fail} 检测到陈旧状态（心跳已过期），已跳过停止操作以避免误杀无关进程。`)
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
  console.log(stillAlive
    ? `${ui.glyphs().warn} 停止请求已发出，但仍有进程存活（请检查 nomad status）。`
    : `${ui.glyphs().ok} 已停止 Nomad。`)
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
    else console.log(`${ui.kv('状态', `${ui.glyphs().ring} 未运行`)}`)
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

  const g = ui.glyphs()
  console.log(ui.kv('状态', running ? `${g.dot} ${ui.tone.ok('运行中')}` : `${g.ring} ${ui.tone.fail('已退出')}（状态文件残留）`))
  console.log(`  ${ui.kv('地址', ui.dim(state.publicUrl ?? sanitizeUrl(state.url ?? '')))}`)
  console.log(`  ${ui.kv('HTTP', probe.reachable ? ui.tone.ok(`可达（${String(probe.status)}）`) : ui.tone.fail('不可达'))}`)
  console.log(`  ${ui.kv('认证', describeHandshake(state.webAuth))}`)
  console.log(`  ${ui.kv('浏览器', describeHandoff(state.browserHandoff))}`)
  console.log(`  ${ui.kv('监管进程', `pid=${String(state.supervisorPid)} ${aliveSupervisor ? ui.tone.ok('存活') : ui.tone.fail('已退出')}`)}`)
  console.log(`  ${ui.kv('DSH 进程', `pid=${String(state.dshPid)} ${aliveDsh ? ui.tone.ok('存活') : ui.tone.fail('已退出')}`)}`)
  console.log(`  ${ui.kv('运行时', `${String(state.runtime?.name ?? '?')} ${String(state.runtime?.version ?? '?')}`)}`)
  console.log(`  ${ui.kv('profile', String(state.profile ?? '?'))}`)
  console.log(`  ${ui.kv('启动于', ui.dim(String(state.startedAt ?? '?')))}`)
  console.log(`  ${ui.kv('日志', ui.dim(ctx.config.paths.logs))}`)
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
/**
 * `nomad update` —— 检查更新（--check，只读）与手动升级（--yes）。
 * 铁律：绝不自动升级 —— 实际升级必须 --yes；运行实例存活时改指针必须 --force。
 * @param {Record<string, string|boolean>} flags - flag
 * @returns {Promise<number>} 退出码
 */
async function cmdUpdate(flags) {
  const ctx = resolveContext(flags)
  const updater = require('./lib/updater.js')
  const { readCurrentManifest, listDshVersions } = require('./lib/runtime-rollback.js')
  const pkg = flagValue(flags, ['package']) ?? updater.DEFAULT_PACKAGE_NAME

  // 当前版本（清单指针）
  let current = '(未知)'
  let manifest = null
  try {
    const m = readCurrentManifest(ctx.root, ctx.config)
    current = m.manifest.version ?? '(未知)'
    manifest = m.manifest
  } catch (error) {
    console.error(`update: 读取 current 指针失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const g = ui.glyphs()
  console.log(`${ui.dim('◌')} 正在查询 npm registry（${pkg}）……`)
  const check = await updater.checkUpdate({ current, packageName: pkg })

  if (check.comparison === 'unknown') {
    console.error(`${g.fail} 查询失败：${check.error ?? '网络不可达'}`)
    console.error(`  ${ui.dim('--check 只读无害；查询需要能访问 npm registry（如走代理请先配好代理环境）。')}`)
    return 1
  }

  // 检查成功即落盘（3.6 面板整合）：--check 与完整升级路径都会留档到
  // data/run/update-check.json，状态端点据此向面板展示「上次检查」结果。
  // 落盘失败不阻断主流程（展示数据缺失可接受，检查结论照常输出）。
  try {
    updater.saveUpdateCheck(ctx.root, check)
  } catch (error) {
    console.error(`提示：检查结果落盘失败（不影响本次检查）：${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(ui.kv('盘内当前', ui.bold(current)))
  console.log(ui.kv('registry 最新', ui.bold(check.latest)))
  const available = listDshVersions(ctx.root, ctx.config)
  console.log(ui.kv('盘内已装', ui.dim(available.join(', ') || '(仅当前)')))

  if (check.comparison === 'up-to-date') console.log(`${g.ok} 结论：${ui.tone.ok('已是最新版本')}`)
  else if (check.comparison === 'current-newer') console.log(`${g.info} 结论：${ui.tone.accent('盘内版本比 registry 最新还新（alpha/内部版），不动作')}`)
  else {
    console.log(`${g.warn} 结论：${ui.tone.warn(`可更新（${current} ${g.arrow} ${check.latest}）`)}`)
    console.log(`  ${ui.dim('升级：nomad update --yes   （下载 → 校验 → 解包 → 装依赖 → 改指针；旧版本保留可 rollback）')}`)
  }
  if (flagBool(flags, ['check'])) return 0

  if (flags.yes !== true) {
    console.error('')
    console.error(`${g.fail} 实际升级被拒绝：缺少 --yes（铁律：升级必须维护者手动触发，绝不自动）。`)
    return 1
  }
  if (check.updateAvailable !== true) {
    console.error(`${g.info} 无需升级（当前 >= registry 最新）。`)
    return 0
  }

  const state = readState(ctx.root)
  const alive = state !== null && (isAlive(Number(state.supervisorPid)) || isAlive(Number(state.dshPid)))
  let result
  try {
    result = await updater.applyUpdate({
      root: ctx.root,
      config: ctx.config,
      currentManifest: manifest,
      nodeExe: ctx.runtime.node.path,
      version: check.latest,
      tarball: check.tarball,
      integrity: check.integrity,
      instanceAlive: alive,
      force: flagBool(flags, ['force']),
      onLine: (line) => { if (line !== '') console.log(`  npm: ${line}`) },
    })
  } catch (error) {
    console.error(`升级失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  console.log(`${g.ok} 已升级 DSH 运行时：${ui.bold(current)} ${g.arrow} ${ui.tone.ok(ui.bold(result.version))}`)
  console.log(`  ${ui.kv('版本目录', ui.dim(result.versionDir) + ui.dim('（依赖树已重建）'))}`)
  console.log(`  ${ui.kv('指针文件', ui.dim(result.pointerFile))}`)
  console.log(`  ${ui.dim('旧版本目录已保留：nomad rollback <旧版本> 可随时回退（回滚只影响下次启动）。')}`)
  console.log(`  ${ui.dim('请执行 nomad start 以新版本启动。')}`)
  return 0
}

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
    const g = ui.glyphs()
    console.log(ui.kv('当前 DSH 版本', ui.bold(current)))
    console.log(ui.kv('已安装版本', ui.dim(available.join(', ') || '(仅 current)')))
    console.log('')
    console.log(`  ${ui.dim('用法：nomad rollback <version>    （如 nomad rollback 0.2.1-alpha.1）')}`)
    console.log(`  ${ui.dim('回滚只影响下次启动；正在运行的实例不受影响，请先 nomad stop。')}`)
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
    const g = ui.glyphs()
    console.log(`${g.ok} 已回滚 DSH 运行时：${ui.bold(result.from)} ${g.arrow} ${ui.tone.ok(ui.bold(result.to))}`)
    console.log(`  ${ui.kv('指针文件', ui.dim(result.file))}`)
    console.log(`  ${ui.dim('下次启动将使用该版本。当前运行实例不受影响，需要切换请先 nomad stop 再 nomad start。')}`)
    return 0
  } catch (error) {
    console.error(`${ui.glyphs().fail} 回滚失败：${error instanceof Error ? error.message : String(error)}`)
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
    const g = ui.glyphs()
    console.log(`${g.ok} 已备份到：${ui.dim(result.dir)}`)
    for (const item of result.manifest.items) {
      console.log(`  ${g.ok} ${item.relPath} ${ui.dim(`（${String(item.files)} 个文件）`)}`)
    }
    for (const warning of result.warnings) console.log(`  ${g.warn} ${warning}`)
    if (alive) {
      console.log('')
      console.log(`  ${g.warn} Nomad 正在运行，本次为运行期快照，可能捕获到写入中途的文件。`)
      console.log(`    ${ui.dim('需要一致性快照时，请先 `nomad stop` 再备份。')}`)
    }
    return 0
  } catch (error) {
    console.error(`${ui.glyphs().fail} 备份失败：${error instanceof Error ? error.message : String(error)}`)
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
    console.log(`${ui.glyphs().ok} 已从 ${ui.dim(backupDir)} 恢复 ${ui.tone.ok(String(result.restored))} 个文件（合并复制：覆盖已有、不删除多余）。`)
    return 0
  } catch (error) {
    console.error(`${ui.glyphs().fail} 恢复失败：${error instanceof Error ? error.message : String(error)}`)
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
    console.log(`${ui.glyphs().ring} 尚未发现任何持久化的工作区（DSH 可能还未初始化过项目）。`)
    console.log(`  ${ui.dim(`清单预期位置：${path.join(ctx.config.paths.dsh_home, 'storages', 'workspace.json')}`)}`)
    return 0
  }
  const g = ui.glyphs()
  console.log(`${g.brand} 已持久化工作区：${ui.bold(String(parsed.workspaces.length))} 个，共 ${ui.bold(String(parsed.totalSessions))} 个会话`)
  console.log(`  ${ui.dim(`（数据位于盘内 ${ctx.config.paths.dsh_home}，runtime 升级不丢失）`)}`)
  console.log('')
  for (const ws of parsed.workspaces) {
    const mark = ws.id === parsed.defaultId ? ui.tone.accent(' [默认]') : ''
    console.log(`${g.bullet} ${ui.bold(ws.title)}${mark}`)
    console.log(`    ${ui.kv('路径', ui.dim(ws.path), 8)}`)
    console.log(`    ${ui.kv('会话数', String(ws.sessionCount), 8)}`)
    if (ws.updatedAt !== null) console.log(`    ${ui.kv('更新于', ui.dim(String(ws.updatedAt)), 8)}`)
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
    case 'update':
      code = await cmdUpdate(flags)
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
      console.log(ui.title('隔离环境计划'))
      for (const line of describePlan(built.report, ctx.config.isolation.override, ctx.root)) console.log(`  ${line}`)
      console.log('')
      console.log(ui.title('实际注入子进程的环境（已脱敏）'))
      console.log(JSON.stringify(redactEnv(built.env), null, 2))
      break
    }
    case 'paths': {
      const ctx = resolveContext(flags)
      const g = ui.glyphs()
      console.log(`${g.brand} ${ui.kv('NOMAD_ROOT', ui.dim(`${ctx.root}（来源 ${ctx.source}）`))}`)
      console.log('')
      console.log(ui.title('路径'))
      for (const [key, value] of Object.entries(ctx.config.paths)) console.log(`  ${ui.kv(key, ui.dim(value))}`)
      console.log(`  ${ui.kv('Node', `${ui.dim(ctx.runtime.node.path)} ${ui.dim(`（${ctx.runtime.node.version ?? '版本未探测'}，${ctx.runtime.node.source}）`)}`)}`)
      try {
        const info = inspectNomadProfile({ root: ctx.root, config: ctx.config })
        console.log(`  ${ui.kv('profile', `${info.spec.name} ${ui.dim(`→ ${info.spec.dir}（模板 ${info.spec.template}，自研层 ${info.spec.bundleSpec}）`)}`)}`)
      } catch (error) {
        console.log(`  ${ui.kv('profile', `${g.fail} ${error instanceof Error ? error.message : String(error)}`)}`)
      }
      if (ctx.runtime.dsh.missing === true) {
        console.log(`  ${ui.kv('DSH', `${g.fail} ${ctx.runtime.dsh.reason ?? '缺失'}`)}`)
      } else {
        console.log(`  ${ui.kv('DSH', `${ctx.runtime.dsh.name} ${ctx.runtime.dsh.version}`)}`)
        console.log(`  ${ui.kv('入口', ui.dim(`${ctx.runtime.dsh.entry}（${ctx.runtime.dsh.entrySource}）`))}`)
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
        const g = ui.glyphs()
        console.log(ui.kv('profile 根目录', ui.dim(scan.base), 16))
        console.log(ui.kv('启动默认', ui.bold(scan.defaultName), 16))
        console.log(ui.kv('内置保留名', ui.dim(`${scan.reserved.join(' / ')}（模板，不在盘内列举）`), 16))
        if (scan.profiles.length === 0) {
          console.log('')
          console.log(`${g.ring} 盘内暂无 profile —— start 会按模板自动创建。`)
          break
        }
        console.log('')
        for (const item of scan.profiles) {
          const tag = item.kind === 'default' ? ui.tone.accent(' [启动默认]') : ''
          const state = item.problems.length === 0
            ? ui.tone.ok('有效')
            : `${g.warn} ${ui.tone.warn(`${item.problems.length} 个问题`)}`
          console.log(`${g.bullet} ${ui.bold(item.name)}${tag}  ${state}`)
          for (const problem of item.problems) console.log(`      ${ui.dim(`- ${problem}`)}`)
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
        const g = ui.glyphs()
        console.log(`${g.ok} profile「${ui.bold(result.name)}」已创建（派生自 ${result.template}）：${ui.dim(result.dir)}`)
        console.log(`  ${ui.kv('bundles', ui.dim(result.bundles.join(', ')), 10)}`)
        for (const file of result.created) console.log(`  ${g.ok} ${ui.dim(file)}`)
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
        const g = ui.glyphs()
        console.log(`${ui.kv('profile', `${ui.bold(name)}  ${ui.dim(check.dir)}`)}`)
        console.log(`  ${ui.kv(`bundles(${String(check.bundles.length)})`, ui.dim(check.bundles.join(', ') || '(无)'), 14)}`)
        if (check.problems.length === 0) {
          console.log(`  ${g.ok} 结论：${ui.tone.ok('有效')}`)
        } else {
          console.log(`  ${g.fail} 结论：${ui.tone.fail('存在问题')}`)
          for (const problem of check.problems) console.log(`      ${ui.dim(`- ${problem}`)}`)
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
      console.log(`${ui.glyphs().brand} ${ui.bold('Nomad profile')}`)
      console.log(`  ${ui.kv('profile', `${ui.bold(info.spec.name)} ${ui.dim(`（派生自内置模板 ${info.spec.template}）`)}`, 14)}`)
      console.log(`  ${ui.kv('目录', ui.dim(info.spec.dir), 14)}`)
      console.log(`  ${ui.kv('自研 bundle', info.spec.bundleSpec, 14)}`)
      console.log(`  ${ui.kv('', ui.dim(`→ ${info.spec.bundleSourceDir}`), 14)}`)
      console.log(`  ${ui.kv('清单', info.exists ? (info.manifestValid ? ui.tone.ok('存在且可解析') : ui.tone.fail('存在但不可解析（JSON 坏了）')) : ui.dim('不存在'), 14)}`)
      if (info.exists && info.manifestValid) {
        for (const [index, bundle] of info.bundles.entries()) {
          const self = bundle === info.spec.bundleSpec ? ui.tone.accent('   ← 自研层') : ''
          console.log(`      ${ui.dim(`${String(index + 1)}.`)} ${bundle}${self}`)
        }
      }
      console.log(`  ${ui.kv('补丁层', info.patchExists ? ui.dim(info.spec.patchPath) : ui.tone.warn('(缺失 —— start 会补)'), 14)}`)
      console.log(`  ${ui.kv('结论', info.problems.length === 0 ? ui.tone.ok('就绪：自研层已在 bundles 末位') : ui.tone.warn(info.problems.join('；')), 14)}`)
      break
    }
    case 'skill': {
      const ctx = resolveContext(flags)
      // 与 profile/rollback 同约定：positionals[0] 是命令本身，子命令从 [1] 起。
      const sub = positionals[1]

      const renderSkillList = () => {
        const scan = listSkills({ root: ctx.root, config: ctx.config })
        const g = ui.glyphs()
        console.log(`${g.brand} ${ui.bold('Skills')} ${ui.dim('（user-dsh 根，rank 400；DSH 文件 watch 热更新 —— 装/删无需重启实例）')}`)
        console.log(`  ${ui.kv('skill 根目录', ui.dim(scan.base), 14)}`)
        if (!scan.exists) {
          console.log(`  ${g.ring} 目录尚未创建 —— 首次 nomad skill add 时自动创建；当前视为空 skill 根。`)
          return
        }
        if (scan.skills.length === 0 && scan.ignored.length === 0) {
          console.log(`  ${g.ring} 空 skill 根，合法基线`)
          return
        }
        if (scan.skills.length > 0) console.log('')
        for (const item of scan.skills) {
          const identity = item.skill === null
            ? '(frontmatter 不可用)'
            : item.skill.name === item.entryName
              ? item.skill.name
              : `${item.skill.name}（条目名 ${item.entryName}）`
          const state = item.valid ? ui.tone.ok('有效') : `${g.warn} ${ui.tone.warn(`${item.problems.length} 个问题`)}`
          console.log(`${g.bullet} ${ui.bold(identity)}  ${ui.dim(`[${item.kind === 'bundle' ? '目录束' : '扁平'}]`)}  ${state}`)
          if (item.skill !== undefined && item.skill !== null && item.skill.description !== undefined) {
            console.log(`      ${ui.kv('描述', ui.dim(item.skill.description), 8)}`)
          }
          if (item.skill !== undefined && item.skill !== null && item.skill.whenToUse !== undefined) {
            console.log(`      ${ui.kv('何时用', ui.dim(item.skill.whenToUse), 8)}`)
          }
          for (const problem of item.problems) console.log(`      ${ui.dim(`- ${problem}`)}`)
          for (const note of item.notes ?? []) console.log(`      ${g.bullet} ${ui.dim(note)}`)
        }
        if (scan.ignored.length > 0) {
          console.log('')
          console.log(ui.tone.warn('被忽略的条目（DSH 不会看）：'))
          for (const item of scan.ignored) console.log(`  ${g.skip} ${item.entryName}  ${ui.dim(`—— ${item.reason}`)}`)
        }
      }

      // -- skill list（无参数同义）
      if (sub === 'list' || sub === undefined) {
        renderSkillList()
        break
      }

      // -- skill add <path>：安装本地 skill
      if (sub === 'add') {
        const source = positionals[2]
        if (typeof source !== 'string' || source === '') {
          console.error('用法：nomad skill add <本地路径>    （<name>/SKILL.md 目录束 或 <name>.md 扁平文件）')
          console.error('  不碰网络下载：git 源请先手动 clone 到本地，再 add 本地路径。')
          code = 1
          break
        }
        const result = addSkill({ root: ctx.root, config: ctx.config }, source)
        if (!result.ok) {
          console.error(`${ui.glyphs().fail} 安装失败：${result.error}`)
          code = 1
          break
        }
        const g = ui.glyphs()
        console.log(`${g.ok} skill「${ui.bold(result.name)}」已安装：${ui.dim(result.dir)}（${result.format === 'bundle' ? '目录束' : '扁平文件'}）`)
        if (result.skill !== undefined && result.skill !== null) {
          console.log(`  ${ui.kv('描述', ui.dim(result.skill.description), 6)}`)
        }
        console.log(`  ${ui.dim('热生效：运行中的实例会通过文件 watch 自动感知，无需重启。')}`)
        break
      }

      // -- skill remove <name>：卸载
      if (sub === 'remove') {
        const name = positionals[2]
        if (typeof name !== 'string' || name === '') {
          console.error('用法：nomad skill remove <name>    （skill 根下的目录名或去扩展名的文件名）')
          code = 1
          break
        }
        const result = removeSkill({ root: ctx.root, config: ctx.config }, name)
        if (!result.ok) {
          console.error(`${ui.glyphs().fail} 卸载失败：${result.error}`)
          code = 1
          break
        }
        console.log(`${ui.glyphs().ok} skill「${ui.bold(result.name)}」已卸载：${ui.dim(result.path)}（${result.format === 'bundle' ? '目录束' : '扁平文件'}）`)
        console.log(`  ${ui.dim('热生效：运行中的实例会自动感知，无需重启。')}`)
        break
      }

      console.error(`未知子命令「${sub}」。可用：list / add <path> / remove <name>；无参数 = list。`)
      code = 1
      break
    }
    case 'storage': {
      const ctx = resolveContext(flags)
      const sub = positionals[1]

      // -- nomad storage（无参数 = 数据全景报告）
      if (sub === undefined || sub === 'report') {
        const report = storageReport({ root: ctx.root, config: ctx.config })
        const g = ui.glyphs()
        console.log(`${g.brand} ${ui.bold('数据全景')} ${ui.dim(`（NOMAD_ROOT = ${report.root}）`)}`)
        console.log('')
        const catLabel = {
          'long-term': '长期-核心（永不清理）',
          cleanable: '可清理（storage clean 白名单）',
          rotate: '可轮转（暂不在清理范围）',
          runtime: '运行时态',
          other: '其他（白名单外，请人工确认）',
        }
        const catPaint = {
          'long-term': (s) => ui.tone.ok(s),
          cleanable: (s) => ui.tone.warn(s),
          rotate: (s) => ui.tone.accent(s),
          runtime: (s) => ui.dim(s),
          other: (s) => ui.tone.fail(s),
        }
        for (const entry of report.entries) {
          if (!entry.exists) {
            console.log(`  ${ui.padEnd(entry.rel, 34)} ${ui.dim('（不存在）')}`)
            continue
          }
          const latest = entry.mtimeMs > 0 ? new Date(entry.mtimeMs).toISOString().replace('T', ' ').slice(0, 16) : '—'
          console.log(`  ${ui.padEnd(entry.rel, 34)} ${ui.bold(ui.padStart(humanBytes(entry.bytes), 9))}  ${ui.dim(`${String(entry.files).padStart(5)} 文件`)}  ${ui.dim(`最近写入 ${latest}`)}  ${catPaint[entry.category](catLabel[entry.category])}`)
        }
        console.log('')
        console.log(`${g.ok} 可清理合计：${ui.tone.warn(report.human.cleanable)} ${ui.dim('/')} ${report.cleanableFiles} 文件 ${ui.dim('（预览：nomad storage clean --dry-run）')}`)
        break
      }

      // -- nomad storage clean [--dry-run] [--yes] [--min-age=<分钟>]
      if (sub === 'clean') {
        const dryRun = flagBool(flags, ['dry-run', 'n'])
        const yes = flagBool(flags, ['yes', 'y'])
        const minAgeRaw = flagValue(flags, ['min-age'])
        const minAgeMs = minAgeRaw !== undefined ? Number(minAgeRaw) * 60 * 1000 : undefined
        if (minAgeMs !== undefined && (!Number.isFinite(minAgeMs) || minAgeMs < 0)) {
          console.error('--min-age 需要是非负分钟数，例如 --min-age=30')
          code = 1
          break
        }
        const result = clean({ root: ctx.root, config: ctx.config }, { dryRun, minAgeMs })
        const g = ui.glyphs()
        console.log(`${ui.dim('清理范围（白名单，绝不进 sessions/profiles/skills）：')} data/tmp、data/dsh-home/tmp`)
        console.log(`${ui.dim(`时间规则：只清「整条目 ${Math.round(result.minAgeMs / 60000)} 分钟内无任何写入」的条目`)}`)
        console.log('')
        if (result.targets.length === 0) {
          console.log(`${g.ok} 没有满足条件的清理目标（干净基线）。`)
        }
        for (const target of result.targets) {
          console.log(`  ${ui.tone.warn('[将删]')} ${target.rel}  ${ui.bold(humanBytes(target.bytes))} ${ui.dim(`/ ${target.files} 文件`)}`)
        }
        for (const item of result.skipped) {
          console.log(`  ${ui.dim('[跳过]')} ${ui.dim(item.rel)}  ${ui.dim(`—— ${item.reason}`)}`)
        }
        console.log('')
        if (dryRun) {
          console.log(`${g.info} dry-run 合计：${ui.bold(humanBytes(result.totalBytes))} / ${result.totalFiles} 文件 ${ui.dim('（未删除任何内容）。')}`)
          console.log(`  ${ui.dim('确认无误后加 --yes 实际执行。')}`)
        } else {
          for (const failure of result.failures) console.error(`  ${ui.tone.fail('[失败]')} ${failure.abs}: ${failure.error}`)
          console.log(`${g.ok} 已清理：${ui.tone.ok(ui.bold(humanBytes(result.freedBytes)))} / ${result.freedFiles} 文件${result.failures.length > 0 ? ui.tone.fail(`（${result.failures.length} 项失败）`) : ''}。`)
          if (result.failures.length > 0) code = 1
        }
        break
      }

      console.error(`未知子命令「${sub}」。可用：report（默认）/ clean [--dry-run|--yes] [--min-age=<分钟>]。`)
      code = 1
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
        console.error(`${ui.glyphs().fail} 没有可用的访问地址（实例未运行）。`)
        code = 3
        break
      }
      console.log(state.url)
      console.error(`${ui.dim('# 该地址含本次启动令牌（用于给浏览器铸 cookie），请勿外传或截图。')}`)
      break
    }
    case 'open': {
      const ctx = resolveContext(flags)
      const state = readState(ctx.root)
      if (state === null || state.url === undefined) {
        console.error(`${ui.glyphs().fail} 实例未运行，无地址可打开。`)
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
        console.error(`${ui.glyphs().fail} 打开失败（${result.method}）：${result.error ?? '未知原因'}`)
        console.error(`  ${ui.dim('备用通道：执行 `nomad url` 拿到**含 token** 的完整地址，手动粘进浏览器地址栏。')}`)
        console.error(`  ${ui.dim('若浏览器被安全软件拦截，可在 config/nomad.yaml 设置 web.browser_path 指向浏览器可执行文件。')}`)
        code = 1
      } else {
        const g = ui.glyphs()
        console.log(`${g.ok} 已请求系统打开浏览器（${result.method}）。`)
        console.log(`  ${ui.kv('地址（脱敏）', ui.dim(state.publicUrl ?? sanitizeUrl(state.url)))}`)
        console.log('  若浏览器仍显示 "authentication required"，只有两种可能，逐一排除：')
        console.log('    ① 地址没带令牌 —— 同一地址**不带** `?token=…` 必然 401，这是 DSH 的鉴权设计，请在地址栏确认 query 还在；')
        console.log('    ② 浏览器拒收 cookie —— 该会话 cookie 是 `dsh-auth-…`（HttpOnly + SameSite=Strict，无 Secure）。')
        console.log('       在无痕窗口里重开一次可排除"扩展/隐私策略拦 cookie"；企业策略也可能拦 127.0.0.1 的 cookie。')
      }
      break
    }
    case 'version': {
      const { root } = detectRoot({ explicit: flagValue(flags, 'root') })
      const g = ui.glyphs()
      console.log(`${g.brand} ${ui.bold('Nomad')} ${ui.dim('— Portable Agent OS')}`)
      console.log(`  ${ui.kv('Nomad', ui.bold(readNomadVersion(root)))}`)
      console.log(`  ${ui.kv('Launcher', LAUNCHER_VERSION)}`)
      console.log(`  ${ui.kv('Node', `${process.versions.node} ${ui.dim(`（${process.execPath}）`)}`)}`)
      console.log(`  ${ui.kv('Platform', `${process.platform} ${process.arch}`)}`)
      console.log(`  ${ui.kv('今天', ui.dim(localDate()))}`)
      break
    }
    case 'help':
      console.log(buildHelp())
      break
    default:
      console.error(`${ui.glyphs().fail} 未知命令：${command}`)
      console.error('')
      console.error(buildHelp())
      code = 64
  }
  process.exitCode = code
}

main().catch((error) => {
  console.error(`nomad: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 70
})
