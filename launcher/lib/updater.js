'use strict'

/**
 * launcher/lib/updater.js — DSH 运行时的「检查更新 + 手动升级」模块（Phase 3.5）。
 *
 * 设计要点（铁律约束）：
 * - **升级必须维护者手动触发**：本模块绝不自动升级；CLI 层 `nomad update` 必须 `--yes` 才执行。
 * - **升级安全性靠多版本共存 + 指针切换**（ADR-0016）：新版本装到 `runtime/dsh/<version>/`，
 *   旧版本目录原样保留，`current` 指针改写指向新版 → `nomad rollback` 天然可回退。
 * - **完整性校验**：npm registry 的 `dist.integrity`（sha512，SSRI 格式）是校验锚点 ——
 *   下载后本地重算 sha512 比对，不匹配即拒绝落地。
 * - **依赖树**：版本目录 = 平铺 npm 树（package.json + package-lock.json + node_modules），
 *   盘内自带 npm CLI，解包后用盘内 Node 跑 `npm install --omit=dev` 重建依赖树。
 * - **可测性**：registry 查询与下载通过注入 `fetchImpl` 替身完成，单测不碰网络；
 *   依赖安装通过注入 `spawnImpl` 替身完成，单测不 spawn 真进程。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { assertInside } = require('./paths.js')

/** npm registry 基址（可用 options.registryBase 覆盖）。 */
const DEFAULT_REGISTRY_BASE = 'https://registry.npmjs.org'

/** 默认升级的引擎包名。 */
const DEFAULT_PACKAGE_NAME = '@deepseek-ai/dsh'

/**
 * 语义化版本比较（支持 prerelease，如 `0.2.1-alpha.1`）。纯函数。
 * 返回 -1 / 0 / 1。非法版本按字符串比较兜底（不抛，调用方自行判空）。
 * @param {string} a - 版本 A
 * @param {string} b - 版本 B
 * @returns {number} 比较结果
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
    if (match === null) return null
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? null : match[4].split('.'),
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa === null || pb === null) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0

  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  // 无 prerelease > 有 prerelease（1.0.0 > 1.0.0-alpha）
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  // 逐标识符比较：数字按数值、其余按字典序；数字 < 非数字
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * 查询 registry 上某包的最新版本元数据（`GET <base>/<name>/latest`）。
 * @param {{ packageName?: string, fetchImpl?: Function, registryBase?: string }} options -
 *   包名 / fetch 替身 / registry 基址
 * @returns {Promise<{ packageName: string, latest: string, tarball: string, integrity: string|null }>}
 */
async function fetchLatestMeta(options = {}) {
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME
  const registryBase = (options.registryBase ?? DEFAULT_REGISTRY_BASE).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${registryBase}/${encodeURIComponent(packageName).replace('%40', '@')}/latest`
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`updater: registry 查询失败（HTTP ${response.status}）: ${url}`)
  }
  const doc = await response.json()
  const latest = typeof doc.version === 'string' ? doc.version : null
  if (latest === null) {
    throw new Error(`updater: registry 响应缺少 version 字段: ${url}`)
  }
  const dist = doc.dist ?? {}
  return {
    packageName,
    latest,
    tarball: typeof dist.tarball === 'string' ? dist.tarball : null,
    integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
  }
}

/**
 * 检查更新（只读，不下载不安装）。
 * @param {{ current: string, packageName?: string, fetchImpl?: Function, registryBase?: string }} options -
 *   盘内当前版本与查询选项
 * @returns {Promise<{ packageName: string, current: string, latest: string|null, updateAvailable: boolean,
 *   comparison: 'up-to-date'|'update-available'|'current-newer'|'unknown', tarball: string|null, integrity: string|null }>}
 */
async function checkUpdate(options) {
  const current = options.current
  let meta
  try {
    meta = await fetchLatestMeta(options)
  } catch (error) {
    return {
      packageName: options.packageName ?? DEFAULT_PACKAGE_NAME,
      current,
      latest: null,
      updateAvailable: false,
      comparison: 'unknown',
      tarball: null,
      integrity: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const cmp = compareVersions(current, meta.latest)
  return {
    packageName: meta.packageName,
    current,
    latest: meta.latest,
    updateAvailable: cmp < 0,
    comparison: cmp === 0 ? 'up-to-date' : cmp < 0 ? 'update-available' : 'current-newer',
    tarball: meta.tarball,
    integrity: meta.integrity,
  }
}

/**
 * `nomad update --check` 结果的落盘位置（`data/run/update-check.json`）。
 *
 * 为什么落在 data/run：与 nomad.state.json 同目录 —— 运行期产物、随 .gitignore 排除、
 * 绝不进开源仓库。端点（status-server）只**读**这个文件，写只发生在 CLI 显式跑
 * `nomad update` 时 —— 只读端点的「绝不写盘」底线不受影响（ADR-0030）。
 */
const UPDATE_CHECK_FILE = 'update-check.json'

/** saveUpdateCheck 允许落盘的字段白名单（其余一律丢弃，防未来字段漂移泄盘）。 */
const UPDATE_CHECK_FIELDS = Object.freeze([
  'packageName',
  'current',
  'latest',
  'comparison',
  'updateAvailable',
])

/**
 * 把一次更新检查的结果落盘（供状态端点/面板展示「上次检查」）。
 * 只写白名单字段 + checkedAt；目录不存在则创建（data/run 本就是运行期目录）。
 * @param {string} root - NOMAD_ROOT
 * @param {object} check - checkUpdate 的返回值
 * @returns {{ file: string, saved: boolean }} 落盘结果（saved=false 表示被跳过）
 */
function saveUpdateCheck(root, check) {
  if (check === null || typeof check !== 'object') return { file: '', saved: false }
  const dir = path.join(root, 'data', 'run')
  const file = path.join(dir, UPDATE_CHECK_FILE)
  const payload = { checkedAt: new Date().toISOString() }
  for (const key of UPDATE_CHECK_FIELDS) {
    if (check[key] !== undefined) payload[key] = check[key]
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
  return { file, saved: true }
}

/**
 * 回读最近一次更新检查结果（只读；损坏/缺失一律返回 null，绝不抛）。
 * @param {string} root - NOMAD_ROOT
 * @returns {object|null} `{ checkedAt, ...fields }` 或 null
 */
function readUpdateCheck(root) {
  const file = path.join(root, 'data', 'run', UPDATE_CHECK_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (typeof parsed.checkedAt !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 校验 Buffer 的 sha512 完整性（SSRI 格式：`sha512-<base64>`）。
 * @param {Buffer|Uint8Array} buffer - 数据
 * @param {string} integrity - 期望的 SSRI 字符串
 * @returns {{ ok: boolean, actual: string }} 校验结果（actual 为实际 SSRI，供报错对照）
 */
function verifyIntegrity(buffer, integrity) {
  const actual = `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`
  const expected = typeof integrity === 'string' ? integrity.trim() : ''
  const expectedB64 = expected.startsWith('sha512-') ? expected.slice('sha512-'.length) : null
  return { ok: expectedB64 !== null && actual === `sha512-${expectedB64}`, actual }
}

/**
 * 下载 tgz 并做完整性校验（校验失败绝不落盘）。
 * @param {{ url: string, integrity: string, fetchImpl?: Function, destPath: string }} options - 下载参数
 * @returns {Promise<{ destPath: string, bytes: number }>} 落盘结果
 */
async function downloadTarball(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(options.url)
  if (!response.ok) {
    throw new Error(`updater: tgz 下载失败（HTTP ${response.status}）: ${options.url}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const check = verifyIntegrity(buffer, options.integrity)
  if (!check.ok) {
    throw new Error(`updater: 完整性校验失败 —— 期望 ${options.integrity}，实际 ${check.actual}。已拒绝落盘。`)
  }
  fs.mkdirSync(path.dirname(options.destPath), { recursive: true })
  fs.writeFileSync(options.destPath, buffer)
  return { destPath: options.destPath, bytes: buffer.length }
}

/**
 * 解包 tgz 到目标目录（系统 tar 解包；npm tgz 内含 `package/` 前缀，解后拍平到 destDir）。
 * @param {{ tgzPath: string, destDir: string, spawnImpl?: Function }} options - 解包参数
 * @returns {Promise<{ destDir: string, entries: number }>} 解包结果
 */
async function extractTarball(options) {
  const { tgzPath, destDir } = options
  fs.mkdirSync(destDir, { recursive: true })
  const spawnImpl = options.spawnImpl ?? spawn
  const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  await new Promise((resolve, reject) => {
    const child = spawnImpl(tarExe, ['-xzf', tgzPath, '-C', destDir], { windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`updater: tar 解包失败（exit ${code}）${stderr.trim() === '' ? '' : `：${stderr.trim()}`}`))
    })
  })
  // 拍平：tarball 根是 `package/`，把它下面的条目提升到 destDir 根。
  const inner = path.join(destDir, 'package')
  if (fs.existsSync(inner)) {
    for (const entry of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, entry), path.join(destDir, entry))
    }
    fs.rmdirSync(inner)
  }
  const entries = fs.readdirSync(destDir).length
  if (entries === 0) {
    throw new Error('updater: 解包结果为空（tarball 形态与预期不符）')
  }
  return { destDir, entries }
}

/**
 * 组装依赖安装的 spawn 参数（纯函数，便于测试）。
 * @param {{ nodeExe: string, versionDir: string }} options - Node 可执行与版本目录
 * @returns {{ file: string, args: string[], cwd: string }} spawn 参数
 *   （`npm install --omit=dev`：引擎运行只需生产依赖；lockfile 由 npm 生成落盘，
 *   与现有版本目录「package.json + package-lock.json + node_modules」的形态对齐）
 */
function buildInstallSpawn({ nodeExe, versionDir }) {
  const npmCli = path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return {
    file: nodeExe,
    args: [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
    cwd: versionDir,
  }
}

/**
 * 在版本目录里重建依赖树（调盘内 npm CLI）。
 * @param {{ nodeExe: string, versionDir: string, spawnImpl?: Function, onLine?: Function }} options - 参数
 * @returns {Promise<{ exitCode: number }>} 安装结果（非零 exit 抛错）
 */
async function installDependencies(options) {
  const spawnImpl = options.spawnImpl ?? spawn
  const { file, args, cwd } = buildInstallSpawn({ nodeExe: options.nodeExe, versionDir: options.versionDir })
  if (!fs.existsSync(args[0])) {
    throw new Error(`updater: 找不到 npm CLI：${args[0]}（盘内 Node 发行版应自带）`)
  }
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, { cwd, windowsHide: true })
    const pipe = (stream) => {
      stream?.on('data', (chunk) => {
        if (typeof options.onLine === 'function') options.onLine(String(chunk).trim())
      })
    }
    pipe(child.stdout)
    pipe(child.stderr)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ exitCode: 0 })
      else reject(new Error(`updater: npm install 失败（exit ${code}），版本目录 ${cwd} 已保留供排查`))
    })
  })
}

/**
 * 为新版本构造 current 指针清单（纯函数；形态与 computeRollback 对齐——
 * 保留 name/profile/app_args/_comment，只换 version 与 entry）。
 * @param {object} currentManifest - 当前清单
 * @param {string} targetVersion - 新版本号
 * @returns {{ manifest: object, entry: string }} 新清单与相对 entry
 */
function buildNextManifest(currentManifest, targetVersion) {
  if (typeof targetVersion !== 'string' || targetVersion === '') {
    throw new Error('updater: 目标版本不能为空')
  }
  const entry = `../${targetVersion}/node_modules/@deepseek-ai/dsh/lib/bin.js`
  const next = {
    ...currentManifest,
    version: targetVersion,
    entry,
  }
  if (typeof next.profile !== 'string') next.profile = 'web'
  if (!Array.isArray(next.app_args)) next.app_args = []
  return { manifest: next, entry }
}

/**
 * 改写 current 指针指向新版本（升级的最后一步；旧版本目录原样保留）。
 * @param {{ root: string, config: object, manifest: object, entry: string, version: string }} options - 参数
 * @returns {{ file: string }} 指针文件
 */
function writePointer(options) {
  const { root, config, manifest, entry, version } = options
  const pointerFile = path.resolve(root, config.runtime.dsh.current, 'nomad-runtime.json')
  const resolvedEntry = assertInside(root, path.resolve(path.dirname(pointerFile), entry), 'updater entry')
  if (!fs.existsSync(resolvedEntry)) {
    throw new Error(`updater: 新版本入口不存在：${resolvedEntry}（拒绝改写指针）`)
  }
  fs.writeFileSync(pointerFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  void version
  return { file: pointerFile }
}

/**
 * 完整升级编排：下载 → 校验 → 解包 → 装依赖 → 改指针。
 * 各步骤通过 `steps` 注入以便测试；CLI 用真实实现接线。
 * @param {object} options - 参数（root/config/currentManifest/nodeExe/version/tarball/integrity +
 *   fetchImpl/spawnImpl/tarSpawnImpl/instanceAlive）
 * @returns {Promise<{ version: string, versionDir: string, pointerFile: string, bytes: number }>} 结果
 */
async function applyUpdate(options) {
  const { root, config, nodeExe, version, tarball, integrity } = options
  if (typeof integrity !== 'string' || integrity === '') {
    throw new Error('updater: registry 未提供 integrity，拒绝下载（无校验锚点）')
  }
  const runtimeDshDir = path.resolve(root, config.runtime.dsh.current, '..')
  const versionDir = assertInside(root, path.join(runtimeDshDir, version), 'updater versionDir')
  if (fs.existsSync(path.join(versionDir, 'nomad-runtime.json')) || fs.existsSync(path.join(versionDir, 'package.json'))) {
    throw new Error(`updater: 版本目录已存在：${versionDir}（不覆盖；如需重装请手动清理后重试）`)
  }
  const tmpDir = assertInside(root, path.join(config.paths.tmp, `dsh-update-${Date.now().toString(36)}`), 'updater tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    // 1) 下载 + 完整性校验（失败不落版本目录）
    const tgzPath = path.join(tmpDir, 'dsh.tgz')
    const downloaded = await downloadTarball({ url: tarball, integrity, fetchImpl: options.fetchImpl, destPath: tgzPath })
    // 2) 解包
    await extractTarball({ tgzPath, destDir: versionDir, spawnImpl: options.tarSpawnImpl })
    // 3) 重建依赖树
    await installDependencies({ nodeExe, versionDir, spawnImpl: options.spawnImpl, onLine: options.onLine })
    // 4) 构造并改写指针（入口必须真实存在才写）
    const { manifest, entry } = buildNextManifest(options.currentManifest, version)
    if (options.instanceAlive === true && options.force !== true) {
      throw new Error('updater: Nomad 正在运行，拒绝改写 current 指针（依赖已装好，可先 nomad stop 再 nomad rollback <version> 切换）')
    }
    const pointer = writePointer({ root, config, manifest, entry, version })
    return { version, versionDir, pointerFile: pointer.file, bytes: downloaded.bytes }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败不掩盖主流程 */ }
  }
}

module.exports = {
  DEFAULT_REGISTRY_BASE,
  DEFAULT_PACKAGE_NAME,
  compareVersions,
  fetchLatestMeta,
  checkUpdate,
  verifyIntegrity,
  downloadTarball,
  extractTarball,
  buildInstallSpawn,
  installDependencies,
  buildNextManifest,
  writePointer,
  applyUpdate,
  saveUpdateCheck,
  readUpdateCheck,
  UPDATE_CHECK_FILE,
}
