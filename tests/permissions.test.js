/**
 * tests/permissions.test.js — 权限模板加载 / 校验 / never 自证的单元测试。
 *
 * 覆盖：
 * - 合法模板解析（levels 8 类齐、never 6 条、profiles 3 档）
 * - 非法值拒绝：未知类别 / 未知取值 / 未知 never id / 重复 never / 敏感类别提升为 allow
 * - levels 缺类别 / deny_patterns 非法 / 文件缺失 / 顶层非映射
 * - summarizeLevels 摘要
 * - selfCheckNever：隔离生效 → 机械条目 ok；隔离关闭 → 失去支撑；契约级条目 verifiable=false
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadPermissions, summarizeLevels, selfCheckNever, NEVER_IDS } = require('../launcher/lib/permissions.js')

const VALID_YAML = [
  'levels:',
  '  read:',
  '    default: allow',
  '  write:',
  '    default: workspace',
  '  execute:',
  '    default: allow',
  '    deny_patterns:',
  '      - "rm -rf /"',
  '  network:',
  '    default: ask',
  '  sensitive:',
  '    default: ask',
  '  external_upload:',
  '    default: ask',
  '  git_push:',
  '    default: ask',
  '  production_deploy:',
  '    default: ask',
  'never:',
  '  - modify_system_env',
  '  - modify_registry',
  '  - delete_user_data',
  '  - upgrade_dsh_master',
  '  - auto_git_push',
  '  - write_outside_nomad_root_and_workspace',
  'profiles:',
  '  coding:',
  '    execute: allow',
  '    write: workspace',
  '  devops:',
  '    production_deploy: ask',
].join('\n')

function makeRoot(yaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-test-'))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  if (yaml !== undefined) {
    fs.writeFileSync(path.join(root, 'config', 'permissions.yaml'), yaml, 'utf8')
  }
  return root
}

function makeCtx({ isolated = true, inside = true, pinned = true } = {}) {
  const base = path.join(os.tmpdir(), 'perm-ctx-' + Math.random().toString(36).slice(2))
  // inside=false：root 与数据目录分属不同根，制造「越界」场景
  const dataRoot = inside ? base : 'X:/elsewhere'
  const config = {
    paths: {
      root: base,
      dsh_home: path.join(dataRoot, 'data', 'dsh-home'),
      workspace: path.join(dataRoot, 'workspace'),
    },
    behavior: { track_master: pinned ? false : true },
  }
  const envReport = isolated
    ? { strategy: 'allowlist', dropped: ['APPDATA', 'SSH_AUTH_SOCK'], inherited: ['Path'], overridden: [], extra: [] }
    : { strategy: 'inherit-all', dropped: [], inherited: ['Path'], overridden: [], extra: [] }
  const runtime = pinned
    ? { dsh: { missing: false, version: '0.2.1-alpha.1', entrySource: 'nomad-runtime.json' } }
    : { dsh: { missing: true, reason: '缺' } }
  return { config, envReport, runtime }
}

test('合法模板：8 类齐全、never 6 条、profiles 解析、零问题', () => {
  const perm = loadPermissions({ root: makeRoot(VALID_YAML) })
  assert.deepStrictEqual(perm.problems, [])
  assert.equal(Object.keys(perm.levels).length, 8)
  assert.equal(perm.levels.write.default, 'workspace')
  assert.deepStrictEqual(perm.levels.execute.deny_patterns, ['rm -rf /'])
  assert.equal(perm.never.length, 6)
  assert.ok(perm.never.every((id) => NEVER_IDS.includes(id)))
  assert.equal(perm.profiles.coding.execute, 'allow')
  assert.equal(perm.profiles.devops.production_deploy, 'ask')
})

test('文件缺失：exists=false 且有 problem', () => {
  const perm = loadPermissions({ root: makeRoot() })
  assert.equal(perm.exists, false)
  assert.ok(perm.problems.some((p) => p.includes('权限模板缺失')))
})

test('非法取值拒绝：default 不在合法域', () => {
  const yaml = VALID_YAML.replace('    default: workspace', '    default: auto')
  const perm = loadPermissions({ root: makeRoot(yaml) })
  assert.ok(perm.problems.some((p) => p.includes('levels.write.default') && p.includes('非法')))
  assert.ok(!('write' in perm.levels))
})

test('未知类别与未知 never id 拒绝（防拼写漂移）', () => {
  const yaml = VALID_YAML + '\n  payments:\n    default: ask\nnever_extra:\n  - modifi_system_env\n'
  const root = makeRoot(VALID_YAML.replace('  read:', '  payments:\n    default: ask\n  read:'))
  const perm = loadPermissions({ root })
  assert.ok(perm.problems.some((p) => p.includes('未知类别「payments」')))
  // 未知 never id：单独构造
  const yaml2 = VALID_YAML.replace('  - modify_system_env', '  - modifi_system_env')
  const perm2 = loadPermissions({ root: makeRoot(yaml2) })
  assert.ok(perm2.problems.some((p) => p.includes('never 含未知条目「modifi_system_env」')))
})

test('敏感类别不可被 profile 提升为 allow', () => {
  const yaml = VALID_YAML + '\n  careless:\n    production_deploy: allow\n'
  const perm = loadPermissions({ root: makeRoot(yaml) })
  assert.ok(perm.problems.some((p) => p.includes('不可提升为 allow')))
  assert.ok(!('production_deploy' in perm.profiles.careless))
})

test('levels 缺类别 / never 重复 / 顶层非映射 均报问题', () => {
  const yaml1 = VALID_YAML.replace('  git_push:\n    default: ask\n', '')
  const perm1 = loadPermissions({ root: makeRoot(yaml1) })
  assert.ok(perm1.problems.some((p) => p.includes('缺类别「git_push」')))

  const yaml2 = VALID_YAML.replace('  - modify_registry', '  - modify_registry\n  - modify_registry')
  const perm2 = loadPermissions({ root: makeRoot(yaml2) })
  assert.ok(perm2.problems.some((p) => p.includes('重复条目「modify_registry」')))

  const perm3 = loadPermissions({ root: makeRoot('- just\n- a list\n') })
  assert.ok(perm3.problems.some((p) => p.includes('顶层必须是映射')))
})

test('summarizeLevels 汇总正确', () => {
  const perm = loadPermissions({ root: makeRoot(VALID_YAML) })
  const summary = summarizeLevels(perm)
  assert.ok(summary.includes('allow 2 类'))
  assert.ok(summary.includes('workspace 1 类'))
  assert.ok(summary.includes('ask 5 类'))
})

test('selfCheckNever：隔离生效 → 机械条目全 ok', () => {
  const perm = loadPermissions({ root: makeRoot(VALID_YAML) })
  const checks = selfCheckNever(perm, makeCtx({ isolated: true, inside: true, pinned: true }))
  for (const check of checks) {
    if (check.verifiable) assert.ok(check.ok, `${check.id} 应通过: ${check.note}`)
  }
  assert.equal(checks.length, 6)
})

test('selfCheckNever：隔离关闭 / 路径越界 / 未锁版 → 对应条目失去支撑', () => {
  const perm = loadPermissions({ root: makeRoot(VALID_YAML) })
  const checks1 = selfCheckNever(perm, makeCtx({ isolated: false }))
  const env1 = checks1.filter((c) => c.id === 'modify_system_env')[0]
  assert.equal(env1.ok, false)

  const checks2 = selfCheckNever(perm, makeCtx({ inside: false }))
  const path2 = checks2.filter((c) => c.id === 'write_outside_nomad_root_and_workspace')[0]
  assert.equal(path2.ok, false)

  const checks3 = selfCheckNever(perm, makeCtx({ pinned: false }))
  const pin3 = checks3.filter((c) => c.id === 'upgrade_dsh_master')[0]
  assert.equal(pin3.ok, false)

  // 契约级条目：verifiable=false，不假装机械验证
  const contract = checks3.filter((c) => c.id === 'auto_git_push')[0]
  assert.equal(contract.verifiable, false)
})

test('never 缺条目：自证只覆盖声明了的条目（缺项由 problems 负责）', () => {
  const yaml = VALID_YAML.replace('  - auto_git_push\n', '')
  const perm = loadPermissions({ root: makeRoot(yaml) })
  assert.equal(perm.never.length, 5)
  const checks = selfCheckNever(perm, makeCtx())
  assert.equal(checks.length, 5)
  assert.ok(!checks.some((c) => c.id === 'auto_git_push'))
})
