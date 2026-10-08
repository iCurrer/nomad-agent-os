'use strict'

/**
 * NOMAD_ROOT 探测。
 *
 * 铁律 2：USB 是 Agent 的 Home，一切路径从 NOMAD_ROOT 派生。
 * 因此启动器第一件事就是**确定自己在哪个盘上**，并且这个判断必须可解释。
 *
 * 优先级：
 *   1. `--root <dir>`（显式）
 *   2. `$NOMAD_ROOT`（显式）
 *   3. 从启动目录向上查找根标记（`AGENTS.md` + `VERSION` + `config/nomad.yaml`）
 *   4. 从 launcher 自身位置向上查找
 * 显式给出的路径若不成立 → **报错**，不静默回退（避免静默挂到错误的盘上）。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 根目录标记文件：三者同时存在才认定为 NOMAD_ROOT。 */
const MARKERS = ['AGENTS.md', 'VERSION', path.join('config', 'nomad.yaml')]

/**
 * 判断目录是否为 NOMAD_ROOT。
 * @param {string} dir - 候选目录
 * @returns {boolean} 是则为 true
 */
function isRoot(dir) {
  try {
    return MARKERS.every((marker) => fs.existsSync(path.join(dir, marker)))
  } catch {
    return false
  }
}

/**
 * 从起始目录逐级向上查找根标记。
 * @param {string} startDir - 起始目录
 * @returns {string | null} 命中的目录，未命中则为 null
 */
function searchUpward(startDir) {
  let current = path.resolve(startDir)
  for (;;) {
    if (isRoot(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * 探测 NOMAD_ROOT。
 * @param {{ explicit?: string, fromDir?: string, env?: NodeJS.ProcessEnv }} [options]
 *   显式路径 / 起始目录 / 环境变量（默认 process.env）
 * @returns {{ root: string, source: string }} 根目录与判定来源
 * @throws {Error} 显式指定的路径不成立，或未找到任何根标记
 */
function detectRoot(options = {}) {
  const env = options.env ?? process.env
  const explicitCli = options.explicit
  const explicitEnv = env.NOMAD_ROOT

  const tryExplicit = (value, source) => {
    const resolved = path.resolve(value)
    if (!isRoot(resolved)) {
      throw new Error(
        `${source} 指向的目录不是 NOMAD_ROOT：${resolved}\n`
        + `  该目录必须同时包含 ${MARKERS.join(' / ')}。\n`
        + '  为避免静默挂到错误的盘上，此处不做回退。',
      )
    }
    return { root: fs.realpathSync(resolved), source }
  }

  if (typeof explicitCli === 'string' && explicitCli.trim() !== '') {
    return tryExplicit(explicitCli, 'cli:--root')
  }
  if (typeof explicitEnv === 'string' && explicitEnv.trim() !== '') {
    return tryExplicit(explicitEnv, 'env:NOMAD_ROOT')
  }

  const fromDir = options.fromDir ?? __dirname
  const fromLauncher = searchUpward(fromDir)
  if (fromLauncher !== null) return { root: fs.realpathSync(fromLauncher), source: `marker:${fromLauncher}` }

  throw new Error(
    '未能定位 NOMAD_ROOT：向上查找未找到根标记。\n'
    + `  需要同时包含：${MARKERS.join(' / ')}\n`
    + '  可用 --root <dir> 或环境变量 NOMAD_ROOT 显式指定。',
  )
}

module.exports = { detectRoot, isRoot, MARKERS }
