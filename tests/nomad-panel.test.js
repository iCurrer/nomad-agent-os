// nomad-panel 客户端半的契约与渲染产物回归。
//
// 为什么要这个文件（2026-10-08，紧随 nomad-brand 之后）：
//   真实冒烟能证明「模块被服务端吐得出来」，但**证不了「模块里的东西是对的」**。
//   对本包尤其致命的一点：**侧栏入口的 id 与主面板的 key 必须一致** ——
//   若不一致，侧栏会**照常出现那一行**（list 注册成功了），点下去却抛
//   `layout.selectPanel: main panel "x" is not registered`。这种「半通」状态
//   在任何"模块可取性"断言下都是全绿的，只有这里能提前抓住。
//
// 为什么不用真 React 渲染：
//   运行时里**没有 react**（它被打进前端 dist，由浏览器提供），
//   所以 `require("react/jsx-runtime")` 与 `require("react")`（hooks）都用**记录式桩**，
//   断言对象是**元素树**而非像素。浏览器里 `require("react")` 是**可得**的 ——
//   上游 sidebar 构建产物 `lib/client.js:11` 就 `require("react")`、`:211` 用 `react.useState`。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const CLIENT_PATH = path.join(ROOT, 'packages', 'nomad-panel', 'lib', 'client.js')
const MANIFEST_PATH = path.join(ROOT, 'packages', 'nomad-panel', 'package.json')

/** 记录式 jsx：把 `jsx(type, props, key)` 变成可断言的纯数据节点。 */
function makeRecorder() {
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  return { jsx, jsxs: jsx }
}

/**
 * 按浏览器的方式执行 client.js，取回它交给 module loader 的信封。
 * 沙箱里**只**提供 `window`（浏览器给的就这么多）；`__DSH_BOOT__` 可选注入，
 * 用来验证构建标识的读取路径。
 * @param {{ boot?: unknown }} [options] - 沙箱注入项
 * @returns {{ id: string, factory: Function }} 模块信封
 */
function loadEnvelope(options = {}) {
  let envelope
  const windowObject = { __ModuleLoader__: { load: (spec) => { envelope = spec } } }
  if (options.boot !== undefined) windowObject.__DSH_BOOT__ = options.boot
  const sandbox = { window: windowObject }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'nomad-panel/client.js' })
  assert.ok(envelope !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load —— 浏览器不会注册它')
  return envelope
}

/** 执行 factory，得到插件模块（等价于浏览器加载完该模块的结果）。 */
function loadModule(options = {}) {
  const envelope = loadEnvelope(options)
  const jsxRuntime = makeRecorder()
  // react 桩：浏览器运行时**确实提供 `require("react")`**（上游 sidebar 构建产物
  // `lib/client.js:11 require("react")`、`:211 react.useState` 即为实证）。这里只给
  // 「记录式」的 hooks —— 测试断言的是元素树，不真渲染：
  //   · useState(initial) → [initial, 空 setter]（不触发重渲染，取首次渲染树即可）
  //   · useEffect(cb)      → 不执行（避免 setInterval 挂起测试进程；fetch 本也不存在）
  const reactStub = {
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  }
  const module = envelope.factory((name) => {
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === 'react') return reactStub
    throw new Error(`client.js 请求了未预期的模块：${name}（浏览器里只有 react 与 react/jsx-runtime 可得）`)
  })
  return { envelope, module }
}

/**
 * 走一遍 apply，收集注册项与调用轨迹。
 * 注意 `inject` 的 mock **必须迭代**回调返回值 —— generator 体在"只调用不迭代"时
 * 根本不会执行（真实实现同样是迭代式安装），少了这一步测试会静默地什么都没断言到。
 * @param {{ boot?: unknown }} [options] - 透传给沙箱
 * @returns {{ comps: Record<string, Function>, options: Record<string, object>, applied: string[], layoutCalls: unknown[] }}
 */
function applyAndCapture(options = {}) {
  const { module } = loadModule(options)
  const comps = {}
  const optionsByName = {}
  const applied = []
  const layoutCalls = []
  const ctx = {
    slots: {
      inject(key, callback) {
        applied.push(`inject:${key}`)
        const effect = callback()
        if (effect != null && typeof effect[Symbol.iterator] === 'function') {
          for (const dispose of effect) void dispose
        }
        return () => {}
      },
      register(opts, component) {
        applied.push(`register:${opts.name}`)
        comps[opts.name] = component
        optionsByName[opts.name] = opts
        return () => {}
      },
    },
    layout: { selectPanel: (id) => { layoutCalls.push(id) } },
  }
  module.apply(ctx)
  return { comps, options: optionsByName, applied, layoutCalls }
}

/**
 * 深度优先遍历元素树。
 * @param {unknown} node - 元素节点 / 子元素数组 / 标量
 * @param {(node: { type: unknown, props: Record<string, unknown> }) => void} visit - 访问器
 * @returns {void}
 */
function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node.type !== undefined) visit(node)
  if (node.props !== undefined && node.props.children !== undefined) walk(node.props.children, visit)
}

/**
 * 把元素树里所有文本节点拼起来，用于断言文案（递归到任意深度）。
 * @param {unknown} tree - 元素树
 * @returns {string} 拼接后的可见文本
 */
function textOf(tree) {
  const parts = []
  const collect = (node) => {
    if (typeof node === 'string') { parts.push(node); return }
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) collect(child); return }
    if (node.props !== undefined) collect(node.props.children)
  }
  collect(tree)
  return parts.join(' ')
}

test('信封：注册 id 与 factory 形态符合 module loader 契约', () => {
  const envelope = loadEnvelope()
  assert.equal(envelope.id, '@nomad/dsh-client-panel')
  assert.equal(typeof envelope.factory, 'function')
})

test('导出契约：inject 只要 slots 服务（layout 走包依赖），apply 是函数', () => {
  const { module } = loadModule()
  assert.deepEqual([...module.inject], ['slots'])
  assert.equal(typeof module.apply, 'function')
})

test('apply：注册「主面板 + 侧栏入口」两处，且都不碰上游 single 槽', () => {
  const { applied, options } = applyAndCapture()
  assert.deepEqual([...applied], [
    'inject:main',
    'register:main',
    'inject:sidebar.panellist',
    'register:sidebar.panellist',
  ])
  // 只占增量型槽位；任何 single 槽都不出现（否则就变成"抢占上游"，需配 disable 才行）
  const names = Object.keys(options).sort()
  assert.deepEqual(names, ['main', 'sidebar.panellist'])
})

test('★ 寻址闭环：主面板的 key 与侧栏入口的 id 必须完全一致', () => {
  const { options } = applyAndCapture()
  const mainKey = options['main'].key
  const rowId = options['sidebar.panellist'].id
  assert.equal(typeof mainKey, 'string')
  assert.equal(mainKey, 'nomad', '主面板 key 应为本面板的寻址 id')
  assert.equal(rowId, mainKey, '侧栏行 id 必须与主面板 key 相同 —— 否则点击会抛 "main panel is not registered"')
})

test('侧栏入口：带 order 与 label（侧栏面板行直接取自本槽的注册条目）', () => {
  const { options } = applyAndCapture()
  const row = options['sidebar.panellist']
  assert.equal(typeof row.order, 'number', 'order 决定侧栏行的排列位置，缺省会被当作 0')
  assert.equal(typeof row.label, 'function')
  assert.equal(row.label(), 'Nomad')
})

test('图标组件：7 颗星、无硬编码色值、active 只改变不透明度', () => {
  const { comps } = applyAndCapture()
  const tree = comps['sidebar.panellist']({ size: 18, active: false })

  assert.equal(tree.type, 'svg')
  assert.equal(tree.props['aria-hidden'], 'true', '装饰性图形必须对无障碍树隐藏')

  const stars = tree.props.children
  assert.equal(stars.type, 'g')
  assert.equal(stars.props.fill, 'currentColor', '图标颜色必须继承，才能在明暗主题下都正确')
  const dots = [...stars.props.children]
  assert.equal(dots.length, 7, '北斗七星必须是 7 颗')

  const idle = stars.props.opacity
  const active = comps['sidebar.panellist']({ size: 18, active: true }).props.children.props.opacity
  assert.ok(typeof idle === 'number' && typeof active === 'number')
  assert.ok(active > idle, '选中态应比静息态更实（不透明度更高）')

  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(JSON.stringify(tree)) && !/\brgba?\(/.test(JSON.stringify(tree)),
    '图标不得硬编码色值',
  )
})

test('图标组件：宿主未给 size 时回退，不因缺参崩掉', () => {
  const { comps } = applyAndCapture()
  for (const props of [{}, { size: undefined }, { size: '18' }]) {
    const tree = comps['sidebar.panellist'](props)
    assert.equal(typeof tree.props.width, 'number', `props=${JSON.stringify(props)} 时应回退到数字宽度`)
  }
})

test('面板组件：渲染出身份信息与回程入口', () => {
  const { comps, options } = applyAndCapture()
  const face = options['main'].inject()
  const tree = comps['main'](face)
  const text = textOf(tree)

  assert.ok(text.includes('Nomad'), '面板必须自报身份')
  assert.ok(text.includes('nomad'), '面板应展示自己的寻址 id，便于排查')
  assert.ok(text.includes('Back to conversation'), '必须提供回对话入口 —— 否则用户点了侧栏就困住')
})

test('面板组件：不含任何硬编码色值（明暗主题下都必须可读）', () => {
  const { comps, options } = applyAndCapture()
  const flat = JSON.stringify(comps['main'](options['main'].inject()))
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(flat) && !/\brgba?\(/.test(flat),
    '面板样式必须全部走上游 --dsw-* 变量',
  )
  assert.ok(flat.includes('--dsw-'), '应当引用上游设计令牌')
})

test('★ 回对话：点击按钮调用 selectPanel(null)（AppFrame 把 null 解为 conversation）', () => {
  const { comps, options, layoutCalls } = applyAndCapture()
  const tree = comps['main'](options['main'].inject())

  const buttons = []
  walk(tree, (node) => { if (node.type === 'button') buttons.push(node) })
  assert.equal(buttons.length, 1, `回程按钮应当且仅有一个，实际 ${String(buttons.length)} 个`)
  assert.equal(buttons[0].props.type, 'button')

  buttons[0].props.onClick()
  assert.deepEqual(layoutCalls, [null], '回对话必须走 selectPanel(null)')
})

test('回对话：layout 服务缺失时静默降级，不让面板整体崩掉', () => {
  const { module } = loadModule()
  let captured
  const ctx = {
    slots: {
      inject(key, callback) { const effect = callback(); if (effect != null && typeof effect[Symbol.iterator] === 'function') { for (const d of effect) void d } return () => {} },
      register(opts, component) {
        captured = captured ?? {}
        if (opts.name === 'main') captured.opts = opts
        return () => {}
      },
    },
    // 刻意不给 layout
  }
  module.apply(ctx)
  const face = captured.opts.inject()
  assert.doesNotThrow(() => { face.back() }, 'layout 缺失时 back() 不应抛错')
})

test('构建标识：能从启动图读取 rev，读不到时降级为占位符而不崩', () => {
  const withBoot = applyAndCapture({ boot: { rev: 'abc123' } })
  const bootText = textOf(withBoot.comps['main'](withBoot.options['main'].inject()))
  assert.ok(bootText.includes('abc123'), '应展示启动图里的构建标识')

  const withoutBoot = applyAndCapture()
  const bareText = textOf(withoutBoot.comps['main'](withoutBoot.options['main'].inject()))
  assert.ok(bareText.includes('—'), '读不到构建标识时应显示占位符，而不是 undefined')
  assert.ok(!bareText.includes('undefined'), '绝不能把 undefined 直接渲染到界面上')
})

test('包声明：声明 web 平台，且 inject 覆盖两个槽的声明方', () => {
  const pkg = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual([...pkg.dsh.client.inject], [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.ok(fs.existsSync(CLIENT_PATH), 'exports["./client"] 指向的文件必须存在（否则扫描器认领后取不到字节）')
})

// ── About 区块（合规声明 + 产品介绍）──────────────────────────────────────────────
// 为什么这些用例值得单独存在：
//   About 不是装饰 —— 它承载上游归属（BRAND_GUIDELINES 允许并鼓励的描述性说明）与
//   MIT 要求的版权/许可声明。文案被改坏的后果是**合规性**，不是观感，
//   所以必须由断言守住，而不是靠"看着对"。

/** 渲染一次面板，返回可见文本。 */
function panelText(options = {}) {
  const { comps, options: registered } = applyAndCapture(options)
  return textOf(comps['main'](registered['main'].inject()))
}

test('About：包含产品定位与「构建在上游之上」的描述性归属', () => {
  const text = panelText()
  assert.ok(text.includes('把 Agent 的家装进 U 盘'), 'About 应给出产品定位')
  assert.ok(
    text.includes('构建在 DeepSeek Harness（DSH）之上'),
    '必须用描述性措辞说明与上游的关系 —— 这是 BRAND_GUIDELINES 明确许可的说法',
  )
})

test('About：合规声明四要素齐全（归属 / 上游许可 / 本项许可 / 依赖许可）', () => {
  const text = panelText()
  assert.ok(text.includes('构建于'), '应有归属行')
  assert.ok(text.includes('DeepSeek Harness（DSH）0.2.1-alpha.1'), '归属行应含上游全名与锁定版本')
  assert.ok(text.includes('Copyright (c) 2026 DeepSeek'), '应保留上游版权声明（MIT 的核心义务）')
  assert.ok(text.includes('上游许可'), '应显式标出上游许可')
  assert.ok(text.includes('本项许可'), '应说明本项目自身的许可')
  assert.ok(text.includes('依赖许可'), '应说明第三方依赖许可的查询位置')
})

test('★ About：不得指向运行时分发包里不存在的聚合清单', () => {
  const text = panelText()
  // 实测：runtime/dsh/<ver>/ 内**没有** THIRD_PARTY_NOTICES.md（只有各包自带的 LICENSE）。
  // 文案若指向它，用户会去翻一个不存在的文件 —— 把"合规"变成"失信"。
  assert.ok(
    !text.includes('THIRD_PARTY_NOTICES'),
    '不得在界面里指向未随运行时分发的聚合清单；应如实指向各依赖包内附的 LICENSE',
  )
  assert.ok(text.includes('各依赖包内 LICENSE'), '依赖许可应如实指向依赖包内附的 LICENSE')
})

test('About：商标与关系声明必须否认官方背书', () => {
  const text = panelText()
  assert.ok(text.includes('注册商标'), '应声明上游名称是注册商标')
  assert.ok(
    text.includes('无隶属') && text.includes('无背书'),
    '必须明确否认与上游存在隶属/背书关系 —— BRAND_GUIDELINES 第 4 条明令禁止造成官方背书印象',
  )
})

test('About：披露上游 developer preview 状态（避免对外暗示稳定可用）', () => {
  const text = panelText()
  assert.ok(text.includes('developer preview'), '应披露上游的 developer preview 状态')
  assert.ok(text.includes('不追踪 master'), '应说明不追逐上游 master / 不自动升级的既定策略')
})

test('★ 上游版本锚定：About 里的版本号必须与 config/nomad.yaml 的 pinned_version 一致', () => {
  // 客户端是零构建手写产物，拿不到配置，只能内联版本号 —— 于是存在两处漂移的风险。
  // 这条用例把"两处一致"变成可判伪的断言：改一处漏另一处立刻红。
  const clientSource = fs.readFileSync(CLIENT_PATH, 'utf8')
  const configSource = fs.readFileSync(path.join(ROOT, 'config', 'nomad.yaml'), 'utf8')

  const pinned = /pinned_version:\s*"([^"]+)"/.exec(configSource)
  assert.ok(pinned !== null, 'config/nomad.yaml 里应有 runtime.dsh.pinned_version')

  const declared = [...clientSource.matchAll(/\bversion:\s*"([^"]+)"/g)].map((match) => match[1])
  assert.equal(declared.length, 1, `client.js 里应恰好有一处内联上游版本，实际 ${String(declared.length)} 处`)
  assert.equal(
    declared[0], pinned[1],
    'client.js 内联的上游版本必须与 config/nomad.yaml 的 pinned_version 相同（升级 DSH 时两处一起改）',
  )
})

test('★ 状态端点锚定：client.js 的固定端口必须与 config/nomad.yaml 的 status.port 一致', () => {
  // 面板靠「可预测的固定端口」去 fetch 只读状态端点（docs/HOST_TO_CLIENT.md §4 路径 B）。
  // 端口写死两处（client.js 的 STATUS_ENDPOINT 与 config 的 status.port），改一处漏另一处
  // 面板就 fetch 到一个不存在的地址，静默降级为骨架 —— 故必须锚定。
  const clientSource = fs.readFileSync(CLIENT_PATH, 'utf8')
  const configSource = fs.readFileSync(path.join(ROOT, 'config', 'nomad.yaml'), 'utf8')

  const endpoint = /STATUS_ENDPOINT\s*=\s*"http:\/\/127\.0\.0\.1:(\d+)\/status"/.exec(clientSource)
  assert.ok(endpoint !== null, 'client.js 里应有 STATUS_ENDPOINT 固定地址常量')

  const statusPort = /^status:\s*$\s*[\s\S]*?^  port:\s*(\d+)/m.exec(configSource)
  assert.ok(statusPort !== null, 'config/nomad.yaml 里应有 status.port')

  assert.equal(
    endpoint[1], statusPort[1],
    'client.js 的端点端口必须与 config 的 status.port 相同（改端口时两处一起改）',
  )
})

// ── 仪表盘改版（维护者 2026-10-09 反馈：介绍与面板分离，数据卡片墙）──────────────
// 契约：① Dashboard 卡片在首屏元素树里；② About 默认折叠（display:none）但**仍在树中**
// （合规文案不缺席）；③ About 开关是 div 不是 button（回程按钮保持全树唯一）。

test('仪表盘改版：数据卡片墙在首屏，About 折叠隐藏但文案仍在元素树里', () => {
  const { comps, options } = applyAndCapture()
  const tree = comps['main'](options['main'].inject())
  const text = textOf(tree)

  // ① Dashboard 卡片标签应出现在首屏（端点未就绪时至少有 Status 骨架卡）
  assert.ok(text.includes('Dashboard'), '应有 Dashboard 分区标题')
  assert.ok(text.includes('Version') || text.includes('Status'), '应有状态卡片（真实数据卡或骨架卡）')

  // ② About 区块默认 display:none（视觉折叠），但文案仍在树中（合规不缺席）
  let aboutNode = null
  walk(tree, (node) => {
    if (node.type === 'section' && node.props && node.props.style
      && node.props.style.display === 'none') aboutNode = node
  })
  assert.ok(aboutNode !== null, 'About 区块应默认折叠（style.display === "none"）')
  const aboutText = textOf(aboutNode)
  assert.ok(aboutText.includes('注册商标') && aboutText.includes('无背书'), '折叠态下合规文案仍必须在元素树里')

  // ③ About 开关是 div（回程 <button> 的全树唯一性由既有断言守住）
  let toggleFound = false
  walk(tree, (node) => {
    if (node.type === 'div' && typeof node.props?.children === 'string'
      && String(node.props.children).includes('About Nomad')) toggleFound = true
  })
  assert.ok(toggleFound, '应有「About Nomad」折叠开关（div 形态）')
})

// ── 发布级打磨（2026-10-09）：语义状态点 + 旧品牌措辞退场 ─────────────────────────
// 契约：① 状态点颜色只允许上游语义 token（禁硬编码由既有用例兜底，这里锁「确实接线」）；
//       ② 对外卡片不再裸露内部缩写前缀（"DSH " 字样退场，引擎版本以「引擎 x」措辞呈现）。

test('发布打磨：语义状态色走上游 token（success/warn/error 三件套已接线）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'nomad-panel', 'lib', 'client.js'), 'utf8')
  assert.ok(source.includes('--dsw-alias-state-success-primary'), '成功色必须来自上游 token')
  assert.ok(source.includes('--dsw-alias-state-warn-primary'), '警告色必须来自上游 token')
  assert.ok(source.includes('--dsw-alias-state-error-primary'), '错误色必须来自上游 token')
})

test('发布打磨：对外卡片措辞不再裸露内部缩写（"DSH " 前缀退场）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'nomad-panel', 'lib', 'client.js'), 'utf8')
  assert.ok(!source.includes('sub: "DSH "'), '卡片副文案不得再以内部缩写开头（改用「引擎 x」措辞）')
  assert.ok(source.includes('"引擎 " + (id.DSH_VERSION'), '引擎版本以「引擎 x」措辞呈现')
})
