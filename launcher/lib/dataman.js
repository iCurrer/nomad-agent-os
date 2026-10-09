'use strict'

/**
 * dataman —— Nomad 数据面管理（Phase 3.3）。
 *
 * 职责边界（对齐 ROADMAP 3.3 与 3.0-B 存储全景勘探结论）：
 *   - `storageReport`  盘内数据全景：各目录体积 / 文件数 / 最近写入时间，
 *                      按「长期-核心 / 可清理 / 其他」三档归类；
 *   - `planClean`      生成清理计划（dry-run 数据源）：**白名单**目录内、
 *                      且整条目「递归最新 mtime」早于阈值的顶层条目；
 *   - `applyClean`     执行清理（assertInside 双保险 + 绝不越白名单）。
 *
 * 安全底线（与 skills/profile 同姿态）：
 *   - 可清理白名单 = `data/tmp` + `data/dsh-home/tmp`，**写死在代码里**；
 *     sessions / storages / profiles / skills / logs / backups / run 永不出现在
 *     清理路径上 —— 白名单外的路径 assertInside 直接抛错；
 *   - 时间规则：运行中实例的 ACL 授权目录（`dsh-acl-skill-*`）可能正在使用，
 *     条目内任何文件 mtime 晚于阈值 → 整条目跳过（宁少清不多删）；
 *   - dsh-acl-locks 同规则处理：陈旧锁可清，活跃锁不动。
 */

const fs = require('node:fs')
const path = require('node:path')
const { assertInside } = require('./paths.js')

/** 清理白名单：相对 NOMAD_ROOT 的目录（写死，禁止运行期扩展）。统一正斜杠形态。 */
const CLEAN_WHITELIST = Object.freeze([
  'data/tmp',
  'data/dsh-home/tmp',
])

/** doctor / 报告用的告警阈值：tmp 超过 10 MB 或 500 文件提示清理。 */
const WARN_TMP_BYTES = 10 * 1024 * 1024
const WARN_TMP_FILES = 500

/** 默认时间阈值：条目最新 mtime 距今超过 2 小时才可清。 */
const DEFAULT_MIN_AGE_MS = 2 * 60 * 60 * 1000

/** 长期-核心目录（只报告、永不清理；与 3.0-B 勘探表一致）。 */
const LONG_TERM = Object.freeze([
  path.join('data', 'dsh-home', 'sessions'),
  path.join('data', 'dsh-home', 'storages'),
  path.join('data', 'dsh-home', 'profiles'),
  path.join('data', 'dsh-home', 'skills'),
])

/**
 * 递归统计一个目录/文件：字节数、文件数、最新 mtime。
 * 符号链接不跟随（按 lstat 计其自身），遍历失败按 0 计并记入 errors。
 * @returns {{ bytes: number, files: number, mtimeMs: number, errors: string[] }}
 */
function statEntryDeep(target) {
  const acc = { bytes: 0, files: 0, mtimeMs: 0, errors: [] }
  const walk = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch (error) {
      acc.errors.push(`${p}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (st.mtimeMs > acc.mtimeMs) acc.mtimeMs = st.mtimeMs
    if (!st.isDirectory()) {
      acc.bytes += st.size
      if (st.isFile()) acc.files += 1
      return
    }
    let names = []
    try {
      names = fs.readdirSync(p)
    } catch (error) {
      acc.errors.push(`${p}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const name of names) walk(path.join(p, name))
  }
  walk(target)
  return acc
}

function humanBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * 数据全景报告：data/ 下一级目录逐个统计 + dsh-home/tmp 单列（它藏在长期目录里但可清理）。
 * @param {{ config: object }} options
 * @returns {{ root: string, entries: Array<{rel: string, abs: string, category: 'long-term'|'cleanable'|'runtime'|'rotate'|'other', bytes: number, files: number, mtimeMs: number, exists: boolean}>, cleanableBytes: number, cleanableFiles: number, human: {cleanable: string} }}
 */
function storageReport(options) {
  const { config } = options
  const root = config.paths.root
  const dataDir = config.paths.data
  const entries = []
  const seen = new Set()

  const push = (rel, category) => {
    const abs = path.join(root, rel)
    seen.add(path.normalize(rel))
    let stat = { bytes: 0, files: 0, mtimeMs: 0, errors: [] }
    let exists = false
    try {
      fs.lstatSync(abs)
      exists = true
      stat = statEntryDeep(abs)
    } catch { /* 不存在按空计 */ }
    entries.push({ rel: rel.replaceAll('\\', '/'), abs, category, bytes: stat.bytes, files: stat.files, mtimeMs: stat.mtimeMs, exists })
  }

  for (const rel of LONG_TERM) push(rel, 'long-term')
  for (const rel of CLEAN_WHITELIST) push(rel, 'cleanable')
  push(path.join('data', 'logs'), 'rotate')
  push(path.join('data', 'backups'), 'rotate')
  push(path.join('data', 'run'), 'runtime')

  // data/ 下白名单未覆盖的一级目录 → other（发现未知目录，供人审）
  try {
    for (const name of fs.readdirSync(dataDir)) {
      const abs = path.join(dataDir, name)
      if (!fs.lstatSync(abs).isDirectory()) continue
      const relNorm = path.normalize(path.join('data', name))
      if (seen.has(relNorm)) continue
      // dsh-home 已按子目录单列；这里补 dsh-home 内 tmp 之外的部分
      if (name === 'dsh-home') {
        const dshHome = abs
        let stat = { bytes: 0, files: 0, mtimeMs: 0, errors: [] }
        try { stat = statEntryDeep(dshHome) } catch { /* 空 */ }
        const tmpStat = { bytes: 0, files: 0 }
        const tmpAbs = path.join(dshHome, 'tmp')
        try {
          const t = statEntryDeep(tmpAbs)
          tmpStat.bytes = t.bytes
          tmpStat.files = t.files
        } catch { /* 无 tmp */ }
        entries.push({
          rel: 'data/dsh-home（不含 tmp）', abs: dshHome,
          category: 'long-term',
          bytes: stat.bytes - tmpStat.bytes, files: stat.files - tmpStat.files,
          mtimeMs: stat.mtimeMs, exists: true,
        })
        continue
      }
      push(path.join('data', name), 'other')
    }
  } catch { /* data 不存在 */ }

  const cleanable = entries.filter((e) => e.category === 'cleanable')
  const cleanableBytes = cleanable.reduce((sum, e) => sum + e.bytes, 0)
  const cleanableFiles = cleanable.reduce((sum, e) => sum + e.files, 0)
  return { root, entries, cleanableBytes, cleanableFiles, human: { cleanable: humanBytes(cleanableBytes) } }
}

/**
 * 生成清理计划：白名单目录下、整条目最新 mtime 早于阈值（默认 2h）的顶层条目。
 * @param {{ config: object }} options
 * @param {{ minAgeMs?: number }} [opts]
 * @returns {{ targets: Array<{abs: string, rel: string, bytes: number, files: number}>, skipped: Array<{abs: string, rel: string, reason: string}>, totalBytes: number, totalFiles: number, minAgeMs: number }}
 */
function planClean(options, opts = {}) {
  const { config } = options
  const root = config.paths.root
  const minAgeMs = typeof opts.minAgeMs === 'number' && opts.minAgeMs >= 0 ? opts.minAgeMs : DEFAULT_MIN_AGE_MS
  const now = Date.now()
  const targets = []
  const skipped = []

  for (const rel of CLEAN_WHITELIST) {
    const base = path.join(root, rel)
    let names = []
    try {
      names = fs.readdirSync(base)
    } catch {
      continue // 白名单目录不存在 = 没什么可清
    }
    for (const name of names) {
      const abs = path.join(base, name)
      // 防御：名字必须真的落在这条白名单目录之内
      assertInside(base, abs, `清理目标 ${rel}`)
      const stat = statEntryDeep(abs)
      const relFull = `${rel.replaceAll('\\', '/')}/${name}`
      if (stat.mtimeMs > 0 && now - stat.mtimeMs < minAgeMs) {
        skipped.push({ abs, rel: relFull, reason: `最近 ${Math.max(1, Math.round((now - stat.mtimeMs) / 60000))} 分钟内有写入（可能在用）` })
        continue
      }
      targets.push({ abs, rel: relFull, bytes: stat.bytes, files: stat.files })
    }
  }

  return {
    targets,
    skipped,
    totalBytes: targets.reduce((s, t) => s + t.bytes, 0),
    totalFiles: targets.reduce((s, t) => s + t.files, 0),
    minAgeMs,
  }
}

/**
 * 执行清理。dryRun=true 只返回计划不删任何东西；false 才动手。
 * @returns 计划 + 实际结果（freedBytes / freedFiles / failures）
 */
function clean(options, opts = {}) {
  const plan = planClean(options, opts)
  if (opts.dryRun) return { ...plan, dryRun: true, freedBytes: 0, freedFiles: 0, failures: [] }

  const failures = []
  let freedBytes = 0
  let freedFiles = 0
  for (const target of plan.targets) {
    try {
      fs.rmSync(target.abs, { recursive: true, force: true })
      freedBytes += target.bytes
      freedFiles += target.files
    } catch (error) {
      failures.push({ abs: target.abs, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // 清完把白名单目录本体补回来（DSH 期望它们存在；目录基线 doctor 也查）
  const { config } = options
  for (const rel of CLEAN_WHITELIST) {
    try { fs.mkdirSync(path.join(config.paths.root, rel), { recursive: true }) } catch { /* 尽力而为 */ }
  }
  return { ...plan, dryRun: false, freedBytes, freedFiles, failures }
}

/**
 * 轻量摘要（状态端点用）：只算可清理两目录的体积/文件数，不做遍历计划。
 * @returns {{ tmpBytes: number, tmpFiles: number, human: string }}
 */
function dataSummary(options) {
  const { config } = options
  const root = config.paths.root
  let bytes = 0
  let files = 0
  for (const rel of CLEAN_WHITELIST) {
    try {
      const stat = statEntryDeep(path.join(root, rel))
      bytes += stat.bytes
      files += stat.files
    } catch { /* 不存在按 0 */ }
  }
  return { tmpBytes: bytes, tmpFiles: files, human: humanBytes(bytes) }
}

module.exports = {
  CLEAN_WHITELIST,
  LONG_TERM,
  WARN_TMP_BYTES,
  WARN_TMP_FILES,
  DEFAULT_MIN_AGE_MS,
  statEntryDeep,
  humanBytes,
  storageReport,
  planClean,
  clean,
  dataSummary,
}
