'use strict'

/**
 * HTTP 可达性探测。
 *
 * 用途：`nomad status` 判断实例是否真的在服务，以及 `start` 在拿到 URL 行之后
 * 做一次确认。注意 DSH 的根路径在未带 token 时返回 401 —— **401 也算可达**，
 * 因为它证明服务器已经绑定并开始应答。
 */

const http = require('node:http')
const https = require('node:https')

/**
 * 发起一次 GET 探测。
 * @param {string} url - 目标 URL
 * @param {{ timeoutMs?: number }} [options] - 超时
 * @returns {Promise<{ reachable: boolean, status?: number, error?: string }>} 探测结果
 */
function probeHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1500
  return new Promise((resolve) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      resolve({ reachable: false, error: `无法解析 URL` })
      return
    }
    const client = parsed.protocol === 'https:' ? https : http
    const request = client.request(
      parsed,
      { method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'nomad-launcher' } },
      (response) => {
        response.resume()
        resolve({ reachable: true, status: response.statusCode ?? 0 })
      },
    )
    request.on('timeout', () => {
      request.destroy(new Error(`探测超时（${timeoutMs}ms）`))
    })
    request.on('error', (error) => {
      resolve({ reachable: false, error: error.message })
    })
    request.end()
  })
}

/**
 * 轮询等待目标可达。
 * @param {string} url - 目标 URL
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] - 超时与轮询间隔
 * @returns {Promise<boolean>} 超时前可达则为 true
 */
async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 300
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await probeHttp(url, { timeoutMs: Math.min(1500, Math.max(300, timeoutMs)) })
    if (result.reachable) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * 阻塞式等待某个文件出现（默认用于等待状态文件落地）。
 * @param {string} file - 文件路径
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] - 超时与轮询间隔
 * @returns {Promise<boolean>} 超时前出现则为 true
 */
async function waitForFile(file, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 200
  const fs = require('node:fs')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fs.existsSync(file)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

module.exports = { probeHttp, waitForHttp, waitForFile }
