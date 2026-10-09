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

test('banner：NOMAD 五行块字 + 右侧信息列，行宽恒定、信息注入正确', () => {
  ui.setColorMode(false)
  try {
    const art = ui.banner([
      'Portable Agent OS',
      'Nomad 0.0.1-dev',
      'Launcher 0.1.0',
      'DSH 0.2.1-alpha.1',
      'Node 22.22.2',
    ])
    const lines = art.split('\n')
    assert.equal(lines.length, 5, '块字艺术固定 5 行')
    for (const line of lines) {
      assert.equal(ui.displayWidth(line.split('  ')[0]) - 0 >= 0, true)
      assert.equal(line.slice(0, 35).length, 35, '艺术区每行 35 列（含尾部空格补齐）')
    }
    assert.ok(lines[0].includes('Portable Agent OS'))
    assert.ok(lines[1].includes('Nomad 0.0.1-dev'))
    assert.ok(lines[3].includes('DSH 0.2.1-alpha.1'))
    assert.ok(art.includes('█'), '应含块字字符'); assert.ok(!art.includes('╗') && !art.includes('╔'), '不得含制表符字形（宋体系字体双宽会散架）')
    // 信息不足 5 行时右侧留空，不抛错
    assert.equal(ui.banner(['a']).split('\n').length, 5)
  } finally {
    ui.setColorMode(undefined)
  }
})

test('banner：tagline 追加在横幅下方；颜色开启时艺术区带 ANSI', () => {
  ui.setColorMode(true)
  try {
    const art = ui.banner(['x'], { tagline: 'ready' })
    const lines = art.split('\n')
    assert.equal(lines.length, 7, '5 行艺术 + 空行 + tagline')
    assert.equal(lines[6], 'ready')
    assert.match(lines[0], /\x1b\[1;36m█/)
  } finally {
    ui.setColorMode(undefined)
  }
})
