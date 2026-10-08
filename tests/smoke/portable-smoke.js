#!/usr/bin/env node
'use strict'

/**
 * Portable Smoke Test —— 端到端可执行验收（对应 docs/ROADMAP.md 的 V1 清单）。
 *
 * 在**真实盘上**跑完整链路：
 *   装载替身运行时 → nomad start（后台）→ 状态文件 → HTTP 可达
 *   → 零污染实证（会话落在盘内 / 宿主临时目录未被写）
 *   → nomad status → nomad url → nomad stop → 状态清理
 *
 * 设计说明：
 *   - 子进程一律用**异步 spawn**（不用 spawnSync）。原因有两条：一是同步等待
 *     会阻塞事件循环、无法边跑边观测；二是本机环境下对同一 node.exe 使用
 *     spawnSync 会返回 EBUSY，属环境限制。异步方式在两种情况下都成立。
 *   - 安全闸：绝不**丢弃**已存在的真实运行时。若 `runtime/dsh/current` 已存在且不是
 *     本测试的替身，则整目录**暂存**到 data/tmp，测试结束（含异常与信号）后原样放回。
 *     原因：本测试与 real-runtime-smoke.js 都要占用 `runtime/dsh/current` 这一个指针，
 *     两者必须能安全轮流跑。
 *
 * 用法：node tests/smoke/portable-smoke.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const { loadConfig } = require(path.join(ROOT, 'launcher', 'lib', 'config.js'))
const NOMAD = path.join(ROOT, 'launcher', 'nomad.js')
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'fake-dsh')
const RUNTIME_DIR = path.join(ROOT, 'runtime', 'dsh')
const CURRENT = path.join(RUNTIME_DIR, 'current')
const STATE = path.join(ROOT, 'data', 'run', 'nomad.state.json')
const SESSION_PROBE = path.join(ROOT, 'data', 'dsh-home', 'sessions', 'fake-session.jsonl')
const TEMP_PROBE = path.join(ROOT, 'data', 'tmp', 'fake-tmp-probe')
const HOST_TEMP_PROBE = path.join(os.tmpdir(), 'fake-tmp-probe')

// 真实 current 指针的暂存位置：本测试期间让位给替身，结束（含异常/信号）时放回。
//
// ⚠️ 必须放在**专用子目录**里。教训：早先直接用 `data/tmp/portable-smoke-current-<ts>`，
// 结果一次批量清理（`rm -rf data/tmp/portable-smoke-*`）把**尚未放回的真实指针**一并扫掉了。
// 独立目录让"放回失败"的残留一眼可辨，也不会被通用通配符误伤。
const SWAP_ROOT = path.join(ROOT, 'data', 'tmp', 'nomad-current-swap')
const SWAP_DIR = path.join(SWAP_ROOT, String(Date.now()))
/** 暂存前记录的 original manifest 原文，用于结束时逐字比对。 */
let originalManifestText = null

// 期望的 profile 名从**配置**派生，不写死。
// 教训（2026-10-08）：这个测试里曾硬编码 `--profile web`；后来 `config/nomad.yaml` 的
// runtime.dsh.profile 改成了 `nomad`，断言就悄悄过期了 —— 而我只同步了 real-runtime-smoke，
// 漏了这个，于是便携冒烟第 2 步就红。派生自单一事实源，才不会再有第二次。
const EXPECTED_PROFILE = loadConfig({ root: ROOT }).runtime.dsh.profile

/**
 * 异步执行 nomad 子命令并收集输出。
 * @param {string[]} args - 参数
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>} 结果
 */
function nomad(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NOMAD, ...args], {
      cwd: ROOT,
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
      resolve({ status: -1, stdout, stderr: `${stderr}\nspawn error: ${error.message}` })
    })
    child.on('exit', (code) => {
      resolve({ status: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 判断 runtime/dsh/current 是否是本测试的替身。
 * @returns {boolean} 是替身则为 true
 */
function isFakeCurrent() {
  try {
    const manifest = path.join(CURRENT, 'nomad-runtime.json')
    if (!fs.existsSync(manifest)) return false
    return String(JSON.parse(fs.readFileSync(manifest, 'utf8')).name ?? '').includes('fake')
  } catch {
    return false
  }
}

/**
 * 自愈：处理上一次**被中途杀掉**（SIGTERM / SIGPIPE）留下的暂存残留。
 *
 * 为什么需要它（2026-10-08 真踩到）：本测试要把真实 `current` 挪开让位给替身。
 * 如果进程恰好在「移除替身」与「放回真实」之间的窗口里被杀，盘上就会留下
 * **`current` 缺失（或仍是替身）+ 暂存躺在 data/tmp** 的状态 —— 而 `nomad start`
 * 会因此干净地失败（doctor 报「运行时目录不存在」），看起来像是运行时坏了。
 *
 * 判据与动作：
 *   · `current` 缺失或是替身，且暂存区里有**真实**清单 → 放回最新那一份
 *   · `current` 已是真实运行时 → 暂存区里剩下的都是垃圾，清掉
 * @returns {void}
 */
function recoverLeftoverStash() {
  if (!fs.existsSync(SWAP_ROOT)) return
  const names = fs.readdirSync(SWAP_ROOT).sort()
  if (names.length === 0) {
    fs.rmSync(SWAP_ROOT, { recursive: true, force: true })
    return
  }
  /** 判定某份暂存是不是真实运行时（而不是被挪开的替身）。 */
  const isRealStash = (dir) => {
    try {
      const manifest = path.join(dir, 'nomad-runtime.json')
      if (!fs.existsSync(manifest)) return false
      return !String(JSON.parse(fs.readFileSync(manifest, 'utf8')).name ?? '').includes('fake')
    } catch {
      return false
    }
  }
  const real = names.filter((name) => isRealStash(path.join(SWAP_ROOT, name)))
  const currentUsable = fs.existsSync(CURRENT) && !isFakeCurrent()

  if (!currentUsable && real.length > 0) {
    const newest = path.join(SWAP_ROOT, real[real.length - 1])
    if (fs.existsSync(CURRENT)) fs.rmSync(CURRENT, { recursive: true, force: true })
    fs.renameSync(newest, CURRENT)
    console.log(`[信息] 自愈：检测到上一次运行遗留的暂存，真实 current 已放回（原暂存 ${path.relative(ROOT, newest)}）`)
  } else {
    console.log(`[信息] 自愈：清理 ${String(names.length)} 份暂存残留（${names.join(', ')}；current ${currentUsable ? '已是真实运行时' : '状态异常'}）`)
  }
  try {
    fs.rmSync(SWAP_ROOT, { recursive: true, force: true })
  } catch (error) {
    console.log(`(暂存区清理未完成：${error.message})`)
  }
}

/**
 * 让开真实运行时指针：把 runtime/dsh/current 整体暂存到 data/tmp。
 * @returns {boolean} 是否发生了暂存
 */
function evictRealCurrent() {
  if (!fs.existsSync(CURRENT) || isFakeCurrent()) return false
  originalManifestText = fs.readFileSync(path.join(CURRENT, 'nomad-runtime.json'), 'utf8')
  fs.mkdirSync(path.dirname(SWAP_DIR), { recursive: true })
  fs.renameSync(CURRENT, SWAP_DIR)
  console.log(`[信息] 真实 current 已暂存至 ${SWAP_DIR}，测试结束后放回`)
  return true
}

/**
 * 把暂存出去的真实 current 原样放回（幂等；同步实现，以便挂在 exit 上）。
 *
 * ⚠️ 顺序刻意用「**先 rename 挪开，再 rename 放回**」而不是「先 rmSync 删掉，再放回」：
 * 删除是不可逆的，而 rm 与 rename 之间的窗口一旦被信号（尤其是 `| head` 造成的 SIGPIPE）
 * 打断，就会留下 `current` **缺失**的状态。rename 一路可回滚，最坏情况只是留下暂存，
 * 由 {@link recoverLeftoverStash} 下次自愈。
 * @returns {void}
 */
function restoreRealCurrent() {
  if (!fs.existsSync(SWAP_DIR)) return
  const aside = `${SWAP_DIR}.evicting`
  try {
    if (fs.existsSync(CURRENT)) {
      if (fs.existsSync(aside)) fs.rmSync(aside, { recursive: true, force: true })
      fs.renameSync(CURRENT, aside)
    }
    fs.renameSync(SWAP_DIR, CURRENT)
    if (originalManifestText !== null) {
      const back = fs.readFileSync(path.join(CURRENT, 'nomad-runtime.json'), 'utf8')
      if (back !== originalManifestText) throw new Error('放回的 manifest 与暂存前不一致')
    }
    if (fs.existsSync(aside)) {
      // 替身是**一次性产物**（fixture 的副本），删不掉不影响正确性 —— 留个明确的痕迹，
      // 由下次运行的 recoverLeftoverStash() 兜掉，绝不让它冒充"暂存未放回"。
      try {
        fs.rmSync(aside, { recursive: true, force: true })
      } catch {
        console.log(`[信息] 替身目录未能删除，已留给下次自愈清理：${path.relative(ROOT, aside)}`)
      }
    }
    console.log('[信息] 真实 current 已放回')
  } catch (error) {
    console.error(`[严重] 真实 current 放回失败，暂存仍在：${SWAP_DIR} —— ${error.message}`)
    process.exitCode = 3
  }
}

/** 清理替身运行时与探针文件（只碰本项目内我们自己的产物），并把真实 current 放回。 */
function cleanup() {
  try {
    if (fs.existsSync(SESSION_PROBE)) fs.rmSync(SESSION_PROBE, { force: true })
    if (fs.existsSync(TEMP_PROBE)) fs.rmSync(TEMP_PROBE, { force: true })
  } catch (error) {
    console.log(`(清理时出现问题：${error.message})`)
  }
  // 先放回真实运行时（内部会把替身先 rename 挪开，再删除），再兜底收尾。
  // 顺序很重要：绝不先删替身 —— 那会制造一个"current 缺失"的不可逆窗口。
  restoreRealCurrent()
  try {
    // 放回失败时（SWAP_DIR 仍在）不碰任何东西，把现场留给下一次自愈和人工排查
    if (fs.existsSync(SWAP_DIR)) return
    if (fs.existsSync(CURRENT) && isFakeCurrent()) fs.rmSync(CURRENT, { recursive: true, force: true })
    if (fs.existsSync(RUNTIME_DIR) && fs.readdirSync(RUNTIME_DIR).length === 0) fs.rmdirSync(RUNTIME_DIR)
  } catch (error) {
    console.log(`(清理时出现问题：${error.message})`)
  }
}

/** 场景定义：每项一个步骤，失败即停。 */
const SCENARIO = [
  ['装载替身运行时到 runtime/dsh/current', () => {
    fs.mkdirSync(CURRENT, { recursive: true })
    for (const name of fs.readdirSync(FIXTURE)) {
      fs.copyFileSync(path.join(FIXTURE, name), path.join(CURRENT, name))
    }
    assert.ok(fs.existsSync(path.join(CURRENT, 'cli.js')), '替身入口未就位')
  }],

  ['doctor 在有运行时的情况下能组装启动命令', async () => {
    const result = await nomad(['doctor'])
    assert.ok(result.stdout.includes('fake-dsh'), `doctor 未识别替身运行时：\n${result.stdout}`)
    const parts = result.stdout.split('[ OK ] 启动命令')
    assert.equal(parts.length, 2, `启动命令检查项未通过：\n${result.stdout}`)
    const block = parts[1]
    assert.ok(block.includes('cli.js'), `启动命令缺少运行时入口：\n${block}`)
    assert.ok(block.includes(`--profile ${EXPECTED_PROFILE}`), `启动命令缺少 --profile ${EXPECTED_PROFILE}（应与 config/nomad.yaml 的 runtime.dsh.profile 一致）`)
    assert.ok(block.includes('--port 0'), '启动命令缺少 --port 0（端口必须交给 OS 协商）')
    assert.ok(block.includes('--no-open'), '启动命令缺少 --no-open（浏览器交接权归 Nomad）')
    assert.ok(!block.includes('npx'), '启动命令出现 npx（铁律 8 禁止）')
  }],

  ['nomad start（后台）就绪并返回 0', async () => {
    const result = await nomad(['start', '--no-browser', '--timeout', '40000'])
    assert.equal(result.status, 0, `start 退出码 ${String(result.status)}\n${result.stdout}\n${result.stderr}`)
    assert.ok(result.stdout.includes('Nomad 已就绪'), `未就绪：\n${result.stdout}`)
  }],

  ['状态文件记录 ready + 带 token 的 URL + OS 协商端口', () => {
    assert.ok(fs.existsSync(STATE), '状态文件未生成')
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    assert.equal(state.phase, 'ready')
    assert.equal(state.profile, EXPECTED_PROFILE, '状态文件里的 profile 应与配置一致（不写死，见文件头说明）')
    assert.equal(state.runtime.name, 'fake-dsh')
    assert.match(state.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/, `URL 形态异常：${String(state.url)}`)
    assert.ok(Number(state.port) > 0, '端口应来自 OS 协商')
    assert.ok(String(state.command).includes('--port 0'), '命令应使用 --port 0')
    assert.ok(!String(state.command).includes('npx'), '命令中不应出现 npx')
    assert.equal(state.publicUrl, `http://127.0.0.1:${String(state.port)}/`, `脱敏 URL 异常：${String(state.publicUrl)}`)
  }],

  ['零污染：会话写进盘内 $DSH_HOME', () => {
    assert.ok(fs.existsSync(SESSION_PROBE), `会话未写进盘内：${SESSION_PROBE}`)
  }],

  ['零污染：TEMP 重定向到盘内，宿主临时目录未被写', () => {
    assert.ok(fs.existsSync(TEMP_PROBE), `临时文件未落到盘内：${TEMP_PROBE}`)
    assert.equal(fs.existsSync(HOST_TEMP_PROBE), false, `宿主临时目录被写：${HOST_TEMP_PROBE}`)
  }],

  ['nomad status 报告运行中（退出码 0）且 HTTP 可达', async () => {
    const result = await nomad(['status'])
    assert.equal(result.status, 0, `status 退出码 ${String(result.status)}\n${result.stdout}`)
    assert.ok(result.stdout.includes('运行中'), `未见运行中：\n${result.stdout}`)
    assert.ok(result.stdout.includes('可达'), `HTTP 不可达：\n${result.stdout}`)
  }],

  ['nomad url 与状态文件一致', async () => {
    const result = await nomad(['url'])
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    assert.equal(result.stdout.trim(), state.url)
  }],

  ['重复 start 不会起第二个实例', async () => {
    const result = await nomad(['start', '--no-browser', '--timeout', '5000'])
    assert.equal(result.status, 0, `重复 start 退出码 ${String(result.status)}`)
    assert.ok(result.stdout.includes('已在运行'), `未识别已运行实例：\n${result.stdout}`)
  }],

  ['nomad stop 干净停止并清理状态文件', async () => {
    const result = await nomad(['stop'])
    assert.equal(result.status, 0, `stop 退出码 ${String(result.status)}\n${result.stdout}`)
    assert.ok(!fs.existsSync(STATE), '状态文件未被清理')
  }],

  ['停止后 status 返回未运行（退出码 3）', async () => {
    const result = await nomad(['status'])
    assert.equal(result.status, 3, `期望退出码 3，实际 ${String(result.status)}\n${result.stdout}`)
  }],

  ['清理替身运行时，并把真实 current 原样放回', () => {
    cleanup()
    assert.equal(isFakeCurrent(), false, '替身运行时未清理干净')
    if (originalManifestText !== null) {
      assert.ok(fs.existsSync(CURRENT), '真实 current 未放回')
      assert.equal(
        fs.readFileSync(path.join(CURRENT, 'nomad-runtime.json'), 'utf8'),
        originalManifestText,
        '放回的 manifest 与暂存前不一致',
      )
    }
  }],
]

/**
 * 主流程。
 * @returns {Promise<void>} 完成
 */
async function main() {
  console.log('── Nomad Portable Smoke Test ──')
  console.log(`NOMAD_ROOT = ${ROOT}`)
  console.log('')

  // 自愈：先把上一次被中途杀掉留下的暂存处理掉，再开始这一轮
  recoverLeftoverStash()

  // 安全闸：真实运行时绝不丢弃 —— 先暂存，结束（含异常与信号）时逐字放回
  process.on('exit', restoreRealCurrent)
  process.on('SIGINT', () => {
    restoreRealCurrent()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    restoreRealCurrent()
    process.exit(143)
  })
  evictRealCurrent()
  if (fs.existsSync(CURRENT)) fs.rmSync(CURRENT, { recursive: true, force: true })

  // 清理可能残留的实例
  await nomad(['stop'])

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
      cleanup()
      await nomad(['stop'])
      break
    }
  }

  console.log('')
  if (failed === 0) {
    console.log(`合计：通过 ${String(executed)} / 失败 0 —— 便携引导闭环成立`)
  } else {
    console.log(`合计：通过 ${String(executed)} / 失败 ${String(failed)}（首个失败即停；剩余 ${String(SCENARIO.length - executed - failed)} 步未执行）`)
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 70
})
