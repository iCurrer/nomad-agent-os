// nomad-locale 客户端半的契约回归。
//
// 为什么需要这个文件：语言包走的是上游 locale 服务的**正规扩展点**，但每个调用
// 都有硬性前置条件（BCP 47 id、fallback 必须已注册且链到 en、重复 (ns, locale) 抛错、
// setLocale 未知 id 抛错）—— 任何一条写错都会在浏览器启动时抛错，把插件行打哑。
// 这里用桩复现上游 LocaleRuntime 的关键契约（正则逐字照抄上游源码），
// 把「调错参数」挡在提交前，而不是等真机启动图告警。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const CLIENT_PATH = path.join(ROOT, 'packages', 'nomad-locale', 'lib', 'client.js')
const PKG_PATH = path.join(ROOT, 'packages', 'nomad-locale', 'package.json')
const PATCH_PATH = path.join(ROOT, 'packages', 'nomad-web-app', 'cordis.patch.yml')

/** 上游 dsh-client-locale 的 BCP 47-style 校验正则（LocaleRuntime.normalizeLanguage 同源）。 */
const LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/

/** locale 服务桩：复现上游关键抛错契约 + 记录调用。 */
function makeLocaleStub() {
  const catalog = new Map([['zh', { id: 'zh', fallback: 'en' }], ['en', { id: 'en', fallback: undefined }]])
  const nsLocales = new Map() // ns -> Set(localeKey)
  const calls = { register: [], addLanguage: [], setLocale: [] }
  return {
    calls,
    active: 'zh',
    register(ns, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
      for (const [locale] of pairs) {
        if (!LOCALE_ID_PATTERN.test(locale)) throw new Error(`locale id "${locale}" is not a BCP 47-style tag`)
        const locales = nsLocales.get(ns) ?? new Set()
        if (locales.has(locale.toLowerCase())) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
      }
      for (const [locale, entries] of pairs) {
        if (entries === undefined || entries === null || typeof entries !== 'object') {
          throw new Error('dict must be an object')
        }
        nsLocales.set(ns, (nsLocales.get(ns) ?? new Set()).add(locale.toLowerCase()))
        calls.register.push({ ns, locale, dict: entries })
      }
    },
    addLanguage(input) {
      if (!LOCALE_ID_PATTERN.test(input.id)) throw new Error(`locale id "${input.id}" is not a BCP 47-style tag`)
      if (typeof input.label !== 'string' || input.label.trim() === '') throw new Error('locale label must not be empty')
      if (!LOCALE_ID_PATTERN.test(input.fallback)) throw new Error(`locale fallback "${input.fallback}" is not a BCP 47-style tag`)
      if (catalog.has(input.id.toLowerCase())) throw new Error(`locale "${input.id}" is already registered`)
      if (!catalog.has(input.fallback.toLowerCase())) throw new Error(`locale fallback "${input.fallback}" is not registered`)
      catalog.set(input.id.toLowerCase(), { id: input.id, fallback: input.fallback })
      calls.addLanguage.push(input)
      return () => {}
    },
    getLocale() {
      return { active: this.active }
    },
    setLocale(id) {
      if (!catalog.has(id.toLowerCase())) throw new Error(`locale "${id}" is not registered`)
      calls.setLocale.push(id)
      this.active = id
    },
  }
}

/** 加载 client.js 并以给定 stub 执行 apply。 */
function runApply(localeStub) {
  let envelope
  const windowObject = { __ModuleLoader__: { load: (spec) => { envelope = spec } } }
  const sandbox = { window: windowObject, console }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'nomad-locale/client.js' })
  assert.ok(envelope !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load')
  const module = envelope.factory((name) => { throw new Error(`nomad-locale/client.js 请求了未预期的模块：${name}`) })
  const effects = []
  const ctx = { locale: localeStub, effect: (fn, label) => { effects.push(label); return fn() } }
  module.apply(ctx)
  return { module, ctx, effects, calls: localeStub.calls }
}

test('契约：语言 id 是 BCP 47-style 且不与上游 zh/en 冲突', () => {
  const { calls } = runApply(makeLocaleStub())
  const lang = calls.addLanguage[0]
  assert.match(lang.id, LOCALE_ID_PATTERN, 'id 必须过上游 BCP 47 校验')
  assert.notEqual(lang.id.toLowerCase(), 'zh', '不得占用上游官方 zh')
  assert.notEqual(lang.id.toLowerCase(), 'en', '不得占用上游官方 en')
  assert.equal(lang.fallback, 'zh', 'fallback 必须是官方 zh（链：zh-nomad → zh → en）')
  assert.ok(lang.label.trim() !== '', '语言目录展示名不能为空')
})

test('契约：只覆盖 hero 文案键，词典落在 conversation 命名空间', () => {
  const { calls } = runApply(makeLocaleStub())
  assert.equal(calls.register.length, 1, '应恰好一次词典注册')
  const { ns, locale, dict } = calls.register[0]
  assert.equal(ns, 'conversation', 'hero 文案在 conversation 插件的词典命名空间')
  assert.equal(locale, calls.addLanguage[0].id, '词典 locale 必须与语言目录 id 一致')
  assert.ok('hero.headline' in dict, '必须覆盖 hero.headline（上游「探索未至之境」）')
  assert.ok('hero.preview' in dict, '必须覆盖 hero.preview（上游「预览版」徽章）')
  for (const [key, value] of Object.entries(dict)) {
    assert.equal(typeof value, 'string', `${key} 的值必须是字符串`)
    assert.ok(!value.includes('DeepSeek') && !value.includes('未至之境'), `${key} 不得残留上游品牌字样`)
  }
})

test('迁移：活跃语言为官方 zh 时切到 Nomad 语言；en 用户绝不被劫持', () => {
  // ① 默认 zh → setLocale('zh-nomad')
  const zhStub = makeLocaleStub()
  const { effects } = runApply(zhStub)
  assert.deepEqual(zhStub.calls.setLocale, [zhStub.calls.addLanguage[0].id], 'zh 活跃时应一次性迁移')
  assert.ok(effects.includes('nomad-locale: language pack'), '语言目录注册应挂 ctx.effect（可清理）')
  // ② en 用户 → 不切换
  const enStub = makeLocaleStub()
  enStub.active = 'en'
  runApply(enStub)
  assert.deepEqual(enStub.calls.setLocale, [], 'en 活跃时绝不切换（不劫持用户语言选择）')
  // ③ 已是 nomad 语言（二次加载）→ 不重复写
  const nomadStub = makeLocaleStub()
  nomadStub.active = 'zh-nomad'
  runApply(nomadStub)
  assert.deepEqual(nomadStub.calls.setLocale, [], '已是 zh-nomad 时不得重复写偏好')
})

test('容错：切换失败只降级（词典/目录已就位），不炸启动', () => {
  const stub = makeLocaleStub()
  stub.setLocale = () => { throw new Error('host preference write refused') }
  assert.doesNotThrow(() => runApply(stub), 'setLocale 抛错必须被 apply 吸收（console.warn 降级）')
})

test('清单：inject 声明 dsh-client-locale，exports 提供 ./client', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'), 'package.json 必须声明 locale 服务来源')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.exports['./client'], '必须导出 ./client（浏览器半寻址入口）')
  const hostSource = fs.readFileSync(path.join(ROOT, 'packages', 'nomad-locale', 'lib', 'host.js'), 'utf8')
  assert.match(hostSource, /export function apply\(\)/, '宿主半必须是空 apply（与 theme/brand 同形态）')
})

test('接线：cordis.patch.yml 的 nomad group 必须挂 nomad-locale 行', () => {
  const patch = fs.readFileSync(PATCH_PATH, 'utf8')
  assert.match(patch, /- id: nomad-locale\s*\n\s*name: \.\.\/nomad-locale\/lib\/host\.js/, 'nomad group 必须有 nomad-locale 子行（name 相对声明包目录）')
})
