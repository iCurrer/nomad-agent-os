'use strict'

/**
 * Nomad Skills 管理器（Phase 3.2）。
 *
 * 管的是 **user-dsh skill 根**：`<DSH_HOME>/skills/`（`data/dsh-home/skills/`）。
 * 为什么是这个目录 —— 3.0-A 勘探结论（源码级，见 docs/DSH_SOURCE_MAP.md「Skill 契约」）：
 *   - DSH 的文件系统 provider 声明 4 个 skill 根；`$DSH_HOME/skills` 是 rank 400 的
 *     user-dsh 根（`skill-filesystem/src/index.ts:253`），且 `skipSystem: true`
 *     （`.system/` 子目录保留被忽略，`:254`）。
 *   - **盘根 `skills/` 目录 DSH 根本不读** —— 早期以为的安装目标已被源码否定。
 *   - 项目级 skill 由 Agent 工作区 `.dsh/skills`（rank 100）/ `.agents/skills`（rank 200）
 *     承载，属于 Agent 自己的文件，Nomad 不代管。
 *
 * 合法形态（`skill-filesystem/src/index.ts:676-687` `isPotentialSkillPath`，逐字对齐）：
 *   - 目录束：`<root>/<name>/SKILL.md`（入口文件深度恰好 2）
 *   - 扁平文件：`<root>/<name>.md`（深度 1）
 *
 * frontmatter 契约（`skill-filesystem/src/index.ts:797-832` `parseSkillFile`）：
 *   - `name` + `description` 必填（缺任一 → DSH **仅 warn 后忽略**，不报错）；
 *   - name 必须 kebab-case：`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`（`dsh-skill/src/index.ts:20`）；
 *   - `whenToUse` 可选。
 *   关键事实：**非法 skill 不会让 DSH 失败，只会被静默跳过** —— 所以本模块的价值就是
 *   把这些「装了但不生效」的状态变成看得见的东西（list 的 problems + doctor 的 WARN）。
 *
 * 热更新：DSH 对 skill 根做文件 watch（`skills/change` 事件，`dsh-skill/src/index.ts:296`），
 *   **装/删 skill 不需要重启实例** —— 这也是本模块敢在实例运行时操作的理由。
 *
 * 安全边界（AGENTS.md 铁律 2/3）：
 *   - 一切读写目标先过 `assertInside`，绝不越出 skill 根半步；
 *   - `remove` 只删 skill 根内、且形状合法的目标；
 *   - `add` 只接受**本地**路径，网络 URL 一律拒绝（不碰网络下载，零依赖）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { assertInside } = require('./paths.js')
const { parse: parseYaml } = require('./yaml-lite.js')

/** DSH 状态根下承载 skill 的子目录名（user-dsh skill 根）。 */
const SKILLS_DIR = 'skills'
/** user-dsh 根的保留子目录（`skipSystem: true`，DSH 忽略其下全部内容）。 */
const RESERVED_ENTRY = '.system'
/** skill 名语法（上游 `dsh-skill/src/index.ts:20` 逐字对齐）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 解析 skill 根目录。
 * @param {object} config - 已加载配置（需 `paths.dsh_home`）
 * @returns {string} skill 根绝对路径
 */
function skillsDir(config) {
  return path.join(config.paths.dsh_home, SKILLS_DIR)
}

/**
 * 从 Markdown 文本提取 YAML frontmatter（`---` 围栏块）。
 * @param {string} text - 文件全文
 * @returns {string|null} 围栏内的 YAML 文本；无合法围栏返回 null
 */
function extractFrontmatter(text) {
  const matched = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  return matched === null ? null : matched[1]
}

/**
 * 尽力解析 frontmatter 为字符串字段表。
 *
 * 两级策略，宁可少报不可误报（误报会让用户删掉其实合法的 skill）：
 *   1. yaml-lite（支持平铺 `key: value`，覆盖绝大多数 skill 的 frontmatter）；
 *   2. 解析失败（多行标量 `|`/`>` 等高级语法 yaml-lite 不支持，而上游用的是完整
 *      YAML 解析器）→ 退化为逐行正则提取 name/description/whenToUse 单行标量。
 *
 * @param {string} yamlText - 围栏内的 YAML 文本
 * @returns {{ fields: Record<string, string>, approximated: boolean }} 字段表与是否走了近似路径
 */
function parseFrontmatterFields(yamlText) {
  try {
    const doc = parseYaml(yamlText)
    if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
      const fields = {}
      for (const [key, value] of Object.entries(doc)) {
        if (typeof value === 'string') fields[key] = value
      }
      return { fields, approximated: false }
    }
  } catch {
    /* 落到近似路径 */
  }
  // 近似路径：只认「行首 key: value」的单行标量，其余一律不猜。
  const fields = {}
  for (const line of yamlText.split(/\r?\n/)) {
    const matched = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+?)\s*$/.exec(line)
    if (matched !== null && fields[matched[1]] === undefined) fields[matched[1]] = matched[2]
  }
  return { fields, approximated: true }
}

/**
 * 校验单个 skill 条目（**只读**；Phase 3.2，供 list/doctor 使用）。
 *
 * `entryName` 是 skill 根下的**目录/文件名**（不是 frontmatter 里的 name）。
 * DSH 以 frontmatter 的 `name` 为 skill 身份；条目名只决定盘上布局。
 * 两者不一致不算问题，但 list 会把两者都显示出来，避免「删了 A 名却删不到」的困惑。
 *
 * @param {string} base - skill 根目录
 * @param {string} entryName - 根下的条目名
 * @returns {{ entryName: string, entryPath: string, kind: 'bundle'|'flat'|'unknown', skillFile: string|null, exists: boolean, valid: boolean, problems: string[], notes: string[], skill: {name: string, description: string, whenToUse?: string}|null }} 校验结果
 */
function validateSkillEntry(base, entryName) {
  const entryPath = assertInside(base, path.join(base, entryName), `skill 条目（${entryName}）`)
  const result = {
    entryName,
    entryPath,
    kind: 'unknown',
    skillFile: null,
    exists: false,
    valid: false,
    problems: [],
    notes: [],
    skill: null,
  }

  const isDir = fs.existsSync(entryPath) && fs.statSync(entryPath).isDirectory()
  if (isDir) {
    const skillFile = path.join(entryPath, 'SKILL.md')
    if (!fs.existsSync(skillFile)) {
      // 目录但没有 SKILL.md：isPotentialSkillPath 判 false，DSH 视若无物。
      result.problems.push('目录内缺少 SKILL.md —— DSH 不会把它当 skill（合法形态：<name>/SKILL.md 或 <name>.md）')
      return result
    }
    result.kind = 'bundle'
    result.skillFile = skillFile
  } else if (entryName.toLowerCase().endsWith('.md') && fs.existsSync(entryPath)) {
    result.kind = 'flat'
    result.skillFile = entryPath
  } else {
    // 既不是目录也不是 .md 文件（或根本不存在）：不算 skill，也不算错误 —— 交给调用方归类。
    return result
  }
  result.exists = true

  // ── frontmatter 契约校验（对齐 parseSkillFile 的忽略规则）──────────────────
  let text = ''
  try {
    text = fs.readFileSync(result.skillFile, 'utf8')
  } catch (error) {
    result.problems.push(`SKILL 文件不可读：${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  const yamlText = extractFrontmatter(text)
  if (yamlText === null) {
    result.problems.push('缺少 YAML frontmatter（--- 围栏块）—— DSH 会忽略该 skill')
    return result
  }
  const { fields, approximated } = parseFrontmatterFields(yamlText)
  const name = typeof fields.name === 'string' ? fields.name.trim() : undefined
  const description = typeof fields.description === 'string' ? fields.description.trim() : undefined
  const whenToUse = typeof fields.whenToUse === 'string' ? fields.whenToUse.trim() : undefined

  if (name === undefined || name === '') {
    result.problems.push('frontmatter 缺少 name —— DSH 会忽略该 skill')
  } else if (!SKILL_NAME_RE.test(name)) {
    result.problems.push(`frontmatter name「${name}」不符合 kebab-case（/^[a-z0-9]+(?:-[a-z0-9]+)*$/）—— DSH 会忽略该 skill`)
  }
  if (description === undefined || description === '') {
    result.problems.push('frontmatter 缺少 description —— DSH 会忽略该 skill')
  }

  result.valid = result.problems.length === 0
  if (result.valid) {
    result.skill = { name, description, ...(whenToUse !== undefined ? { whenToUse } : {}) }
  } else if (name !== undefined && name !== '' && description !== undefined && description !== '') {
    // 名字非法但字段齐全：仍把字段带出去，方便 list 展示「装了什么」。
    result.skill = { name, description, ...(whenToUse !== undefined ? { whenToUse } : {}) }
  }
  if (approximated) {
    // 提示性信息，不进 problems（不算 broken）：valid 判定已在上面的 problems 阶段完成。
    result.notes.push('frontmatter 使用了 Nomad 校验器子集之外的 YAML 语法，字段按单行标量近似提取 —— 以 DSH 实际加载为准')
  }
  return result
}

/**
 * 只读列出 skill 根下全部条目（供 CLI / doctor / 状态端点使用）。
 *
 * 归类：
 *   - `skills`  ：形状合法的条目（bundle / flat），无论 frontmatter 是否有效 ——
 *                 无效的带 `problems`，doctor 会把它们变成 WARN；
 *   - `ignored` ：DSH 根本不会看的条目（无 SKILL.md 的目录、非 .md 文件、`.system` 保留名）。
 *
 * @param {{ config: object }} options - 已加载配置（需 `paths.dsh_home`）
 * @returns {{ base: string, exists: boolean, skills: object[], ignored: object[] }} 结果
 */
function listSkills(options) {
  const base = skillsDir(options.config)
  const result = { base, exists: fs.existsSync(base), skills: [], ignored: [] }
  if (!result.exists) return result

  const entries = fs
    .readdirSync(base, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  for (const entryName of entries) {
    if (entryName === RESERVED_ENTRY) {
      result.ignored.push({ entryName, reason: '保留名 .system/（DSH 在 user-dsh 根忽略其下全部内容）' })
      continue
    }
    const check = validateSkillEntry(base, entryName)
    if (check.kind === 'unknown') {
      result.ignored.push({
        entryName,
        reason: check.problems.length > 0
          ? check.problems[0]
          : '既不是 <name>/SKILL.md 目录束，也不是 <name>.md 扁平文件 —— DSH 不会看它',
      })
      continue
    }
    result.skills.push(check)
  }
  return result
}

/**
 * 校验「要安装进 skill 根的条目名」。
 * @param {string} name - 候选条目名
 * @returns {string} 原样返回
 * @throws {Error} 为空、含路径分隔符、是保留/相对目录名时
 */
function validateSkillEntryName(name) {
  if (typeof name !== 'string' || name === '') {
    throw new Error(`skill: 条目名必须是非空字符串，实际 ${JSON.stringify(name)}`)
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`skill: 条目名不得含路径分隔符（${JSON.stringify(name)}）`)
  }
  if (name === '.' || name === '..' || name === RESERVED_ENTRY || name === 'node_modules') {
    throw new Error(`skill: ${JSON.stringify(name)} 是保留目录名，不能作为 skill 条目名`)
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    throw new Error(`skill: 条目名不得以点开头或结尾（${JSON.stringify(name)}）`)
  }
  return name
}

/**
 * 递归复制（自写，不用 `fs.cpSync`）。
 *
 * 为什么不用 cpSync：行为完全可控 + 兼容受限执行环境（部分宿主的 fs shim 对
 * cpSync 支持不完整，会静默失败；readFileSync/writeFileSync/mkdirSync 则处处可用）。
 * skill 目录本身很浅（通常就一个 SKILL.md），手写复制的成本可忽略。
 *
 * @param {string} src - 源（文件或目录）
 * @param {string} dst - 目标（与源同形态）
 * @returns {number} 复制的文件数
 */
function copyPath(src, dst) {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    let count = 0
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      count += copyPath(path.join(src, entry.name), path.join(dst, entry.name))
    }
    return count
  }
  fs.writeFileSync(dst, fs.readFileSync(src))
  return 1
}

/**
 * 安装一个本地 skill 到 user-dsh 根（`nomad skill add <path>`）。
 *
 * 规则：
 *   - 安装源必须是**本地**已存在的目录束（含 SKILL.md）或 `.md` 扁平文件；
 *     网络 URL 一律拒绝（git 源请维护者手动 clone 后再 add 本地路径 —— 零依赖铁律）；
 *   - 装前先校验源内容：会被 DSH 静默忽略的 skill（缺 frontmatter 等）**拒绝安装**，
 *     把「装了但不生效」挡在门外；
 *   - 目标已存在即拒绝（绝不覆盖 —— 与 profile/create 同姿态）；
 *   - 条目名取源 basename（`.md` 文件去扩展名）。
 *
 * @param {{ config: object }} options - 已加载配置
 * @param {string} source - 本地源路径（目录或 .md 文件）
 * @returns {{ ok: boolean, name?: string, dir?: string, format?: 'bundle'|'flat', skill?: object, problems?: string[], error?: string }} 结果
 */
function addSkill(options, source) {
  if (typeof source !== 'string' || source === '') {
    return { ok: false, error: 'skill add：必须提供本地源路径（目录束或 .md 文件）' }
  }
  // 网络判定用 `scheme://`（URL 的权威形态）。不能只判 `scheme:` —— Windows 盘符
  // `C:\...` 同样匹配 `[a-z]+:`，会把本地路径误杀。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || source.startsWith('git@')) {
    return {
      ok: false,
      error: `skill add：不接受网络地址（${source}）。\n  本模块不碰网络下载：请先手动 clone 到本地，再 add 本地路径。`,
    }
  }
  let sourcePath = path.resolve(source)
  if (!fs.existsSync(sourcePath)) {
    // 相对路径回退：cwd 解析不到时再按 NOMAD_ROOT 解析一次 —— 文档示例
    // （`nomad skill add docs/examples/skills/hello-nomad`）从任意目录执行都能用。
    const rootRelative = path.join(options.config.paths.root, source)
    if (source !== path.resolve(source) && fs.existsSync(rootRelative)) {
      sourcePath = path.resolve(rootRelative)
    } else {
      return { ok: false, error: `skill add：源路径不存在：${sourcePath}（相对路径按当前目录解析，盘内路径可写相对 NOMAD_ROOT 的形式或绝对路径）` }
    }
  }

  const base = skillsDir(options.config)
  let sourceStat
  try {
    sourceStat = fs.statSync(sourcePath)
  } catch (error) {
    return { ok: false, error: `skill add：源路径不可访问：${error instanceof Error ? error.message : String(error)}` }
  }

  // 源形状判定 + 装前校验（用「临时条目名」跑一次完整校验，复用同一套契约逻辑）。
  // 注意两个名字不同：probe 名是**校验视角**的条目名（扁平文件必须带 .md，
  // 与 validateSkillEntry 在 listSkills 侧的命名一致）；安装条目名去扩展名。
  const isDirectory = sourceStat.isDirectory()
  const probeName = path.basename(sourcePath)
  const entryName = isDirectory ? probeName : probeName.replace(/\.md$/i, '')
  let probe
  try {
    validateSkillEntryName(entryName)
    probe = validateSkillEntry(path.dirname(sourcePath), probeName)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (probe.kind === 'unknown') {
    return {
      ok: false,
      error: `skill add：源不是合法 skill 形态（${probe.problems[0] ?? '既非目录束也非 .md 文件'}）`,
    }
  }
  if (!probe.valid) {
    return {
      ok: false,
      error: `skill add：源 skill 会被 DSH 忽略，拒绝安装：\n  ${probe.problems.join('\n  ')}\n  请先修复源文件后再 add。`,
    }
  }

  // 目标与盘面形态一致：目录束 = <base>/<name>/，扁平文件 = <base>/<name>.md
  // （removeSkill 同样按两形态查找，二者必须对得上）。
  const target = isDirectory ? path.join(base, entryName) : `${path.join(base, entryName)}.md`
  try {
    assertInside(base, target, 'skill 安装目标')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (fs.existsSync(target)) {
    return { ok: false, name: entryName, dir: target, error: `skill「${entryName}」已存在（${target}）—— 绝不覆盖已有内容` }
  }

  try {
    fs.mkdirSync(base, { recursive: true })
    copyPath(sourcePath, target)
  } catch (error) {
    return { ok: false, name: entryName, error: `skill 安装失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // 装后回读校验：承诺必须能在盘上验出来（与 ensureNomadProfile 同姿态）。
  // 校验用与盘面一致的条目名（扁平文件带 .md，与 listSkills 视角一致）。
  const verifyName = isDirectory ? entryName : `${entryName}.md`
  const verify = validateSkillEntry(base, verifyName)
  if (!verify.valid) {
    return { ok: false, name: entryName, dir: target, error: `安装后校验失败：${verify.problems.join('；') || '条目形态不被识别'}` }
  }
  return { ok: true, name: entryName, dir: target, format: verify.kind, skill: verify.skill }
}

/**
 * 卸载一个 skill（`nomad skill remove <name>`）。
 *
 * `<name>` 是 skill 根下的**条目名**（目录名或去扩展名的文件名）。
 * 依次尝试目录束与扁平文件两种形态；都不存在时报错并给出根内现有条目名。
 *
 * @param {{ config: object }} options - 已加载配置
 * @param {string} name - 条目名
 * @returns {{ ok: boolean, name?: string, path?: string, format?: 'bundle'|'flat', error?: string }} 结果
 */
function removeSkill(options, name) {
  const base = skillsDir(options.config)
  let entryName
  let target
  try {
    entryName = validateSkillEntryName(name)
    target = assertInside(base, path.join(base, entryName), `skill 条目（${name}）`)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    try {
      fs.rmSync(target, { recursive: true })
    } catch (error) {
      return { ok: false, name: entryName, error: `skill 卸载失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, name: entryName, path: target, format: 'bundle' }
  }

  const flatPath = `${target}.md`
  if (fs.existsSync(flatPath)) {
    try {
      fs.unlinkSync(flatPath)
    } catch (error) {
      return { ok: false, name: entryName, error: `skill 卸载失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, name: entryName, path: flatPath, format: 'flat' }
  }

  const present = fs.existsSync(base)
    ? fs.readdirSync(base).filter((item) => item !== RESERVED_ENTRY)
    : []
  return {
    ok: false,
    name: entryName,
    error: `skill「${entryName}」不存在于 ${base}`
      + (present.length > 0 ? `\n  现有条目：${present.join(', ')}` : '\n  （skill 根当前为空）'),
  }
}

module.exports = {
  skillsDir,
  validateSkillEntry,
  validateSkillEntryName,
  listSkills,
  addSkill,
  removeSkill,
  SKILLS_DIR,
  RESERVED_ENTRY,
  SKILL_NAME_RE,
}
