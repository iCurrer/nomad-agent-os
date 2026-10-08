'use strict'

/**
 * 运行时发现：盘内自带 Node + 盘内 DSH。
 *
 * 铁律（AGENTS.md 第 4 节）：
 *   1. Runtime 与 Data 分离 —— `runtime/` 可替换，`data/` 长期存在；
 *   5. Runtime 版本化 —— `runtime/dsh/<version>/` + `runtime/dsh/current`；
 *   7. 用户机零编译 —— 用户机不得要求 pnpm / node_modules / 现场构建；
 *   8. 启动路径禁止 npx —— 必须直接调 node 入口。
 *
 * 本模块只做"发现"，不做"安装/下载/构建"。
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { assertInside } = require('./paths.js')

/** 各平台的 node 可执行文件名。 */
function nodeBinaryNames(platform = process.platform) {
  return platform === 'win32' ? ['node.exe'] : ['node']
}

/**
 * 版本戳文件名。由打包期写入（与 node 可执行文件同目录）。
 *
 * 为什么需要它：`probeNodeVersion()` 依赖 spawnSync 拉起 node.exe，而 spawnSync
 * 在受限环境（某些沙箱 / 安全软件）会返回 EBUSY 而拿不到版本。打包期我们本来
 * 就知道版本，写一个纯文本戳即可让体检与启动不依赖外部进程，顺带更快。
 */
const NODE_VERSION_STAMP = 'NOMAD_NODE_VERSION'

/**
 * 读取打包期写下的版本戳（回退用）。
 * @param {string} dir - node 可执行文件所在目录
 * @returns {string|null} 形如 `v22.23.3`；不存在返回 null
 */
function readVersionStamp(dir) {
  try {
    const file = path.join(dir, NODE_VERSION_STAMP)
    if (!fs.existsSync(file)) return null
    const version = fs.readFileSync(file, 'utf8').trim()
    return version === '' ? null : version
  } catch {
    return null
  }
}

/**
 * 探测 node 可执行文件的版本。
 * @param {string} binary - node 路径
 * @returns {string|null} 形如 `v22.22.2`；失败返回 null
 */
function probeNodeVersion(binary) {
  try {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    if (result.status !== 0 || typeof result.stdout !== 'string') return null
    const version = result.stdout.trim()
    return version === '' ? null : version
  } catch {
    return null
  }
}

/**
 * 在盘内查找 node。
 * @param {{ root: string, nodeDir: string }} options - 根目录与 node 目录
 * @returns {{ path: string, version: string|null, source: string } | null} 结果
 */
function findBundledNode(options) {
  const { nodeDir } = options
  const names = nodeBinaryNames()
  const roots = [nodeDir, path.join(nodeDir, 'bin'), path.join(nodeDir, 'current'), path.join(nodeDir, 'current', 'bin')]

  // 版本化布局：runtime/node/<version>/<binary>
  try {
    if (fs.existsSync(nodeDir) && fs.statSync(nodeDir).isDirectory()) {
      for (const entry of fs.readdirSync(nodeDir)) {
        roots.push(path.join(nodeDir, entry))
        roots.push(path.join(nodeDir, entry, 'bin'))
      }
    }
  } catch {
    /* 读不到就按普通候选继续 */
  }

  for (const dir of roots) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const probed = probeNodeVersion(candidate)
        // 探测失败（沙箱/安全软件下 spawnSync 会 EBUSY）时回退到打包期版本戳。
        const stampped = probed === null ? readVersionStamp(dir) : null
        return {
          path: candidate,
          version: probed ?? stampped,
          versionSource: probed !== null ? 'probe' : (stampped !== null ? 'stamp' : 'unknown'),
          source: `bundled:${candidate}`,
        }
      }
    }
  }
  return null
}

/**
 * 解析 DSH 运行时入口。
 * @param {string} dir - 运行时目录（已解析绝对路径）
 * @param {string} root - NOMAD_ROOT，用于越界校验
 * @returns {{ name: string, version: string, entry: string, entrySource: string, profile: string|null, appArgs: string[] }} 入口描述
 */
function resolveEntry(dir, root) {
  const manifestFile = path.join(dir, 'nomad-runtime.json')
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (typeof manifest.entry !== 'string' || manifest.entry === '') {
      throw new Error(`runtime: ${manifestFile} 缺少 entry 字段`)
    }
    const entry = assertInside(root, path.resolve(dir, manifest.entry), 'nomad-runtime.json#entry')
    if (!fs.existsSync(entry)) throw new Error(`runtime: 清单声明的 entry 不存在：${entry}`)
    return {
      name: typeof manifest.name === 'string' ? manifest.name : '(unnamed)',
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
      entry,
      entrySource: 'nomad-runtime.json',
      profile: typeof manifest.profile === 'string' ? manifest.profile : null,
      appArgs: Array.isArray(manifest.app_args) ? manifest.app_args.filter((item) => typeof item === 'string') : [],
    }
  }

  const pkgFile = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    throw new Error(`runtime: ${dir} 下既无 nomad-runtime.json 也无 package.json，无法确定 DSH 入口`)
  }
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  let relative = null
  let entrySource = ''
  if (typeof pkg.bin === 'string') {
    relative = pkg.bin
    entrySource = 'package.json#bin'
  } else if (pkg.bin !== null && typeof pkg.bin === 'object') {
    const keys = Object.keys(pkg.bin)
    const preferred = keys.includes('dsh') ? 'dsh' : keys[0]
    if (preferred !== undefined) {
      relative = pkg.bin[preferred]
      entrySource = `package.json#bin.${preferred}`
    }
  }
  if (relative === null && typeof pkg.main === 'string') {
    relative = pkg.main
    entrySource = 'package.json#main'
  }
  if (relative === null && typeof pkg.exports === 'object' && pkg.exports !== null && typeof pkg.exports['.'] === 'string') {
    relative = pkg.exports['.']
    entrySource = 'package.json#exports["."]'
  }
  if (relative === null) {
    throw new Error(`runtime: ${pkgFile} 无法推导入口（bin / main / exports 均不可用）`)
  }

  const entry = assertInside(root, path.resolve(dir, relative), 'runtime entry')
  if (!fs.existsSync(entry)) throw new Error(`runtime: 推导出的入口不存在：${entry}`)
  return {
    name: typeof pkg.name === 'string' ? pkg.name : '(unnamed)',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    entry,
    entrySource,
    profile: null,
    appArgs: [],
  }
}

/**
 * 发现运行时（Node + DSH）。
 * @param {{ root: string, config: object }} options - 根目录与已加载配置
 * @returns {{ node: object, dsh: object, warnings: string[] }} 发现结果
 */
function discoverRuntime(options) {
  const { root, config } = options
  const warnings = []
  const runtimeDir = config.paths.runtime

  let node = findBundledNode({ root, nodeDir: config.nodeDir })
  if (node === null) {
    const mode = config.runtime.node.mode
    if (mode === 'host') {
      node = { path: process.execPath, version: process.versions.node, source: 'host:process.execPath' }
      warnings.push('runtime.node.mode = host：使用宿主机 Node，便携性不成立（V1 要求 bundled）。')
    } else {
      node = { path: process.execPath, version: process.versions.node, source: 'host-fallback:process.execPath' }
      warnings.push(
        `未找到盘内 Node（期望 ${config.nodeDir}）；已回退到当前进程 Node：${process.execPath}。`,
      )
    }
  }

  const dshDir = assertInside(root, path.resolve(root, config.runtime.dsh.current), 'runtime.dsh.current')
  let dsh
  if (!fs.existsSync(dshDir)) {
    dsh = {
      missing: true,
      dir: dshDir,
      reason: `运行时目录不存在：${dshDir}`,
    }
  } else {
    let realDir = dshDir
    try {
      realDir = fs.realpathSync(dshDir)
    } catch {
      /* 非软链则用原路径 */
    }
    try {
      dsh = { missing: false, dir: realDir, available: listRuntimeVersions(path.join(runtimeDir, 'dsh')), ...resolveEntry(realDir, root) }
    } catch (error) {
      dsh = { missing: true, dir: realDir, reason: error.message }
    }
  }

  return { node, dsh, warnings }
}

/**
 * 列出 `runtime/dsh/` 下已存在的版本目录（供回滚选择）。
 * @param {string} dshRoot - `runtime/dsh` 目录
 * @returns {string[]} 版本目录名（不含 current）
 */
function listRuntimeVersions(dshRoot) {
  try {
    return fs.readdirSync(dshRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'current')
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 从一个入口文件路径向上定位它所属的 `node_modules` 目录。
 *
 * ⚠️ 不能用 `runtime.dsh.dir` 去拼 `node_modules`：`current` 是一个**纯清单目录**
 * （只放 `nomad-runtime.json`），它下面根本没有 `node_modules`。真正的 `node_modules`
 * 在版本目录里（`runtime/dsh/<version>/node_modules`），只有**入口路径**才指向那里。
 *
 * @param {string} fromPath - 入口文件绝对路径
 * @returns {string|null} `node_modules` 绝对路径；找不到返回 null
 */
function findNodeModulesDir(fromPath) {
  let dir = path.dirname(path.resolve(fromPath))
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 扫描 `node_modules` 里**残缺的包**：目录下有子目录，却没有 `package.json`。
 *
 * 为什么需要这个检查（真实缺陷，2026-10-08）：打包运行时期间有一次 npm install 被
 * 外部信号打断，留下了一批「有内容却没有 `package.json`」的包。这类残缺包
 * **不会让 DSH 起不来**，只会在运行期静默地让 roster 里的某个条目 "failed to import"，
 * 于是缺陷长期不可见 —— 直到人工去读日志才发现。
 *
 * 判据刻意收窄以避免误报：npm 对**不匹配当前平台**的 `optionalDependencies` 会留下
 * **完全为空**的目录（如 `@img/sharp-darwin-x64`），那是正常行为，不算残缺。
 * 因此只把「**有子目录**但缺 `package.json`」判为残缺。
 *
 * 局限：这是**目录遍历**，只能发现「存在但残缺」，**发现不了「整份缺失」**，
 * 也看不到嵌套 `node_modules` 的完整期望。要覆盖那两类，用
 * {@link scanMissingPackages}（锁文件对账）—— 它是更权威的判据，本函数是它的
 * **无锁文件回退**。
 *
 * @param {string} nodeModulesDir - 运行时版本目录下的 `node_modules`
 * @returns {{ name: string, contents: string[] }[]} 残缺包列表（相对包名）
 */
function scanBrokenPackages(nodeModulesDir) {
  const broken = []
  const inspect = (dir, prefix, rel, depth) => {
    if (depth > 5) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (prefix === '' && entry.name.startsWith('@')) {
        inspect(full, entry.name, relPath, depth)
        continue
      }
      let subdirs = []
      try {
        subdirs = fs.readdirSync(full, { withFileTypes: true })
          .filter((child) => child.isDirectory())
          .map((child) => child.name)
      } catch {
        /* 读不到子目录就当作空目录（正常可选依赖桩），不报 */
      }
      const contentDirs = subdirs.filter((child) => child !== 'node_modules')
      if (!fs.existsSync(path.join(full, 'package.json')) && contentDirs.length > 0) {
        broken.push({ name: relPath, contents: contentDirs.sort() })
      }
      // 嵌套 node_modules：npm 为冲突版本就地嵌套，**那里同样会残缺**（正是真实事故点：
      // 顶层留下残骸、而正确的嵌套位置整份缺失）。
      inspect(path.join(full, 'node_modules'), '', `${relPath}/node_modules`, depth + 1)
    }
  }
  inspect(nodeModulesDir, '', '', 0)
  return broken.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 名字里出现这些 token 说明该包是**平台专属**发行物。 */
const PLATFORM_TOKENS = [
  'darwin', 'win32', 'win', 'linux', 'freebsd', 'openbsd', 'netbsd',
  'android', 'sunos', 'aix', 'webcontainers', 'wasm',
]

/** 名字里出现这些 token 说明该包是**架构专属**发行物。 */
const ARCH_TOKENS = ['x64', 'arm64', 'arm', 'ia32', 'ppc64', 's390x', 'riscv64', 'loong64', 'universal']

/** token 是否以「词」的形态出现（`@img/sharp-win32-x64` → win32 / x64）。 */
function hasToken(name, token) {
  return new RegExp(`(^|[/@_-])${token}([/_-]|$)`).test(name)
}

/**
 * 这个包是不是「为别的平台/架构/运行时准备的」——是的话，它不在当前机器上装是**正常**的。
 *
 * 为什么不能只看 `optional`（数据实测，2026-10-08）：`npm install` 后盘上缺 70 个包，
 * **全部**是 `optional`；但 `optional` 里既有「本该缺席的别平台包」
 * （`@img/sharp-linux-x64`），也有「**本该存在却缺席的平台匹配包**」
 * （`@img/sharp-win32-x64` —— 正是当时那起缺陷的一员）。所以判据必须是
 * 「optional **且** 名字指示的平台/架构与当前机器不符」。
 *
 * 锁文件里**没有** `os`/`cpu` 字段（实测两者都缺），所以只能从包名解析。
 * @param {string} name - 包名（可含 scope）
 * @param {string} [platform] - 覆盖 `process.platform`（便于测试）
 * @param {string} [arch] - 覆盖 `process.arch`（便于测试）
 * @returns {boolean} true = 预期不在本机出现
 */
function isForeignPlatformPackage(name, platform = process.platform, arch = process.arch) {
  const lower = name.toLowerCase()
  if (hasToken(lower, 'wasm') || hasToken(lower, 'webcontainers')) return true
  // musl 变体：本机不是 musl 就预期缺席（Windows / macOS 上恒不匹配）。
  if (hasToken(lower, 'musl') && platform !== 'linux') return true
  const platformHit = PLATFORM_TOKENS.find((token) => hasToken(lower, token))
  if (platformHit !== undefined) {
    const ok = platformHit === 'win' ? platform === 'win32' : platformHit === platform
    if (!ok) return true
  }
  const archHit = ARCH_TOKENS.find((token) => hasToken(lower, token))
  if (archHit !== undefined && archHit !== arch) return true
  return false
}

/**
 * 选出可用的锁文件路径（优先项目根 `package-lock.json`，回退 npm 的隐藏锁文件）。
 * @param {string} versionDir - `runtime/dsh/<version>/`
 * @returns {string|null} 锁文件绝对路径
 */
function findLockfile(versionDir) {
  const candidates = [
    path.join(versionDir, 'package-lock.json'),
    path.join(versionDir, 'node_modules', '.package-lock.json'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * **锁文件对账**：锁文件说「该装的包」，盘上是不是真的有（有 `package.json`）。
 *
 * 为什么需要它（这是 2026-10-08 那起缺陷的正解）：被打断的 `npm install` 会留下
 * 「顶层残骸 + 正确的嵌套位置整份缺失」这种半成品树。而**再跑一次 `npm install`
 * 也修不好** —— npm 信任 `node_modules/.package-lock.json` 里「已安装」的记录，
 * 不会重新解压。目录遍历（{@link scanBrokenPackages}）同样看不出来，因为
 * 「缺失」不是「残缺」。只有「拿锁文件的期望表去对账」才抓得住。
 *
 * 补救手法：把出问题的目录挪走（或删掉 `node_modules/.package-lock.json`）后重跑
 * `npm install`，npm 会按锁文件把包放回**正确的嵌套位置**。详见 `docs/DEVELOPMENT.md` §8。
 *
 * @param {string} versionDir - `runtime/dsh/<version>/`
 * @returns {{ name: string, reason: string, optional: boolean }[]|null}
 *   缺失包列表；**无锁文件可对账时返回 null**（区别于「对账后确认无缺失」的空数组）
 */
function scanMissingPackages(versionDir) {
  const lockfile = findLockfile(versionDir)
  if (lockfile === null) return null
  let packages
  try {
    packages = JSON.parse(fs.readFileSync(lockfile, 'utf8')).packages
  } catch {
    return null
  }
  if (packages === null || typeof packages !== 'object') return null

  const missing = []
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue
    if (entry === null || typeof entry !== 'object') continue
    if (entry.link === true) continue // 工作区软链，不适用
    const name = key.slice('node_modules/'.length)
    if (name === '' || name.includes('node_modules/')) continue // 忽略嵌套键（父键会覆盖到）
    if (entry.optional === true && isForeignPlatformPackage(name)) continue
    const dir = path.join(versionDir, key)
    if (fs.existsSync(path.join(dir, 'package.json'))) continue
    let reason = '目录不存在'
    if (fs.existsSync(dir)) {
      let children = []
      try {
        children = fs.readdirSync(dir)
      } catch {
        /* 读不到就当空目录 */
      }
      reason = children.length === 0 ? '目录为空（半成品树）' : `有内容但缺 package.json（${children.slice(0, 4).join(', ')}…）`
    }
    missing.push({ name, reason, optional: entry.optional === true })
  }
  return missing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}


/**
 * 数出锁文件里登记的包数量（诊断用：体检里交代「一共核对了多少个」）。
 * @param {string} versionDir - `runtime/dsh/<version>/`
 * @returns {number} 登记数量；无锁文件或解析失败时为 0
 */
function countLockedPackages(versionDir) {
  const lockfile = findLockfile(versionDir)
  if (lockfile === null) return 0
  try {
    const packages = JSON.parse(fs.readFileSync(lockfile, 'utf8')).packages
    if (packages === null || typeof packages !== 'object') return 0
    return Object.keys(packages).filter((key) => {
      if (!key.startsWith('node_modules/')) return false
      return !key.slice('node_modules/'.length).includes('node_modules/')
    }).length
  } catch {
    return 0
  }
}

module.exports = {
  discoverRuntime,
  findBundledNode,
  resolveEntry,
  probeNodeVersion,
  readVersionStamp,
  listRuntimeVersions,
  scanBrokenPackages,
  scanMissingPackages,
  countLockedPackages,
  findLockfile,
  isForeignPlatformPackage,
  findNodeModulesDir,
  nodeBinaryNames,
  NODE_VERSION_STAMP,
}
