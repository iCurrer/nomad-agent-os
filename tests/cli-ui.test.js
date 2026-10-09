'use strict'

/**
 * cli-ui 单元测试 —— 终端样式引擎（Phase 3.6 CLI 美化）。
 *
 * 契约面：
 *   - 颜色三态：强制开 / 强制关 / 自动（NO_COLOR）；关闭时输出纯文本且符号回退 ASCII。
 *   - CJK 感知宽度：中文按 2 列计；kv 行对齐以显示宽度为准（中英混排键不歪）。
 *   - 嵌套样式：内层 reset 后外层样式自动恢复。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const ui = require('../launcher/lib/cli-ui.js')

test('颜色关闭：style 原样返回，符号回退 ASCII，tone 为恒等', () => {
  ui.setColorMode(false)
  try {
    assert.equal(ui.bold('abc'), 'abc')
    assert.equal(ui.cyan('标题'), '标题')
    assert.equal(ui.glyphs().ok, '[OK]')
    assert.equal(ui.glyphs().fail, '[X]')
    assert.equal(ui.glyphs().arrow, '->')
    assert.equal(ui.tone.ok('21'), '21')
  } finally {
    ui.setColorMode(undefined)
  }
})

test('颜色开启：包含 ANSI 码，符号为 Unicode，tone 上语义色', () => {
  ui.setColorMode(true)
  try {
    assert.match(ui.cyan('x'), /\x1b\[36mx\x1b\[0m/)
    assert.match(ui.bold('x'), /\x1b\[1mx\x1b\[0m/)
    assert.equal(ui.glyphs().ok, '\x1b[32m✓\x1b[0m')
    assert.equal(ui.glyphs().dot, '\x1b[32m●\x1b[0m')
    assert.match(ui.tone.fail('0'), /\x1b\[31m0\x1b\[0m/)
  } finally {
    ui.setColorMode(undefined)
  }
})

test('嵌套样式：内层 reset 后外层自动恢复', () => {
  ui.setColorMode(true)
  try {
    const nested = ui.cyan(ui.red('a'))
    // 内层红色结束的 reset 之后应补回外层青色，最终才整体 reset。
    assert.match(nested, /\x1b\[31ma\x1b\[0m\x1b\[36m\x1b\[0m$/)
  } finally {
    ui.setColorMode(undefined)
  }
})

test('CJK 显示宽度：中文 2 列、ASCII 1 列、ANSI 不计宽', () => {
  ui.setColorMode(false)
  assert.equal(ui.displayWidth('中文ab'), 6)
  assert.equal(ui.displayWidth('path'), 4)
  assert.equal(ui.displayWidth(ui.cyan('状态')), 4)
  assert.equal(ui.codePointWidth('中'.codePointAt(0)), 2)
})

test('padEnd/padStart 按显示宽度补齐：中英混排后总宽一致', () => {
  ui.setColorMode(false)
  const zh = ui.padEnd('地址', 12)
  const en = ui.padEnd('address', 12)
  assert.equal(ui.displayWidth(zh), 12)
  assert.equal(ui.displayWidth(en), 12)
  const rs = ui.padStart('32MB', 10)
  assert.equal(ui.displayWidth(rs), 10)
})

test('kv：不同语言键名渲染后显示总宽一致（键区对齐）', () => {
  ui.setColorMode(false)
  const a = ui.kv('地址', 'http://x')
  const b = ui.kv('address', 'http://x')
  assert.equal(ui.displayWidth(a), ui.displayWidth(b))
  // 值部分不受键宽挤压：strip 后应以完整值结尾
  assert.ok(ui.stripAnsi(a).endsWith('http://x'))
})

test('title：标题 + 横线的总宽守恒，颜色关闭时为纯文本', () => {
  ui.setColorMode(false)
  const line = ui.title('启动计划', 40)
  assert.equal(ui.displayWidth(line), 40)
  assert.ok(line.startsWith('── 启动计划 '))
  assert.ok(line.endsWith('─'))
})
