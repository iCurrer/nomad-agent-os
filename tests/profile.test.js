'use strict'

/**
 * `launcher/lib/profile.js` 单元测试 —— profile 自举的纯逻辑面。
 *
 * 覆盖：
 *   - profile 名守卫（与上游 `resolveProfileDir` / 保留名守卫对齐）
 *   - 落点解析与 bundle spec 相对路径计算（零物化的前提）
 *   - 幂等 ensure：创建 / 补正 / 不动已有内容
 *   - bundle 源合法性（`dsh.bundle.patch`）
 *   - 逃生舱 ensure_profile = false
 *   - 越界拒绝（宿主绝对路径 / 逃出 NOMAD_ROOT）
 *
 * 不覆盖（属真实引擎面，见 tests/smoke/nomad-profile-smoke.js）：
 *   - 生成的 profile 能否被真实 DSH 加载并渲染 Web UI
 *   - 我们的模板正文与上游 `initProfile` 产物是否逐字一致
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ensureNomadProfile,
  inspectNomadProfile,
  resolveNomadProfile,
  validateProfileName,
  validateBundleSource,
  PROFILE_ROOT_CONFIG,
  PROFILE_PATCH_TEMPLATE,
  PROFILE_PNPM_WORKSPACE,
} = require('../launcher/lib/profile.js')

/** 仓库根（本文件在 tests/ 下）。 */
const REPO_ROOT = path.resolve(__dirname, '..')

/**
 * 造一个临时 NOMAD_ROOT。
 * @returns {string} 绝对路径
 */
function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-profile-'))
}

/**
 * 造一个最小可用配置对象（绕过 loadConfig，保持测试隔离）。
 * @param {string} root - NOMAD_ROOT
 * @param {object} [overrides] - runtime.dsh 覆盖项
 * @returns {object} 配置
 */
function makeConfig(root, overrides = {}) {
  return {
    paths: { dsh_home: path.join(root, 'data', 'dsh-home') },
    runtime: {
      dsh: {
        profile: 'nomad',
        profile_template: 'web',
        ensure_profile: true,
        bundle_source: 'packages/nomad-web-app',
        ...overrides,
      },
    },
  }
}

/**
 * 造一个合法的自研 bundle 源。
 * @param {string} root - NOMAD_ROOT
 * @param {(manifest: object, dir: string) => void} [mutate] - 写盘**前**的清单篡改钩子
 * @param {(dir: string) => void} [after] - 写盘**后**的文件系统篡改钩子
 * @returns {string} bundle 源目录
 */
function makeBundleSource(root, mutate, after) {
  const dir = path.join(root, 'packages', 'nomad-web-app')
  fs.mkdirSync(dir, { recursive: true })
  const manifest = {
    name: '@nomad/nomad-web-app',
    version: '0.0.1',
    private: true,
    dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
  }
  if (typeof mutate === 'function') mutate(manifest, dir)
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  if (!fs.existsSync(path.join(dir, 'cordis.patch.yml'))) {
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: nomad\n      group: true\n', 'utf8')
  }
  if (typeof after === 'function') after(dir)
  return dir
}

/**
 * 读 profile 清单。
 * @param {object} spec - resolveNomadProfile 的返回值
 * @returns {object} 清单
 */
function readManifest(spec) {
  return JSON.parse(fs.readFileSync(spec.manifestPath, 'utf8'))
}

test('validateProfileName：接受普通名，拒绝路径形态与上游保留名', () => {
  assert.equal(validateProfileName('nomad'), 'nomad')
  assert.equal(validateProfileName('nomad-dev'), 'nomad-dev')

  for (const bad of ['', '.', '..', 'node_modules', 'a/b', 'a\\b']) {
    assert.throws(() => validateProfileName(bad), /profile:/, `应拒绝 ${JSON.stringify(bad)}`)
  }
  // 上游内置名是保留名，不可作为自建目标（dsh-app-boot/lib/index.js:146）
  for (const shipped of ['acp', 'web', 'headless', 'sdk', 'sdk-minimal']) {
    assert.throws(() => validateProfileName(shipped), /内置 profile 名/, `应拒绝保留名 ${shipped}`)
  }
  assert.throws(() => validateProfileName(undefined), /非空字符串/)
})

test('resolveNomadProfile：落点全部在盘内，bundle spec 为相对的 POSIX 路径', () => {
  const root = makeRoot()
  makeBundleSource(root)
  const spec = resolveNomadProfile({ root, config: makeConfig(root) })

  assert.equal(spec.name, 'nomad')
  assert.equal(spec.template, 'web')
  assert.deepEqual(spec.templateBundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.equal(spec.dir, path.join(root, 'data', 'dsh-home', 'profiles', 'nomad'))
  assert.equal(spec.manifestPath, path.join(spec.dir, 'package.json'))
  assert.equal(spec.patchPath, path.join(spec.dir, 'cordis.patch.yml'))
  assert.equal(spec.workspacePath, path.join(spec.dir, 'pnpm-workspace.yaml'))
  assert.equal(spec.rootConfigPath, path.join(spec.dir, 'cordis.yml'))

  // 关键性质：spec 必须能解析回 bundle 源本身（零物化方案的正确性前提）
  assert.equal(spec.bundleSpec.split('/').includes('\\'), false, 'spec 必须是 POSIX 分隔符')
  assert.equal(path.resolve(spec.dir, spec.bundleSpec), spec.bundleSourceDir)
  assert.ok(spec.bundleSpec.startsWith('..'), `相对深度应当向上跳：${spec.bundleSpec}`)
})

test('resolveNomadProfile：拒绝越界与非法模板', () => {
  const root = makeRoot()
  // 宿主绝对路径
  assert.throws(
    () => resolveNomadProfile({ root, config: makeConfig(root, { bundle_source: 'D:\\evil' }) }),
    /禁止宿主绝对路径/,
  )
  // 逃出 NOMAD_ROOT
  assert.throws(
    () => resolveNomadProfile({ root, config: makeConfig(root, { bundle_source: '../../outside' }) }),
    /越出 NOMAD_ROOT/,
  )
  // 模板名必须是上游内置名
  assert.throws(
    () => resolveNomadProfile({ root, config: makeConfig(root, { profile_template: 'nope' }) }),
    /内置模板名/,
  )
})

test('ensureNomadProfile：首次创建 —— 模板 bundles + 自研层在末位，形状与上游一致', () => {
  const root = makeRoot()
  makeBundleSource(root)
  const config = makeConfig(root)
  const spec = resolveNomadProfile({ root, config })

  const result = ensureNomadProfile({ root, config })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'created')

  const manifest = readManifest(spec)
  assert.equal(manifest.name, 'dsh-profile-nomad', '命名约定取自上游 initProfile（dsh-profile-<basename>）')
  assert.equal(manifest.private, true)
  assert.deepEqual(manifest.dependencies, {})
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    spec.bundleSpec,
  ])

  // 行尾与缩进必须与上游 writeProfileManifest 一致（JSON.stringify(…, undefined, 2) + "\n"）
  const raw = fs.readFileSync(spec.manifestPath, 'utf8')
  assert.equal(raw, `${JSON.stringify(manifest, undefined, 2)}\n`)

  assert.ok(fs.existsSync(spec.patchPath), '补丁层应被创建')
  assert.ok(fs.existsSync(spec.workspacePath), 'pnpm 设置应被创建')
  assert.ok(fs.existsSync(spec.rootConfigPath), '根配置应被创建')
  assert.ok(result.created.includes(spec.manifestPath))
})

test('ensureNomadProfile：幂等 —— 连跑两次第二次为 unchanged', () => {
  const root = makeRoot()
  makeBundleSource(root)
  const config = makeConfig(root)
  const spec = resolveNomadProfile({ root, config })

  ensureNomadProfile({ root, config })
  const before = fs.readFileSync(spec.manifestPath, 'utf8')

  const second = ensureNomadProfile({ root, config })
  assert.equal(second.action, 'unchanged')
  assert.equal(second.ok, true)
  assert.equal(fs.readFileSync(spec.manifestPath, 'utf8'), before, '幂等：字节不应变化')
})

test('ensureNomadProfile：补正 —— 自研层不在末位时移到末位，其余 bundle 与键原样保留', () => {
  const root = makeRoot()
  makeBundleSource(root)
  const config = makeConfig(root)
  const spec = resolveNomadProfile({ root, config })

  // 造一个「自研层被夹在中间 + 带自定义键 + 带多余 bundle」的清单
  fs.mkdirSync(spec.dir, { recursive: true })
  fs.writeFileSync(spec.manifestPath, `${JSON.stringify({
    name: 'dsh-profile-nomad',
    private: true,
    dependencies: {},
    customField: { keep: 'me' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', spec.bundleSpec, '@deepseek-ai/dsh-web-app'],
        extra: 'keep-me-too',
      },
    },
  }, undefined, 2)}\n`, 'utf8')

  const result = ensureNomadProfile({ root, config })
  assert.equal(result.action, 'updated')

  const manifest = readManifest(spec)
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    spec.bundleSpec,
  ], '自研层必须落到末位')
  assert.equal(manifest.dsh.profile.extra, 'keep-me-too', 'profile 其余键不得被冲掉')
  assert.deepEqual(manifest.customField, { keep: 'me' }, '清单其余顶层键不得被冲掉')
})

test('ensureNomadProfile：绝不覆盖已存在的补丁层（用户改过的东西不动）', () => {
  const root = makeRoot()
  makeBundleSource(root)
  const config = makeConfig(root)
  const spec = resolveNomadProfile({ root, config })

  fs.mkdirSync(spec.dir, { recursive: true })
  fs.writeFileSync(spec.patchPath, '# 用户自己写的补丁层\n- id: system-prompt\n', 'utf8')

  ensureNomadProfile({ root, config })
  assert.equal(
    fs.readFileSync(spec.patchPath, 'utf8'),
    '# 用户自己写的补丁层\n- id: system-prompt\n',
    '已存在的 cordis.patch.yml 必须原样保留（与上游 initProfile 的 existsSync 守卫同姿态）',
  )
})

test('ensureNomadProfile：bundle 源非法时失败，且不做任何写入', () => {
  const cases = [
    ['缺 package.json', undefined, (dir) => { fs.rmSync(path.join(dir, 'package.json'), { force: true }) }, /缺少清单/],
    ['无 dsh.bundle.patch', (manifest) => { delete manifest.dsh }, undefined, /未声明 dsh\.bundle\.patch/],
    ['patch 为空数组', (manifest) => { manifest.dsh.bundle.patch = [] }, undefined, /未声明 dsh\.bundle\.patch/],
    ['patch 指向不存在的文件', (manifest) => { manifest.dsh.bundle.patch = ['./nope.yml'] }, undefined, /补丁文件不存在/],
  ]
  for (const [label, mutate, after, pattern] of cases) {
    const root = makeRoot()
    makeBundleSource(root, mutate, after)
    const config = makeConfig(root)
    const spec = resolveNomadProfile({ root, config })

    const result = ensureNomadProfile({ root, config })
    assert.equal(result.ok, false, `${label}：应当失败`)
    assert.match(result.error, pattern, `${label}：错误信息应指明原因`)
    assert.equal(fs.existsSync(spec.manifestPath), false, `${label}：失败时不得留下半成品 profile`)
  }
})

test('ensureNomadProfile：ensure_profile = false 时跳过（逃生舱）', () => {
  const root = makeRoot()
  makeBundleSource(root)
  const config = makeConfig(root, { ensure_profile: false })
  const spec = resolveNomadProfile({ root, config })

  const result = ensureNomadProfile({ root, config })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'skipped')
  assert.equal(fs.existsSync(spec.manifestPath), false, '跳过时不得创建 profile')
})

test('inspectNomadProfile：只读 —— 对不存在的 profile 不产生任何文件', () => {
  const root = makeRoot()
  makeBundleSource(root)
  const config = makeConfig(root)
  const spec = resolveNomadProfile({ root, config })

  const info = inspectNomadProfile({ root, config })
  assert.equal(info.exists, false)
  assert.equal(info.bundleSource.ok, true)
  assert.equal(info.bundleLast, false)
  assert.equal(fs.existsSync(spec.dir), false, '巡检不得创建目录或文件')

  ensureNomadProfile({ root, config })
  const after = inspectNomadProfile({ root, config })
  assert.equal(after.exists, true)
  assert.equal(after.manifestValid, true)
  assert.equal(after.bundleIncluded, true)
  assert.equal(after.bundleLast, true)
  assert.equal(after.patchExists, true)
  assert.equal(after.workspaceExists, true)
  assert.deepEqual(after.problems, [])
})

test('inspectNomadProfile：清单损坏时给出问题而非抛错', () => {
  const root = makeRoot()
  makeBundleSource(root)
  const config = makeConfig(root)
  const spec = resolveNomadProfile({ root, config })

  fs.mkdirSync(spec.dir, { recursive: true })
  fs.writeFileSync(spec.manifestPath, '{ 这不是 JSON', 'utf8')

  const info = inspectNomadProfile({ root, config })
  assert.equal(info.exists, true)
  assert.equal(info.manifestValid, false)
  assert.equal(info.problems.some((line) => line.includes('不可解析')), true)
})

test('仓库内真实的 packages/nomad-web-app 必须是合法 bundle 源', () => {
  const dir = path.join(REPO_ROOT, 'packages', 'nomad-web-app')
  const result = validateBundleSource(dir)
  assert.equal(result.ok, true, result.error ?? '')
  assert.equal(result.name, '@nomad/nomad-web-app')
  assert.deepEqual(result.patches, ['./cordis.patch.yml'], '声明了 dsh.bundle.patch → 才是一个 bundle')
})

test('模板正文与上游原文逐字一致（本地漂移守卫；上游漂移由真实冒烟测守卫）', () => {
  // 这三段抄自 dsh-app-boot/lib/index.js:563-573 与 profile-boot-*.js:121-125。
  // 若上游改了模板，tests/smoke/nomad-profile-smoke.js 会与上游实际产物比对并失败。
  assert.equal(PROFILE_ROOT_CONFIG, `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`)
  assert.equal(PROFILE_PATCH_TEMPLATE, `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`)
  assert.equal(PROFILE_PNPM_WORKSPACE, `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`)
})
