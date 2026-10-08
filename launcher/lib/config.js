'use strict'

/**
 * 配置加载：`config/nomad.yaml` → 已解析、已校验、路径全部绝对化的配置对象。
 *
 * 三道强制关卡（任一不过直接抛错，不静默降级）：
 *   1. 路径关卡：所有路径必须相对 NOMAD_ROOT 且不越界（`paths.js`）；
 *   2. Secret 关卡：配置里不允许出现密钥类字段（AGENTS.md 第 7 节）；
 *   3. 占位符关卡：`${NOMAD_ROOT}` / `${paths.<key>}` 展开后不允许残留。
 */

const fs = require('node:fs')
const path = require('node:path')
const { parse } = require('./yaml-lite.js')
const { resolveInside } = require('./paths.js')

/** 禁止出现在配置里的字段名（只允许引用式凭据）。 */
const SECRET_KEY = /(api[_-]?key|secret|passwd|password|access[_-]?token|private[_-]?key|bearer_token)/i

/** 路径键的缺省值。 */
const DEFAULT_PATHS = {
  runtime: 'runtime',
  data: 'data',
  dsh_home: 'data/dsh-home',
  workspace: 'workspace',
  skills: 'skills',
  profiles: 'profiles',
  mcp: 'mcp',
  config: 'config',
  tmp: 'data/tmp',
  run: 'data/run',
  backups: 'data/backups',
}

/** 其他缺省值。 */
const DEFAULTS = {
  runtime: {
    dsh: {
      current: 'runtime/dsh/current',
      keep_versions: 3,
      delivery: 'npm-bundled',
      launch_mode: 'node-entry',
      profile: 'nomad',
      // 自建 profile 的派生来源（必须是上游内置模板名；内置名单见 launcher/lib/profile.js）
      profile_template: 'web',
      // 启动前自举 profile（只写 $DSH_HOME/profiles/<name>/）。设 false = 由人手工维护。
      ensure_profile: true,
      // 自研 bundle 源（相对 NOMAD_ROOT）；其 package.json 必须声明 dsh.bundle.patch
      bundle_source: 'packages/nomad-web-app',
      launcher_args: [],
      app_args: [],
      auto_update: false,
      track_master: false,
    },
    node: { mode: 'bundled', entry: 'runtime/node' },
  },
  web: { host: '127.0.0.1', port: 0, default_port_hint: 3080, open_browser: true, browser_path: '' },
  status: { host: '127.0.0.1', port: 3090, poll_interval_ms: 5000 },
  isolation: { enabled: true, strategy: 'allowlist', resolve_relative_to_root: true },
  logging: { level: 'info', dir: 'data/logs', max_files: 10 },
  behavior: { auto_update: false, track_master: false, graceful_shutdown_timeout_ms: 8000, hard_kill_after_timeout: true },
  theme: { mode: 'dark' },
}

/**
 * 深度合并：`overlay` 覆盖 `base`，对象递归、数组整体替换。
 * @param {unknown} base - 基线
 * @param {unknown} overlay - 覆盖层
 * @returns {unknown} 合并结果
 */
function deepMerge(base, overlay) {
  if (overlay === undefined || overlay === null) return base
  if (Array.isArray(base) || Array.isArray(overlay)) return overlay
  if (typeof base !== 'object' || typeof overlay !== 'object') return overlay
  const out = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = key in base ? deepMerge(base[key], value) : value
  }
  return out
}

/**
 * 对所有字符串叶子节点做映射。
 * @param {unknown} node - 任意配置节点
 * @param {(value: string) => string} fn - 映射函数
 * @returns {unknown} 映射后的副本
 */
function mapStrings(node, fn) {
  if (typeof node === 'string') return fn(node)
  if (Array.isArray(node)) return node.map((item) => mapStrings(item, fn))
  if (node !== null && typeof node === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(node)) out[key] = mapStrings(value, fn)
    return out
  }
  return node
}

/**
 * 收集所有字符串叶子节点的 JSON 路径（用于报错定位）。
 * @param {unknown} node - 任意配置节点
 * @param {string} [prefix] - 路径前缀
 * @returns {{ path: string, value: string }[]} 叶子列表
 */
function collectStrings(node, prefix = '') {
  const out = []
  if (typeof node === 'string') {
    out.push({ path: prefix, value: node })
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => out.push(...collectStrings(item, `${prefix}[${String(index)}]`)))
    return out
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.push(...collectStrings(value, prefix === '' ? key : `${prefix}.${key}`))
    }
  }
  return out
}

/**
 * 校验：不允许出现密钥类字段。
 * @param {unknown} node - 配置树
 * @param {string} [prefix] - 路径前缀
 * @returns {void}
 * @throws {Error} 命中禁止字段名时
 */
function assertNoSecrets(node, prefix = '') {
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    const here = prefix === '' ? key : `${prefix}.${key}`
    if (SECRET_KEY.test(key)) {
      throw new Error(
        `config: 字段 ${here} 属禁止项（AGENTS.md 第 7 节：配置中不得出现密钥值）。\n`
        + '  请改为引用式凭据（如 credential_ref），密钥放加密 Secret Store 或 OS 凭据库。',
      )
    }
    assertNoSecrets(value, here)
  }
}

/**
 * 加载并校验配置。
 * @param {{ root: string, file?: string }} options - 根目录与配置文件（默认 `<root>/config/nomad.yaml`）
 * @returns {object} 解析结果：`{ file, raw, paths, runtime, web, isolation, logging, behavior, theme, nodeDir, warnings }`
 */
function loadConfig(options) {
  const root = options.root
  const file = options.file ?? path.join(root, 'config', 'nomad.yaml')
  if (!fs.existsSync(file)) {
    throw new Error(`config: 找不到配置文件 ${file}`)
  }

  const warnings = []
  const raw = parse(fs.readFileSync(file, 'utf8'))
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`config: ${file} 解析结果为空或不是映射`)
  }

  // 关卡 2：Secret —— 在展开之前先查，避免把占位符也当值看。
  assertNoSecrets(raw)

  // 占位符第一轮：${NOMAD_ROOT}
  const rooted = mapStrings(raw, (value) => value.replace(/\$\{NOMAD_ROOT\}/g, root))

  // 路径解析关卡
  const declared = { ...DEFAULT_PATHS, ...(rooted.paths ?? {}) }
  // `paths.root` 就是 NOMAD_ROOT 本身，不是"子路径"，因此不走相对路径关卡；
  // 但必须与实际根一致（防止配置被搬到别的盘上后仍然写着旧根）。
  const declaredRoot = declared.root
  delete declared.root
  if (declaredRoot !== undefined && String(declaredRoot) !== root) {
    throw new Error(`config: paths.root 声明为 ${JSON.stringify(declaredRoot)}，但实际 NOMAD_ROOT 为 ${root}。`)
  }

  const paths = {}
  for (const [key, value] of Object.entries(declared)) {
    paths[key] = resolveInside(root, value, `paths.${key}`)
  }
  paths.root = root
  // logging.dir 是日志路径的唯一来源；paths.logs 跟随它。
  const loggingRaw = deepMerge(DEFAULTS.logging, rooted.logging)
  paths.logs = resolveInside(root, loggingRaw.dir, 'logging.dir')

  // 占位符第二轮：${paths.<key>}
  const expanded = mapStrings(rooted, (value) => value.replace(/\$\{paths\.([a-z_]+)\}/g, (match, key) => (
    typeof paths[key] === 'string' ? paths[key] : match
  )))

  // 关卡 3：残留占位符
  for (const leaf of collectStrings(expanded)) {
    if (/\$\{[^}]+\}/.test(leaf.value)) {
      throw new Error(`config: ${leaf.path} 存在未解析的占位符：${leaf.value}`)
    }
  }

  const runtime = deepMerge(DEFAULTS.runtime, expanded.runtime)
  const web = deepMerge(DEFAULTS.web, expanded.web)
  const isolation = deepMerge(DEFAULTS.isolation, expanded.isolation)
  const behavior = deepMerge(DEFAULTS.behavior, expanded.behavior)
  const theme = deepMerge(DEFAULTS.theme, expanded.theme)
  const status = deepMerge(DEFAULTS.status, expanded.status)

  // isolation.override 里的相对值统一按 NOMAD_ROOT 解析为绝对路径
  const overrides = {}
  if (isolation.resolve_relative_to_root !== false) {
    for (const [name, value] of Object.entries(isolation.override ?? {})) {
      if (typeof value !== 'string' || value === '') continue
      overrides[name] = path.isAbsolute(value) ? value : resolveInside(root, value, `isolation.override.${name}`)
    }
  } else {
    for (const [name, value] of Object.entries(isolation.override ?? {})) {
      if (typeof value === 'string' && value !== '') overrides[name] = value
    }
  }
  isolation.override = overrides

  // 端口：0 = 交给 OS 协商（DSH `--port 0` 官方支持）
  const port = Number(web.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`config: web.port 必须是不小于 0 的整数，实际 ${JSON.stringify(web.port)}`)
  }
  web.port = port

  // host：DSH 主动拒绝 0.0.0.0（bundle/web-app/src/startup.ts:85-87）
  if (web.host !== '127.0.0.1') {
    throw new Error(
      `config: web.host 只允许 "127.0.0.1"，实际 ${JSON.stringify(web.host)}。\n`
      + '  依据：packages/bundle/web-app/src/startup.ts:85-87 —— DSH 刻意拒绝 0.0.0.0（会把 RCE 暴露到网络）。',
    )
  }

  // status 端点：同样只允许 127.0.0.1；端口必须是合法固定端口（面板靠它 fetch，不能用 0 随机）。
  if (status.host !== '127.0.0.1') {
    throw new Error(`config: status.host 只允许 "127.0.0.1"，实际 ${JSON.stringify(status.host)}。`)
  }
  const statusPort = Number(status.port)
  if (!Number.isInteger(statusPort) || statusPort < 1 || statusPort > 65535) {
    throw new Error(`config: status.port 必须是 1~65535 的固定端口（面板依赖可预测地址），实际 ${JSON.stringify(status.port)}`)
  }
  status.port = statusPort
  const pollMs = Number(status.poll_interval_ms)
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 600000) {
    throw new Error(`config: status.poll_interval_ms 必须是 1000~600000 的整数，实际 ${JSON.stringify(status.poll_interval_ms)}`)
  }
  status.poll_interval_ms = pollMs

  if (isolation.strategy === 'inherit-all') {
    warnings.push('isolation.strategy = inherit-all：子进程将继承宿主全量环境，零污染无法保证。')
  }
  if (runtime.dsh.auto_update === true || runtime.dsh.track_master === true) {
    throw new Error('config: auto_update / track_master 必须为 false（铁律 6、禁止自动升级 DSH）。')
  }

  const nodeDir = typeof runtime.node.entry === 'string'
    ? resolveInside(root, runtime.node.entry, 'runtime.node.entry')
    : path.join(paths.runtime, 'node')

  return {
    file,
    root,
    raw,
    paths,
    runtime,
    web,
    status,
    isolation,
    logging: deepMerge(DEFAULTS.logging, { ...loggingRaw, dir: paths.logs }),
    behavior,
    theme,
    nodeDir,
    warnings,
  }
}

module.exports = { loadConfig, deepMerge, mapStrings, SECRET_KEY, DEFAULT_PATHS, DEFAULTS }
