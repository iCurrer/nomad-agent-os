// nomad-brand 客户端半的契约与渲染产物回归。
//
// 为什么要这个文件（2026-10-08）：
//   真实冒烟能证明「模块被服务端吐得出来」，但**证不了「模块里的东西是对的」** ——
//   产物若是空信封、槽名打错、组件渲染不出图元，那三环断言照样全绿。
//   这里用 `vm` 把 `lib/client.js` **按浏览器的方式**执行一遍，只给它浏览器真正给的东西。
//
// 为什么不用真 React 渲染：
//   运行时里**没有 react**（它被打进了前端 dist，由浏览器提供），
//   所以 `require("react/jsx-runtime")` 用**记录式桩**。
//   于是本文件的断言对象是**组件产出的元素树**，不是像素 —— 这点必须诚实：
//   「元素树对」是「界面正确」的必要条件，充分性仍由真机人眼判定。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const CLIENT_PATH = path.join(ROOT, 'packages', 'nomad-brand', 'lib', 'client.js')
const MANIFEST_PATH = path.join(ROOT, 'packages', 'nomad-brand', 'package.json')

/** 记录式 jsx：把 `jsx(type, props, key)` 变成可断言的纯数据节点。 */
function makeRecorder() {
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  return { jsx, jsxs: jsx }
}

/**
 * 按浏览器的方式执行 client.js，取回它交给 module loader 的信封。
 * 沙箱里**只**提供 `window.__ModuleLoader__` —— 浏览器给的就这么多。
 * @returns {{ id: string, factory: Function }} 模块信封
 */
function loadEnvelope() {
  let envelope
  const sandbox = { window: { __ModuleLoader__: { load: (spec) => { envelope = spec } } } }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'nomad-brand/client.js' })
  assert.ok(envelope !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load —— 浏览器不会注册它')
  return envelope
}

/** 执行 factory，得到插件模块（等价于浏览器加载完该模块的结果）。 */
function loadModule() {
  const envelope = loadEnvelope()
  const jsxRuntime = makeRecorder()
  const module = envelope.factory((name) => {
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`client.js 请求了未预期的模块：${name}（浏览器里只有 react/jsx-runtime 可得）`)
  })
  return { envelope, module }
}

/**
 * 走一遍 apply，并把注册到的组件取出来。
 * 注意 `inject` 的 mock **必须迭代**回调返回值 —— `apply` 里传的是 generator，
 * generator 体在"只调用不迭代"时**根本不会执行**（真实实现同样是迭代式安装）。
 * 少了这一步，测试会静默地什么都没断言到。
 * @returns {{ comps: Record<string, Function>, applied: string[] }} 注册表与调用轨迹
 */
function applyAndCapture() {
  const { module } = loadModule()
  const comps = {}
  const applied = []
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
      register(options, component) {
        applied.push(`register:${options.name}`)
        comps[options.name] = component
        return () => {}
      },
    },
  }
  module.apply(ctx)
  return { comps, applied }
}

test('信封：注册 id 与 factory 形态符合 module loader 契约', () => {
  const envelope = loadEnvelope()
  assert.equal(envelope.id, '@nomad/dsh-client-brand')
  assert.equal(typeof envelope.factory, 'function')
})

test('导出契约：inject 只要 slots 服务，apply 是函数', () => {
  const { module } = loadModule()
  assert.equal(module.inject.length, 1)
  assert.equal(module.inject[0], 'slots')
  assert.equal(typeof module.apply, 'function')
})

test('apply：只注册侧栏两个品牌槽，且顺序为 mark → name', () => {
  const { applied } = applyAndCapture()
  assert.deepEqual([...applied], [
    'inject:sidebar.brand.mark',
    'inject:sidebar.brand.name',
    'register:sidebar.brand.mark',
    'register:sidebar.brand.name',
  ])
})

test('mark 组件：渲染北斗七星 —— 1 条连线 + 恰好 7 颗星', () => {
  const { comps } = applyAndCapture()
  const tree = comps['sidebar.brand.mark']({ size: 24 })

  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 24)
  assert.equal(tree.props.height, 24)
  assert.equal(tree.props.viewBox, '0 0 24 24')
  assert.equal(tree.props['aria-hidden'], 'true', '装饰性图形必须对无障碍树隐藏')

  const kids = [...tree.props.children]
  assert.equal(kids.length, 2, 'svg 应只有「连线」与「星点」两个子元素')

  const [line, stars] = kids
  assert.equal(line.type, 'path')
  assert.ok(line.props.d.startsWith('M'), `连线必须是一条自起点出发的路径，实际：${String(line.props.d)}`)

  assert.equal(stars.type, 'g')
  const dots = [...stars.props.children]
  assert.equal(dots.length, 7, '北斗七星必须是 7 颗')
  for (const dot of dots) {
    assert.equal(dot.type, 'circle')
    assert.equal(typeof dot.props.cx, 'number')
    assert.equal(typeof dot.props.cy, 'number')
    assert.equal(typeof dot.props.r, 'number')
  }

  // 天权（斗柄与斗魁的枢纽）画得更大：七星里应恰有两档半径，且大档只有一颗。
  const radii = [...new Set(dots.map((dot) => dot.props.r))]
  assert.equal(radii.length, 2, `七星应有且仅有两档半径（枢纽星更大），实际：${radii.join(' / ')}`)
  const big = Math.max(...radii)
  assert.equal(dots.filter((dot) => dot.props.r === big).length, 1, '枢纽星应当唯一')
})

test('mark 组件：宿主未给 size 时回退 24，不因缺参崩掉', () => {
  const { comps } = applyAndCapture()
  for (const props of [{}, { size: undefined }, { size: 'N/A' }]) {
    const tree = comps['sidebar.brand.mark'](props)
    assert.equal(tree.props.width, 24, `props=${JSON.stringify(props)} 时应回退 24`)
  }
})

test('name 组件：字标为 Nomad', () => {
  const { comps } = applyAndCapture()
  const tree = comps['sidebar.brand.name']({})
  assert.equal(tree.type, 'span')
  assert.equal(tree.props.children, 'Nomad')
})

test('两者都跟随主题：不出现任何硬编码色值，只用 currentColor / inherit', () => {
  const { comps } = applyAndCapture()
  const mark = comps['sidebar.brand.mark']({ size: 24 })
  const name = comps['sidebar.brand.name']({})

  const [, stars] = [...mark.props.children]
  assert.equal(mark.props.children[0].props.stroke, 'currentColor')
  assert.equal(stars.props.fill, 'currentColor')
  assert.equal(name.props.style.color, 'inherit', '字标颜色必须继承，才能在明暗主题下都正确')

  for (const tree of [mark, name]) {
    const flat = JSON.stringify(tree)
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(flat) && !/\brgba?\(/.test(flat),
      `不得硬编码颜色（会让明暗主题之一不可读）：${flat}`,
    )
  }
})

test('包声明：dsh.client 只声明 web 平台，且 exports["./client"] 指向手写产物', () => {
  const pkg = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual([...pkg.dsh.client.inject], [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.ok(fs.existsSync(CLIENT_PATH), 'exports["./client"] 指向的文件必须存在（否则扫描器认领后取不到字节）')
})
