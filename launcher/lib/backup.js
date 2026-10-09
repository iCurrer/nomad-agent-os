'use strict'

/**
 * 用户数据备份与恢复（Recoverable 价值）。
 *
 * 设计依据（ADR-0032）：
 *   - 零依赖、跨平台：只用 Node `fs` 递归复制，**不调用 tar/7z/robocopy**（后者在本环境受限，
 *     见 ADR-0027）；Windows 长路径由 libuv 自动加 `\\?\` 前缀解决。
 *   - 备份对象 = 盘内**用户数据**（`paths.dsh_home`，含 sessions/profiles/projects/documents/storages）；
 *     可选 `--include-config` 额外备份 `paths.config`。这些是 Runtime/Data 分离（ADR-0001）下
 *     **不可再生**的资产。runtime/ 不备份（可重下）。
 *   - 备份落点 = `paths.backups/nomad-backup-<timestamp>/`，结构按"相对 NOMAD_ROOT 的路径"
 *     镜像，便于精确回放；同时写 `backup-manifest.json`。
 *   - restore 是**合并复制**：用备份覆盖目标位置已有文件，但**不删除**备份中没有的文件
 *     （避免误删本机更新过的数据）；运行实例存活时拒绝，除非 `--force`。
 *   - 排除 `tmp` / `run` / `node_modules` 等易变或无关目录，且跳过符号链接以防环。
 */

const fs = require('node:fs')
const path = require('node:path')
const { assertInside } = require('./paths.js')

/** 递归复制时跳过的目录名（任何层级）。 */
const EXCLUDE_DIRS = new Set(['tmp', 'run', 'node_modules'])

/**
 * 递归复制目录树（零依赖）。
 * @param {string} src - 源绝对路径
 * @param {string} dest - 目标绝对路径
 * @param {{ exclude: Set<string>, onFile?: (rel: string) => void }} options - 选项
 * @returns {number} 复制的文件数
 */
function copyTree(src, dest, options) {
  const { exclude, onFile } = options
  const walk = (from, to) => {
    let local = 0
    const entries = fs.readdirSync(from, { withFileTypes: true })
    fs.mkdirSync(to, { recursive: true })
    for (const entry of entries) {
      const fromPath = path.join(from, entry.name)
      const toPath = path.join(to, entry.name)
      // 用 lstat 判定符号链接（withFileTypes 的 dirent 在某些平台对 symlink 判别不稳），
      // 跳过符号链接以避免环与跨盘引用。
      let stat
      try {
        stat = fs.lstatSync(fromPath)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (exclude.has(entry.name)) continue
        local += walk(fromPath, toPath)
      } else if (stat.isFile()) {
        fs.copyFileSync(fromPath, toPath)
        local += 1
        if (onFile !== undefined) onFile(path.relative(dest, toPath))
      }
    }
    return local
  }
  return walk(src, dest)
}

/**
 * 构造时间戳目录名（本地时区，文件系统友好）。
 * @returns {string} 形如 `nomad-backup-20261008-193400`
 */
function timestampName() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `nomad-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 解析备份源目录列表。
 * @param {string} root - NOMAD_ROOT
 * @param {object} config - 已加载配置
 * @param {boolean} includeConfig - 是否额外备份 config 目录
 * @returns {{ relPath: string, abs: string }[]} 源列表
 */
function resolveSources(root, config, includeConfig) {
  const sources = [{ relPath: path.relative(root, config.paths.dsh_home), abs: config.paths.dsh_home }]
  if (includeConfig === true) {
    const cfgAbs = config.paths.config
    if (cfgAbs !== undefined && fs.existsSync(cfgAbs)) {
      sources.push({ relPath: path.relative(root, cfgAbs), abs: cfgAbs })
    }
  }
  return sources
}

/**
 * 执行备份。
 * @param {string} root - NOMAD_ROOT
 * @param {object} config - 已加载配置
 * @param {{ includeConfig?: boolean, to?: string }} options - 选项
 * @returns {{ dir: string, manifest: object, warnings: string[] }} 结果
 */
function createBackup(root, config, options = {}) {
  const warnings = []
  const destDir = options.to !== undefined
    ? path.resolve(root, options.to)
    : path.join(config.paths.backups, timestampName())

  // 落点必须在 NOMAD_ROOT 之内（防把数据写到盘外），且不能是某个源目录自身（防递归）。
  assertInside(root, destDir, 'backup dest')
  const sources = resolveSources(root, config, options.includeConfig === true)
  for (const src of sources) {
    const abs = path.resolve(root, src.abs)
    if (destDir === abs || destDir.startsWith(abs + path.sep)) {
      throw new Error(`backup: 落点 ${destDir} 位于源目录 ${abs} 之内，会自递归，已拒绝`)
    }
  }

  fs.mkdirSync(destDir, { recursive: true })
  const items = []
  for (const src of sources) {
    const abs = path.resolve(root, src.abs)
    if (!fs.existsSync(abs)) {
      warnings.push(`源目录不存在，跳过：${abs}`)
      continue
    }
    const target = path.join(destDir, src.relPath)
    const n = copyTree(abs, target, { exclude: EXCLUDE_DIRS })
    items.push({ relPath: src.relPath, files: n })
  }

  const manifest = {
    tool: 'nomad-backup',
    schema: 1,
    createdAt: new Date().toISOString(),
    root,
    items,
  }
  fs.writeFileSync(path.join(destDir, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { dir: destDir, manifest, warnings }
}

/**
 * 从备份恢复（合并复制：覆盖已有、不删除多余）。
 * @param {string} root - NOMAD_ROOT
 * @param {object} config - 已加载配置
 * @param {string} backupDir - 备份目录（绝对或相对 root）
 * @returns {{ restored: number, items: number }} 结果
 */
function restoreBackup(root, config, backupDir) {
  const absBackup = path.resolve(root, backupDir)
  assertInside(root, absBackup, 'restore source')
  const manifestFile = path.join(absBackup, 'backup-manifest.json')
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`restore: 备份清单不存在：${manifestFile}（不是有效的 nomad 备份目录）`)
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    throw new Error(`restore: 清单解析失败：${error.message}`)
  }
  if (!Array.isArray(manifest.items)) {
    throw new Error('restore: 清单缺少 items 字段，无法恢复')
  }
  let restored = 0
  const targets = []
  for (const item of manifest.items) {
    const relPath = item.relPath
    const from = path.join(absBackup, relPath)
    const to = path.resolve(root, relPath)
    if (!fs.existsSync(from)) {
      throw new Error(`restore: 备份项缺失：${from}`)
    }
    targets.push({ from, to, relPath })
  }
  for (const { from, to } of targets) {
    restored += copyTree(from, to, { exclude: EXCLUDE_DIRS })
  }
  return { restored, items: manifest.items.length }
}

/**
 * 查询最近一次备份的年龄（3.5 备份提示用；只读，不触发备份）。
 * @param {object} config - 已加载配置（用 paths.backups）
 * @returns {{ last: string|null, ageDays: number|null }} 最近备份的 ISO 时间与距今天数；从未备份过则均为 null
 */
function lastBackupInfo(config) {
  const dir = config.paths.backups
  let newest = null
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('nomad-backup-')) continue
      const stat = fs.statSync(path.join(dir, entry.name))
      if (newest === null || stat.mtimeMs > newest.mtimeMs) newest = stat
    }
  } catch {
    return { last: null, ageDays: null }
  }
  if (newest === null) return { last: null, ageDays: null }
  return { last: new Date(newest.mtimeMs).toISOString(), ageDays: Math.floor((Date.now() - newest.mtimeMs) / 86400000) }
}

module.exports = {
  EXCLUDE_DIRS,
  copyTree,
  timestampName,
  resolveSources,
  createBackup,
  restoreBackup,
  lastBackupInfo,
}
