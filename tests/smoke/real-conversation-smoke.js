#!/usr/bin/env node
'use strict'

/**
 * 阶段 3.5 —— 真实对话轮冒烟测试（用真实 DSH + 真实模型凭据）。
 *
 * 这是 ROADMAP「阶段 3.5：接真实对话轮」的验收，一次性关掉 V1 清单三条 `~`：
 *   - [~] DSH Agent 正常工作（此前只验证过「Web UI 能起」，从未跑过一轮真实模型对话）
 *   - [~] Session 持久化（此前只有空 sessions/ 目录，从无真实会话记录）
 *   - [~] 凭据注入（ADR-0019 只验过「凭据文件生成位置」，没验过「真能解析出 key 跑通」）
 *
 * 用上游 `dsh --profile headless`（one-shot 直接驱动 Agent）来做，而不是 Web UI：
 *   - headless 不弹任何 UI，纯 stdout 输出，机器可判定；
 *   - `--json` 输出 newline-delimited 事件流（session → status/text/tool_call/… → final），
 *     每个事件都是 Session 的提交点，可直接断言；
 *   - 复用 Launcher 的 buildEnv 构造隔离环境，DSH_HOME 指向盘内，key 从 .credentials.yaml 解析。
 *
 * 两条路径（缺一不可）：
 *   A. 正向：用**真实盘内 key**（data/dsh-home/.credentials.yaml）跑一轮，断言完整事件流 + final 答案。
 *   B. 负向：scratch 空 HOME 跑同一命令，断言**干净失败**于 MISSING_CREDENTIAL（证明 key 确实来自盘内文件，
 *      不是从宿主环境变量漏进来的；同时证明「无 key 时不是静默假成功」）。
 *
 * 隔离承诺：
 *   - 正向路径把 DSH_HOME 指向**真实** data/dsh-home（因为 key 就在那，Session 也该落那）；
 *   - 负向路径全在 data/tmp/ 下，不碰真实 dsh-home；
 *   - 不碰 runtime/dsh/current、不碰正在运行的实例；
 *   - 全程不打印 key 值，只打印「有/无」「长度」这种脱敏事实。
 *
 * 用法：node tests/smoke/real-conversation-smoke.js [--timeout <ms>]
 *   （真实对话会消耗模型凭据，请确认后再跑；负向路径零成本。）
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { buildEnv } = require('../../launcher/lib/env.js')
const { loadConfig } = require('../../launcher/lib/config.js')

const ROOT = path.resolve(__dirname, '..', '..')
const CURRENT = path.join(ROOT, 'runtime', 'dsh', 'current')
const CURRENT_MANIFEST = path.join(CURRENT, 'nomad-runtime.json')

/** 负向路径的 scratch（唯一会写盘的地方）。 */
const SANDBOX = path.join(ROOT, 'data', 'tmp', 'real-conversation-smoke')
const SCRATCH_HOME = path.join(SANDBOX, 'home')
const SCRATCH_TMP = path.join(SANDBOX, 'tmp')

const argv = process.argv.slice(2)
const timeoutIndex = argv.indexOf('--timeout')
const READY_TIMEOUT = timeoutIndex === -1 ? 180000 : Number(argv[timeoutIndex + 1])

/** 读真实运行时（current 清单 + 盘内 Node）。 */
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

/** 读取真实配置（拿 data/dsh-home 的绝对路径）。 */
function readHome() {
  const config = loadConfig({ root: ROOT })
  return config.paths.dsh_home
}

/**
 * 读盘内凭据文件，只返回脱敏事实（绝不返回 key 值）。
 * @param {string} home - DSH_HOME
 * @returns {{ exists: boolean, refs: string[], hasApiKey: boolean, apiKeyLen: number }}
 */
function describeCredentials(home) {
  const file = path.join(home, '.credentials.yaml')
  if (!fs.existsSync(file)) return { exists: false, refs: [], hasApiKey: false, apiKeyLen: 0 }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { exists: false, refs: [], hasApiKey: false, apiKeyLen: 0 }
  }
  // 只解析 refs 段下的顶层键名与长度，不打印值。
  const refs = []
  let inRefs = false
  let currentRef = null
  let hasApiKey = false
  let apiKeyLen = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (/^\s*refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (inRefs && /^\S/.test(line) && line.trim() !== '') break // 离开 refs 段
    if (inRefs) {
      const m = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
      if (m) {
        const name = m[1]
        const value = m[2].trim()
        refs.push(name)
        if (name === 'DEEPSEEK_API_KEY') {
          hasApiKey = true
          apiKeyLen = value.length
        }
      }
    }
  }
  return { exists: true, refs, hasApiKey, apiKeyLen }
}

/** 构造隔离环境（复用 buildEnv，DSH_HOME 指向给定 home）。 */
function makeEnv(home, tmp) {
  const { env } = buildEnv({
    root: ROOT,
    isolation: {
      enabled: true,
      strategy: 'allowlist',
      inherit_allowlist: ['path', 'systemroot', 'windir', 'comspec', 'pathext'],
      override: {
        DSH_HOME: home,
        HOME: home,
        USERPROFILE: home,
        TEMP: tmp,
        TMP: tmp,
        TMPDIR: tmp,
      },
    },
  })
  return env
}

/**
 * 跑一次 headless（异步 spawn：本机沙箱里 spawnSync 会 EBUSY 返回 status null）。
 * @param {object} runtime - readRuntime 返回值
 * @param {string[]} args - headless 参数
 * @param {string} home - DSH_HOME
 * @param {string} tmp - 临时目录
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runHeadless(runtime, args, home, tmp) {
  return new Promise((resolve) => {
    const child = spawn(runtime.nodePath, [runtime.entry, '--profile', 'headless', ...args], {
      cwd: path.join(ROOT, 'workspace'),
      env: makeEnv(home, tmp),
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
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }, READY_TIMEOUT)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\nspawn error: ${error.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 解析 --json 事件流（每行一个 JSON）。 */
function parseJsonEvents(stdout) {
  const events = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 非 JSON 行（诊断/告警）忽略 */
    }
  }
  return events
}

/** 从 --json 事件流提取 final 文本。 */
function extractFinal(events) {
  const final = events.find((event) => event.type === 'final')
  return final === undefined ? undefined : final.text
}

async function main() {
  console.log('═══ 阶段 3.5 真实对话轮冒烟 ═══')
  console.log(`超时：${READY_TIMEOUT} ms\n`)

  const runtime = readRuntime()
  if (runtime === null) {
    console.log('SKIP：运行时未就绪（runtime/dsh/current 缺失或为 fake）')
    return
  }
  console.log(`运行时：DSH ${runtime.version}`)

  const home = readHome()
  const creds = describeCredentials(home)
  console.log('盘内凭据：')
  console.log(`  .credentials.yaml 存在: ${creds.exists ? '是' : '否'}`)
  console.log(`  refs: ${creds.refs.join(', ') || '(无)'}`)
  console.log(`  DEEPSEEK_API_KEY: ${creds.hasApiKey ? `已配置（${creds.apiKeyLen} 字符，值不打印）` : '缺失'}`)
  console.log('')

  let failures = 0

  // ── 路径 B（先跑，零成本）：负向 —— 空 HOME 必须干净失败于 MISSING_CREDENTIAL ──
  console.log('── 路径 B：无凭据负向验证（不花钱、不发模型请求）──')
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH_HOME, { recursive: true })
  fs.mkdirSync(SCRATCH_TMP, { recursive: true })
  {
    const neg = await runHeadless(runtime, ['--json', 'reply with exactly: OK'], SCRATCH_HOME, SCRATCH_TMP)
    const events = parseJsonEvents(neg.stdout)
    const hasError = events.some((e) => e.type === 'error')
    const errorMsg = events.find((e) => e.type === 'error')?.message ?? ''
    const missCred = /MISSING_CREDENTIAL/i.test(neg.stdout + neg.stderr) || /no API key/i.test(neg.stderr) || /no API key/i.test(errorMsg)
    console.log(`  退出码: ${neg.code}`)
    console.log(`  有 error 事件: ${hasError ? '是' : '否'}`)
    console.log(`  判定为缺凭据: ${missCred ? '是' : '否'}`)
    if (missCred) {
      console.log('  ✅ 负向通过：空 HOME 干净失败于缺凭据，证明 key 不来自宿主环境')
    } else {
      failures += 1
      console.log('  ❌ 负向失败：空 HOME 未按预期报缺凭据')
      console.log(`    stdout(前 400): ${neg.stdout.slice(0, 400)}`)
      console.log(`    stderr(前 400): ${neg.stderr.slice(0, 400)}`)
    }
  }
  console.log('')

  // ── 路径 A：正向 —— 真实盘内 key 跑一轮 ──
  console.log('── 路径 A：真实凭据正向验证（会消耗模型凭据）──')
  if (!creds.hasApiKey) {
    console.log('  ⚠️  SKIP：盘内 .credentials.yaml 缺 DEEPSEEK_API_KEY，无法跑正向')
    console.log('      （请先在 Web UI 的 Models 页填一次 key，或手动写 refs.DEEPSEEK_API_KEY）')
  } else {
    const before = new Set()
    const sessionsDir = path.join(home, 'sessions')
    if (fs.existsSync(sessionsDir)) {
      for (const entry of fs.readdirSync(sessionsDir)) before.add(entry)
    }
    const task = 'reply with exactly: NOMAD-OK'
    const pos = await runHeadless(runtime, ['--json', task], home, path.join(home, 'tmp'))
    const events = parseJsonEvents(pos.stdout)
    const final = extractFinal(events)
    const sessionEvent = events.find((e) => e.type === 'session')
    const hasText = events.some((e) => e.type === 'text')
    const turnEnd = events.find((e) => e.type === 'status' && e.phase === 'turn_end')

    console.log(`  退出码: ${pos.code}`)
    console.log(`  session 事件: ${sessionEvent ? `是（id=${sessionEvent.sessionId}）` : '否'}`)
    console.log(`  有 text 事件: ${hasText ? '是' : '否'}`)
    console.log(`  turn_end 原因: ${turnEnd?.reason?.kind ?? '(无)'}`)
    console.log(`  final 答案: ${final === undefined ? '(无)' : JSON.stringify(final)}`)

    // 会话落盘检查
    let sessionPersisted = false
    if (fs.existsSync(sessionsDir)) {
      for (const entry of fs.readdirSync(sessionsDir)) {
        if (!before.has(entry)) {
          sessionPersisted = true
          break
        }
      }
    }
    console.log(`  Session 落盘: ${sessionPersisted ? '是（新增会话目录）' : '否（无新增）'}`)

    if (pos.code === 0 && sessionEvent !== undefined && hasText && final !== undefined && sessionPersisted) {
      console.log('  ✅ 正向通过：真实对话轮跑通，答案与会话均落盘')
    } else {
      failures += 1
      console.log('  ❌ 正向失败')
      console.log(`    stdout(前 600): ${pos.stdout.slice(0, 600)}`)
      console.log(`    stderr(前 600): ${pos.stderr.slice(0, 600)}`)
    }
  }

  console.log('')
  console.log(failures === 0 ? '═══ 全部通过 ═══' : `═══ ${failures} 项失败 ═══`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('冒烟测试异常：', error)
  process.exitCode = 1
})
