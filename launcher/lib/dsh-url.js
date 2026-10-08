'use strict'

/**
 * DSH Web 启动行的解析与脱敏。
 *
 * 源码依据（证据等级：本地源码）：
 *   packages/bundle/web-app/src/index.ts:290
 *     console.log(`dsh web: ${authenticatedUrl}${lanUrl === undefined ? '' : ` (LAN: ${lanUrl})`}`)
 *   packages/client/connection/src/browser-auth.ts:223-227
 *     authenticatedUrl() 把本进程的 launch token 作为 query 参数挂上；
 *   packages/client/connection/src/browser-auth.ts:238-245
 *     根路径带合法 token 的 GET 会铸 cookie 并重定向到干净的 `./`。
 *
 * 结论：**必须把带上 token 的 URL 交给浏览器**，裸 loopback 地址会拿到 401。
 * 同时：token 属敏感值，日志里只能出现脱敏后的地址。
 */

/** `dsh web: <url>` 行；可带 ` (LAN: <url>)` 后缀。 */
const URL_LINE = /^dsh web:\s+(\S+?)(?:\s+\(LAN:\s+(\S+?)\))?\s*$/

/**
 * 解析 DSH 的启动行。
 * @param {string} line - 一行 stdout 文本
 * @returns {{ url: string, lanUrl?: string, port: number } | null} 解析结果，非启动行则为 null
 */
function parseLaunchLine(line) {
  const matched = URL_LINE.exec(String(line).trim())
  if (matched === null) return null
  const url = matched[1]
  let port = 0
  try {
    const parsed = new URL(url)
    port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  } catch {
    return null
  }
  return matched[2] === undefined ? { url, port } : { url, lanUrl: matched[2], port }
}

/**
 * 去掉 URL 上全部 query 与 hash，用于**日志 / status 展示**（绝不外泄 token）。
 * @param {string} url - 原始 URL
 * @returns {string} 脱敏后的 URL；无法解析时返回 `(unparsable)`
 */
function sanitizeUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return '(unparsable)'
  }
}

module.exports = { parseLaunchLine, sanitizeUrl }
