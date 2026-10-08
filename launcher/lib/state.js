'use strict'

/**
 * 运行状态文件：`<NOMAD_ROOT>/data/run/nomad.state.json`。
 *
 * ⚠️ 安全提示：该文件包含**带 launch token 的浏览器 URL**（DSH 用它给浏览器铸 cookie）。
 * 因此：
 *   - 写入权限收紧为 0600；
 *   - 该目录必须留在盘内（`data/run/`），并在 `.gitignore` 中排除；
 *   - 日志里绝不打印带 token 的 URL（见 `dsh-url.js#sanitizeUrl`）。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 状态文件名。 */
const STATE_NAME = 'nomad.state.json'

/**
 * 心跳间隔（监督进程写状态文件的频率）。
 * @type {number}
 */
const HEARTBEAT_INTERVAL_MS = 5000

/**
 * 心跳容忍上限：超过此值即认为状态文件已陈旧，**不得再按其中的 PID 杀进程**。
 *
 * 为什么必须这么保守：PID 会被操作系统复用。一个陈旧状态文件里的 pid 可能
 * 已经在指某个毫不相干的进程（编辑器、浏览器、你的 shell），此时盲杀就是事故。
 * 拿不到新鲜心跳时，正确做法是**如实报告并交给用户人工确认**，而不是"尽力清理"。
 *
 * @type {number}
 */
const HEARTBEAT_MAX_AGE_MS = 25000

/**
 * 是否持有新鲜心跳。
 * @param {object} state - 状态对象
 * @returns {boolean} 新鲜则为 true
 */
function isFresh(state) {
  if (state === null || typeof state !== 'object') return false
  const stamp = Date.parse(String(state.heartbeatAt ?? state.startedAt ?? ''))
  if (!Number.isFinite(stamp)) return false
  return Date.now() - stamp <= HEARTBEAT_MAX_AGE_MS
}

/**
 * 状态文件绝对路径。
 * @param {string} root - NOMAD_ROOT
 * @returns {string} 路径
 */
function stateFile(root) {
  return path.join(root, 'data', 'run', STATE_NAME)
}

/**
 * 读取状态（容错：文件缺失或损坏返回 null）。
 * @param {string} root - NOMAD_ROOT
 * @returns {object|null} 状态对象
 */
function readState(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 写入状态（自动建目录，权限 0600）。
 * @param {string} root - NOMAD_ROOT
 * @param {object} state - 状态对象
 * @returns {string} 写入的文件路径
 */
function writeState(root, state) {
  const file = stateFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return file
}

/**
 * 同步退避等待。
 * @param {number} ms - 毫秒
 * @returns {void}
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 删除状态文件（带退避重试）。
 *
 * 为什么要重试：Windows 上刚被其他进程读过/写过的文件会短暂处于占用态，单次
 * rmSync 就会失败；外部安全软件也可能拦截删除。失败的后果不是灾难（陈旧状态会被
 * `isFresh` 的 PID 安全闸拦下），但会留下垃圾文件、让 `status` 多绕一圈，所以要重试。
 *
 * @param {string} root - NOMAD_ROOT
 * @returns {boolean} 状态文件是否确实已不存在
 */
function clearState(root) {
  const file = stateFile(root)
  if (!fs.existsSync(file)) return true
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 被占用或被拦：退避后重试 */
    }
    if (!fs.existsSync(file)) return true
    sleepSync(40 * (attempt + 1))
  }
  return !fs.existsSync(file)
}

/**
 * 判断进程是否存活（信号 0 探测；不存在则返回 false）。
 * @param {number} pid - 进程号
 * @returns {boolean} 存活则为 true
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

module.exports = {
  stateFile,
  readState,
  writeState,
  clearState,
  isAlive,
  isFresh,
  STATE_NAME,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_AGE_MS,
}
