'use strict'

/**
 * Nomad 路径卫士。
 *
 * 铁律（AGENTS.md 第 4 节）：
 *   2. 一切路径从 NOMAD_ROOT 派生。
 *   3. 禁止硬编码 Host 路径（`C:\Users\...` / `/home/...` 等）。
 *
 * 本模块是这两条铁律在**运行期**的唯一执行点：配置里的任何路径都必须过
 * `resolveInside`，越界或绝对路径直接抛错，而不是悄悄放行。
 */

const path = require('node:path')

/** Windows 盘符形态（`C:\...` / `C:/...`）。POSIX 上 `path.isAbsolute` 不识别，故单独拦。 */
const WIN_DRIVE = /^[a-zA-Z]:[\\/]/

/** UNC 形态（`\\server\share`）。 */
const UNC = /^\\\\/

/**
 * 判断一个字符串是否是宿主绝对路径（含跨平台形态）。
 * @param {string} value - 待判断的路径字符串
 * @returns {boolean} 是宿主绝对路径则为 true
 */
function isHostAbsolute(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || WIN_DRIVE.test(value) || UNC.test(value))
}

/**
 * 把配置里的相对路径解析为 NOMAD_ROOT 之下的绝对路径。
 *
 * 拒绝：空值、宿主绝对路径、以及解析后越出 NOMAD_ROOT 的路径（`../` 逃逸）。
 *
 * @param {string} root - NOMAD_ROOT 绝对路径
 * @param {unknown} value - 配置中的原始值
 * @param {string} label - 报错时显示的位置（如 `paths.runtime`）
 * @returns {string} 解析后的绝对路径
 */
function resolveInside(root, value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}: 路径必须是非空字符串，实际收到 ${JSON.stringify(value)}`)
  }
  if (isHostAbsolute(value)) {
    throw new Error(
      `${label}: 禁止宿主绝对路径 ${JSON.stringify(value)}`
      + '（AGENTS.md 铁律 3）。所有路径必须相对 NOMAD_ROOT。',
    )
  }
  const absolute = path.resolve(root, value)
  const relative = path.relative(root, absolute)
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`${label}: 路径越出 NOMAD_ROOT（${JSON.stringify(value)} → ${absolute}）`)
  }
  return absolute
}

/**
 * 断言某个绝对路径确实位于 root 之下（用于校验由外部来源给出的路径，如运行时清单）。
 * @param {string} root - NOMAD_ROOT
 * @param {string} target - 待校验的绝对路径
 * @param {string} label - 报错时显示的位置
 * @returns {string} 原样返回 target
 */
function assertInside(root, target, label) {
  const absolute = path.resolve(target)
  const relative = path.relative(path.resolve(root), absolute)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label}: ${absolute} 不在 NOMAD_ROOT（${root}）之内`)
  }
  return absolute
}

/**
 * 把一组 `{ 键: 相对路径 }` 解析为绝对路径映射。
 * @param {string} root - NOMAD_ROOT
 * @param {Record<string, unknown>} map - 键 → 相对路径
 * @param {string} labelPrefix - 报错前缀（如 `paths`）
 * @returns {Record<string, string>} 键 → 绝对路径
 */
function resolvePathMap(root, map, labelPrefix) {
  const out = {}
  for (const [key, value] of Object.entries(map)) {
    out[key] = resolveInside(root, value, `${labelPrefix}.${key}`)
  }
  return out
}

/**
 * 去掉路径末尾的分隔符：`E:\` → `E:`；`D:\u盘\` → `D:\u盘`。
 *
 * 必要性（**只有部署到盘符根才会暴露**，见 ADR-0028）：`NOMAD_ROOT` 在盘符根时天然**带尾分隔符**
 * （`E:\`）。此时若按 `` `${root}\\x` `` 拼前缀，会得到 `E:\\x`（双反斜杠），
 * 于是 `startsWith` 恒为 false —— 明明在盘内，却被判成越界。
 *
 * @param {string} p - 路径
 * @returns {string} 去掉尾分隔符后的路径
 */
function stripTrailingSep(p) {
  const s = p.replace(/[\\/]+$/, '')
  return s === '' ? p : s
}

/**
 * 判断 target 是否位于 root 之内（含 root 自身）。
 *
 * 判据是「去尾分隔符后的前缀 + 段边界」，而不是裸 `startsWith(root)` ——
 * 后者会把 `D:\u盘2` 误判为在 `D:\u盘` 之内。
 *
 * @param {string} root - 容器目录
 * @param {string} target - 待判断路径
 * @returns {boolean} 在内则为 true
 */
function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const r = stripTrailingSep(path.resolve(root))
  const t = stripTrailingSep(path.resolve(target))
  if (t === r) return true
  if (!t.startsWith(r)) return false
  const boundary = t[r.length]
  return boundary === '\\' || boundary === '/'
}

module.exports = {
  isHostAbsolute, resolveInside, assertInside, resolvePathMap, stripTrailingSep, isInside,
}
