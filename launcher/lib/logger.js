'use strict'

/**
 * Launcher 日志。
 *
 * 铁律（AGENTS.md 第 7 节）：Secret 不得进入日志。
 * 因此本模块提供两层保护：
 *   1. `redactEnv` —— 打印环境变量前按名字脱敏；
 *   2. `sanitizeUrl`（见 dsh-url.js）—— 启动 URL 只打印去掉 query 的形态。
 * 日志落在 `<NOMAD_ROOT>/data/logs/`，属盘内数据，不外泄到宿主。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 命中即脱敏的变量 / 字段名。 */
const SENSITIVE = /(key|token|secret|password|passwd|credential|cookie|authorization)/i

/** 日志等级权重。 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 本地日期，格式 `YYYY-MM-DD`（避免 toISOString 的时区偏移）。
 * @param {Date} [date] - 时间点
 * @returns {string} 日期字符串
 */
function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 本地时间戳，格式 `YYYY-MM-DD HH:mm:ss`。
 * @param {Date} [date] - 时间点
 * @returns {string} 时间戳
 */
function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 保留最近 maxFiles 个日志文件。
 * @param {string} dir - 日志目录
 * @param {string} tag - 文件名前缀
 * @param {number} maxFiles - 保留数量
 * @returns {void}
 */
function prune(dir, tag, maxFiles) {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) return
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${tag}-`) && name.endsWith('.log'))
      .sort()
    for (const name of files.slice(0, Math.max(0, files.length - maxFiles))) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
  } catch {
    /* 清理失败不影响启动 */
  }
}

/**
 * 创建日志器。
 * @param {{ dir?: string, level?: string, maxFiles?: number, silent?: boolean, tag?: string, mirror?: Console }} [options]
 *   日志目录 / 等级 / 保留数 / 是否只写文件 / 前缀 / 控制台镜像
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function, filePath: string|null, level: string }} 日志器
 */
function createLogger(options = {}) {
  const tag = options.tag ?? 'nomad'
  const level = options.level ?? 'info'
  const threshold = LEVELS[level] ?? LEVELS.info
  const mirror = options.mirror === undefined ? console : options.mirror

  let filePath = null
  if (typeof options.dir === 'string' && options.dir !== '') {
    try {
      fs.mkdirSync(options.dir, { recursive: true })
      filePath = path.join(options.dir, `${tag}-${localDate()}.log`)
      prune(options.dir, tag, options.maxFiles ?? 10)
    } catch (error) {
      mirror?.error?.(`nomad: 日志目录不可写（${options.dir}）：${error.message}`)
      filePath = null
    }
  }

  const write = (levelName, message) => {
    if (LEVELS[levelName] < threshold) return
    const line = `[${localStamp()}] ${levelName.toUpperCase().padEnd(5)} ${message}`
    if (options.silent !== true && mirror !== null) {
      const sink = levelName === 'error' ? mirror.error : levelName === 'warn' ? mirror.warn : mirror.log
      sink?.call(mirror, line)
    }
    if (filePath !== null) {
      try {
        fs.appendFileSync(filePath, `${line}\n`, 'utf8')
      } catch {
        /* 磁盘写失败不应中断启动流程 */
      }
    }
  }

  return {
    level,
    filePath,
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * 打印前对环境变量做脱敏。
 * @param {Record<string, string|undefined>} env - 环境变量
 * @returns {Record<string, string>} 脱敏后的副本
 */
function redactEnv(env) {
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    out[name] = SENSITIVE.test(name) ? '[redacted]' : String(value ?? '')
  }
  return out
}

/**
 * 递归脱敏对象中的敏感字段（日志 / 诊断输出用）。
 * @param {unknown} node - 任意值
 * @returns {unknown} 脱敏后的副本
 */
function redactDeep(node) {
  if (Array.isArray(node)) return node.map((item) => redactDeep(item))
  if (node !== null && typeof node === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] = SENSITIVE.test(key) ? '[redacted]' : redactDeep(value)
    }
    return out
  }
  return node
}

module.exports = { createLogger, redactEnv, redactDeep, localDate, localStamp, SENSITIVE }
