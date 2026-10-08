'use strict'

/**
 * 极简参数解析（零依赖）。
 *
 * 支持形态：
 *   `--flag`            → true
 *   `--flag value`      → 'value'
 *   `--flag=value`      → 'value'
 *   `-f`                → true（短名同样进 flags，键为 `f`）
 *   `positional`        → positionals
 */

/**
 * 解析 argv（不含 node 与脚本路径）。
 * @param {string[]} argv - 参数列表
 * @returns {{ positionals: string[], flags: Record<string, string|boolean> }} 解析结果
 */
function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next
        i += 1
      } else {
        flags[body] = true
      }
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      for (const ch of token.slice(1)) flags[ch] = true
      continue
    }
    positionals.push(token)
  }
  return { positionals, flags }
}

/**
 * 取字符串型 flag（`--flag` 无值时不返回）。
 * @param {Record<string, string|boolean>} flags - flag 表
 * @param {string} name - flag 名
 * @returns {string|undefined} 值
 */
function flagValue(flags, name) {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * 取布尔型 flag。
 * @param {Record<string, string|boolean>} flags - flag 表
 * @param {string[]} names - 可能的 flag 名（任一命中即真）
 * @returns {boolean} 结果
 */
function flagBool(flags, names) {
  return names.some((name) => flags[name] === true || flags[name] === 'true')
}

module.exports = { parseArgs, flagValue, flagBool }
