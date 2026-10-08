'use strict'

/**
 * 配置加载测试：真实 `config/nomad.yaml` 必须能被解析、占位符展开、路径守卫生效。
 * 这是"配置即契约"的回归防线 —— 改动配置文件会立刻反映在这里。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadConfig } = require('../launcher/lib/config.js')
const { isRoot } = require('../launcher/lib/root.js')

const ROOT = path.resolve(__dirname, '..')

test('仓库根满足 NOMAD_ROOT 标记', () => {
  assert.equal(isRoot(ROOT), true)
})

test('真实配置可加载并展开占位符', () => {
  const config = loadConfig({ root: ROOT })
  assert.equal(config.root, ROOT)
  assert.ok(config.paths.dsh_home.startsWith(ROOT))
  assert.equal(config.paths.dsh_home, path.join(ROOT, 'data', 'dsh-home'))
  // ${paths.dsh_home} 必须被真正展开成绝对路径
  assert.equal(config.isolation.override.DSH_HOME, config.paths.dsh_home)
  assert.equal(config.isolation.override.USERPROFILE, config.paths.dsh_home)
  assert.equal(config.isolation.override.TEMP, config.paths.tmp)
  assert.equal(config.isolation.override.TMPDIR, path.join(ROOT, 'data', 'tmp'))
})

test('全部路径都在 NOMAD_ROOT 之内且无残留占位符', () => {
  const config = loadConfig({ root: ROOT })
  for (const [key, value] of Object.entries(config.paths)) {
    assert.ok(value.startsWith(ROOT), `paths.${key} 越界：${value}`)
    assert.ok(!value.includes('${'), `paths.${key} 有残留占位符：${value}`)
  }
  for (const [name, value] of Object.entries(config.isolation.override)) {
    assert.ok(value.startsWith(ROOT), `isolation.override.${name} 未落在盘内：${value}`)
  }
})

test('隔离策略为白名单且启用', () => {
  const config = loadConfig({ root: ROOT })
  assert.equal(config.isolation.enabled, true)
  assert.equal(config.isolation.strategy, 'allowlist')
  assert.deepEqual(config.isolation.inherit_allowlist, ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive'])
})

test('端口不写死、host 只允许回环、DSH 入口走 node-entry', () => {
  const config = loadConfig({ root: ROOT })
  assert.equal(config.web.port, 0)
  assert.equal(config.web.host, '127.0.0.1')
  assert.equal(config.runtime.dsh.launch_mode, 'node-entry')
  assert.equal(config.runtime.dsh.auto_update, false)
  assert.equal(config.runtime.dsh.track_master, false)
  // Nomad 跑自建 profile（内置模板名是保留名，只能作为 profile_template）
  assert.equal(config.runtime.dsh.profile, 'nomad')
  assert.equal(config.runtime.dsh.profile_template, 'web')
  assert.equal(config.runtime.dsh.ensure_profile, true)
  assert.equal(config.runtime.dsh.bundle_source, 'packages/nomad-web-app')
})

test('日志目录取自 logging.dir 且落在盘内', () => {
  const config = loadConfig({ root: ROOT })
  assert.equal(config.paths.logs, path.join(ROOT, 'data', 'logs'))
  assert.equal(config.logging.dir, config.paths.logs)
})

test('Secret 关卡：配置里出现 api_key 直接拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-cfg-'))
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x')
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.0.0')
  fs.mkdirSync(path.join(dir, 'config'))
  fs.writeFileSync(
    path.join(dir, 'config', 'nomad.yaml'),
    ['providers:', '  deepseek:', '    api_key: "sk-oops"', 'paths:', '  data: "data"'].join('\n'),
  )
  assert.throws(() => loadConfig({ root: dir }), /禁止项/)
})

test('路径关卡：配置里出现宿主绝对路径直接拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-cfg-'))
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x')
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.0.0')
  fs.mkdirSync(path.join(dir, 'config'))
  fs.writeFileSync(
    path.join(dir, 'config', 'nomad.yaml'),
    ['paths:', '  data: "C:/Users/someone/AppData"'].join('\n'),
  )
  assert.throws(() => loadConfig({ root: dir }), /禁止宿主绝对路径/)
})

test('占位符关卡：残留占位符直接拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-cfg-'))
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x')
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.0.0')
  fs.mkdirSync(path.join(dir, 'config'))
  fs.writeFileSync(
    path.join(dir, 'config', 'nomad.yaml'),
    ['logging:', '  dir: "${paths.not_a_key}"'].join('\n'),
  )
  assert.throws(() => loadConfig({ root: dir }), /未解析的占位符/)
})

test('host 关卡：0.0.0.0 被拒绝（DSH 本身也拒绝）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-cfg-'))
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x')
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.0.0')
  fs.mkdirSync(path.join(dir, 'config'))
  fs.writeFileSync(
    path.join(dir, 'config', 'nomad.yaml'),
    ['web:', '  host: "0.0.0.0"'].join('\n'),
  )
  assert.throws(() => loadConfig({ root: dir }), /只允许 "127\.0\.0\.1"/)
})
