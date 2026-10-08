'use strict'

const { isInside } = require('./paths.js')

/**
 * 宿主隔离：进程级环境构造。
 *
 * 源码依据（证据等级：本地源码）：
 *   vendor/deepseek-harness/apps/desktop/scripts/test-host-updates.ts:34-39
 *     —— 上游自己的隔离先例：只保留 5 个 Windows 必需变量，其余一律不继承；
 *        并把 DSH_HOME / USERPROFILE / HOME / TEMP / TMP / TMPDIR 指向私有根。
 *   vendor/deepseek-harness/packages/util/home-paths/README.md
 *     —— `resolveDshHome()` 优先级：显式配置 > $DSH_HOME > ~/.dsh。
 *   vendor/deepseek-harness/packages/bundle/base/cordis.patch.yml:133
 *     —— `root: !!js dshHomePath('sessions')`，会话记录默认写在 $DSH_HOME/sessions。
 *
 * 结论：把 DSH_HOME 指向盘内 + 白名单继承 + 临时目录重定向，就能让 DSH 的所有
 * 写入点落在盘内。详见 docs/HOST_ISOLATION.md。
 *
 * 注意：**只影响子进程**。本模块绝不调用 setx / 注册表 / 系统环境 API。
 */

/**
 * 上游隔离先例使用的白名单（大小写不敏感匹配）。
 *
 * 相对上游 `test-host-updates.ts` 的 5 项，**多一项 `systemdrive`**：
 * 该变量值是系统盘符（`C:`），无隐私；但缺失会让 `%SystemDrive%\…` 类路径在子进程里
 * 展开失败、退化为相对路径并落到 cwd（Agent 工作区）。实测缺陷见 docs/HOST_ISOLATION.md
 * 的「SystemDrive 例外」一节。配置层同样列出（config/nomad.yaml），此处为兜底保持一致。
 */
const DEFAULT_ALLOWLIST = ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive']

/** 白名单缺失时的保底值（用于 host fallback 模式，仍尽量贴合上游配方）。 */
function normalizeAllowlist(raw) {
  const list = Array.isArray(raw) && raw.length > 0 ? raw : DEFAULT_ALLOWLIST
  return list.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/**
 * 构造隔离后的环境变量。
 * @param {{ root: string, isolation: object, extra?: Record<string,string>, base?: NodeJS.ProcessEnv }} options
 *   root / isolation 配置 / 额外注入 / 基准环境
 * @returns {{ env: Record<string,string>, report: object }} 环境与构造报告
 */
function buildEnv(options) {
  const { root, isolation } = options
  const base = options.base ?? process.env
  const extra = options.extra ?? {}
  const allowlist = normalizeAllowlist(isolation?.inherit_allowlist)
  const enabled = isolation?.enabled !== false
  const strategy = enabled ? (isolation?.strategy ?? 'allowlist') : 'inherit-all'

  const report = {
    strategy,
    allowlist,
    inherited: [],
    dropped: [],
    overridden: [],
    extra: [],
  }

  const env = {}
  if (strategy === 'inherit-all') {
    for (const [name, value] of Object.entries(base)) {
      if (value !== undefined) env[name] = value
    }
    report.inherited = Object.keys(env)
  } else {
    const allowed = new Set(allowlist.map((name) => name.toLowerCase()))
    for (const [name, value] of Object.entries(base)) {
      if (value === undefined) continue
      if (allowed.has(name.toLowerCase())) {
        env[name] = value
        report.inherited.push(name)
      } else {
        report.dropped.push(name)
      }
    }
  }

  for (const [name, value] of Object.entries(isolation?.override ?? {})) {
    if (typeof value !== 'string' || value === '') continue
    env[name] = value
    report.overridden.push(name)
  }

  for (const [name, value] of Object.entries(extra)) {
    if (typeof value !== 'string' || value === '') continue
    env[name] = value
    report.extra.push(name)
  }

  // 隔离必须是可自证的：把这些标记写进子进程，便于日后排查"这一跑到底隔没隔"。
  env.NOMAD_ROOT = root
  env.NOMAD_ISOLATED = strategy === 'inherit-all' ? '0' : '1'
  report.extra.push('NOMAD_ROOT', 'NOMAD_ISOLATED')

  report.inherited.sort()
  report.dropped.sort()
  report.overridden.sort()
  report.extra.sort()
  return { env, report }
}

/**
 * 把 PATH 前置一个目录（用于让 DSH 子进程能找到盘内自带的 node）。
 * @param {Record<string,string>} env - 环境（会被原地修改）
 * @param {string} dir - 要前置的目录
 * @returns {boolean} 是否实际改动
 */
function prependToPath(env, dir) {
  if (typeof dir !== 'string' || dir === '') return false
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? (process.platform === 'win32' ? 'Path' : 'PATH')
  const delimiter = process.platform === 'win32' ? ';' : ':'
  const current = env[key]
  if (current === undefined) {
    env[key] = dir
    return true
  }
  const parts = current.split(delimiter).filter((part) => part !== '')
  if (parts.some((part) => part.toLowerCase() === dir.toLowerCase())) return false
  env[key] = `${dir}${delimiter}${current}`
  return true
}

/**
 * 汇总一份人类可读的隔离计划（doctor 用）。
 * @param {object} report - buildEnv 的 report
 * @param {Record<string,string>} overrides - 隔离覆盖项（已解析为绝对路径）
 * @param {string} root - NOMAD_ROOT
 * @returns {string[]} 逐行文本
 */
function describePlan(report, overrides, root) {
  const lines = []
  lines.push(`策略: ${report.strategy}${report.strategy === 'inherit-all' ? '（⚠️ 未隔离，全量继承宿主环境）' : '（白名单继承）'}`)
  lines.push(`继承: ${report.inherited.join(', ') || '(无)'}`)
  lines.push(`丢弃: ${report.dropped.length} 个宿主变量`)
  lines.push('覆盖（子进程强制注入）:')
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (typeof value !== 'string') continue
    // 用 isInside 而非裸前缀拼接：NOMAD_ROOT 在盘符根时带尾分隔符（`E:\`），
    // 此时拼 `` `${root}\\` `` 会得到 `E:\\`，匹配恒为 false（ADR-0028）
    const inside = isInside(root, value)
    lines.push(`  ${name} = ${value}${inside ? '' : '   ⚠️ 不在 NOMAD_ROOT 之内'}`)
  }
  return lines
}

module.exports = { buildEnv, prependToPath, describePlan, DEFAULT_ALLOWLIST }
