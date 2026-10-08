#!/usr/bin/env node
'use strict'

/**
 * 陈旧状态安全闸验证。
 *
 * 场景：状态文件存在（心跳过期），其中记录的 PID 指向一个**无辜的存活进程**。
 * 期望：`nomad stop` 拒绝按 PID 杀进程，如实报告，并清理状态文件；
 *       那个无辜进程必须仍然活着。
 *
 * 这条测试保护的是"PID 被系统复用"这一类事故：如果 stop 盲信状态文件，
 * 用户机器上任何一个碰巧复用该 PID 的程序都可能被杀掉。
 *
 * 用法：node tests/smoke/stale-state-guard.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const NOMAD = path.join(ROOT, 'launcher', 'nomad.js')
const STATE = path.join(ROOT, 'data', 'run', 'nomad.state.json')
const { HEARTBEAT_MAX_AGE_MS } = require(path.join(ROOT, 'launcher', 'lib', 'state.js'))

/**
 * 执行 nomad 子命令。
 * @param {string[]} args - 参数
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>} 结果
 */
function nomad(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NOMAD, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
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
    child.on('exit', (code) => {
      resolve({ status: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 判断进程是否存活。
 * @param {number} pid - 进程号
 * @returns {boolean} 存活则为 true
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 主流程。
 * @returns {Promise<void>} 完成
 */
async function main() {
  console.log('── Nomad 陈旧状态安全闸验证 ──')

  // 1. 造一个"无辜进程"，并等它真的起来
  const innocent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve) => {
    setTimeout(resolve, 500)
  })
  assert.ok(alive(innocent.pid), '无辜进程未启动')
  console.log(`[准备] 无辜进程 pid=${String(innocent.pid)}`)

  // 2. 写入一个心跳过期的状态文件，PID 指向它
  const stale = new Date(Date.now() - HEARTBEAT_MAX_AGE_MS - 60000).toISOString()
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  fs.writeFileSync(STATE, `${JSON.stringify({
    nomadRoot: ROOT,
    supervisorPid: innocent.pid,
    dshPid: innocent.pid,
    phase: 'ready',
    heartbeatAt: stale,
    startedAt: stale,
  }, null, 2)}\n`, 'utf8')
  console.log('[准备] 已写入心跳过期的状态文件（PID 指向无辜进程）')

  // 3. 执行 stop，期望拒绝并返回 1
  const result = await nomad(['stop'])
  console.log('')
  console.log(`[结果] stop 退出码 = ${String(result.status)}`)
  console.log(`[结果] 输出：${result.stdout.trim().split('\n').join(' / ')}`)
  if (result.stderr.trim() !== '') console.log(`[结果] 错误输出：${result.stderr.trim().split('\n').join(' / ')}`)

  let failed = 0
  /**
   * 断言一步。
   * @param {string} name - 名称
   * @param {() => void} fn - 断言体
   * @returns {void}
   */
  const check = (name, fn) => {
    try {
      fn()
      console.log(`[ OK ] ${name}`)
    } catch (error) {
      failed += 1
      console.log(`[FAIL] ${name}\n       ${error.message}`)
    }
  }

  check('stop 拒绝盲杀并返回 1', () => {
    assert.equal(result.status, 1, `期望退出码 1，实际 ${String(result.status)}`)
  })
  check('stop 明确告知跳过了停止操作', () => {
    assert.ok(result.stderr.includes('已跳过停止操作'), `未见拒绝说明：${result.stderr}`)
  })
  check('无辜进程仍然存活（未被误杀）', () => {
    assert.ok(alive(innocent.pid), `无辜进程 pid=${String(innocent.pid)} 被杀掉了`)
  })
  check('陈旧状态文件已被清理', () => {
    assert.equal(fs.existsSync(STATE), false, '状态文件仍存在')
  })

  // 收尾：结束无辜进程
  try {
    innocent.kill()
  } catch {
    /* 已退出 */
  }

  console.log('')
  console.log(failed === 0 ? '合计：通过 4 / 失败 0 —— 安全闸有效' : `合计：失败 ${String(failed)}`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`stale-guard: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 70
})
