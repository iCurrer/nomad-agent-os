'use strict'

/**
 * Phase 3.1 Profiles 管理器单测 —— validateProfileDir / listProfiles / createProfile。
 *
 * fixture 形状与 projects.test.js 同款：临时 root + `data/dsh-home/profiles/<name>/`。
 * 只测 launcher 侧纯函数，不碰真实 DSH_HOME。
 */

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = fs

const {
  validateProfileDir,
  listProfiles,
  createProfile,
  SHIPPED_PROFILES,
  PROFILE_PATCH_FILENAME,
  PROFILE_ROOT_FILENAME,
} = require('../launcher/lib/profile.js')

function makeRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'nomad-prof-'))
}

function makeConfig(root, profileName) {
  return {
    paths: { root, dsh_home: path.join(root, 'data', 'dsh-home') },
    runtime: { dsh: { profile: profileName ?? 'nomad' } },
  }
}

/** 写一个最小合法 profile（4 文件，bundles 取自内置模板）。 */
function writeProfile(root, name, { template = 'web', patch = null, manifest = null, omit = [] } = {}) {
  const dir = path.join(root, 'data', 'dsh-home', 'profiles', name)
  mkdirSync(dir, { recursive: true })
  if (!omit.includes('package.json')) {
    writeFileSync(
      path.join(dir, 'package.json'),
      manifest ?? `${JSON.stringify({
        name: `dsh-profile-${name}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...SHIPPED_PROFILES[template]] } },
      }, undefined, 2)}\n`,
    )
  }
  if (!omit.includes(PROFILE_PATCH_FILENAME)) {
    writeFileSync(path.join(dir, PROFILE_PATCH_FILENAME), patch ?? '[]\n')
  }
  if (!omit.includes(PROFILE_ROOT_FILENAME)) {
    writeFileSync(path.join(dir, PROFILE_ROOT_FILENAME), '[]\n')
  }
  if (!omit.includes('pnpm-workspace.yaml')) {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\n')
  }
  return dir
}

test('validateProfileDir：合法 profile 零问题，bundles 正确提取', () => {
  const root = makeRoot()
  const dir = writeProfile(root, 'alpha', { template: 'headless' })
  const check = validateProfileDir(dir)
  assert.strictEqual(check.exists, true)
  assert.strictEqual(check.manifestValid, true)
  assert.deepStrictEqual(check.bundles, SHIPPED_PROFILES.headless)
  assert.deepStrictEqual(check.problems, [])
})

test('validateProfileDir：坏 JSON / 缺 bundles / 相对路径 bundle 缺失 各自报问题', () => {
  const root = makeRoot()
  // ① 清单不可解析
  const badJson = writeProfile(root, 'bad-json', { manifest: '{not json' })
  const r1 = validateProfileDir(badJson)
  assert.strictEqual(r1.manifestValid, false)
  assert.ok(r1.problems.some((p) => p.includes('package.json 不可解析')))

  // ② 合法 JSON 但缺 dsh.profile.bundles
  const noBundles = writeProfile(root, 'no-bundles', {
    manifest: JSON.stringify({ name: 'x', private: true }),
  })
  const r2 = validateProfileDir(noBundles)
  assert.ok(r2.problems.some((p) => p.includes('dsh.profile.bundles')))

  // ③ 显式相对路径 bundle 指向不存在目录（scoped npm 名含 / 不做存在性检查）
  const dir = path.join(root, 'data', 'dsh-home', 'profiles', 'bad-rel')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'x',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '../no-such-bundle'] } },
  }))
  writeFileSync(path.join(dir, PROFILE_PATCH_FILENAME), '[]\n')
  const r3 = validateProfileDir(dir)
  assert.ok(r3.problems.some((p) => p.includes('bundle 相对路径不存在') && p.includes('no-such-bundle')))
  assert.ok(!r3.problems.some((p) => p.includes('dsh-base'))) // 包名不做存在性检查
})

test('validateProfileDir：patch 顶层数组 / 不可解析 YAML 报问题；缺失不报', () => {
  const root = makeRoot()
  const badPatch = writeProfile(root, 'bad-patch', { patch: 'name: cordis:group\n' }) // 对象而非数组
  const r1 = validateProfileDir(badPatch)
  assert.ok(r1.problems.some((p) => p.includes('顶层必须是数组')))

  const noPatch = writeProfile(root, 'no-patch', { omit: [PROFILE_PATCH_FILENAME] })
  assert.deepStrictEqual(validateProfileDir(noPatch).problems, []) // 缺失 = start/init 会补

  const dir = path.join(root, 'data', 'dsh-home', 'profiles', 'unparseable')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['x'] } } }))
  writeFileSync(path.join(dir, PROFILE_PATCH_FILENAME), '\t- [broken')
  const r2 = validateProfileDir(dir)
  assert.ok(r2.problems.some((p) => p.includes(`${PROFILE_PATCH_FILENAME} 不可解析`)))
})

test('validateProfileDir：目录不存在直接返回 exists=false', () => {
  const root = makeRoot()
  const check = validateProfileDir(path.join(root, 'data', 'dsh-home', 'profiles', 'ghost'))
  assert.strictEqual(check.exists, false)
  assert.deepStrictEqual(check.problems, ['目录不存在'])
})

test('listProfiles：字母序列出，default 打标，reserved 列内置模板名', () => {
  const root = makeRoot()
  writeProfile(root, 'zeta')
  writeProfile(root, 'nomad')
  writeProfile(root, 'alpha')
  const scan = listProfiles({ config: makeConfig(root, 'nomad') })
  assert.deepStrictEqual(scan.profiles.map((p) => p.name), ['alpha', 'nomad', 'zeta'])
  assert.deepStrictEqual(scan.profiles.map((p) => p.kind), ['user', 'default', 'user'])
  assert.ok(scan.reserved.includes('web') && scan.reserved.includes('headless'))
  assert.ok(scan.profiles.every((p) => p.problems.length === 0))
})

test('listProfiles：profiles 目录缺失 → 空列表不抛错', () => {
  const root = makeRoot()
  const scan = listProfiles({ config: makeConfig(root) })
  assert.deepStrictEqual(scan.profiles, [])
  assert.strictEqual(scan.defaultName, 'nomad')
})

test('listProfiles：坏 profile 带问题列表进入结果（不抛错不剔除）', () => {
  const root = makeRoot()
  writeProfile(root, 'good')
  writeProfile(root, 'broken', { manifest: '{oops' })
  const scan = listProfiles({ config: makeConfig(root) })
  assert.strictEqual(scan.profiles.length, 2)
  const broken = scan.profiles.find((p) => p.name === 'broken')
  assert.ok(broken.problems.length > 0)
})

test('createProfile：按模板生成 4 文件，bundles 与模板一致', () => {
  const root = makeRoot()
  const result = createProfile({ root, config: makeConfig(root) }, 'helper', 'headless')
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.bundles, SHIPPED_PROFILES.headless)
  assert.strictEqual(result.created.length, 4)
  for (const file of result.created) assert.ok(existsSync(file))
  const manifest = JSON.parse(readFileSync(path.join(result.dir, 'package.json'), 'utf8'))
  assert.deepStrictEqual(manifest.dsh.profile.bundles, SHIPPED_PROFILES.headless)
  // 创建后立即可被 listProfiles 读到且有效
  const scan = listProfiles({ config: makeConfig(root) })
  const item = scan.profiles.find((p) => p.name === 'helper')
  assert.ok(item !== undefined && item.problems.length === 0)
})

test('createProfile：已存在拒绝（绝不覆盖）、保留名拒绝、坏模板拒绝、路径分隔符拒绝', () => {
  const root = makeRoot()
  const config = makeConfig(root)
  writeProfile(root, 'exists')
  const r1 = createProfile({ root, config }, 'exists')
  assert.strictEqual(r1.ok, false)
  assert.ok(r1.error.includes('绝不覆盖'))

  const r2 = createProfile({ root, config }, 'web')
  assert.strictEqual(r2.ok, false)
  assert.ok(r2.error.includes('保留'))

  const r3 = createProfile({ root, config }, 'anything', 'not-a-template')
  assert.strictEqual(r3.ok, false)
  assert.ok(r3.error.includes('模板必须是上游内置名'))

  const r4 = createProfile({ root, config }, 'a/b')
  assert.strictEqual(r4.ok, false)
  assert.ok(r4.error.includes('路径分隔符'))
})
