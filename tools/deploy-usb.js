#!/usr/bin/env node
'use strict'

/**
 * deploy-usb.js — 把 Nomad 从开发机部署到可移动盘（U 盘 / 移动硬盘 / SD 卡）
 *
 * 为什么需要它：一块盘上的 Nomad 是 32,000+ 个文件 / 约 604 MB，而部署**不是**「拖过去」：
 *   1. exFAT / FAT32 不支持符号链接与 junction —— 必须先证明整棵树里没有链接；
 *   2. 树里有 1 条 264 字符的路径，超过 Windows 传统 260 上限 —— 必须知道谁能处理、谁不能；
 *   3. 开发机有约 471 MB 专属内容（上游源码 / 下载缓存 / 内部记忆）绝不该上盘；
 *   4. `data/` 里有明文凭据（ADR-0019）—— 默认不带，目标盘全新初始化。
 *
 * 复制实现**有意不用 robocopy**：
 *   · 零外部依赖，Windows / Linux / macOS 同一套逻辑；
 *   · Node 的 libuv 在 Windows 上会自动给绝对路径加 `\\?\` 前缀，**长路径天然可用**
 *     （实测 264 字符路径可写入并回读；这正是不用 robocopy 的原因之一）；
 *   · 「目标已存在且大小一致则跳过」⇒ 中断后可原样重跑，自动续传。
 *
 * 依据：docs/DEPLOY.md、ADR-0016（清单指针而非软链）、ADR-0019（凭据不上盘）、ADR-0027。
 *
 * 用法：
 *   node tools/deploy-usb.js --target E:\            # 预检 + 复制 + 对账
 *   node tools/deploy-usb.js --target E:\ --dry-run  # 只预检与打印计划，不写入目标盘
 *   node tools/deploy-usb.js --target E:\ --force    # 目标盘已有 Nomad 时仍继续
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { detectRoot } = require('../launcher/lib/root.js')

// ── 常量 ────────────────────────────────────────────────────────────────────

/** Windows 传统路径长度上限。Node 运行时不受它约束（libuv 自动加 `\\?\`），但非 Node 工具会。 */
const MAX_PATH_LEN = 260

/** 目标文件系统不允许出现的字符。 */
const ILLEGAL_NAME = /[<>:"|?*\u0000-\u001f]/

/** 随盘的目录（白名单驱动：不在此列者默认**不上盘**）。 */
const DEPLOY_DIRS = ['launcher', 'config', 'docs', 'packages', 'runtime']

/**
 * 体量占 99.5% 且**日常开发不会变动**的目录。`--app-only` 会跳过它，
 * 把「改一行代码 → 同步到盘」从事后统计的 3.7s 压到亚秒级。
 * 其变动只可能来自「升级 DSH / Node 版本」—— 那种情况必须走全量，故设版本戳守卫。
 */
const RUNTIME_DIR = 'runtime'

/** 运行时的版本标识文件：`--app-only` 用它快速判断「runtime 有没有变」而不必扫描 32,089 个文件。 */
const RUNTIME_STAMPS = [
  'runtime/dsh/current/nomad-runtime.json',
  'runtime/node/NOMAD_NODE_VERSION',
]

/** 随盘的根文件。 */
const DEPLOY_FILES = [
  'Nomad.cmd',
  'Nomad-Stop.cmd',
  'Nomad-Restart.cmd',
  'Nomad-Doctor.cmd',
  'nomad',
  'VERSION',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.gitignore',
]

/** 明确不上盘的顶层条目（仅用于分类提示，白名单模式下本就不会被复制）。 */
const EXCLUDE = [
  'vendor',     // 上游 DSH 源码：仅开发机阅读，152.6 MB
  '.cache-dev', // 下载缓存与一次性脚本，318.3 MB
  '.workbuddy', // 工作区记忆与当日日志：含内部推理与宿主路径
  '.cursor',    // 编辑器配置
  'tests',      // 自检脚本（决策：运行最小集不带）
  'tools',      // 开发机工具（含本部署器本身）：盘上不需要「部署盘」的能力
  'data',       // 运行态 + 明文凭据 → 目标盘全新初始化
  'workspace',
  'skills',
  'profiles',
  'mcp',
  '.git',
]

/** 目标盘需要重建的空骨架（doctor 的「目录基线」检查对象；DSH 首次启动会填充）。 */
const SKELETON = [
  'data/dsh-home',
  'data/tmp',
  'data/logs',
  'data/run',
  'data/backups',
  'workspace',
  'skills',
  'profiles',
  'mcp',
]

/** 复制时按文件名跳过的运行态残留（可写性探针等）。 */
const SKIP_NAMES = ['.nomad-write-probe']

// ── 小工具 ──────────────────────────────────────────────────────────────────

function human(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function num(n) {
  return n.toLocaleString('en-US')
}

function emptyAcc() {
  return {
    files: 0, dirs: 0, bytes: 0, longestRel: '',
    symlinks: [], caseCollisions: [], illegal: [], skipped: [], longPaths: [],
  }
}

// ── 扫描（只读） ────────────────────────────────────────────────────────────

/**
 * 递归扫描一个条目，同时产出规模与四项可移植性风险。
 * @param {string} abs - 绝对路径
 * @param {string} rel - 相对 NOMAD_ROOT 的路径，用 `/` 分隔
 * @param {object} acc - 累加器
 */
function scanEntry(abs, rel, acc) {
  let st
  try { st = fs.lstatSync(abs) } catch { return }

  if (st.isSymbolicLink()) { acc.symlinks.push(rel); return }

  if (st.isDirectory()) {
    acc.dirs++
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    const seen = new Map()
    for (const ent of entries) {
      const lower = ent.name.toLowerCase()
      if (seen.has(lower) && seen.get(lower) !== ent.name) {
        acc.caseCollisions.push(`${rel}/${ent.name}  ←→  ${seen.get(lower)}`)
      } else if (!seen.has(lower)) {
        seen.set(lower, ent.name)
      }
      if (ILLEGAL_NAME.test(ent.name)) acc.illegal.push(`${rel}/${ent.name}`)
      if (SKIP_NAMES.includes(ent.name)) { acc.skipped.push(`${rel}/${ent.name}`); continue }
      scanEntry(path.join(abs, ent.name), `${rel}/${ent.name}`, acc)
    }
    return
  }

  acc.files++
  acc.bytes += st.size
  if (rel.length > acc.longestRel.length) acc.longestRel = rel
  if (rel.length >= MAX_PATH_LEN) acc.longPaths.push(rel)
}

function scanTree(abs, rel) {
  const acc = emptyAcc()
  scanEntry(abs, rel, acc)
  return acc
}

// ── 文件清单（复制用） ──────────────────────────────────────────────────────

/** 把白名单展开为 `{ rel, size }` 列表（rel 用 `/` 分隔）。 */
function collectFiles(root, dirs = DEPLOY_DIRS) {
  const out = []
  const pushDir = (abs, rel) => {
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (SKIP_NAMES.includes(ent.name)) continue
      const a = path.join(abs, ent.name)
      const r = `${rel}/${ent.name}`
      let st
      try { st = fs.lstatSync(a) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) pushDir(a, r)
      // 非 runtime 的内容（文档 / 配置 / 启动器 / 自研包）改动频繁且体量极小 → 每次强制覆盖，
      // 避免「大小恰好相同但内容已变」被 size 判据漏掉。runtime/ 是打包产物，用 size 判据快速跳过。
      else out.push({ rel: r, size: st.size, always: !r.startsWith('runtime/') })
    }
  }
  for (const d of dirs) {
    const abs = path.join(root, d)
    if (fs.existsSync(abs)) pushDir(abs, d)
  }
  for (const f of DEPLOY_FILES) {
    const abs = path.join(root, f)
    if (fs.existsSync(abs)) out.push({ rel: f, size: fs.statSync(abs).size, always: true })
  }
  return out
}

// ── runtime 版本戳守卫（`--app-only` 的安全阀） ───────────────────────────────

/**
 * 只读两个极小的版本标识文件，回答「盘上的 runtime 和源端是不是同一个版本」。
 * 目的：让 `--app-only` 不必扫描 32,089 个文件，又不会在「升级了 DSH/Node 却只推了 app」时静默漏同步。
 * @returns {string[]} 问题描述列表；空数组 = 一致
 */
function checkRuntimeStamps(root, target) {
  const problems = []
  for (const rel of RUNTIME_STAMPS) {
    const abs = path.join(root, ...rel.split('/'))
    if (!fs.existsSync(abs)) continue // 源端本就没有这项标识 → 无从比较，跳过
    const dst = path.join(target, ...rel.split('/'))
    if (!fs.existsSync(dst)) { problems.push(`${rel} —— 目标盘没有（runtime 尚未部署？）`); continue }
    const a = fs.readFileSync(abs)
    const b = fs.readFileSync(dst)
    if (!a.equals(b)) problems.push(`${rel} —— 内容与源端不同`)
  }
  return problems
}

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { target: null, dryRun: false, force: false, appOnly: false, help: false, concurrency: 12 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target' || a === '-t') {
      opts.target = argv[++i]
      if (opts.target === undefined) throw new Error('--target 需要一个路径参数')
    } else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force') opts.force = true
    else if (a === '--app-only') opts.appOnly = true
    else if (a === '--concurrency' || a === '-c') {
      opts.concurrency = Number(argv[++i])
      if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
        throw new Error('--concurrency 需要一个 ≥1 的整数')
      }
    } else if (a === '--help' || a === '-h') opts.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

function printUsage() {
  console.log([
    'Nomad → 可移动盘 部署',
    '',
    '用法：',
    '  node tools/deploy-usb.js --target <盘符根> [选项]',
    '',
    '选项：',
    '  -t, --target <dir>     目标盘根目录，如 E:\\ 或 E:/（建议直接用盘符根）',
    '      --dry-run          只预检并打印计划，不写入目标盘',
    '      --app-only         只同步非 runtime 内容（日常开发循环用；亚秒级）',
    '      --force            目标盘已有 Nomad 时仍继续（默认拒绝，防误覆盖）',
    '  -c, --concurrency <n>  并发复制数（默认 12）',
    '  -h, --help             显示本帮助',
    '',
    '示例：',
    '  node tools/deploy-usb.js --target E:\\ --dry-run',
    '  node tools/deploy-usb.js --target E:\\',
    '  node tools/deploy-usb.js --target E:\\ --app-only   # 日常：只推 app 层',
  ].join('\n'))
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { printUsage(); return 0 }
  if (!opts.target) { printUsage(); return 2 }

  console.log('Nomad → 可移动盘 部署')
  console.log('')

  // 1. 定位源根
  const { root, source } = detectRoot({ fromDir: path.resolve(__dirname, '..') })
  const target = path.resolve(opts.target)

  // 2. 目标合法性（防自复制）
  const inside = (child, parent) => {
    const r = path.relative(parent, child)
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
  }
  if (inside(target, root)) {
    console.error(`✗ 目标 ${target} 位于源 ${root} 之内，拒绝执行。`)
    return 2
  }
  if (inside(root, target)) {
    console.error(`✗ 源 ${root} 位于目标 ${target} 之内，拒绝执行。`)
    return 2
  }
  if (!fs.existsSync(target)) {
    console.error(`✗ 目标不存在：${target}`)
    return 2
  }

  console.log('── 1/6 源与目标 ──────────────────────────────')
  console.log(`  源    ${root}`)
  console.log(`        （定位依据：${source}）`)
  console.log(`  目标  ${target}`)

  // `--app-only`：跳过 runtime（日常开发不会动它），只同步 app 层 → 亚秒级重跑
  const deployDirs = opts.appOnly ? DEPLOY_DIRS.filter((d) => d !== RUNTIME_DIR) : DEPLOY_DIRS
  if (opts.appOnly) {
    console.log('  模式  --app-only（只同步 app 层，不扫描 / 不复制 runtime）')
    const stamps = checkRuntimeStamps(root, target)
    if (stamps.length > 0) {
      console.error('\n✗ --app-only 不可用：目标盘的 runtime 与源端不一致。')
      stamps.forEach((m) => console.error(`      ${m}`))
      console.error('  runtime 只在「升级 DSH / Node 版本」或「修复残缺包」时变动，那类改动必须全量。')
      console.error('  做法：去掉 --app-only 重跑一次（增量续传，只有变动的部分会被写）。')
      return 2
    }
    console.log('  runtime 版本戳  ✓ 一致（未扫描 32,089 个文件）')
  }

  // 3. 可写探针 + 已有 Nomad 检测
  const probe = path.join(target, '.nomad-deploy-probe')
  try {
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    console.log('  可写  ✓')
  } catch (e) {
    console.error(`  可写  ✗ ${e.code ?? e.message}`)
    console.error('\n目标盘不可写，部署中止。')
    return 2
  }

  const alreadyNomad = fs.existsSync(path.join(target, 'VERSION'))
    || fs.existsSync(path.join(target, 'AGENTS.md'))
  if (alreadyNomad) {
    console.log('  已有 Nomad  ✓（目标盘上已存在 VERSION / AGENTS.md）')
    if (!opts.force && !opts.dryRun) {
      console.error('\n✗ 目标盘看起来已经是一块 Nomad 盘。若要续写，请显式加 --force。')
      console.error('  提示：本工具按条目复制且不删除任何目标端文件，重跑是安全的（增量续传）。')
      return 2
    }
  } else {
    console.log('  已有 Nomad  —（空白盘，将全新初始化）')
  }

  // 「可覆盖」探针 —— 把自身内容原样写回，零风险，却能提前暴露最贵的失败。
  // 为什么必须提前问：**新建文件在 exFAT 上几乎总是成功，而覆盖已存在文件可能被拒**（EPERM）。
  // 盘上实例还在运行时，它加载过的成批文件会被句柄占用 —— 那时复制会「成功 1 个、失败 56 个」，
  // 白跑一趟才报错。这里先用 VERSION 试一次，2 秒内就说清楚。
  const coverProbe = path.join(target, 'VERSION')
  if (fs.existsSync(coverProbe)) {
    if (opts.dryRun) {
      console.log('  可覆盖  ·（--dry-run 只读，跳过写入探针；真跑时会先验证）')
    } else {
      try {
        const keep = fs.readFileSync(coverProbe)
        fs.writeFileSync(coverProbe, keep)
        console.log('  可覆盖  ✓（已存在的文件可写）')
      } catch (e) {
        console.error(`  可覆盖  ✗ ${e.code ?? e.message}`)
        console.error('')
        console.error('目标盘上「已存在的文件」当前写不进去。新建是成功的，被拒的是覆盖 —— 常见原因：')
        console.error('  · 盘上的 Nomad 实例还在运行 → 先执行 <目标盘>\\Nomad-Stop.cmd 再来部署')
        console.error('  · 实例刚停、句柄尚未释放 → 拔插一次 U 盘（或等几秒重试）')
        console.error('  · 杀毒软件正在扫描盘上文件 → 稍后重试')
        console.error('  注：无需 --force，续传机制会自动只补差异。')
        return 2
      }
    }
  }

  // 4. 部署集预检
  console.log('')
  console.log('── 2/6 部署集预检 ────────────────────────────')

  const agg = emptyAcc()
  const missing = []
  let fileCount = 0
  let fileBytes = 0

  for (const name of deployDirs) {
    const abs = path.join(root, name)
    if (!fs.existsSync(abs)) { missing.push(`${name}/`); continue }
    const r = scanTree(abs, name)
    agg.files += r.files; agg.dirs += r.dirs; agg.bytes += r.bytes
    agg.symlinks.push(...r.symlinks)
    agg.caseCollisions.push(...r.caseCollisions)
    agg.illegal.push(...r.illegal)
    agg.skipped.push(...r.skipped)
    agg.longPaths.push(...r.longPaths)
    if (r.longestRel.length > agg.longestRel.length) agg.longestRel = r.longestRel
    console.log(`  ${name.padEnd(12)}${num(r.files).padStart(9)} 文件${human(r.bytes).padStart(12)}`)
  }
  if (opts.appOnly) {
    console.log(`  ${RUNTIME_DIR.padEnd(12)}${'—'.padStart(9)}      （--app-only 跳过）`)
  }

  for (const name of DEPLOY_FILES) {
    const abs = path.join(root, name)
    if (!fs.existsSync(abs)) { missing.push(name); continue }
    const size = fs.statSync(abs).size
    fileCount++; fileBytes += size
    if (name.length > agg.longestRel.length) agg.longestRel = name
  }
  agg.files += fileCount; agg.bytes += fileBytes
  console.log(`  ${'（根文件）'.padEnd(11)}${num(fileCount).padStart(9)} 文件${human(fileBytes).padStart(12)}`)
  console.log('  ────────────────────────────────────────────')
  console.log(`  合计        ${num(agg.files).padStart(9)} 文件${human(agg.bytes).padStart(12)}`)

  if (missing.length > 0) console.log(`\n  ⚠ 缺失条目（源根里没有）：${missing.join(', ')}`)

  // 5. 可移植性风险
  console.log('')
  console.log('── 3/6 可移植性风险 ──────────────────────────')

  if (agg.symlinks.length > 0) {
    console.error(`  ✗ 符号链接 ${agg.symlinks.length} 个 —— 目标盘（exFAT/FAT32）无法承载，部署中止：`)
    agg.symlinks.slice(0, 10).forEach((s) => console.error(`      ${s}`))
    return 2
  }
  console.log('  ✓ 符号链接      0（可携带到 exFAT / FAT32）')

  const longestAbsLen = path.join(target, agg.longestRel).length
  if (longestAbsLen >= MAX_PATH_LEN) {
    console.log(`  ⚠ 最长路径      ${longestAbsLen} 字符（超过传统上限 ${MAX_PATH_LEN}）`)
    console.log(`      最长项：${agg.longestRel}`)
    console.log(`      共 ${agg.longPaths.length} 条 ≥${MAX_PATH_LEN} 字符的路径`)
    console.log('      · Node 运行时**不受影响**：libuv 会自动加 `\\\\?\\` 前缀（ADR-0027 已实测）')
    console.log('      · 但资源管理器、copy 命令等非 Node 工具有可能读不到它')
    console.log('      · 缩短办法：直接用盘符根作目标（E:\\ 前缀 3 字符，已是最短）')
  } else {
    console.log(`  ✓ 最长路径      ${longestAbsLen} 字符（未超 ${MAX_PATH_LEN}）`)
  }

  if (agg.caseCollisions.length > 0) {
    console.error(`  ✗ 大小写冲突 ${agg.caseCollisions.length} 处 —— 目标盘不区分大小写，会互相覆盖，部署中止：`)
    agg.caseCollisions.slice(0, 10).forEach((s) => console.error(`      ${s}`))
    return 2
  }
  console.log('  ✓ 大小写冲突    0')

  if (agg.illegal.length > 0) {
    console.error(`  ✗ 非法文件名字符 ${agg.illegal.length} 处：`)
    agg.illegal.slice(0, 10).forEach((s) => console.error(`      ${s}`))
    return 2
  }
  console.log('  ✓ 非法文件名    0')

  if (agg.skipped.length > 0) {
    console.log(`  · 跳过运行态残留 ${agg.skipped.length} 个（${SKIP_NAMES.join(', ')}）`)
  }

  // 6. 目标盘空间
  console.log('')
  console.log('── 4/6 目标盘空间 ────────────────────────────')
  try {
    const s = fs.statfsSync(target)
    const free = s.bavail * s.bsize
    const total = s.blocks * s.bsize
    console.log(`  可用 ${human(free)} / 共 ${human(total)}`)
    if (opts.appOnly) {
      console.log(`  本次写入 ${human(agg.bytes)}（仅 app 层；runtime 不参与本次同步，不计入占比）`)
    } else {
      console.log(`  部署集占比 ${(agg.bytes / free * 100).toFixed(1)}%${agg.bytes < free ? '  ✓ 放得下' : '  ✗ 空间不足'}`)
      if (agg.bytes / free > 0.8) console.log('  ⚠ 占用超过 80%：小文件在 exFAT 上按簇对齐，实际占用会明显更大')
    }
    if (agg.bytes >= free) return 2
  } catch (e) {
    console.log(`  （无法读取空间：${e.code ?? e.message}）`)
  }

  // 7. 未分类条目（防漂移：源根新增内容不会被静默带上盘）
  const unclassified = fs.readdirSync(root).filter(
    (n) => !DEPLOY_DIRS.includes(n) && !DEPLOY_FILES.includes(n) && !EXCLUDE.includes(n),
  )
  if (unclassified.length > 0) {
    console.log('')
    console.log('  ⚠ 未分类的顶层条目（默认不上盘；请显式归入白名单或排除清单）：')
    unclassified.forEach((n) => console.log(`      ${n}`))
  }

  // 8. 复制计划
  console.log('')
  console.log('── 5/6 复制计划 ──────────────────────────────')
  const plan = [
    ...deployDirs.filter((d) => fs.existsSync(path.join(root, d))).map((d) => `${d}/`),
    ...DEPLOY_FILES.filter((f) => fs.existsSync(path.join(root, f))),
  ]
  plan.forEach((p) => console.log(`  ${p}`))
  console.log(`  + 骨架目录 ${SKELETON.length} 个（复制后创建）`)

  if (opts.dryRun) {
    console.log('')
    console.log('--dry-run：预检通过，未写入任何内容。去掉 --dry-run 即开始复制。')
    return 0
  }

  // 9. 执行复制
  console.log('')
  console.log('── 6/6 执行 ──────────────────────────────────')
  const t0 = Date.now()
  const limit = Math.max(1, opts.concurrency)

  const files = collectFiles(root, deployDirs)
  const dirs = new Set()
  for (const f of files) {
    const d = path.dirname(f.rel)
    if (d !== '.') dirs.add(d) // 根文件的 dirname 是 '.'，拼出来会变成盘符根 E:\ → EPERM
  }

  // 目录先建（含深层嵌套），并发建以缩短 USB 上的等待
  const dirList = [...dirs]
  let di = 0
  const dirErrors = []
  async function dirWorker() {
    for (;;) {
      const my = di++
      if (my >= dirList.length) return
      const abs = path.join(target, ...dirList[my].split('/'))
      try {
        await fsp.mkdir(abs, { recursive: true })
      } catch (e) {
        if (e.code !== 'EEXIST') dirErrors.push(`${dirList[my]}  →  ${e.code ?? e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(4, limit) }, dirWorker))

  if (dirErrors.length > 0) {
    console.error(`  ✗ 有 ${dirErrors.length} 个目录创建失败：`)
    dirErrors.slice(0, 15).forEach((s) => console.error(`      ${s}`))
    return 3
  }
  console.log(`  ✓ 目录结构     ${num(dirList.length)} 个已就绪`)

  // 文件并发复制（已存在且大小一致则跳过 ⇒ 天然续传）
  let idx = 0
  let done = 0
  let skipped = 0
  let copiedBytes = 0
  const failures = []
  const total = files.length

  async function worker() {
    for (;;) {
      const my = idx++
      if (my >= total) return
      const f = files[my]
      const dst = path.join(target, ...f.rel.split('/'))
      try {
        // runtime/ 用「存在且大小一致」快速跳过（占 99.5% 的文件量）；
        // 文档 / 配置 / 根文件强制覆盖，避免同尺寸改内容被漏掉
        let exists = false
        if (f.always !== true) {
          try {
            const st = await fsp.stat(dst)
            exists = st.size === f.size
          } catch { exists = false }
        }

        if (exists) {
          skipped++
        } else {
          await fsp.copyFile(path.join(root, ...f.rel.split('/')), dst)
          copiedBytes += f.size
        }
        done++
        if (done % 5000 === 0) {
          console.log(`     ${num(done)}/${num(total)} …`)
        }
      } catch (e) {
        failures.push(`${f.rel}  →  ${e.code ?? e.message}`)
        done++
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const mbps = copiedBytes > 0 ? (copiedBytes / 1024 / 1024 / Number(elapsed)).toFixed(1) : '—'
  console.log(`  ✓ 文件         ${num(files.length - skipped)} 个已复制（${human(copiedBytes)}），${num(skipped)} 个已是最新`)
  console.log(`  ✓ 耗时         ${elapsed}s  ·  ${mbps} MB/s（并发 ${limit}）`)

  if (failures.length > 0) {
    console.error(`\n  ✗ 有 ${failures.length} 个文件复制失败：`)
    failures.slice(0, 15).forEach((s) => console.error(`      ${s}`))
    if (failures.length > 15) console.error(`      …… 另有 ${failures.length - 15} 个`)
    const eperm = failures.filter((s) => /EPERM|EACCES/.test(s)).length
    if (eperm > 0) {
      console.error('')
      console.error(`  ${eperm} 个失败是「权限/占用」类（EPERM）—— 失败的都是**已存在**的目标文件。`)
      console.error('  最可能是盘上的 Nomad 实例还在运行（它加载过的文件被句柄占用）。做法：')
      console.error('    1. 执行 <目标盘>\\Nomad-Stop.cmd')
      console.error('    2. 若仍失败，拔插一次 U 盘释放句柄，再重跑本工具（会自动续传，不会重拷）')
    }
    return 3
  }

  // 10. 骨架目录
  for (const d of SKELETON) {
    try {
      await fsp.mkdir(path.join(target, ...d.split('/')), { recursive: true })
    } catch (e) {
      console.error(`  ✗ 骨架 ${d}: ${e.code ?? e.message}`)
      return 3
    }
  }
  console.log(`  ✓ 骨架目录     ${SKELETON.length} 个已创建`)

  // 11. 对账
  // 注意：**以「当前源端」重新统计**，而不是沿用第 2 步的预检数字 ——
  // 部署可能耗时十几分钟（实测 USB 上 644s），期间源树若被改动，预检数字就是过期快照，
  // 会造成「虚假的不一致」。这里重扫一遍，比的才是「此刻源 vs 此刻目标」。
  console.log('')
  console.log('── 对账 ──────────────────────────────────────')
  if (opts.appOnly) console.log('  （范围：仅 app 层，不含 runtime）')
  const measure = (base) => {
    const acc = emptyAcc()
    for (const name of deployDirs) {
      const abs = path.join(base, name)
      if (!fs.existsSync(abs)) continue
      const r = scanTree(abs, name)
      acc.files += r.files; acc.bytes += r.bytes
    }
    for (const name of DEPLOY_FILES) {
      const abs = path.join(base, name)
      if (!fs.existsSync(abs)) continue
      acc.files++; acc.bytes += fs.statSync(abs).size
    }
    return acc
  }
  const srcAgg = measure(root)
  const dstAgg = measure(target)

  console.log(`  源    ${num(srcAgg.files).padStart(9)} 文件${human(srcAgg.bytes).padStart(12)}`)
  console.log(`  目标  ${num(dstAgg.files).padStart(9)} 文件${human(dstAgg.bytes).padStart(12)}`)
  if (srcAgg.files === dstAgg.files && srcAgg.bytes === dstAgg.bytes) {
    console.log('  ✓ 文件数与总字节完全一致')
  } else {
    console.error(`  ✗ 对账不一致：文件差 ${num(dstAgg.files - srcAgg.files)}，体积差 ${human(dstAgg.bytes - srcAgg.bytes)}`)
    if (srcAgg.files !== agg.files || srcAgg.bytes !== agg.bytes) {
      console.error('      ⚠ 源树在本次部署期间发生过变化（预检快照与当前不符）：')
      console.error(`        预检时 ${num(agg.files)} 文件 / ${human(agg.bytes)}，现在 ${num(srcAgg.files)} 文件 / ${human(srcAgg.bytes)}。`)
    }
    console.error('      本工具支持续传 —— 修正源树后**原样重跑**即可对齐。')
    return 4
  }

  // 12. 后续步骤
  console.log('')
  console.log(opts.appOnly
    ? '部署完成（app 层）。目标盘上重启实例即可看到改动：'
    : '部署完成。在目标盘上验证：')
  console.log(`  ${target}\\Nomad-Restart.cmd     # 已在运行 → 停止并重新启动（开发循环最常用）`)
  console.log(`  ${target}\\Nomad-Doctor.cmd      # 体检（路径 / 运行时 / 隔离 / 端口）`)
  console.log(`  ${target}\\Nomad.cmd             # 未运行 → 启动并自动打开浏览器`)
  console.log('')
  console.log('注意：')
  if (opts.appOnly) {
    console.log('  · 本次未扫描 / 未复制 runtime（仅核对版本戳一致）。')
    console.log('  · 升级 DSH 或 Node 版本后，须去掉 --app-only 做一次全量同步。')
  }
  console.log('  · 拔盘前用「安全弹出」：exFAT 有写入缓存，直接拔可能丢最近写入。')
  console.log('  · 首次启动会在盘上自举 nomad profile（ensure_profile），无需手工配置。')
  console.log('  · 盘符可以变（E: → F: → G:）：全部路径都从脚本位置派生，无需改任何配置。')
  console.log('  · 重跑本工具是安全的：已存在且大小一致的文件会跳过，只补差异（断点续传）。')
  return 0
}

main()
  .then((code) => { process.exitCode = code })
  .catch((e) => {
    console.error(`\n✗ ${e.message}`)
    process.exitCode = 1
  })
