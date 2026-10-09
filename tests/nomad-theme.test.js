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
    // 选中/激活面家族（2026-10-09 发布打磨：修「选中后纯白」与米白主题打架）
    '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-multi-select',
    '--dsw-alias-markdown-code-segment-selected',
    '--dsw-specific-selector',
    '--dsw-specific-tip',
    '--dsw-alias-button-ghost-active-fill',
    '--dsw-alias-bg-document-selection',
  ]
  assert.deepEqual(names.sort(), official.sort(), 'token 键名必须是 9 alias + 4 侧栏 specific + 7 选中面的覆盖集（写错键名 = override 静默失效）')
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
    // 选中/激活面家族浅色 = 暖色梯度（与 layer-2 / nav-item-active 同族）
    '--dsw-alias-bg-layer-3': '#F0E7DF',
    '--dsw-alias-bg-multi-select': '#EAE0D6',
    '--dsw-alias-markdown-code-segment-selected': '#F0E7DF',
    '--dsw-specific-selector': '#EAE0D6',
    '--dsw-specific-tip': '#EAE0D6',
    '--dsw-alias-button-ghost-active-fill': '#E0CFC0',
    '--dsw-alias-bg-document-selection': 'color-mix(in srgb, #C99F8A 40%, transparent)',
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
    // 选中/激活面家族暗色 = 保持 DSH 默认（引用官方 static 变量）
    '--dsw-alias-bg-layer-3': 'var(--dsw-static-neutral-bluish-800)',
    '--dsw-alias-bg-multi-select': 'var(--dsw-static-neutral-850)',
    '--dsw-alias-markdown-code-segment-selected': 'var(--dsw-static-neutral-bluish-800)',
    '--dsw-specific-selector': 'var(--dsw-static-neutral-bluish-800)',
    '--dsw-specific-tip': 'var(--dsw-static-neutral-bluish-800)',
    '--dsw-alias-button-ghost-active-fill': 'var(--dsw-static-neutral-bluish-750)',
    '--dsw-alias-bg-document-selection': 'color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent)',
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

// ── 发布打磨（2026-10-09）：隐藏上游鲸鱼吉祥物 ──────────────────────────────────
// 契约：apply 时向 document.head 注入一条 id 锚定的 style 规则；幂等（重复 apply 不叠加）；
// 规则用 [class*="_fish"] 子串匹配（hash 变了也能跟上）；无 document 环境（SSR/测试沙箱）跳过。

/** 带最小 document 桩的加载器：捕获注入的 style 元素 + 标题守卫的可观测状态。 */
function loadModuleWithDocument() {
  const injected = []
  let existing = null
  // 标题守卫桩：title setter 同步触发已注册的观察者回调（模拟真实浏览器语义）。
  const observerCallbacks = []
  let title = ''
  const documentStub = {
    getElementById: (id) => (existing !== null && existing.id === id ? existing : null),
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (el) => { existing = el; injected.push(el) } },
    get title() { return title },
    set title(value) {
      title = value
      for (const cb of observerCallbacks) cb()
    },
  }
  let envelope
  const windowObject = { __ModuleLoader__: { load: (spec) => { envelope = spec } } }
  const sandbox = {
    window: windowObject,
    document: documentStub,
    MutationObserver: class {
      constructor(cb) { observerCallbacks.push(cb) }
      observe() { /* 桩：注册即视为已监听 */ }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'nomad-theme/client.js' })
  assert.ok(envelope !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load')
  const module = envelope.factory(() => { throw new Error('unexpected require') })
  const ctx = { theme: { overrideTokens: () => {} } }
  return { module, ctx, injected, document: documentStub, windowObject }
}

test('发布打磨：注入上游鲸鱼隐藏规则，幂等不叠加', () => {
  const { module, ctx, injected } = loadModuleWithDocument()
  module.apply(ctx)
  assert.equal(injected.length, 1, '首次 apply 恰好注入一条 style')
  assert.equal(injected[0].id, 'nomad-theme-hide-fish')
  assert.ok(injected[0].textContent.includes('[class*="_fish"]'), '规则用 _fish 子串匹配（hash 弹性）')
  assert.ok(injected[0].textContent.includes('display:none'), '必须隐藏元素')
  // 幂等：getElementById 已命中（existing 有 id），再次 apply 不叠加
  module.apply(ctx)
  assert.equal(injected.length, 1, '重复 apply 不得叠加第二条 style')
})

// ── 发布打磨（2026-10-09）：浏览器标签标题守卫 ──────────────────────────────────
// 契约：上游 layout 的 productTitle = "DeepSeek Harness" 是硬编码且每次会话切换都会
// 重写 document.title ⇒ 一次性改写必被打回。守卫 = 应用即修一次 + MutationObserver
// 持续监听；凡含上游产品名就地替换为 Nomad，保留会话名前缀；幂等（window 旗标）。

test('标题守卫：apply 立即改写含上游产品名的初始标题', () => {
  const { module, ctx, document } = loadModuleWithDocument()
  document.title = 'DeepSeek Harness'
  module.apply(ctx)
  assert.equal(document.title, 'Nomad', '初始标题应立即改为 Nomad')
})

test('标题守卫：观察者持续拦截 —— 会话切换写入「会话 — DeepSeek Harness」时保留前缀只换产品名', () => {
  const { module, ctx, document } = loadModuleWithDocument()
  module.apply(ctx)
  // 模拟上游 DocumentTitle 组件的效果：切换会话时重写整个标题
  document.title = '调试引擎 — DeepSeek Harness'
  assert.equal(document.title, '调试引擎 — Nomad', '会话前缀必须保留，仅产品名替换')
  // 上游清理函数直接写回 productTitle 的场景
  document.title = 'DeepSeek Harness'
  assert.equal(document.title, 'Nomad')
  // 守卫自己的改写（已不含目标串）不会引发二次改写（天然无死循环）
  document.title = 'Nomad'
  assert.equal(document.title, 'Nomad')
  // 与上游无关的正常标题不受影响
  document.title = '设置 — Nomad'
  assert.equal(document.title, '设置 — Nomad')
})

test('标题守卫：幂等 —— 重复 apply 不得叠加观察者（改写只发生一次）', () => {
  const { module, ctx, document } = loadModuleWithDocument()
  module.apply(ctx)
  module.apply(ctx)
  module.apply(ctx)
  document.title = 'x — DeepSeek Harness'
  assert.equal(document.title, 'x — Nomad')
  // 若叠加了 3 个观察者，title 会被写 3 次；通过对比结果无法直接观测次数，
  // 但守卫逻辑本身幂等（第二次替换不命中），这里至少锁住结果正确性。
  // 真正的叠加防护由 window.__nomadTitleGuardInstalled 旗标守：源码断言兜底。
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  assert.ok(source.includes('__nomadTitleGuardInstalled'), '必须用 window 旗标做安装幂等')
})
