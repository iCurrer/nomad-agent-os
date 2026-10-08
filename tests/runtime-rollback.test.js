'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mkdtempSync, mkdirSync, writeFileSync } = fs

const {
  computeRollback,
  applyRollback,
  listDshVersions,
  readCurrentManifest,
  DSH_ENTRY_RELATIVE,
} = require('../launcher/lib/runtime-rollback.js')

function makeConfig(root) {
  return { runtime: { dsh: { current: 'runtime/dsh/current' } }, paths: { root } }
}

function scaffold(root, versions, currentVersion) {
  for (const v of versions) {
    const bin = path.join(root, 'runtime', 'dsh', v, DSH_ENTRY_RELATIVE)
    mkdirSync(path.dirname(bin), { recursive: true })
    writeFileSync(bin, '// entry stub')
  }
  const manifest = {
    name: '@deepseek-ai/dsh',
    version: currentVersion,
    entry: `../${currentVersion}/${DSH_ENTRY_RELATIVE}`,
    profile: 'nomad',
    app_args: ['--flag'],
    _comment: 'test',
  }
  const file = path.join(root, 'runtime', 'dsh', 'current', 'nomad-runtime.json')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(manifest, null, 2))
  return manifest
}

test('listDshVersions 排除 current 并按名排序', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-rollback-'))
  scaffold(root, ['0.2.0', '0.2.1-alpha.1', '0.1.9'], '0.2.1-alpha.1')
  const versions = listDshVersions(root, makeConfig(root))
  assert.deepStrictEqual(versions, ['0.1.9', '0.2.0', '0.2.1-alpha.1'])
})

test('computeRollback 改写 version/entry 并保留其余字段', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-rollback-'))
  const manifest = scaffold(root, ['0.2.0', '0.2.1-alpha.1'], '0.2.1-alpha.1')
  const { manifest: next, entry, version } = computeRollback(
    manifest, '0.2.0', ['0.2.0', '0.2.1-alpha.1'], root, makeConfig(root),
  )
  assert.strictEqual(version, '0.2.0')
  assert.strictEqual(entry, '../0.2.0/node_modules/@deepseek-ai/dsh/lib/bin.js')
  assert.strictEqual(next.name, '@deepseek-ai/dsh')
  assert.strictEqual(next.profile, 'nomad')
  assert.deepStrictEqual(next.app_args, ['--flag'])
  assert.strictEqual(next._comment, 'test')
})

test('computeRollback 目标版本未安装则抛错', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-rollback-'))
  const manifest = scaffold(root, ['0.2.1-alpha.1'], '0.2.1-alpha.1')
  assert.throws(
    () => computeRollback(manifest, '9.9.9', ['0.2.1-alpha.1'], root, makeConfig(root)),
    /未安装/,
  )
})

test('computeRollback 目标入口不存在则抛错', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-rollback-'))
  // 只 scaffold 当前版本，目标版本目录缺失
  const manifest = scaffold(root, ['0.2.1-alpha.1'], '0.2.1-alpha.1')
  assert.throws(
    () => computeRollback(manifest, '0.2.0', ['0.2.0', '0.2.1-alpha.1'], root, makeConfig(root)),
    /入口不存在/,
  )
})

test('applyRollback 写回 current 指针并改 version', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-rollback-'))
  scaffold(root, ['0.2.0', '0.2.1-alpha.1'], '0.2.1-alpha.1')
  const result = applyRollback(root, makeConfig(root), '0.2.0')
  assert.strictEqual(result.from, '0.2.1-alpha.1')
  assert.strictEqual(result.to, '0.2.0')
  const { manifest } = readCurrentManifest(root, makeConfig(root))
  assert.strictEqual(manifest.version, '0.2.0')
  assert.strictEqual(manifest.entry, '../0.2.0/node_modules/@deepseek-ai/dsh/lib/bin.js')
})
