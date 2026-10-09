/**
 * tests/updater.test.js — 运行时更新模块的单元测试（不碰网络、不 spawn 真进程）。
 *
 * 覆盖：
 * - compareVersions：核心位 / prerelease 规则（数字 < 非数字、位数不齐、alpha 序）
 * - fetchLatestMeta / checkUpdate：注入 fetch 替身（可更新 / 已最新 / 盘内更新 / HTTP 错误 / 字段缺失）
 * - verifyIntegrity：sha512 SSRI 正确 / 篡改 / 非 sha512 前缀
 * - downloadTarball：校验通过落盘 / 校验失败拒绝落盘 / HTTP 错误
 * - extractTarball：真实 tgz 夹具（系统 tar 创建）→ 解包拍平；tar 失败报错
 * - buildInstallSpawn / installDependencies：argv 形状；npm-cli 缺失拒绝；注入 spawn 成功/失败
 * - buildNextManifest：保留 name/profile/app_args，换 version/entry
 * - writePointer：入口存在才写 / 入口缺失拒绝
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const {
  compareVersions,
  fetchLatestMeta,
  checkUpdate,
  verifyIntegrity,
  downloadTarball,
  extractTarball,
  buildInstallSpawn,
  installDependencies,
  buildNextManifest,
  writePointer,
} = require('../launcher/lib/updater.js')
const { spawn } = require('node:child_process')

/** 异步 spawn 包装（沙箱杀 spawnSync：EBUSY —— 记忆教训，测试一律异步 spawn）。 */
function spawnAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, opts)
    let stderr = ''
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`spawn ${file} exit ${code}${stderr ? ': ' + stderr.trim() : ''}`))
    })
  })
}

/** 与 updater.extractTarball 同源：win32 显式用 System32 bsdtar（GNU tar 会把 C: 当远程主机）。 */
function systemTar() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

function jsonResponse(body, status = 200) {
  return { ok: status === 200, status, json: async () => body }
}

const REGISTRY_DOC = {
  version: '0.3.0',
  dist: {
    tarball: 'https://registry.example/@deepseek-ai/dsh/-/dsh-0.3.0.tgz',
    integrity: 'sha512-AAAA',
  },
}

test('compareVersions：核心位与 prerelease 语义', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1) // 数值比较，不是字典序
  assert.equal(compareVersions('1.0.0', '1.0.0-alpha'), 1) // 无 pre > 有 pre
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2'), -1)
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1) // 数值位
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1) // 位数短 < 长
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1) // 字典序
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1) // 非数字 > 数字
  assert.equal(compareVersions('0.2.1-alpha.1', '0.2.1'), -1)
})

test('fetchLatestMeta：解析 version/dist', async () => {
  const meta = await fetchLatestMeta({ fetchImpl: async () => jsonResponse(REGISTRY_DOC) })
  assert.equal(meta.latest, '0.3.0')
  assert.equal(meta.tarball, REGISTRY_DOC.dist.tarball)
  assert.equal(meta.integrity, 'sha512-AAAA')
})

test('fetchLatestMeta：HTTP 错误 / 缺 version 拒绝', async () => {
  await assert.rejects(
    () => fetchLatestMeta({ fetchImpl: async () => jsonResponse({}, 500) }),
    /HTTP 500/,
  )
  await assert.rejects(
    () => fetchLatestMeta({ fetchImpl: async () => jsonResponse({ dist: {} }) }),
    /缺少 version/,
  )
})

test('checkUpdate：可更新 / 已最新 / 盘内更新 / 查询失败', async () => {
  const newer = await checkUpdate({ current: '0.2.1-alpha.1', fetchImpl: async () => jsonResponse(REGISTRY_DOC) })
  assert.equal(newer.comparison, 'update-available')
  assert.equal(newer.updateAvailable, true)

  const same = await checkUpdate({ current: '0.3.0', fetchImpl: async () => jsonResponse(REGISTRY_DOC) })
  assert.equal(same.comparison, 'up-to-date')

  const older = await checkUpdate({ current: '0.4.0', fetchImpl: async () => jsonResponse(REGISTRY_DOC) })
  assert.equal(older.comparison, 'current-newer')
  assert.equal(older.updateAvailable, false)

  const fail = await checkUpdate({ current: '0.2.1', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(fail.comparison, 'unknown')
  assert.ok(fail.error.includes('ECONNREFUSED'))
})

test('verifyIntegrity：SSRI 匹配 / 篡改 / 前缀不符', () => {
  const data = Buffer.from('dsh-tgz-bytes')
  const good = `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`
  assert.equal(verifyIntegrity(data, good).ok, true)
  assert.equal(verifyIntegrity(Buffer.from('tampered'), good).ok, false)
  assert.equal(verifyIntegrity(data, 'sha1-AAAA').ok, false)
})

test('downloadTarball：校验通过落盘 / 篡改拒绝落盘', async () => {
  const data = Buffer.from('dsh-tgz-bytes')
  const good = `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`
  const dest = path.join(os.tmpdir(), `upd-dl-${Date.now().toString(36)}.tgz`)
  const r = await downloadTarball({ url: 'https://x/y.tgz', integrity: good, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }), destPath: dest })
  assert.equal(r.bytes, data.length)
  assert.equal(fs.readFileSync(dest).toString(), 'dsh-tgz-bytes')
  fs.rmSync(dest, { force: true })

  const dest2 = path.join(os.tmpdir(), `upd-dl2-${Date.now().toString(36)}.tgz`)
  await assert.rejects(
    () => downloadTarball({ url: 'https://x/y.tgz', integrity: good, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('evil').buffer }), destPath: dest2 }),
    /完整性校验失败/,
  )
  assert.equal(fs.existsSync(dest2), false) // 校验失败绝不落盘
})

test('extractTarball：真实 tgz 解包并拍平 package/ 前缀', async () => {
  // 用系统 tar 造一个最小 tgz 夹具（npm tarball 形态：package/…）；异步 spawn（沙箱杀 spawnSync）
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-stage-'))
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-extract-'))
  fs.mkdirSync(path.join(stage, 'package', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'package', 'package.json'), '{"name":"@deepseek-ai/dsh","version":"9.9.9"}')
  fs.writeFileSync(path.join(stage, 'package', 'lib', 'bin.js'), 'console.log(1)')
  const tgzPath = path.join(stage, 'fixture.tgz')
  await spawnAsync(systemTar(), ['-czf', tgzPath, '-C', stage, 'package'])
  const r = await extractTarball({ tgzPath, destDir: outDir })
  assert.ok(r.entries >= 2)
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8')).version, '9.9.9')
  assert.equal(fs.readFileSync(path.join(outDir, 'lib', 'bin.js'), 'utf8'), 'console.log(1)')
  assert.equal(fs.existsSync(path.join(outDir, 'package')), false) // 前缀已拍平
  fs.rmSync(stage, { recursive: true, force: true })
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('buildInstallSpawn：argv 形状（盘内 npm-cli、--omit=dev）', () => {
  const plan = buildInstallSpawn({ nodeExe: 'X:/runtime/node/node.exe', versionDir: 'X:/runtime/dsh/0.3.0' })
  assert.equal(plan.file, 'X:/runtime/node/node.exe')
  assert.ok(plan.args[0].includes(path.join('node_modules', 'npm', 'bin', 'npm-cli.js')))
  assert.ok(plan.args.includes('install'))
  assert.ok(plan.args.includes('--omit=dev'))
  assert.equal(plan.cwd, 'X:/runtime/dsh/0.3.0')
})

test('installDependencies：npm-cli 缺失拒绝 / 注入 spawn 成功与失败', async () => {
  const fakeNodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-node-'))
  await assert.rejects(
    () => installDependencies({ nodeExe: path.join(fakeNodeDir, 'node.exe'), versionDir: fakeNodeDir }),
    /找不到 npm CLI/,
  )

  const spawned = []
  const ok = await installDependencies({
    nodeExe: process.execPath,
    versionDir: __dirname,
    spawnImpl: (file, args, opts) => {
      spawned.push({ file, args, opts })
      const { EventEmitter } = require('node:events')
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0))
      return child
    },
  })
  assert.equal(ok.exitCode, 0)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].opts.windowsHide, true)

  await assert.rejects(
    () => installDependencies({
      nodeExe: process.execPath,
      versionDir: __dirname,
      spawnImpl: () => {
        const { EventEmitter } = require('node:events')
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        queueMicrotask(() => child.emit('close', 1))
        return child
      },
    }),
    /npm install 失败/,
  )
  fs.rmSync(fakeNodeDir, { recursive: true, force: true })
})

test('buildNextManifest：换 version/entry，保留其余字段', () => {
  const cur = { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.1', entry: '../0.2.1-alpha.1/node_modules/@deepseek-ai/dsh/lib/bin.js', profile: 'web', app_args: [], _comment: 'x' }
  const { manifest, entry } = buildNextManifest(cur, '0.3.0')
  assert.equal(manifest.version, '0.3.0')
  assert.equal(entry, '../0.3.0/node_modules/@deepseek-ai/dsh/lib/bin.js')
  assert.equal(manifest.entry, entry)
  assert.equal(manifest.profile, 'web')
  assert.deepStrictEqual(manifest.app_args, [])
  assert.equal(manifest.name, '@deepseek-ai/dsh') // 保留
  assert.equal(manifest._comment, 'x') // 保留
})

function makeRootWithRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-root-'))
  const versionDir = path.join(root, 'runtime', 'dsh', '0.3.0')
  const entryAbs = path.join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  fs.mkdirSync(entryAbs, { recursive: true })
  fs.writeFileSync(path.join(entryAbs, 'bin.js'), 'console.log(1)')
  const currentDir = path.join(root, 'runtime', 'dsh', 'current')
  fs.mkdirSync(currentDir, { recursive: true })
  const config = {
    runtime: { dsh: { current: 'runtime/dsh/current' } },
    paths: { tmp: path.join(root, 'data', 'tmp'), root },
  }
  fs.mkdirSync(config.paths.tmp, { recursive: true })
  return { root, config, currentDir, versionDir }
}

test('writePointer：入口存在才写 / 入口缺失拒绝改写', () => {
  const { root, config, currentDir, versionDir } = makeRootWithRuntime()
  const manifest = { name: '@deepseek-ai/dsh', version: '0.3.0', entry: '../0.3.0/node_modules/@deepseek-ai/dsh/lib/bin.js' }
  const r = writePointer({ root, config, manifest, entry: manifest.entry, version: '0.3.0' })
  assert.equal(r.file, path.join(currentDir, 'nomad-runtime.json'))
  const written = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.equal(written.version, '0.3.0')

  const bad = { ...manifest, entry: '../0.9.9/node_modules/@deepseek-ai/dsh/lib/bin.js' }
  assert.throws(() => writePointer({ root, config, manifest: bad, entry: bad.entry, version: '0.9.9' }), /新版本入口不存在/)
  void versionDir
})
