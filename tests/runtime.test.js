'use strict'

/**
 * 运行时发现模块的单元测试。
 *
 * 重点覆盖 **Node 版本戳回退**：受限环境下 `spawnSync` 拉 node.exe 会 EBUSY，
 * 探测拿不到版本，必须能回退到打包期写下的 NOMAD_NODE_VERSION 戳。
 * 这条回退是真实踩坑后加的（doctor 曾报「版本未探测到」）。
 *
 * 测试用临时目录一律放在盘内 data/tmp，不写宿主临时目录。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  findBundledNode,
  resolveEntry,
  readVersionStamp,
  listRuntimeVersions,
  scanBrokenPackages,
  scanMissingPackages,
  countLockedPackages,
  isForeignPlatformPackage,
  findNodeModulesDir,
  NODE_VERSION_STAMP,
} = require('../launcher/lib/runtime.js')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(ROOT, 'data', 'tmp', `test-runtime-${String(process.pid)}`)

/**
 * 建一个一次性目录。
 * @param {string} name - 子目录名
 * @returns {string} 绝对路径
 */
function makeDir(name) {
  const dir = path.join(SANDBOX, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test.before(() => {
  fs.mkdirSync(SANDBOX, { recursive: true })
})

test.after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
})

test('readVersionStamp 读得到戳、读不到返回 null', () => {
  const dir = makeDir('stamp-yes')
  fs.writeFileSync(path.join(dir, NODE_VERSION_STAMP), 'v22.23.3\n', 'utf8')
  assert.equal(readVersionStamp(dir), 'v22.23.3')

  const empty = makeDir('stamp-no')
  assert.equal(readVersionStamp(empty), null)
  assert.equal(readVersionStamp(path.join(SANDBOX, 'not-exist')), null)
})

test('findBundledNode：探测失败时回退到版本戳', () => {
  const dir = makeDir('node-with-stamp')
  // 不是真的可执行文件 —— spawnSync 必然失败，正好模拟 EBUSY 场景
  fs.writeFileSync(path.join(dir, 'node.exe'), 'not-a-real-binary', 'utf8')
  fs.writeFileSync(path.join(dir, NODE_VERSION_STAMP), 'v22.99.0', 'utf8')

  const found = findBundledNode({ root: ROOT, nodeDir: dir })
  assert.ok(found !== null, '未找到盘内 Node')
  assert.equal(found.version, 'v22.99.0')
  assert.equal(found.versionSource, 'stamp')
})

test('findBundledNode：无戳且探测失败时标记 unknown，不抛错', () => {
  const dir = makeDir('node-no-stamp')
  fs.writeFileSync(path.join(dir, 'node.exe'), 'not-a-real-binary', 'utf8')

  const found = findBundledNode({ root: ROOT, nodeDir: dir })
  assert.ok(found !== null, '未找到盘内 Node')
  assert.equal(found.version, null)
  assert.equal(found.versionSource, 'unknown')
})

test('findBundledNode：支持 runtime/node/<version>/<binary> 版本化布局', () => {
  const dir = makeDir('node-versioned')
  const sub = path.join(dir, 'v9.9.9')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, 'node.exe'), 'x', 'utf8')
  fs.writeFileSync(path.join(sub, NODE_VERSION_STAMP), 'v9.9.9', 'utf8')

  const found = findBundledNode({ root: ROOT, nodeDir: dir })
  assert.ok(found !== null)
  assert.equal(found.version, 'v9.9.9')
})

test('resolveEntry：按 nomad-runtime.json 解析相对入口', () => {
  const dir = makeDir('dsh-manifest')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '// entry', 'utf8')
  fs.writeFileSync(
    path.join(dir, 'nomad-runtime.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3', entry: 'lib/bin.js', profile: 'web' }),
    'utf8',
  )

  const entry = resolveEntry(dir, ROOT)
  assert.equal(entry.name, '@deepseek-ai/dsh')
  assert.equal(entry.version, '1.2.3')
  assert.equal(entry.entrySource, 'nomad-runtime.json')
  assert.equal(entry.profile, 'web')
  assert.equal(entry.entry, path.join(dir, 'lib', 'bin.js'))
})

test('resolveEntry：清单 entry 越出 root 必须被拒绝（路径卫士）', () => {
  const dir = makeDir('dsh-escape')
  // 注意层数：SANDBOX = <ROOT>/data/tmp/test-runtime-<pid>，再下一层才是 dir。
  // 需要向上 5 层才能越过 ROOT（dir → test-runtime → tmp → data → ROOT → 越界）。
  fs.writeFileSync(
    path.join(dir, 'nomad-runtime.json'),
    JSON.stringify({ name: 'evil', version: '0', entry: '../../../../../outside.js' }),
    'utf8',
  )
  assert.throws(() => resolveEntry(dir, ROOT), /不在 NOMAD_ROOT/)
})

test('resolveEntry：无清单时回退 package.json#bin', () => {
  const dir = makeDir('dsh-pkgbin')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '// entry', 'utf8')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'some-dsh', version: '0.0.1', bin: { dsh: 'lib/bin.js' } }),
    'utf8',
  )

  const entry = resolveEntry(dir, ROOT)
  assert.equal(entry.name, 'some-dsh')
  assert.equal(entry.entrySource, 'package.json#bin.dsh')
})

test('listRuntimeVersions：排除 current，并只列目录', () => {
  const dir = makeDir('dsh-root')
  fs.mkdirSync(path.join(dir, '0.2.0'), { recursive: true })
  fs.mkdirSync(path.join(dir, '0.2.1-alpha.1'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'current'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), 'x', 'utf8')

  assert.deepEqual(listRuntimeVersions(dir), ['0.2.0', '0.2.1-alpha.1'])
  assert.deepEqual(listRuntimeVersions(path.join(SANDBOX, 'not-exist')), [])
})

/**
 * `scanBrokenPackages` —— 真实缺陷的守门人。
 *
 * 缺陷背景：打包期一次被打断的 npm install 留下了「有 lib/ 但没有 package.json」的包，
 * DSH 照常启动，只是 roster 里某个条目静默 "failed to import"。这个扫描器把它变成可见事实。
 * 误报控制同样重要：npm 对不匹配平台的可选依赖会留下**空目录**，那是正常行为。
 */
test('scanBrokenPackages：抓出「有子目录但缺 package.json」的残缺包', () => {
  const modules = makeDir('broken-modules')

  // 残缺：有 lib/ 却没有 package.json
  fs.mkdirSync(path.join(modules, '@scope', 'broken-with-lib', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(modules, '@scope', 'broken-with-lib', 'lib', 'client.js'), 'x', 'utf8')

  // 正常：package.json 齐全
  const ok = path.join(modules, '@scope', 'ok-pkg')
  fs.mkdirSync(path.join(ok, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(ok, 'package.json'), '{}', 'utf8')

  // 正常噪音：平台不匹配的可选依赖 —— **完全为空**的目录
  fs.mkdirSync(path.join(modules, '@scope', 'empty-optional-stub'), { recursive: true })
  fs.mkdirSync(path.join(modules, 'unscoped-empty-stub'), { recursive: true })

  // 残缺：非 scope 包，同样判据
  fs.mkdirSync(path.join(modules, 'broken-plain', 'dist'), { recursive: true })

  assert.deepEqual(scanBrokenPackages(modules), [
    { name: '@scope/broken-with-lib', contents: ['lib'] },
    { name: 'broken-plain', contents: ['dist'] },
  ])
})

test('scanBrokenPackages：目录不存在或为空时返回空数组，不抛错', () => {
  assert.deepEqual(scanBrokenPackages(path.join(SANDBOX, 'not-exist')), [])

  const empty = makeDir('empty-modules')
  assert.deepEqual(scanBrokenPackages(empty), [])
})

test('scanBrokenPackages：忽略点目录（.bin / .pnpm），不误判为包', () => {
  const modules = makeDir('dotdir-modules')
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true })
  fs.mkdirSync(path.join(modules, '.pnpm'), { recursive: true })
  fs.mkdirSync(path.join(modules, '@scope', 'with-lib', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(modules, '@scope', 'with-lib', 'package.json'), '{}', 'utf8')

  assert.deepEqual(scanBrokenPackages(modules), [])
})

test('findNodeModulesDir：从入口路径向上定位 node_modules', () => {
  // 真实形态：runtime/dsh/<version>/node_modules/@scope/pkg/lib/bin.js
  const entry = path.join('D:', 'u盘', 'runtime', 'dsh', '0.2.1-alpha.1', 'node_modules',
    '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.equal(
    findNodeModulesDir(entry),
    path.join('D:', 'u盘', 'runtime', 'dsh', '0.2.1-alpha.1', 'node_modules'),
  )

  // 已就在 node_modules 直下
  const shallow = path.join('D:', 'u盘', 'rt', 'node_modules', 'index.js')
  assert.equal(findNodeModulesDir(shallow), path.join('D:', 'u盘', 'rt', 'node_modules'))
})

test('findNodeModulesDir：路径里没有 node_modules 时返回 null（不猜、不抛错）', () => {
  // 这正是「用 current 目录去拼 node_modules」会踩的坑：current 下只有清单文件。
  const manifestDir = path.join('D:', 'u盘', 'runtime', 'dsh', 'current', 'nomad-runtime.json')
  assert.equal(findNodeModulesDir(manifestDir), null)
})

test('scanBrokenPackages：会递归进**嵌套 node_modules**（真实事故点）', () => {
  const modules = makeDir('nested-modules')
  // 好包 + 它内部嵌着的一个残缺包：npm 为冲突版本就地嵌套，那里同样会残缺。
  fs.mkdirSync(path.join(modules, 'good-parent', 'node_modules', '@scope', 'broken-inner', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(modules, 'good-parent', 'package.json'), '{}', 'utf8')

  assert.deepEqual(scanBrokenPackages(modules), [
    { name: 'good-parent/node_modules/@scope/broken-inner', contents: ['lib'] },
  ])
})

test('isForeignPlatformPackage：靠包名判定「本该不在本机出现」', () => {
  // 实测数据（2026-10-08）：npm install 后盘上缺 70 个包，全是 optional，
  // 但其中既有「本该缺席的别平台包」，也有「本该存在却缺席的平台匹配包」。
  // 所以判据不能只看 optional —— 必须看包名里的平台/架构 token。
  const win = ['win32', 'x64']
  const cases = [
    ['@img/sharp-win32-x64', false, '平台架构都匹配 → 必须有'],
    ['@img/sharp-darwin-arm64', true, 'darwin → 本机不需要'],
    ['@img/sharp-darwin-x64', true, 'darwin → 本机不需要'],
    ['@img/sharp-linux-x64', true, 'linux → 本机不需要'],
    ['@img/sharp-win32-arm64', true, '架构不符'],
    ['@img/sharp-win32-ia32', true, '架构不符'],
    ['@img/sharp-libvips-win32-x64', false, '名字带 libvips 但仍匹配'],
    ['sherpa-onnx-win-ia32', true, '平台 token 简写 win + 架构不符'],
    ['sherpa-onnx-linux-x64', true, 'linux'],
    ['koffi-openbsd-x64', true, 'openbsd'],
    ['node-addon-require-builtin-linux-arm64-musl', true, 'linux + musl'],
    ['node-addon-require-builtin-win32-x64-msvc', false, 'win32 x64，msvc 是 Windows 正常变体'],
    ['@deepseek-ai/libreoffice-kit-wasm', true, 'wasm 运行时'],
    ['@deepseek-ai/dsh-client-ui-sidebar-documentpreview', false, '纯 JS 包，无平台 token → 必须有'],
    ['@deepseek-ai/libreoffice-kit', false, '父包本身无平台 token → 必须有'],
    ['node-addon-require-builtin-win32-arm64-msvc', true, '架构不符'],
  ]
  for (const [name, expected, why] of cases) {
    assert.equal(
      isForeignPlatformPackage(name, win[0], win[1]),
      expected,
      `${name}（${why}）应为 ${String(expected)}`,
    )
  }

  // 换一台 linux 机器，同一批名字的判定要跟着翻过来 —— 判据是「与当前机不符」，不是白名单。
  assert.equal(isForeignPlatformPackage('@img/sharp-win32-x64', 'linux', 'x64'), true)
  assert.equal(isForeignPlatformPackage('@img/sharp-linux-x64', 'linux', 'x64'), false)
})

/**
 * 造一个「锁文件 + 磁盘」的对照现场。
 * @param {string} versionDir - 假版本目录
 * @param {object} packages - 锁文件 packages 表
 * @returns {void}
 */
function writeLockfile(versionDir, packages) {
  fs.mkdirSync(versionDir, { recursive: true })
  fs.writeFileSync(
    path.join(versionDir, 'package-lock.json'),
    `${JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'rt' }, ...packages } }, null, 2)}\n`,
    'utf8',
  )
}

test('scanMissingPackages：抓得住「整份缺失」—— 这正是目录遍历的盲区', () => {
  const versionDir = makeDir('lock-missing')
  // 装好的包
  fs.mkdirSync(path.join(versionDir, 'node_modules', 'present'), { recursive: true })
  fs.writeFileSync(path.join(versionDir, 'node_modules', 'present', 'package.json'), '{}', 'utf8')
  // 整份缺失（连目录都没有）
  // 半成品：有内容但没有 package.json
  fs.mkdirSync(path.join(versionDir, 'node_modules', 'half-baked', 'lib'), { recursive: true })
  // 别平台的 optional：缺席是正常的
  // 平台匹配的 optional：缺席是缺陷
  writeLockfile(versionDir, {
    'node_modules/present': { version: '1.0.0' },
    'node_modules/gone-entirely': { version: '1.0.0' },
    'node_modules/half-baked': { version: '1.0.0' },
    'node_modules/@img/sharp-darwin-x64': { version: '0.35.5', optional: true },
    'node_modules/@img/sharp-win32-x64': { version: '0.35.5', optional: true },
  })

  const missing = scanMissingPackages(versionDir)
  assert.deepEqual(missing.map((item) => item.name), [
    '@img/sharp-win32-x64',
    'gone-entirely',
    'half-baked',
  ])
  assert.equal(missing.find((item) => item.name === 'gone-entirely').reason, '目录不存在')
  assert.match(missing.find((item) => item.name === 'half-baked').reason, /有内容但缺 package\.json/)
  assert.equal(missing.find((item) => item.name === '@img/sharp-win32-x64').optional, true)
  assert.equal(countLockedPackages(versionDir), 5)
})

test('scanMissingPackages：无锁文件时返回 null（区别于「对账后无缺失」）', () => {
  const versionDir = makeDir('lock-absent')
  fs.mkdirSync(path.join(versionDir, 'node_modules'), { recursive: true })
  assert.equal(scanMissingPackages(versionDir), null)
  assert.equal(countLockedPackages(versionDir), 0)
})

test('scanMissingPackages：忽略 link 条目与嵌套键，lock 损坏时返回 null 而不抛错', () => {
  const versionDir = makeDir('lock-edge')
  writeLockfile(versionDir, {
    'node_modules/workspace-pkg': { link: true },
    'node_modules/parent/node_modules/child': { version: '1.0.0' },
  })
  // link 与嵌套键都不参与对账 → 没有缺失
  assert.deepEqual(scanMissingPackages(versionDir), [])

  const brokenLock = makeDir('lock-corrupt')
  fs.writeFileSync(path.join(brokenLock, 'package-lock.json'), '{ not json', 'utf8')
  assert.equal(scanMissingPackages(brokenLock), null)
})
