'use strict'

/**
 * DSH 运行时回滚：改写 `runtime/dsh/current/nomad-runtime.json` 的 entry，
 * 指向一个已安装的旧版本目录。
 *
 * 设计依据（ADR-0016 / ADR-0032）：
 *   - `current` 是**清单间接**指针（不是 junction/symlink），回滚 = 改写一行 `entry`；
 *   - `current` 目录只放 `nomad-runtime.json`，entry 是**相对 current 目录**的路径；
 *   - 回滚只影响「下一次启动」—— 运行中的实例已加载自己的入口，不受影响；
 *   - 因此运行实例存活时拒绝回滚（除非 --force），避免用户误以为"已切换当前实例"。
 *
 * 本模块只做"改写指针"，不下载/不安装/不删任何运行时文件。
 */

const fs = require('node:fs')
const path = require('node:path')
const { listRuntimeVersions } = require('./runtime.js')
const { assertInside } = require('./paths.js')

/** 版本目录里 DSH 入口的约定相对位置（相对版本目录根）。 */
const DSH_ENTRY_RELATIVE = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

/**
 * 读取 current 指针清单。
 * @param {string} root - NOMAD_ROOT
 * @param {object} config - 已加载配置
 * @returns {{ file: string, manifest: object }} 清单文件与内容
 */
function readCurrentManifest(root, config) {
  const dshRoot = path.resolve(root, config.runtime.dsh.current)
  const file = path.join(dshRoot, 'nomad-runtime.json')
  if (!fs.existsSync(file)) {
    throw new Error(`rollback: 找不到 current 指针清单 ${file}`)
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`rollback: 清单 ${file} 不是合法 JSON：${error.message}`)
  }
  return { file, manifest }
}

/**
 * 列出已安装的 DSH 版本（不含 current）。
 * @param {string} root - NOMAD_ROOT
 * @param {object} config - 已加载配置
 * @returns {string[]} 版本目录名
 */
function listDshVersions(root, config) {
  const dshDir = path.resolve(root, config.runtime.dsh.current, '..')
  return listRuntimeVersions(dshDir)
}

/**
 * 计算回滚后的新清单。纯函数，不写盘。
 * @param {object} currentManifest - 当前清单
 * @param {string} targetVersion - 目标版本目录名（如 `0.2.1-alpha.1`）
 * @param {string[]} available - 已安装版本列表
 * @param {string} root - NOMAD_ROOT，用于越界校验
 * @param {object} config - 已加载配置
 * @returns {{ manifest: object, entry: string, version: string }} 新清单与关键字段
 */
function computeRollback(currentManifest, targetVersion, available, root, config) {
  if (typeof targetVersion !== 'string' || targetVersion === '') {
    throw new Error('rollback: 目标版本不能为空')
  }
  if (!available.includes(targetVersion)) {
    throw new Error(
      `rollback: 目标版本 ${targetVersion} 未安装。已安装：${available.join(', ') || '(无)'}`,
    )
  }
  const dshRoot = path.resolve(root, config.runtime.dsh.current)
  const entry = `../${targetVersion}/${DSH_ENTRY_RELATIVE}`
  // 越界校验：entry 必须仍落在 NOMAD_ROOT 之内（防配置被改成指向盘外）。
  assertInside(root, path.resolve(dshRoot, entry), 'rollback entry')

  const resolvedEntry = path.resolve(dshRoot, entry)
  if (!fs.existsSync(resolvedEntry)) {
    throw new Error(`rollback: 目标版本入口不存在：${resolvedEntry}`)
  }

  // 保留 name / profile / app_args，只换 version 与 entry。
  const next = {
    ...currentManifest,
    version: targetVersion,
    entry,
  }
  if (typeof next.profile !== 'string') next.profile = 'web'
  if (!Array.isArray(next.app_args)) next.app_args = []
  return { manifest: next, entry, version: targetVersion }
}

/**
 * 应用回滚：计算并写回 current 指针。
 * @param {string} root - NOMAD_ROOT
 * @param {object} config - 已加载配置
 * @param {string} targetVersion - 目标版本
 * @returns {{ file: string, from: string, to: string }} 结果
 */
function applyRollback(root, config, targetVersion) {
  const { file, manifest } = readCurrentManifest(root, config)
  const available = listDshVersions(root, config)
  const from = typeof manifest.version === 'string' ? manifest.version : '(未知)'
  const { manifest: next } = computeRollback(manifest, targetVersion, available, root, config)
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return { file, from, to: targetVersion }
}

module.exports = {
  DSH_ENTRY_RELATIVE,
  readCurrentManifest,
  listDshVersions,
  computeRollback,
  applyRollback,
}
