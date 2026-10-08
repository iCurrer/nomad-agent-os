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
  inherit_allowlist: ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive'],
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
  SystemDrive: 'C:',
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
  assert.equal(env.SystemDrive, HOSTY.SystemDrive)
})

test('★ 回归：SystemDrive 必须被继承（否则系统路径退化为工作区相对路径）', () => {
  // 缺陷背景：白名单曾漏掉 SystemDrive，导致子进程里 `%SystemDrive%\ProgramData\...`
  // 展开失败，退化成相对路径并以 cwd（Agent 工作区）为基准落盘 —— 实测在 workspace/
  // 下重建了 Windows 兼容性缓存库（4 文件 / ~966 KB）。见 docs/HOST_ISOLATION.md。
  // 本用例锁死该变量不得从白名单移除；同时确认它不夹带任何敏感信息。
  const { env, report } = buildEnv({ root: ROOT, isolation: ISOLATION, base: HOSTY })
  assert.ok(
    report.inherited.map((n) => n.toLowerCase()).includes('systemdrive'),
    'SystemDrive 必须在继承白名单内 —— 移除它会让 Windows 路径展开失败并污染工作区',
  )
  assert.equal(env.SystemDrive, 'C:', '应原样继承宿主值（此处模拟为 C:）')

  // 反向断言：它必须是**白名单内**才被继承，而非"什么都继承"。
  // （若哪天有人把 strategy 改成 inherit-all，这条与上面的敏感变量用例会一起红。）
  assert.ok(
    !report.inherited.map((n) => n.toLowerCase()).includes('appdata'),
    'APPDATA 仍不得继承 —— 本次例外只放开 systemdrive 一个变量',
  )
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
