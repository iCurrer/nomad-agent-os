'use strict'

/**
 * Phase 3.3 数据面管理单测 —— storageReport / planClean / clean / dataSummary。
 *
 * fixture：临时 root + data/tmp 与 data/dsh-home/tmp 白名单目录。
 * 只测 launcher 侧纯函数，不碰真实 NOMAD_ROOT 的 data/。
 * 安全验收核心：白名单外路径（sessions 等）绝不出现在清理目标里。
 */

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } = fs

const {
  storageReport,
  planClean,
  clean,
  dataSummary,
  humanBytes,
  CLEAN_WHITELIST,
} = require('../launcher/lib/dataman.js')

function makeRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'nomad-data-'))
}

function makeConfig(root) {
  return { paths: { root, data: path.join(root, 'data'), dsh_home: path.join(root, 'data', 'dsh-home') } }
}

/** 把条目 mtime 拨回 minutesAgo 分钟前。 */
function age(target, minutesAgo) {
  const past = new Date(Date.now() - minutesAgo * 60 * 1000)
  utimesSync(target, past, past)
}

test('storageReport：三档归类正确，可清理合计等于白名单之和', () => {
  const root = makeRoot()
  const config = makeConfig(root)

  // 长期
  mkdirSync(path.join(root, 'data', 'dsh-home', 'sessions'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'dsh-home', 'sessions', 's1.jsonl.zstd'), 'x'.repeat(100))
  // 可清理
  mkdirSync(path.join(root, 'data', 'tmp', 'dsh-acl-skill-AAA'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'tmp', 'dsh-acl-skill-AAA', 'a.txt'), 'y'.repeat(50))
  mkdirSync(path.join(root, 'data', 'dsh-home', 'tmp'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'dsh-home', 'tmp', 'dsh-spill-1'), 'z'.repeat(10))
  // 轮转
  mkdirSync(path.join(root, 'data', 'logs'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'logs', 'host.log'), 'l')

  const report = storageReport({ config })
  const byRel = new Map(report.entries.map((e) => [e.rel, e]))
  assert.strictEqual(byRel.get('data/dsh-home/sessions').category, 'long-term')
  assert.strictEqual(byRel.get('data/tmp').category, 'cleanable')
  assert.strictEqual(byRel.get('data/dsh-home/tmp').category, 'cleanable')
  assert.strictEqual(byRel.get('data/logs').category, 'rotate')

  assert.strictEqual(report.cleanableBytes, 60)
  assert.strictEqual(report.cleanableFiles, 2)
  assert.ok(report.human.cleanable.length > 0)

  // dsh-home 拆分展示：不含 tmp 的长期部分
  const split = byRel.get('data/dsh-home（不含 tmp）')
  assert.ok(split && split.bytes >= 100)
})

test('storageReport：data 下未知目录归入 other（供人工确认）', () => {
  const root = makeRoot()
  const config = makeConfig(root)
  mkdirSync(path.join(root, 'data', 'mystery'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'mystery', 'x.bin'), '?')

  const report = storageReport({ config })
  const mystery = report.entries.find((e) => e.rel === 'data/mystery')
  assert.ok(mystery)
  assert.strictEqual(mystery.category, 'other')
})

test('planClean：陈旧条目入选、新鲜条目整条跳过（时间规则）', () => {
  const root = makeRoot()
  const config = makeConfig(root)
  const tmp = path.join(root, 'data', 'tmp')

  const oldDir = path.join(tmp, 'dsh-acl-skill-OLD')
  mkdirSync(path.join(oldDir, 'inner'), { recursive: true })
  writeFileSync(path.join(oldDir, 'inner', 'deep.txt'), 'o')
  age(oldDir, 180) // 3 小时前
  age(path.join(oldDir, 'inner'), 180) // 父目录时间也被写文件刷新过，一并拨旧
  age(path.join(oldDir, 'inner', 'deep.txt'), 180) // 内层文件同样拨旧（整条目递归 mtime 才是判据）

  const freshDir = path.join(tmp, 'dsh-acl-skill-FRESH')
  mkdirSync(freshDir, { recursive: true })
  writeFileSync(path.join(freshDir, 'a.txt'), 'f')
  age(freshDir, 180)
  // 目录内最后一个文件是新的 → 整条目（含目录本身）都算在用
  writeFileSync(path.join(freshDir, 'b.txt'), 'f')

  const oldFile = path.join(tmp, 'commit-msg.txt')
  writeFileSync(oldFile, 'o')
  age(oldFile, 180)

  const plan = planClean({ config }, { minAgeMs: 120 * 60 * 1000 })
  const targetRels = plan.targets.map((t) => t.rel)
  assert.ok(targetRels.includes('data/tmp/dsh-acl-skill-OLD'))
  assert.ok(targetRels.includes('data/tmp/commit-msg.txt'))
  assert.ok(!targetRels.some((r) => r.includes('FRESH')), '新鲜条目必须跳过')
  const skippedFresh = plan.skipped.find((s) => s.rel.includes('FRESH'))
  assert.ok(skippedFresh && /在用/.test(skippedFresh.reason))
})

test('clean：dry-run 不删，实际删后白名单目录被补回，白名单外绝不动', () => {
  const root = makeRoot()
  const config = makeConfig(root)
  const tmp = path.join(root, 'data', 'tmp')

  const stale = path.join(tmp, 'test-runtime-X')
  mkdirSync(stale, { recursive: true })
  writeFileSync(path.join(stale, 'a.txt'), 'a'.repeat(300))
  age(stale, 300)

  // 白名单外的「同形」目录：即使名字像可清理物也绝不能删
  const forbidden = path.join(root, 'data', 'dsh-home', 'sessions', 'dsh-acl-skill-IMPOSTOR')
  mkdirSync(forbidden, { recursive: true })
  writeFileSync(path.join(forbidden, 's.jsonl.zstd'), 's')

  const dry = clean({ config }, { dryRun: true, minAgeMs: 0 })
  assert.strictEqual(dry.targets.length, 1)
  assert.ok(existsSync(stale), 'dry-run 不删')

  const real = clean({ config }, { minAgeMs: 0 })
  assert.strictEqual(real.freedFiles, 1)
  assert.strictEqual(real.failures.length, 0)
  assert.ok(!existsSync(stale), '实际清理删除条目')
  assert.ok(existsSync(tmp), '白名单目录本体补回')
  assert.ok(existsSync(path.join(forbidden, 's.jsonl.zstd')), 'sessions 内容分毫不动')
})

test('dataSummary：只汇总白名单体积/文件数', () => {
  const root = makeRoot()
  const config = makeConfig(root)
  mkdirSync(path.join(root, 'data', 'tmp', 'q'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'tmp', 'q', 'a.txt'), '12345')
  mkdirSync(path.join(root, 'data', 'dsh-home', 'tmp'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'dsh-home', 'tmp', 'b.txt'), '12')

  const summary = dataSummary({ config })
  assert.strictEqual(summary.tmpFiles, 2)
  assert.strictEqual(summary.tmpBytes, 7)
  assert.ok(summary.human.includes('B'))
})

test('CLEAN_WHITELIST 冻结且只含两个 tmp 目录（安全底线自检）', () => {
  assert.deepStrictEqual([...CLEAN_WHITELIST].sort(), ['data/dsh-home/tmp', 'data/tmp'])
  assert.ok(Object.isFrozen(CLEAN_WHITELIST))
})

test('humanBytes：三档单位', () => {
  assert.strictEqual(humanBytes(5), '5 B')
  assert.strictEqual(humanBytes(2048), '2.0 KB')
  assert.strictEqual(humanBytes(3 * 1024 * 1024), '3.0 MB')
})
