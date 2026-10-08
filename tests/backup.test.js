'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = fs

const { copyTree, createBackup, restoreBackup, EXCLUDE_DIRS } = require('../launcher/lib/backup.js')

function makeConfig(root) {
  return {
    paths: {
      root,
      dsh_home: path.join(root, 'data', 'dsh-home'),
      config: path.join(root, 'config'),
      backups: path.join(root, 'data', 'backups'),
    },
  }
}

function seedDshHome(root) {
  const base = path.join(root, 'data', 'dsh-home')
  const p = (...parts) => path.join(base, ...parts)
  mkdirSync(p('sessions', 'a'), { recursive: true })
  writeFileSync(p('sessions', 'a', 'session.jsonl'), 's1')
  mkdirSync(p('profiles', 'nomad'), { recursive: true })
  writeFileSync(p('profiles', 'nomad', 'package.json'), '{"x":1}')
  mkdirSync(p('tmp', 'should-skip'), { recursive: true })
  writeFileSync(p('tmp', 'should-skip', 'junk'), 'tmp')
  mkdirSync(p('run'), { recursive: true })
  writeFileSync(p('run', 'state.json'), 'run')
  return base
}

test('copyTree 复制文件并排除 tmp/run/node_modules', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-bk-'))
  const src = path.join(root, 'src')
  mkdirSync(path.join(src, 'keep'), { recursive: true })
  writeFileSync(path.join(src, 'keep', 'a.txt'), 'a')
  mkdirSync(path.join(src, 'tmp'), { recursive: true })
  writeFileSync(path.join(src, 'tmp', 'b.txt'), 'b')
  mkdirSync(path.join(src, 'node_modules', 'x'), { recursive: true })
  writeFileSync(path.join(src, 'node_modules', 'x', 'y.txt'), 'y')

  const dest = path.join(root, 'dest')
  const n = copyTree(src, dest, { exclude: EXCLUDE_DIRS })
  assert.strictEqual(n, 1) // 只有 keep/a.txt
  assert.ok(existsSync(path.join(dest, 'keep', 'a.txt')))
  assert.ok(!existsSync(path.join(dest, 'tmp', 'b.txt')))
  assert.ok(!existsSync(path.join(dest, 'node_modules', 'x', 'y.txt')))
})

test('copyTree 嵌套目录计数精确（防递归重复累加回归）', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-bk-'))
  const src = path.join(root, 'src')
  // 2 个目录各 3 个文件 = 6 个文件，验证 count 不被递归翻倍
  for (const d of ['a', 'b']) {
    const dir = path.join(src, d)
    mkdirSync(dir, { recursive: true })
    for (const f of ['1', '2', '3']) writeFileSync(path.join(dir, `${f}.txt`), f)
  }
  const dest = path.join(root, 'dest')
  const n = copyTree(src, dest, { exclude: EXCLUDE_DIRS })
  assert.strictEqual(n, 6)
})

test('createBackup 备份 dsh_home 并写清单，排除 tmp/run', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-bk-'))
  seedDshHome(root)
  const config = makeConfig(root)
  const to = path.join(root, 'data', 'backups', 'test-bk')
  const result = createBackup(root, config, { to })
  assert.strictEqual(result.manifest.items.length, 1)
  const item = result.manifest.items[0]
  assert.strictEqual(item.relPath, path.join('data', 'dsh-home'))
  // 精确计数（非 >=）：防止递归累计被重复加导致的计数膨胀回归
  assert.strictEqual(item.files, 2)
  // 备份里不应含 tmp / run
  assert.ok(existsSync(path.join(to, 'data', 'dsh-home', 'sessions', 'a', 'session.jsonl')))
  assert.ok(!existsSync(path.join(to, 'data', 'dsh-home', 'tmp')))
  assert.ok(!existsSync(path.join(to, 'data', 'dsh-home', 'run')))
  assert.ok(existsSync(path.join(to, 'backup-manifest.json')))
})

test('createBackup --include-config 额外备份 config 目录', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-bk-'))
  seedDshHome(root)
  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(path.join(root, 'config', 'nomad.yaml'), 'x: 1')
  const config = makeConfig(root)
  const to = path.join(root, 'data', 'backups', 'test-bk2')
  const result = createBackup(root, config, { to, includeConfig: true })
  assert.strictEqual(result.manifest.items.length, 2)
  assert.ok(existsSync(path.join(to, 'config', 'nomad.yaml')))
})

test('restoreBackup 合并复制：回放文件，且不删除目标多余文件', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-bk-'))
  seedDshHome(root)
  const config = makeConfig(root)
  const to = path.join(root, 'data', 'backups', 'test-bk3')
  createBackup(root, config, { to })

  // 改动源，并加一个"目标多余"文件，验证恢复不会删它
  writeFileSync(path.join(root, 'data', 'dsh-home', 'sessions', 'a', 'session.jsonl'), 's1-CHANGED')
  writeFileSync(path.join(root, 'data', 'dsh-home', 'profiles', 'nomad', 'extra.json'), 'extra-KEEP')

  const r = restoreBackup(root, config, to)
  assert.ok(r.restored >= 2)
  // 备份里没有 extra.json，但目标原有 extra.json 应保留（合并语义）
  assert.strictEqual(readFileSync(path.join(root, 'data', 'dsh-home', 'sessions', 'a', 'session.jsonl'), 'utf8'), 's1')
  assert.ok(existsSync(path.join(root, 'data', 'dsh-home', 'profiles', 'nomad', 'extra.json')))
})
