// nomad-theme 客户端半的契约回归。
//
// 为什么需要这个文件：换肤是「注入具体色值」，是项目里**唯一**写死色值的模块
// （其它模块都走 --dsw-* 变量 + currentColor 兜底）。所以必须有三重锚定，防止
// 「色值写错 / token 名漂移 / light/dark 缺一」这类换肤事故：
//   1. **token 键名 = DSH 官方 alias 清单**（写错键名 → override 静默失效，界面不变）；
//   2. **light/dark 双值齐全且一一对应**（README 强制 both palettes mandatory，
//      缺一侧会在用户切主题时该 token 变「未定义」）；
//   3. **浅色 = 维护者定的暖米白大地色系**（9 个 alias + 4 个侧栏 specific 共 13 个色值逐字锚定）。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const CLIENT_PATH = path.join(ROOT, 'packages', 'nomad-theme', 'lib', 'client.js')

/** 加载 client.js，拿到信封 + 一个可检查的 theme 桩。 */
function loadModule() {
  let envelope
  const windowObject = { __ModuleLoader__: { load: (spec) => { envelope = spec } } }
  const sandbox = { window: windowObject }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'nomad-theme/client.js' })
  assert.ok(envelope !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load')

  // theme 桩：记录 overrideTokens 收到的 source 与 tokens。
  const calls = []
  const themeStub = {
    overrideTokens: (source, tokens) => { calls.push({ source, tokens }) },
  }

  const module = envelope.factory((name) => {
    // 本包零依赖 react（纯换肤，无 UI 渲染），factory 里不应 require 任何模块。
    throw new Error(`nomad-theme/client.js 请求了未预期的模块：${name}`)
  })
  // 手动注入 theme 到模块作用域不可行 —— apply(ctx) 的 ctx 是外部传入的，
  // 所以直接构造 ctx 对象调用 apply。
  const ctx = { theme: themeStub }
  module.apply(ctx)

  return { envelope, module, calls, ctx }
}

test('apply：调用 overrideTokens 且 source = 本包 id', () => {
  const { calls } = loadModule()
  assert.equal(calls.length, 1, 'apply 应恰好调用一次 overrideTokens')
  assert.equal(calls[0].source, '@nomad/dsh-client-theme', '覆盖源必须是本包 id')
})

test('token 键名 = 9 个 alias 清单 + 4 个侧边栏 specific 覆盖集', () => {
  const { calls } = loadModule()
  const tokens = calls[0].tokens
  const names = Object.keys(tokens)
  // 换肤覆盖集 = 9 个语义 alias（主区/卡片/文字/边框走这层）+ 4 个侧边栏 specific
  // （侧边栏背景与导航项 hover/active 直接绑定 specific，不经过 alias 引用链，
  // 见 client.js 头注释「为什么除了 alias 还要覆盖 specific」）。
  const official = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-button-primary-hover',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-specific-sidebar-fill',
    '--dsw-specific-sidebar-nav-item-hover',
    '--dsw-specific-sidebar-nav-item-active',
    '--dsw-specific-sidebar-nav-item-active-accent',
  ]
  assert.deepEqual(names.sort(), official.sort(), 'token 键名必须是 9 alias + 4 侧栏 specific 的覆盖集（写错键名 = override 静默失效）')
})

test('light/dark 双值齐全，且每项都是 { light, dark } 字符串对', () => {
  const { calls } = loadModule()
  const tokens = calls[0].tokens
  for (const [name, modes] of Object.entries(tokens)) {
    assert.ok(modes !== null && typeof modes === 'object', `${name} 必须是 { light, dark } 对象`)
    assert.equal(typeof modes.light, 'string', `${name}.light 必须是字符串`)
    assert.equal(typeof modes.dark, 'string', `${name}.dark 必须是字符串`)
    assert.ok(modes.light.length > 0, `${name}.light 不能为空`)
    assert.ok(modes.dark.length > 0, `${name}.dark 不能为空`)
  }
})

test('浅色 = 维护者定的暖米白大地色系（9 个色值逐字锚定）', () => {
  const { calls } = loadModule()
  const tokens = calls[0].tokens
  const expected = {
    '--dsw-alias-bg-base': '#F5EEE8',
    '--dsw-alias-bg-layer-1': '#EDE2D9',
    '--dsw-alias-bg-layer-2': '#F0E7DF',
    '--dsw-alias-brand-primary': '#C99F8A',
    '--dsw-alias-button-primary-hover': '#A87560',
    '--dsw-alias-label-primary': '#332B27',
    '--dsw-alias-label-secondary': '#81746D',
    '--dsw-alias-border-l1': '#DED1C7',
    '--dsw-alias-border-l2': '#D0BFAF',
    '--dsw-specific-sidebar-fill': '#EDE2D9',
    '--dsw-specific-sidebar-nav-item-hover': '#E5D8CD',
    '--dsw-specific-sidebar-nav-item-active': '#E0CFC0',
    '--dsw-specific-sidebar-nav-item-active-accent': '#C99F8A',
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(tokens[name].light, value, `${name} 的浅色值必须是 ${value}`)
  }
})

test('暗色 = 保持 DSH 默认（非暖米白，逐字锚定默认暗色值）', () => {
  const { calls } = loadModule()
  const tokens = calls[0].tokens
  const expected = {
    '--dsw-alias-bg-base': 'rgb(21, 21, 23)',
    '--dsw-alias-bg-layer-1': 'rgb(35, 35, 36)',
    '--dsw-alias-bg-layer-2': 'rgb(44, 44, 46)',
    '--dsw-alias-brand-primary': 'rgb(249, 250, 251)',
    '--dsw-alias-label-primary': 'rgb(249, 250, 251)',
    '--dsw-alias-label-secondary': 'rgb(207, 211, 214)',
    '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.06)',
    '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.12)',
    '--dsw-specific-sidebar-fill': 'var(--dsw-static-neutral-bluish-900)',
    '--dsw-specific-sidebar-nav-item-hover': 'var(--dsw-static-neutral-bluish-75)',
    '--dsw-specific-sidebar-nav-item-active': 'var(--dsw-static-neutral-bluish-100)',
    '--dsw-specific-sidebar-nav-item-active-accent': 'var(--dsw-static-deepseek-100)',
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(tokens[name].dark, value, `${name} 的暗色值必须保持默认 ${value}`)
  }
})

test('inject 声明 theme 服务', () => {
  const { module } = loadModule()
  assert.deepEqual(module.inject, ['theme'], 'inject 必须声明 theme service（由 ui-theme provide）')
})

test('宿主半是空 apply（不注册任何服务）', () => {
  const hostSrc = fs.readFileSync(path.join(ROOT, 'packages', 'nomad-theme', 'lib', 'host.js'), 'utf8')
  assert.ok(/export\s+function\s+apply\s*\(\s*\)\s*\{\s*\}/.test(hostSrc), '宿主半必须是空 apply')
})
