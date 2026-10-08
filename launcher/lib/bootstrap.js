'use strict'

/**
 * 引导：目录基线 + 启动命令组装。
 *
 * 目录基线来自 AGENTS.md 第 4 节；启动命令来自**已核实的源码契约**：
 *   apps/cli/src/args.ts:167-174
 *     `--profile <name>` + `[args...]`（app 参数）；`allowUnknownOption/passThroughOptions`
 *   packages/bundle/web-app/src/startup.ts:59-63
 *     `--host` / `--no-open` / `--port` / `--public-url` / `--trusted-host`
 *   packages/bundle/web-app/src/startup.ts:61
 *     `--port 0` = 让 OS 分配可用端口
 *
 * 禁止在此模块里发明任何未经核实的 flag（AGENTS.md 禁止清单第 14 条）。
 */

const fs = require('node:fs')

/**
 * 创建目录基线（幂等）。
 * @param {object} config - 已加载配置
 * @returns {{ created: string[], existing: string[], failed: { dir: string, error: string }[] }} 结果
 */
function ensureDirs(config) {
  const targets = [
    config.paths.runtime,
    config.paths.data,
    config.paths.dsh_home,
    config.paths.tmp,
    config.paths.run,
    config.paths.backups,
    config.paths.logs,
    config.paths.workspace,
    config.paths.skills,
    config.paths.profiles,
    config.paths.mcp,
  ]
  const created = []
  const existing = []
  const failed = []
  for (const dir of targets) {
    if (fs.existsSync(dir)) {
      existing.push(dir)
      continue
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
      created.push(dir)
    } catch (error) {
      failed.push({ dir, error: error.message })
    }
  }
  return { created, existing, failed }
}

/**
 * 校验目录可写（真写入再删除一个探针文件）。
 * @param {string} dir - 目录
 * @returns {{ ok: boolean, error?: string }} 结果
 */
function assertWritable(dir) {
  const probe = `${dir}/.nomad-write-probe`
  try {
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.rmSync(probe, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/**
 * 只读巡检目录基线（**不创建任何东西**，供 doctor 使用）。
 *
 * 体检命令必须是只读的：会不会自动建目录，必须由 `start` 决定，
 * 不能因为跑了一次 doctor 就悄悄在盘上写了东西。
 *
 * @param {object} config - 已加载配置
 * @returns {{ existing: string[], missing: string[], unwritable: { dir: string, error: string }[] }} 巡检结果
 */
function inspectDirs(config) {
  const targets = [
    config.paths.runtime,
    config.paths.data,
    config.paths.dsh_home,
    config.paths.tmp,
    config.paths.run,
    config.paths.backups,
    config.paths.logs,
    config.paths.workspace,
    config.paths.skills,
    config.paths.profiles,
    config.paths.mcp,
  ]
  const existing = []
  const missing = []
  const unwritable = []
  for (const dir of targets) {
    if (!fs.existsSync(dir)) {
      missing.push(dir)
      continue
    }
    existing.push(dir)
    const probe = assertWritable(dir)
    if (!probe.ok) unwritable.push({ dir, error: probe.error ?? '未知原因' })
  }
  return { existing, missing, unwritable }
}

/**
 * 组装 DSH 启动命令。
 *
 * 顺序说明：`--profile` 必须最先（`apps/cli/src/args.ts:159-166` 注释：launcher 的
 * flag 在最前，遇到第一个它不认识的 token 之后全部归被启动的 app）；因此
 * Nomad 自己的 launcher 级 flag（如 `--patch`）放在 profile 之后、app flag 之前。
 *
 * @param {{ config: object, runtime: object }} options - 配置与运行时
 * @returns {{ command: string, args: string[], cwd: string, display: string }} 命令描述
 */
function buildArgv(options) {
  const { config, runtime } = options
  const dshCfg = config.runtime.dsh

  // 入口缺失时必须报错：绝不能把 `--profile` 之类当成脚本路径交给 node
  // （那会得到 "bad option: --profile" 这种毫无指向性的报错）。
  if (typeof runtime?.dsh?.entry !== 'string' || runtime.dsh.entry === '') {
    throw new Error('bootstrap: 运行时缺少 DSH 入口（runtime.dsh.entry），无法组装启动命令')
  }

  const profile = typeof dshCfg.profile === 'string' && dshCfg.profile !== '' ? dshCfg.profile : 'web'
  const launcherArgs = Array.isArray(dshCfg.launcher_args) ? dshCfg.launcher_args : []
  const appArgs = Array.isArray(dshCfg.app_args) ? dshCfg.app_args : []
  // 运行时清单（nomad-runtime.json）可附加 app 参数：来自打包期的实测值，不是猜测。
  const manifestArgs = Array.isArray(runtime?.dsh?.appArgs) ? runtime.dsh.appArgs : []

  const args = [
    runtime.dsh.entry,
    '--profile', profile,
    ...launcherArgs.filter((item) => typeof item === 'string'),
    '--host', config.web.host,
    '--port', String(config.web.port),
    // Nomad 拥有浏览器交接权：恒定关闭 DSH 自开，等拿到带 token 的 URL 后自己开。
    '--no-open',
    ...appArgs.filter((item) => typeof item === 'string'),
    ...manifestArgs.filter((item) => typeof item === 'string'),
  ]

  return {
    command: runtime.node.path,
    args,
    cwd: config.paths.workspace,
    display: renderCommand(runtime.node.path, args),
  }
}

/**
 * 把命令渲染成可读（且可复制）的一行。
 * @param {string} command - 可执行文件
 * @param {string[]} args - 参数
 * @returns {string} 展示字符串
 */
function renderCommand(command, args) {
  const quote = (value) => (/\s/.test(value) ? JSON.stringify(value) : value)
  return [command, ...args].map(quote).join(' ')
}

module.exports = { ensureDirs, inspectDirs, assertWritable, buildArgv, renderCommand }
