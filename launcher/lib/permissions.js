/**
 * launcher/lib/permissions.js — Agent 权限分级模板的加载、校验与展示。
 *
 * 职责边界（铁律 5 / 3.0-C 勘探结论）：
 * - `config/permissions.yaml` 是 Nomad 的权限分级**模板**（8 类 + never 硬禁止清单），
 *   此前无任何代码消费它；本模块让它「看得见」——在 doctor 与 dry-run 中展示生效档位。
 * - **禁止自造桥接**：上游 DSH 有原生权限体系（SandboxMode × ApprovalPolicy，事件溯源），
 *   本模块绝不把 Nomad 8 级模板换算/注入成上游旋钮（会对抗其事件溯源设计）。
 *   模板在此阶段是「契约声明 + 展示」，真正生效的是上游原生体系。
 * - `never` 清单的诚实自证：凡能用 Nomad 已有机制（宿主隔离白名单、路径守卫、
 *   版本锁定）机械验证的条目就验证；验证不了的如实标注「契约级约束」，不假装通过。
 *
 * 数据来源：`config/permissions.yaml`（平铺 key: value，yaml-lite 子集足够）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { parse } = require('./yaml-lite.js')
const { isInside } = require('./paths.js')

/** 权限类别（8 类，与模板顶层 levels 键一一对应；未知键拒绝——防拼写漂移）。 */
const CATEGORIES = Object.freeze([
  'read',
  'write',
  'execute',
  'network',
  'sensitive',
  'external_upload',
  'git_push',
  'production_deploy',
])

/** 类别取值合法域。 */
const VALUES = Object.freeze(['allow', 'ask', 'workspace', 'deny'])

/** never 清单的已知条目（未知 id 拒绝——防拼写漂移）。 */
const NEVER_IDS = Object.freeze([
  'modify_system_env',
  'modify_registry',
  'delete_user_data',
  'upgrade_dsh_master',
  'auto_git_push',
  'write_outside_nomad_root_and_workspace',
])

/**
 * 敏感类别：模板原则「敏感操作一律询问」，不允许被 profile 提升为 allow
 * （依据模板自身注释：sensitive/external_upload/git_push/production_deploy 标注「必须询问」）。
 */
const ASK_ONLY_CATEGORIES = Object.freeze(['sensitive', 'external_upload', 'git_push', 'production_deploy'])

/**
 * 加载并校验权限模板。
 * @param {{ root: string, file?: string }} options - 根目录与模板路径（默认 `<root>/config/permissions.yaml`）
 * @returns {{ file: string, exists: boolean, levels: object, never: string[], profiles: object, problems: string[] }}
 *   解析结果；`problems` 非空表示模板非法（调用方决定 WARN/FAIL 呈现）。
 */
function loadPermissions(options) {
  const root = options.root
  const file = options.file ?? path.join(root, 'config', 'permissions.yaml')
  const result = { file, exists: false, levels: {}, never: [], profiles: {}, problems: [] }

  if (!fs.existsSync(file)) {
    result.problems.push(`权限模板缺失：${file}（应随盘部署）`)
    return result
  }
  result.exists = true

  let doc
  try {
    doc = parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    result.problems.push(`权限模板解析失败：${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    result.problems.push('权限模板顶层必须是映射（levels / never / profiles）')
    return result
  }

  // ---- levels：8 类，每类 default ∈ VALUES；execute 可选 deny_patterns（字符串数组） ----
  const levels = doc.levels
  if (levels === null || typeof levels !== 'object' || Array.isArray(levels)) {
    result.problems.push('levels 必须是映射')
  } else {
    for (const [key, value] of Object.entries(levels)) {
      if (!CATEGORIES.includes(key)) {
        result.problems.push(`levels 含未知类别「${key}」（合法：${CATEGORIES.join(', ')}）`)
        continue
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        result.problems.push(`levels.${key} 必须是映射`)
        continue
      }
      const def = value.default
      if (!VALUES.includes(def)) {
        result.problems.push(`levels.${key}.default = ${JSON.stringify(def)} 非法（合法：${VALUES.join(', ')}）`)
        continue
      }
      result.levels[key] = { ...value }
      const patterns = value.deny_patterns
      if (patterns !== undefined) {
        if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string' || p.length === 0)) {
          result.problems.push(`levels.${key}.deny_patterns 必须是非空字符串数组`)
          delete result.levels[key].deny_patterns
        }
      }
    }
    for (const category of CATEGORIES) {
      if (!(category in result.levels)) {
        result.problems.push(`levels 缺类别「${category}」`)
      }
    }
  }

  // ---- never：非空字符串数组；只认已知 id；不允许重复 ----
  const never = doc.never
  if (!Array.isArray(never) || never.length === 0) {
    result.problems.push('never 必须是非空字符串数组')
  } else {
    const seen = new Set()
    for (const item of never) {
      if (typeof item !== 'string' || item.length === 0) {
        result.problems.push(`never 含非法条目 ${JSON.stringify(item)}`)
        continue
      }
      if (!NEVER_IDS.includes(item)) {
        result.problems.push(`never 含未知条目「${item}」（合法：${NEVER_IDS.join(', ')}）`)
        continue
      }
      if (seen.has(item)) {
        result.problems.push(`never 重复条目「${item}」`)
        continue
      }
      seen.add(item)
      result.never.push(item)
    }
  }

  // ---- profiles：每档只允许覆盖已知类别；取值合法；敏感类别不可提升为 allow ----
  const profiles = doc.profiles
  if (profiles !== undefined && profiles !== null) {
    if (typeof profiles !== 'object' || Array.isArray(profiles)) {
      result.problems.push('profiles 必须是映射')
    } else {
      for (const [name, overrides] of Object.entries(profiles)) {
        if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
          result.problems.push(`profiles.${name} 必须是映射`)
          continue
        }
        const clean = {}
        for (const [category, value] of Object.entries(overrides)) {
          if (!CATEGORIES.includes(category)) {
            result.problems.push(`profiles.${name} 含未知类别「${category}」`)
            continue
          }
          if (!VALUES.includes(value)) {
            result.problems.push(`profiles.${name}.${category} = ${JSON.stringify(value)} 非法（合法：${VALUES.join(', ')}）`)
            continue
          }
          if (value === 'allow' && ASK_ONLY_CATEGORIES.includes(category)) {
            result.problems.push(`profiles.${name}.${category} 不可提升为 allow（模板原则：敏感操作一律询问）`)
            continue
          }
          clean[category] = value
        }
        result.profiles[name] = clean
      }
    }
  }

  return result
}

/**
 * 汇总一行档位摘要（展示用）。
 * @param {object} perm - loadPermissions 的返回值
 * @returns {string} 如「allow 3 类 · workspace 1 类 · ask 4 类」
 */
function summarizeLevels(perm) {
  const counts = {}
  for (const category of CATEGORIES) {
    const def = perm.levels[category]?.default
    if (def !== undefined) counts[def] = (counts[def] ?? 0) + 1
  }
  const parts = []
  for (const value of VALUES) {
    if (counts[value] !== undefined) parts.push(`${value} ${counts[value]} 类`)
  }
  return parts.join(' · ') || '（无有效类别）'
}

/**
 * never 清单的机械自证：凡 Nomad 已有机制能验证的条目就验证，验证不了的如实标注。
 * @param {object} perm - loadPermissions 的返回值
 * @param {{ config: object, envReport: object, runtime: object }} ctx - 自证上下文
 * @returns {Array<{ id: string, ok: boolean, verifiable: boolean, note: string }>} 逐条自证结果
 */
function selfCheckNever(perm, ctx) {
  const { config, envReport, runtime } = ctx
  const checks = []

  // 1) modify_system_env / modify_registry ←→ 宿主隔离白名单（继承丢弃 + 强制注入）
  const isolated = envReport?.strategy === 'allowlist' && (envReport?.dropped?.length ?? 0) > 0
  checks.push({
    id: 'modify_system_env',
    ok: isolated,
    verifiable: true,
    note: isolated
      ? `宿主隔离 allowlist 生效，已丢弃 ${envReport.dropped.length} 个宿主变量，子进程拿不到宿主全量环境`
      : '宿主隔离未生效（strategy 非 allowlist 或零丢弃），该 never 条目失去机械支撑',
  })
  checks.push({
    id: 'modify_registry',
    ok: isolated,
    verifiable: true,
    note: isolated
      ? '子进程环境被白名单收窄，配合 never 契约约束注册表写入'
      : '宿主隔离未生效，该 never 条目失去机械支撑',
  })

  // 2) write_outside_nomad_root_and_workspace ←→ 路径守卫（dsh_home / workspace 必须盘内）
  const dshHome = config?.paths?.dsh_home
  const workspace = config?.paths?.workspace
  const inside = typeof dshHome === 'string' && typeof workspace === 'string'
    && isInside(config.paths.root, dshHome) && isInside(config.paths.root, workspace)
  checks.push({
    id: 'write_outside_nomad_root_and_workspace',
    ok: inside,
    verifiable: true,
    note: inside
      ? 'dsh_home 与 workspace 均在 NOMAD_ROOT 内（Runtime/Data 物理分离铁律）'
      : 'dsh_home 或 workspace 越出 NOMAD_ROOT，该 never 条目失去机械支撑',
  })

  // 3) upgrade_dsh_master ←→ 版本锁定（清单指针 + 行为配置双锚点）
  const pinned = runtime?.dsh?.missing !== true
    && typeof runtime?.dsh?.entrySource === 'string'
    && runtime.dsh.entrySource.includes('nomad-runtime.json')
    && config?.behavior?.track_master === false
  checks.push({
    id: 'upgrade_dsh_master',
    ok: pinned,
    verifiable: true,
    note: pinned
      ? `运行时由清单指针锁定（${runtime.dsh.version}），behavior.track_master = false`
      : '运行时未锁定到清单指针或 track_master 开启，该 never 条目失去机械支撑',
  })

  // 4) 契约级约束：无机械自证锚点，如实标注（不假装通过）
  checks.push({
    id: 'delete_user_data',
    ok: true,
    verifiable: false,
    note: '契约级约束 —— 由 Agent 行为守约承担，launcher 无机械验证点（诚实标注）',
  })
  checks.push({
    id: 'auto_git_push',
    ok: true,
    verifiable: false,
    note: '契约级约束 —— 由 Agent 行为守约承担，launcher 无机械验证点（诚实标注）',
  })

  // 只返回 never 清单里实际声明的条目（模板缺项由 loadPermissions 的 problems 负责）
  return checks.filter((check) => perm.never.includes(check.id))
}

/**
 * 组装展示行（doctor 与 dry-run 共用）。
 * @param {object} perm - loadPermissions 的返回值
 * @param {Array<{ id: string, ok: boolean, verifiable: boolean, note: string }>} checks - selfCheckNever 的返回值
 * @returns {string[]} 展示行
 */
function describePermissions(perm, checks) {
  const lines = []
  lines.push(`档位: ${summarizeLevels(perm)}（write = ${perm.levels.write?.default ?? '?'}）`)
  const askProfiles = Object.keys(perm.profiles)
  lines.push(`预设档: ${askProfiles.length > 0 ? askProfiles.join(', ') : '（无）'}`)
  for (const check of checks) {
    const mark = check.verifiable ? (check.ok ? '✓' : '✗') : '—'
    lines.push(`  ${mark} ${check.id}: ${check.note}`)
  }
  return lines
}

module.exports = { loadPermissions, summarizeLevels, selfCheckNever, describePermissions, CATEGORIES, VALUES, NEVER_IDS, ASK_ONLY_CATEGORIES }
