#!/usr/bin/env node
'use strict'

/**
 * Nomad Profile Smoke Test —— 用**真实 DSH** 验证「自举出来的 nomad profile 真能跑」。
 *
 * 这是 L4-a 阶段 3 的验收（docs/ROADMAP.md）：
 *   阶段 1  `l4a-patch-probe.js`   证明补丁层能被叠加进组合树
 *   阶段 2  `l4a-bundle-probe.js`  证明自研 bundle 能作为 profile 的补丁层换层
 *   阶段 3  本文件                 证明 **Launcher 自举出的 profile 能被真实 DSH 加载并渲染 Web UI**
 *
 * 与阶段 2 的区别（不是重复）：阶段 2 的 profile 是 `dsh --from-default-profile` 生成的；
 * 本测试的 profile 是 **`launcher/lib/profile.js` 自己写出来的**。两者要证明的命题不同 ——
 * 「上游模板能换层」≠「我们写的模板能跑」。
 *
 * 同时做一件上游漂移守卫：把我们的三份模板正文与 DSH 自己 `initProfile` 的产物**逐字**比对。
 * 上游一改模板，这里立刻红。
 *
 * 隔离承诺：全程只在 `data/tmp/nomad-profile-smoke/` 下活动，**不碰**真实 `data/dsh-home`、
 * 不碰 `runtime/dsh/current`、不碰正在运行的实例。跑完即清理。
 *
 * 用法：node tests/smoke/nomad-profile-smoke.js [--timeout <ms>]
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const { parseLaunchLine } = require('../../launcher/lib/dsh-url.js')
const { buildEnv } = require('../../launcher/lib/env.js')
const {
  ensureNomadProfile,
  inspectNomadProfile,
  resolveNomadProfile,
  PROFILE_ROOT_CONFIG,
  PROFILE_PATCH_TEMPLATE,
  PROFILE_PNPM_WORKSPACE,
} = require('../../launcher/lib/profile.js')

const ROOT = path.resolve(__dirname, '..', '..')
const CURRENT = path.join(ROOT, 'runtime', 'dsh', 'current')
const CURRENT_MANIFEST = path.join(CURRENT, 'nomad-runtime.json')
const REPO_BUNDLE = path.join(ROOT, 'packages', 'nomad-web-app')

/** 本测试的活动范围（唯一会写盘的地方）。 */
const SANDBOX = path.join(ROOT, 'data', 'tmp', 'nomad-profile-smoke')
/** 被测 profile 的 DSH_HOME（= 阶段 3 的现场）。 */
const SCRATCH_HOME = path.join(SANDBOX, 'home')
/** 生成上游参考模板用的独立 DSH_HOME（避免与被测 profile 互相影响）。 */
const REF_HOME = path.join(SANDBOX, 'ref-home')
/** 临时目录重定向目标。 */
const SCRATCH_TMP = path.join(SANDBOX, 'tmp')

const PROFILE = 'nomad'
const TEMPLATE = 'web'
const REF_PROFILE = 'upstream-ref'

const argv = process.argv.slice(2)
const timeoutIndex = argv.indexOf('--timeout')
const READY_TIMEOUT = timeoutIndex === -1 ? 180000 : Number(argv[timeoutIndex + 1])

/** 宿主侧零污染标尺（只读探测，不写宿主任何位置）。 */
const HOST_CANARIES = [
  path.join(os.homedir(), '.dsh'),
  path.join(os.homedir(), '.dsh-2'),
]

/**
 * 读取真实运行时（current 清单 + 盘内 Node）。
 * @returns {{ nodePath: string, entry: string, version: string }|null} 运行时；不可用时 null
 */
function readRuntime() {
  if (!fs.existsSync(CURRENT_MANIFEST)) return null
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(CURRENT_MANIFEST, 'utf8'))
  } catch {
    return null
  }
  if (String(manifest.name ?? '').includes('fake')) return null
  const entry = path.resolve(CURRENT, manifest.entry)
  const nodePath = path.join(ROOT, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  if (!fs.existsSync(entry) || !fs.existsSync(nodePath)) return null
  return { nodePath, entry, version: `${String(manifest.version)}` }
}

/**
 * 造一个把 DSH_HOME 指向 scratch 的配置对象（绕过 loadConfig，保持隔离）。
 * @param {string} home - 目标 DSH_HOME
 * @returns {object} 配置
 */
function makeConfig(home) {
  return {
    paths: { dsh_home: home },
    runtime: {
      dsh: {
        profile: PROFILE,
        profile_template: TEMPLATE,
        ensure_profile: true,
        bundle_source: path.relative(ROOT, REPO_BUNDLE).split(path.sep).join('/'),
      },
    },
  }
}

/**
 * 构造 DSH 子进程环境（复用真实隔离配方，仅把落点换成 scratch）。
 * @returns {Record<string, string>} 环境
 */
function scratchEnv() {
  const { env } = buildEnv({
    root: SANDBOX,
    isolation: {
      enabled: true,
      strategy: 'allowlist',
      inherit_allowlist: ['path', 'systemroot', 'windir', 'comspec', 'pathext'],
      override: {
        DSH_HOME: SCRATCH_HOME,
        HOME: SCRATCH_HOME,
        USERPROFILE: SCRATCH_HOME,
        TEMP: SCRATCH_TMP,
        TMP: SCRATCH_TMP,
        TMPDIR: SCRATCH_TMP,
      },
    },
  })
  return env
}

/**
 * 跑一次 DSH（短命：`--dump-config` / `--from-default-profile`）。
 *
 * ⚠️ 刻意用**异步** `spawn` 而非 `spawnSync`：本机 Bash 沙箱里 `spawnSync` 会
 * 静默返回 `status: null`（与 `probeNodeVersion` 遇到的 EBUSY 同源），
 * 报出来就是一句毫无指向性的 `code=-1`。
 *
 * @param {object} runtime - readRuntime 的返回值
 * @param {string[]} args - DSH 参数
 * @param {string} home - DSH_HOME
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} 结果
 */
function runDsh(runtime, args, home) {
  return new Promise((resolve) => {
    const child = spawn(runtime.nodePath, [runtime.entry, ...args], {
      cwd: ROOT,
      env: { ...scratchEnv(), DSH_HOME: home, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}\nspawn error: ${error.message}` })
    })
    child.on('exit', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 单跳 HTTP GET（可携带 cookie）。
 * @param {string} url - 完整 URL
 * @param {string|null} cookie - cookie
 * @returns {Promise<object>} 响应摘要
 */
function singleGet(url, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 20000, headers: cookie === null ? {} : { cookie } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        const setCookie = response.headers['set-cookie']
        resolve({
          status: response.statusCode ?? 0,
          location: response.headers.location ?? null,
          contentType: String(response.headers['content-type'] ?? ''),
          bytes: Buffer.byteLength(body, 'utf8'),
          cookie: Array.isArray(setCookie) ? setCookie.map((item) => item.split(';')[0]).join('; ') : cookie,
        })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error('HTTP 探测超时'))
    })
    request.on('error', reject)
  })
}

/**
 * 带 token 的 HTTP 探测：跟随重定向并携带 cookie（DSH 会先铸 cookie 再跳根路径）。
 * @param {string} url - 含 token 的 URL
 * @param {number} maxHops - 最多跟随几次
 * @returns {Promise<{ status: number, bytes: number, contentType: string, chain: object[] }>} 结果
 */
async function fetchUrl(url, maxHops = 4) {
  const chain = []
  let current = url
  let cookie = null
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await singleGet(current, cookie)
    cookie = response.cookie
    chain.push({ status: response.status, contentType: response.contentType, bytes: response.bytes, location: response.location })
    if (response.status >= 300 && response.status < 400 && response.location !== null) {
      current = new URL(String(response.location), current).toString()
      continue
    }
    return { status: response.status, bytes: response.bytes, contentType: response.contentType, chain }
  }
  const last = chain[chain.length - 1] ?? { status: 0, bytes: 0, contentType: '' }
  return { status: last.status, bytes: last.bytes, contentType: last.contentType, chain }
}

/**
 * 强制结束进程树。
 * @param {number} pid - 进程号
 * @returns {void}
 */
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* 尽力而为 */
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 已退出 */
  }
}

/**
 * 用真实 DSH 直接启动被测 profile，等到就绪行出现。
 * @param {object} runtime - readRuntime 的返回值
 * @returns {Promise<{ child: object, launch: object, diagnostics: string[] }>} 结果
 */
function bootProfile(runtime) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      runtime.nodePath,
      [runtime.entry, '--profile', PROFILE, '--host', '127.0.0.1', '--port', '0', '--no-open'],
      { cwd: ROOT, env: scratchEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )

    const diagnostics = []
    const settle = {
      done: false,
    }
    let buffer = ''
    const timer = setTimeout(() => {
      if (settle.done) return
      settle.done = true
      killTree(child.pid)
      reject(new Error(`等待 profile 就绪超时（${String(READY_TIMEOUT)}ms）\n${diagnostics.slice(-30).join('\n')}`))
    }, READY_TIMEOUT)

    const onData = (chunk) => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line !== '') {
          diagnostics.push(line)
          if (diagnostics.length > 60) diagnostics.shift()
        }
        if (settle.done) continue
        const launch = parseLaunchLine(line)
        if (launch === null) continue
        settle.done = true
        clearTimeout(timer)
        resolve({ child, launch, diagnostics })
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => {
      if (settle.done) return
      settle.done = true
      clearTimeout(timer)
      reject(new Error(`DSH 进程启动失败：${error.message}`))
    })
    child.on('exit', (code) => {
      if (settle.done) return
      settle.done = true
      clearTimeout(timer)
      reject(new Error(`DSH 在就绪前退出（code=${String(code)}）\n${diagnostics.slice(-30).join('\n')}`))
    })
  })
}

/** 已启动的 DSH 进程（供 finally 兜底清理）。 */
let booted = null
/** 上游参考模板的落盘内容（供跨步骤断言）。 */
const REF = { dir: null, manifest: null, patch: null, workspace: null }
/** 前置步骤读到的真实运行时。 */
let RUNTIME = null

const SCENARIO = [
  ['前置：真实 DSH 运行时可用（否则整体 SKIP）', () => {
    RUNTIME = readRuntime()
    assert.ok(RUNTIME !== null, 'SKIP: runtime/dsh/current 未指向真实 DSH')
    console.log(`       运行时 ${RUNTIME.version}`)
    console.log(`       入口   ${path.relative(ROOT, RUNTIME.entry)}`)
  }],

  ['前置：宿主零污染标尺 —— 宿主 ~/.dsh 不存在', () => {
    for (const canary of HOST_CANARIES) {
      assert.equal(fs.existsSync(canary), false, `标尺目录已存在，无法作为判据：${canary}`)
    }
    console.log(`       标尺 ${HOST_CANARIES[0]}`)
  }],

  ['上游参考：用 DSH 自己的 --from-default-profile 生成模板，读回三份正文', async () => {
    const result = await runDsh(RUNTIME, [REF_PROFILE, '--from-default-profile', TEMPLATE, '--dump-config'], REF_HOME)
    assert.equal(result.code, 0, `生成上游参考 profile 失败（code=${String(result.code)}）\n${result.stderr.slice(0, 800)}`)
    const dir = path.join(REF_HOME, 'profiles', REF_PROFILE)
    for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      assert.ok(fs.existsSync(path.join(dir, name)), `上游模板缺失 ${name}：${dir}`)
    }
    REF.dir = dir
    REF.manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    REF.patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    REF.workspace = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
    console.log(`       上游 bundles: ${(REF.manifest.dsh?.profile?.bundles ?? []).join(', ')}`)
  }],

  ['漂移守卫：我们的模板正文与上游产物逐字一致', () => {
    assert.equal(PROFILE_PATCH_TEMPLATE, REF.patch, 'cordis.patch.yml 模板正文与上游不一致（上游改了模板，需更新 launcher/lib/profile.js）')
    assert.equal(PROFILE_PNPM_WORKSPACE, REF.workspace, 'pnpm-workspace.yaml 模板正文与上游不一致')
    assert.deepEqual(
      REF.manifest.dsh?.profile?.bundles,
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      `上游 web 模板的 bundles 变了：${JSON.stringify(REF.manifest.dsh?.profile?.bundles)}`,
    )
    assert.equal(REF.manifest.name, `dsh-profile-${REF_PROFILE}`, '上游清单命名约定变了')
  }],

  ['自举：ensureNomadProfile 在 scratch 上创建 nomad profile', () => {
    const config = makeConfig(SCRATCH_HOME)
    const result = ensureNomadProfile({ root: ROOT, config })
    assert.equal(result.ok, true, result.error ?? '')
    assert.equal(result.action, 'created', `期望 created，实际 ${result.action}`)

    const spec = resolveNomadProfile({ root: ROOT, config })
    const manifest = JSON.parse(fs.readFileSync(spec.manifestPath, 'utf8'))
    assert.equal(manifest.name, `dsh-profile-${PROFILE}`, '清单命名应与上游约定一致')
    assert.equal(JSON.stringify(manifest.dsh.profile.bundles.slice(0, -1)), JSON.stringify(REF.manifest.dsh.profile.bundles),
      '前几层必须是上游模板的 bundles（自研层只能追加在后面）')
    assert.equal(manifest.dsh.profile.bundles.at(-1), spec.bundleSpec, '自研层必须在末位')
    assert.equal(path.resolve(spec.dir, spec.bundleSpec), REPO_BUNDLE, 'bundle spec 必须解析回仓库内的自研 bundle')
    console.log(`       自研层 ${spec.bundleSpec}`)
    console.log(`       目录   ${path.relative(ROOT, spec.dir)}`)
  }],

  ['幂等：再跑一次 ensureNomadProfile 得到 unchanged 且字节不变', () => {
    const config = makeConfig(SCRATCH_HOME)
    const spec = resolveNomadProfile({ root: ROOT, config })
    const before = fs.readFileSync(spec.manifestPath, 'utf8')
    const again = ensureNomadProfile({ root: ROOT, config })
    assert.equal(again.action, 'unchanged', `期望 unchanged，实际 ${again.action}`)
    assert.equal(fs.readFileSync(spec.manifestPath, 'utf8'), before, '幂等失败：清单被改写')
    const info = inspectNomadProfile({ root: ROOT, config })
    assert.equal(info.bundleLast, true)
    assert.deepEqual(info.problems, [])
  }],

  ['组合树：自举出的 profile 被 DSH 正确组合（来源链含自研层 + Nomad 身份生效）', async () => {
    const result = await runDsh(RUNTIME, ['--profile', PROFILE, '--dump-config'], SCRATCH_HOME)
    assert.equal(result.code, 0, `--dump-config 失败（code=${String(result.code)}）\n${result.stderr.slice(0, 800)}`)
    const text = result.stdout
    assert.ok(text.length > 10000, `组合树过短（${String(text.length)}B），可能没加载到 profile`)

    const provenance = text.split('\n').filter((line) => line.includes('patched by'))
    assert.ok(provenance.length > 0, '组合树里没有来源链（patched by）')
    assert.ok(
      provenance.some((line) => line.includes('nomad-web-app')),
      `来源链未包含自研 bundle：\n${provenance.slice(0, 5).join('\n')}`,
    )
    // 扬弃折叠标量的换行影响：归一化空白后再匹配（阶段 2 踩过的坑）
    const flat = text.replace(/\s+/g, ' ')
    assert.ok(flat.includes('Nomad portable drive'), 'personaSuffix 未替换为 Nomad 身份文本 → 自研补丁层没生效')
    console.log(`       组合树 ${String(text.split('\n').length)} 行，来源链 ${String(provenance.length)} 处`)
  }],

  ['真启动：真实 DSH 加载自举出的 profile 并渲染 Web UI', async () => {
    const boot = await bootProfile(RUNTIME)
    booted = boot.child
    console.log(`       DSH pid=${String(boot.child.pid)}  端口 ${String(boot.launch.port)}`)

    const response = await fetchUrl(boot.launch.url)
    for (const hop of response.chain) {
      console.log(`       ${String(hop.status)}  ${hop.contentType || '-'}  ${String(hop.bytes)}B${hop.location ? ` → ${String(hop.location)}` : ''}`)
    }
    assert.ok(response.status >= 200 && response.status < 400, `最终 HTTP ${String(response.status)}`)
    assert.ok(response.bytes > 0, `响应体为空（跟随 ${String(response.chain.length)} 跳）`)
    assert.match(response.contentType, /html/i, `content-type 不是 HTML：${response.contentType}`)

    const warnings = boot.diagnostics.filter((line) => /did not activate|failed to import/i.test(line))
    if (warnings.length > 0) console.log(`       （DSH 告警 ${String(warnings.length)} 条，属运行时残缺包问题，见 doctor）`)
  }],

  ['零污染：真实 DSH 跑完自举 profile 后宿主标尺仍未出现', () => {
    for (const canary of HOST_CANARIES) {
      assert.equal(fs.existsSync(canary), false, `宿主污染！出现了 ${canary} —— 隔离失效`)
    }
    assert.ok(fs.existsSync(SCRATCH_HOME), '盘内 DSH_HOME 未创建 —— 状态根本没落在盘内')
    // 只报事实，不断言：凭据文件是否生成属运行期行为观测（ADR-0019 的依据之一）。
    const entries = fs.readdirSync(SCRATCH_HOME)
    const creds = path.join(SCRATCH_HOME, '.credentials.yaml')
    console.log(`       ${path.relative(ROOT, SCRATCH_HOME)} 下：${entries.join(', ') || '(空)'}`)
    console.log(`       .credentials.yaml：${fs.existsSync(creds) ? '已生成（明文模板，见 ADR-0019）' : '本次未生成'}`)
  }],
]

/**
 * 清理：结束进程树 + 删除 sandbox。
 * @returns {void}
 */
function cleanup() {
  if (booted !== null) {
    killTree(booted.pid)
    booted = null
  }
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* 清理失败不致命，下次运行会先清 */
  }
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

/**
 * 主流程。
 * @returns {Promise<void>} 完成
 */
async function main() {
  console.log('── Nomad Profile Smoke Test（真实 DSH × 自举 profile）──')
  console.log(`NOMAD_ROOT = ${ROOT}`)
  console.log(`sandbox    = ${path.relative(ROOT, SANDBOX)}`)
  console.log('')

  // 干净现场：fixed 名字必须每次重建，否则上一次的 profile 会让「首次创建」断言失真
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH_HOME, { recursive: true })
  fs.mkdirSync(REF_HOME, { recursive: true })
  fs.mkdirSync(SCRATCH_TMP, { recursive: true })

  if (readRuntime() === null) {
    console.log('[SKIP] runtime/dsh/current 未指向真实 DSH —— 本测试未执行（这不是通过）。')
    console.log('       先按 docs/DEVELOPMENT.md §8 打包运行时，或改跑 tests/smoke/l4a-bundle-probe.js（替身面）。')
    cleanup()
    process.exitCode = 0
    return
  }

  let failed = 0
  let executed = 0
  for (const [name, run] of SCENARIO) {
    try {
      await run()
      executed += 1
      console.log(`[ OK ] ${name}`)
    } catch (error) {
      failed += 1
      console.log(`[FAIL] ${name}`)
      console.log(`       ${String(error.message).split('\n').join('\n       ')}`)
      break
    }
  }

  cleanup()

  console.log('')
  if (failed === 0) {
    console.log(`合计：通过 ${String(executed)} / 失败 0 —— 自举 profile 的真实端到端闭环成立`)
  } else {
    const remaining = SCENARIO.length - executed - failed
    console.log(`合计：通过 ${String(executed)} / 失败 ${String(failed)}（首个失败即停；剩余 ${String(remaining)} 步未执行）`)
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  cleanup()
  console.error(`nomad-profile-smoke: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 70
})
