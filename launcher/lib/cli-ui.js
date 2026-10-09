'use strict'

/**
 * cli-ui —— 终端样式引擎（零依赖，Phase 3.6 CLI 美化）。
 *
 * 设计原则：
 *   - **零新依赖**：便携盘不引 npm 包，ANSI 转义直接手写（Win10+ conhost/WT
 *     由 libuv 对 TTY 自动启用 VT 处理，无需额外配置）。
 *   - **颜色自动降级**：非 TTY（管道/重定向/测试捕获）一律输出纯文本，
 *     保证 `nomad status --json` 之外的机器可读性；NO_COLOR 环境变量遵循
 *     https://no-color.org 约定，FORCE_COLOR=1 可强制。
 *   - **CJK 感知对齐**：中文键名占 2 列（西文终端等宽字体下的真实宽度），
 *     kv 行用显示宽度对齐而不是 String.padEnd（按码元数算，中文会歪）。
 *   - **内容与皮肤分离**：本模块只管「怎么好看」，文案仍在调用方 ——
 *     改样式不需要动业务逻辑，改文案不需要懂 ANSI。
 */

/** 颜色强制开关（undefined = 自动检测；测试可显式设定）。 */
let forcedColor = undefined

/**
 * 设置颜色强制模式（供测试与特殊终端使用）。
 * @param {boolean|undefined} value - true 强制开 / false 强制关 / undefined 自动
 * @returns {void}
 */
function setColorMode(value) {
  forcedColor = value
}

/**
 * 当前输出流是否启用颜色。
 * @returns {boolean} 是否启用
 */
function colorEnabled() {
  if (forcedColor !== undefined) return forcedColor
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0'
  return process.stdout.isTTY === true
}

/**
 * 包裹字符串为 ANSI 样式（支持嵌套：内层 reset 后自动恢复外层样式）。
 * @param {string} s - 原文
 * @param {...number} codes - SGR 码（1 bold / 2 dim / 31 red / 32 green / 33 yellow / 36 cyan / 90 gray）
 * @returns {string} 样式化文本
 */
function style(s, ...codes) {
  if (codes.length === 0) return String(s)
  if (!colorEnabled()) return String(s)
  const open = `\x1b[${codes.join(';')}m`
  // 嵌套修复：内层样式以 \x1b[0m 结尾会连外层一起清掉，在其后补回外层开码。
  const inner = String(s).replace(/\x1b\[0m/g, `\x1b[0m${open}`)
  return `${open}${inner}\x1b[0m`
}

const bold = (s) => style(s, 1)
const dim = (s) => style(s, 2)
const red = (s) => style(s, 31)
const green = (s) => style(s, 32)
const yellow = (s) => style(s, 33)
const cyan = (s) => style(s, 36)
const gray = (s) => style(s, 90)

/**
 * 去除 ANSI 转义（宽度计算 / 日志落盘前的净化）。
 * @param {string} s - 可能含转义的文本
 * @returns {string} 纯文本
 */
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * 单个码点的终端显示宽度（CJK 与全角 = 2，其余 = 1，控制符 = 0）。
 * 区段范围取自 Unicode EastAsianWidth 的 W/F 类主流子集，覆盖中日韩文本与常用 emoji。
 * @param {number} cp - 码点
 * @returns {number} 显示列数
 */
function codePointWidth(cp) {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20100 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/**
 * 字符串显示宽度（按码点聚合；先剥 ANSI）。
 * @param {string} s - 文本
 * @returns {number} 显示列数
 */
function displayWidth(s) {
  let width = 0
  for (const ch of stripAnsi(s)) width += codePointWidth(ch.codePointAt(0))
  return width
}

/**
 * 按显示宽度右补空格到 n 列（CJK 安全版 String.padEnd）。
 * @param {string} s - 文本
 * @param {number} n - 目标列数
 * @returns {string} 补齐后文本
 */
function padEnd(s, n) {
  const text = String(s)
  const gap = n - displayWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

/**
 * 按显示宽度左补空格到 n 列（CJK 安全版 String.padStart）。
 * @param {string} s - 文本
 * @param {number} n - 目标列数
 * @returns {string} 补齐后文本
 */
function padStart(s, n) {
  const text = String(s)
  const gap = n - displayWidth(text)
  return gap > 0 ? ' '.repeat(gap) + text : text
}

/**
 * 状态符号（彩色；颜色关闭时回退 ASCII 安全形态）。
 * @returns {{ ok: string, fail: string, warn: string, skip: string, info: string, arrow: string, bullet: string, dot: string, ring: string, brand: string }} 符号表
 */
function glyphs() {
  if (colorEnabled()) {
    return {
      ok: green('✓'),
      fail: red('✗'),
      warn: yellow('⚠'),
      skip: gray('–'),
      info: cyan('ℹ'),
      arrow: gray('→'),
      bullet: gray('•'),
      dot: green('●'),
      ring: gray('○'),
      brand: cyan('✦'),
    }
  }
  return { ok: '[OK]', fail: '[X]', warn: '[!]', skip: '--', info: '(i)', arrow: '->', bullet: '-', dot: '*', ring: 'o', brand: '*' }
}

/**
 * 分区标题：`── 标题 ──────────────`（标题青色加粗，横线灰色，总宽对齐）。
 * @param {string} text - 标题文案
 * @param {number} [totalWidth=62] - 总显示宽度
 * @returns {string} 标题行
 */
function title(text, totalWidth = 62) {
  const head = `── ${text} `
  const rest = Math.max(0, totalWidth - displayWidth(head))
  const rule = '─'.repeat(rest)
  return `${style(head, 1, 36)}${dim(rule)}`
}

/**
 * 键值行：`键        值`（键加粗右补齐到 keyWidth 显示列）。
 * 键宽按显示宽度计算，中英混排键名也能对齐。
 * @param {string} key - 键（纯文本，不要预上色）
 * @param {string} value - 值（可含样式/路径）
 * @param {number} [keyWidth=12] - 键列宽
 * @returns {string} 键值行
 */
function kv(key, value, keyWidth = 12) {
  return `${bold(padEnd(key, keyWidth))} ${value}`
}

/**
 * 语义色（成功/失败/警告/中性），供调用方给数值与结论上色，避免到处写码值。
 */
const tone = { ok: green, fail: red, warn: yellow, mute: gray, accent: cyan }

module.exports = {
  setColorMode,
  colorEnabled,
  style,
  bold,
  dim,
  red,
  green,
  yellow,
  cyan,
  gray,
  stripAnsi,
  codePointWidth,
  displayWidth,
  padEnd,
  padStart,
  glyphs,
  title,
  kv,
  tone,
}
