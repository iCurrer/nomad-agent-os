'use strict'

/**
 * 宿主隔离测试（核心）：白名单继承 + 强制覆盖 + 临时目录重定向。
 * 这是"零污染"在代码层面的证据，对应 docs/HOST_ISOLATION.md。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildEnv, prependToPath } = require('../launcher/lib/env.js')

const ROOT = path.resolve(__dirname, '..')

const ISOLATION = {
  enabled: true,
  strategy: 'allowlist',
  inherit_allowlist: ['path', 'systemroot', 'windir', 'comspec', 'pathext'],
  override: {
    DSH_HOME: path.join(ROOT, 'data', 'dsh-home'),
    HOME: path.join(ROOT, 'data', 'dsh-home'),
    USERPROFILE: path.join(ROOT, 'data', 'dsh-home'),
    TEMP: path.join(ROOT, 'data', 'tmp'),
    TMP: path.join(ROOT, 'data', 'tmp'),
    TMPDIR: path.join(ROOT, 'data', 'tmp'),
  },
}

/** 模拟一个"脏"的宿主环境（用通用用户名，不嵌入任何真实路径）。 */
const HOSTY = {
  Path: 'C:\\Windows\\system32;C:\\Windows',
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  PATHEXT: '.COM;.EXE',
  APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\someone',
  HOME: 'C:\\Users\\someone',
  TEMP: 'C:\\Users\\someone\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\someone\\AppData\\Local\\Temp',
  DEEPSEEK_API_KEY: 'sk-this-must-never-be-inherited',
  NPM_TOKEN: 'npm-this-must-never-be-inherited',
  GITHUB_TOKEN: 'ghp-also-not-inherited',
}

test('白名单继承：宿主必需变量保留（大小写不敏感）', () => {
  const { env, report } = buildEnv({ root: ROOT, isolation: ISOLATION, base: HOSTY })
  assert.equal(report.strategy, 'allowlist')
  assert.equal(env.Path, HOSTY.Path)
  assert.equal(env.SystemRoot, HOSTY.SystemRoot)
  assert.equal(env.ComSpec, HOSTY.ComSpec)
  assert.equal(env.PATHEXT, HOSTY.PATHEXT)
})

test('敏感变量一律不继承', () => {
  const { env, report } = buildEnv({ root: ROOT, isolation: ISOLATION, base: HOSTY })
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(env.NPM_TOKEN, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.ok(report.dropped.includes('DEEPSEEK_API_KEY'))
  assert.ok(report.dropped.includes('GITHUB_TOKEN'))
})

test('APPDATA / LOCALAPPDATA 不继承（源码中二者只读不写）', () => {
  const { env } = buildEnv({ root: ROOT, isolation: ISOLATION, base: HOSTY })
  assert.equal(env.APPDATA, undefined)
  assert.equal(env.LOCALAPPDATA, undefined)
})

test('强制覆盖全部指向 NOMAD_ROOT 之内', () => {
  const { env } = buildEnv({ root: ROOT, isolation: ISOLATION, base: HOSTY })
  assert.equal(env.DSH_HOME, path.join(ROOT, 'data', 'dsh-home'))
  assert.equal(env.USERPROFILE, path.join(ROOT, 'data', 'dsh-home'))
  assert.equal(env.HOME, path.join(ROOT, 'data', 'dsh-home'))
  assert.equal(env.TEMP, path.join(ROOT, 'data', 'tmp'))
  assert.equal(env.TMP, path.join(ROOT, 'data', 'tmp'))
  assert.equal(env.TMPDIR, path.join(ROOT, 'data', 'tmp'))
  for (const name of ['DSH_HOME', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR']) {
    assert.ok(env[name].startsWith(ROOT), `${name} 必须落在盘内`)
  }
})

test('注入自证标记，便于事后判断"这一跑到底隔没隔"', () => {
  const { env } = buildEnv({ root: ROOT, isolation: ISOLATION, base: HOSTY })
  assert.equal(env.NOMAD_ROOT, ROOT)
  assert.equal(env.NOMAD_ISOLATED, '1')
})

test('isolated=false 时明确降级为 inherit-all 并留下证据', () => {
  const { env, report } = buildEnv({ root: ROOT, isolation: { ...ISOLATION, enabled: false }, base: HOSTY })
  assert.equal(report.strategy, 'inherit-all')
  assert.equal(env.DEEPSEEK_API_KEY, HOSTY.DEEPSEEK_API_KEY)
  assert.equal(env.NOMAD_ISOLATED, '0')
})

test('extra 注入生效', () => {
  const { env, report } = buildEnv({
    root: ROOT,
    isolation: ISOLATION,
    base: HOSTY,
    extra: { NOMAD_TEST: '1' },
  })
  assert.equal(env.NOMAD_TEST, '1')
  assert.ok(report.extra.includes('NOMAD_TEST'))
})

test('prependToPath 幂等且不重复', () => {
  const env = { Path: 'C:\\Windows' }
  assert.equal(prependToPath(env, 'D:\\u盘\\runtime\\node'), true)
  assert.equal(env.Path.split(';')[0], 'D:\\u盘\\runtime\\node')
  assert.equal(prependToPath(env, 'D:\\u盘\\runtime\\node'), false)
})
