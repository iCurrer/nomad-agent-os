'use strict'

/**
 * Nomad DSH profile 自举（L4-a 阶段 2.5）。
 *
 * 为什么需要它：Nomad 要跑**自己的** profile（缺省名 `nomad`），而不是上游内置的 `web`。
 * 而 DSH 自己只会「profile 不存在时按内置模板初始化」，**没有**把自研 bundle 追加进去的
 * 能力（`dsh plugin` 在 npm 版被拒绝，见 docs/UI_ARCHITECTURE.md §8.5.1）—— 那一步
 * 必须由 Launcher 完成。本模块就是那一步的**唯一实现点**。
 *
 * 上游事实（逐条来自盘内运行时源码，不是推断。依据：AGENTS.md 第 0 节优先级阶梯）：
 *   - 目录：`<DSH_HOME>/profiles/<name>`
 *     `@deepseek-ai/dsh-app-boot/lib/index.js:485`（`PROFILES_DIR = "profiles"`）
 *     `…:524-527`（`resolveProfileDir`，含名字合法性校验）
 *   - 清单：`package.json` → `dsh.profile.bundles`（有序包名/相对路径列表）
 *     `…:581-597`（`initProfile`）、`…:892-894`（`writeProfileManifest`）
 *   - 补丁层：`cordis.patch.yml`，`…:487` + `…:563-567`（模板正文）
 *   - pnpm 设置：`pnpm-workspace.yaml`，`…:568-573`
 *   - `cordis.yml` **由 DSH 每次加载时无条件重写为空列表**
 *     （`.dsh-<随机串>/lib/profile-boot-<哈希>.js:189,207`），
 *     目的是防止 Loader 的树回写把组合结果烘焙进该文件、导致下次启动 bundle 行重复。
 *     因此它**不是**我们的维护对象；本模块仍写一份，只为让工具能直接读盘。
 *   - 内置模板名即**保留名**，不可作为自建 profile 目标：
 *     `acp / web / headless / sdk / sdk-minimal`（`…:529-535`；守卫见 `profile-boot:146`）
 *   - 内置初始化**从不覆盖已存在文件**（`…:584-596` 的 `existsSync` 守卫）
 *     → 我们的 ensure 必须同样幂等，绝不冲掉用户已有的 profile 内容。
 *
 * 安全边界（AGENTS.md 铁律 2/3/4）：
 *   - 只写 `<DSH_HOME>/profiles/<name>/` 之下的文件；
 *   - 任何写入目标先过 `assertInside(root)` 与 `resolveInside(root)`；
 *   - 绝不触碰宿主机用户目录，绝不触碰上游内置 profile。
 */

const fs = require('node:fs')
const path = require('node:path')
const { assertInside, resolveInside } = require('./paths.js')
const { parse: parseYaml } = require('./yaml-lite.js')

/**
 * 读 YAML 文件顶层数组（供 profile 校验用）。
 *
 * 上游模板的 `cordis.patch.yml` / `cordis.yml` 正文是**流式空数组 `[]`**
 * （`dsh-app-boot/lib/index.js:563-567` 模板原文），而 `yaml-lite.js` 只支持
 * 块式语法、对 `[]` 会抛错。因此这里先剥注释行、trim，命中 `[]` 直接短路返回，
 * 其余交 yaml-lite 解析 —— 不为这一个形态去改公共解析器。
 *
 * @param {string} file - YAML 文件路径
 * @returns {unknown} 解析结果（调用方自行断言数组）
 * @throws {Error} 文件不可读或 YAML 不可解析时
 */
function readYamlTopArray(file) {
  const text = fs.readFileSync(file, 'utf8')
  const stripped = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .trim()
  if (stripped === '[]') return []
  return parseYaml(stripped)
}

/**
 * 上游内置（＝保留）profile 名 → 其模板 bundle 列表。
 * 与 `dsh-app-boot/lib/index.js:529-535` 逐字对齐；同名不可作为自建目标。
 */
const SHIPPED_PROFILES = {
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
}

/** 缺省派生模板（上游内置名）。 */
const DEFAULT_TEMPLATE = 'web'
/** 缺省自建 profile 名。 */
const DEFAULT_PROFILE = 'nomad'
/** 缺省自研 bundle 源（相对 NOMAD_ROOT）。 */
const DEFAULT_BUNDLE_SOURCE = 'packages/nomad-web-app'

/** DSH 状态根下承载 profile 的子目录名（上游 `PROFILES_DIR`）。 */
const PROFILES_DIR = 'profiles'
/** profile 补丁层文件名（上游 `PROFILE_PATCH_FILENAME`）。 */
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
/** profile 根配置文件名（上游 `PROFILE_ROOT_FILENAME`，由 DSH 无条件重写）。 */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * 上游 `PROFILE_ROOT_CONFIG` 原文（`profile-boot-*.js:121-125`）。
 * 写它只是为了让工具能直接读盘；DSH 每次启动都会用同一份内容覆盖它。
 */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** 上游 `PROFILE_PATCH_TEMPLATE` 原文（`dsh-app-boot/lib/index.js:563-567`）。 */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** 上游 `PROFILE_PNPM_WORKSPACE` 原文（`dsh-app-boot/lib/index.js:568-573`）。 */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * 把路径转成 POSIX 分隔符形态（bundle spec 必须是平台无关的写法）。
 * @param {string} value - 任意路径
 * @returns {string} 以 `/` 分隔的路径
 */
function toPosix(value) {
  return value.split(path.sep).join('/')
}

/**
 * 校验 profile 名。规则与上游 `resolveProfileDir` 的守卫对齐（早报错优于让 DSH 报错）。
 * @param {unknown} name - 候选名
 * @returns {string} 原样返回
 * @throws {Error} 名为空、含路径分隔符、是相对目录名、或命中上游保留名时
 */
function validateProfileName(name) {
  if (typeof name !== 'string' || name === '') {
    throw new Error(`profile: profile 名必须是非空字符串，实际 ${JSON.stringify(name)}`)
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`profile: profile 名不得含路径分隔符（${JSON.stringify(name)}）`)
  }
  if (name === '.' || name === '..' || name === 'node_modules') {
    throw new Error(`profile: ${JSON.stringify(name)} 是保留目录名，不能作为 profile 名`)
  }
  if (Object.hasOwn(SHIPPED_PROFILES, name)) {
    throw new Error(
      `profile: ${JSON.stringify(name)} 是 DSH 上游内置 profile 名（保留），不可作为自建 profile 目标。\n`
      + `  可用的内置模板：${Object.keys(SHIPPED_PROFILES).sort().join(' / ')}`
      + '（作为 runtime.dsh.profile_template 使用，而不是作为 profile 名）。',
    )
  }
  return name
}

/**
 * 判断两个字符串列表是否逐位相同。
 * @param {string[]} left - 列表
 * @param {string[]} right - 列表
 * @returns {boolean} 相同则为 true
 */
function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * 解析 Nomad profile 的落点与自研 bundle spec（**纯计算，不碰盘**）。
 *
 * `bundleSpec` 是 **profile 目录 → 自研 bundle 源** 的相对路径（POSIX 写法）。
 * 用相对路径而非物化拷贝，依据 ADR-0020：源留在 repo 内可版本控制、零复制零漂移、
 * 天然免疫盘符变化。代价是它依赖 profile 目录在盘内的深度 —— 所以必须由本函数
 * **算出来**，不能手工写死在文件里。
 *
 * @param {{ root: string, config: object }} options - NOMAD_ROOT 与已加载配置
 * @returns {object} `{ name, template, templateBundles, dir, manifestPath, patchPath, workspacePath, rootConfigPath, bundleSourceDir, bundleSpec }`
 * @throws {Error} 名字非法 / 模板名非法 / bundle 源路径越界时
 */
function resolveNomadProfile(options) {
  const { root, config } = options
  const name = validateProfileName(config.runtime.dsh.profile ?? DEFAULT_PROFILE)
  const template = config.runtime.dsh.profile_template ?? DEFAULT_TEMPLATE
  if (!Object.hasOwn(SHIPPED_PROFILES, template)) {
    throw new Error(
      `profile: runtime.dsh.profile_template 必须是上游内置模板名（${Object.keys(SHIPPED_PROFILES).sort().join(' / ')}），`
      + `实际 ${JSON.stringify(template)}`,
    )
  }
  const bundleSourceDir = resolveInside(
    root,
    config.runtime.dsh.bundle_source ?? DEFAULT_BUNDLE_SOURCE,
    'runtime.dsh.bundle_source',
  )
  const dir = assertInside(
    root,
    path.join(config.paths.dsh_home, PROFILES_DIR, name),
    `runtime.dsh.profile（${name}）`,
  )
  return {
    name,
    template,
    templateBundles: SHIPPED_PROFILES[template],
    dir,
    manifestPath: path.join(dir, 'package.json'),
    patchPath: path.join(dir, PROFILE_PATCH_FILENAME),
    workspacePath: path.join(dir, 'pnpm-workspace.yaml'),
    rootConfigPath: path.join(dir, PROFILE_ROOT_FILENAME),
    bundleSourceDir,
    bundleSpec: toPosix(path.relative(dir, bundleSourceDir)),
  }
}

/**
 * 校验自研 bundle 源「真的是一个 bundle」。
 *
 * bundle 的判据是上游给的：package.json 里声明 `dsh.bundle.patch` 指向自己的补丁文件
 * （`@deepseek-ai/dsh-web-app/package.json` 的形态，见 §8.5.1）。不校验就会在 DSH
 * 启动期得到一句含糊的「did not activate」，所以这里提前把话说清楚。
 *
 * @param {string} dir - bundle 源目录
 * @returns {{ ok: boolean, error?: string, name?: string, patches?: string[] }} 结果
 */
function validateBundleSource(dir) {
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `自研 bundle 源缺少清单：${manifestPath}` }
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, error: `自研 bundle 清单不可解析：${manifestPath}（${error.message}）` }
  }
  const patches = manifest?.dsh?.bundle?.patch
  if (!Array.isArray(patches) || patches.length === 0 || patches.some((item) => typeof item !== 'string')) {
    return {
      ok: false,
      error: `自研 bundle 清单未声明 dsh.bundle.patch（或不是非空字符串数组）：${manifestPath}`,
    }
  }
  for (const relative of patches) {
    const file = path.resolve(dir, relative)
    if (!fs.existsSync(file)) {
      return { ok: false, error: `自研 bundle 声明的补丁文件不存在：${file}（来自 dsh.bundle.patch）` }
    }
  }
  return { ok: true, name: manifest.name, patches }
}

/**
 * 只读巡检 Nomad profile（供 doctor / dry-run 使用，**不创建、不修改任何文件**）。
 * @param {{ root: string, config: object }} options - NOMAD_ROOT 与已加载配置
 * @returns {{ spec: object, exists: boolean, manifestValid: boolean, bundles: string[], bundleIncluded: boolean, bundleLast: boolean, bundleSource: object, patchExists: boolean, workspaceExists: boolean, problems: string[] }} 巡检结果
 */
function inspectNomadProfile(options) {
  const spec = resolveNomadProfile(options)
  const result = {
    spec,
    exists: fs.existsSync(spec.manifestPath),
    manifestValid: false,
    bundles: [],
    bundleIncluded: false,
    bundleLast: false,
    bundleSource: validateBundleSource(spec.bundleSourceDir),
    patchExists: fs.existsSync(spec.patchPath),
    workspaceExists: fs.existsSync(spec.workspacePath),
    problems: [],
  }
  if (!result.bundleSource.ok) result.problems.push(result.bundleSource.error)

  if (result.exists) {
    try {
      const manifest = JSON.parse(fs.readFileSync(spec.manifestPath, 'utf8'))
      result.manifestValid = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      if (result.manifestValid) {
        const bundles = manifest?.dsh?.profile?.bundles
        result.bundles = Array.isArray(bundles) ? bundles.filter((item) => typeof item === 'string') : []
        result.bundleIncluded = result.bundles.includes(spec.bundleSpec)
        result.bundleLast = result.bundles[result.bundles.length - 1] === spec.bundleSpec
      } else {
        result.problems.push('profile 清单不是 JSON 对象')
      }
    } catch (error) {
      result.problems.push(`profile 清单不可解析：${error.message}`)
    }
  } else {
    result.problems.push('profile 尚未初始化（start 会自动创建）')
  }
  return result
}

/**
 * 自举 Nomad profile（幂等）。
 *
 * 行为：
 *   1. profile 清单缺失 → 按内置模板的 bundles 创建（形状与上游 `initProfile` 逐字一致）；
 *   2. 清单存在 → **只在末尾追加**自研 bundle spec；已有的其他 bundle 与其余键原样保留；
 *   3. 补丁层 / pnpm 设置 / 根配置 **只在缺失时补**，绝不覆盖已有内容
 *      （与上游 `initProfile` 的 `existsSync` 守卫同姿态 —— 用户改过的东西不动）。
 *
 * `ensure_profile = false` 时直接跳过（逃生舱：由人手工维护 profile）。
 *
 * @param {{ root: string, config: object, logger?: object }} options - NOMAD_ROOT、已加载配置、可选日志器
 * @returns {{ ok: boolean, action: 'created'|'updated'|'unchanged'|'skipped'|'error', name?: string, dir?: string, bundleSpec?: string, created?: string[], updated?: string[], error?: string, reason?: string }} 结果
 */
function ensureNomadProfile(options) {
  const { root, config, logger } = options
  const note = (level, message) => {
    if (logger !== null && typeof logger === 'object' && typeof logger[level] === 'function') logger[level](message)
  }

  let spec
  try {
    spec = resolveNomadProfile({ root, config })
  } catch (error) {
    return { ok: false, action: 'error', error: error.message }
  }

  if (config.runtime.dsh.ensure_profile === false) {
    return {
      ok: true,
      action: 'skipped',
      name: spec.name,
      dir: spec.dir,
      bundleSpec: spec.bundleSpec,
      reason: 'runtime.dsh.ensure_profile = false（按配置由人手工维护 profile）',
    }
  }

  const source = validateBundleSource(spec.bundleSourceDir)
  if (!source.ok) {
    return { ok: false, action: 'error', name: spec.name, dir: spec.dir, bundleSpec: spec.bundleSpec, error: source.error }
  }

  const created = []
  const updated = []
  let action = 'unchanged'

  try {
    fs.mkdirSync(spec.dir, { recursive: true })

    // ① 清单：不存在则按模板创建
    let manifest = null
    if (fs.existsSync(spec.manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(spec.manifestPath, 'utf8'))
      if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error(`profile 清单必须是 JSON 对象：${spec.manifestPath}`)
      }
    } else {
      manifest = {
        name: `dsh-profile-${spec.name}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...spec.templateBundles] } },
      }
      fs.writeFileSync(spec.manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
      created.push(spec.manifestPath)
      action = 'created'
    }

    // ② 自研层必须**排在最后**（它的补丁要叠在上游 web-app 层之上）
    const current = Array.isArray(manifest?.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter((item) => typeof item === 'string')
      : []
    const next = [...current.filter((item) => item !== spec.bundleSpec), spec.bundleSpec]
    if (!sameList(current, next)) {
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
      fs.writeFileSync(spec.manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
      updated.push(spec.manifestPath)
      if (action !== 'created') action = 'updated'
    }

    // ③ 只在缺失时补的伴生文件（用户已有的内容绝不动）
    for (const [file, content] of [
      [spec.patchPath, PROFILE_PATCH_TEMPLATE],
      [spec.workspacePath, PROFILE_PNPM_WORKSPACE],
      [spec.rootConfigPath, PROFILE_ROOT_CONFIG],
    ]) {
      if (fs.existsSync(file)) continue
      fs.writeFileSync(file, content, 'utf8')
      created.push(file)
      if (action === 'unchanged') action = 'created'
    }

    // ④ 回读校验：ensure 的承诺必须能在盘上验出来，否则宁可报错
    const verify = JSON.parse(fs.readFileSync(spec.manifestPath, 'utf8'))
    const finalBundles = verify?.dsh?.profile?.bundles
    if (!Array.isArray(finalBundles) || finalBundles[finalBundles.length - 1] !== spec.bundleSpec) {
      throw new Error(`写入后校验失败：${spec.manifestPath} 的 bundles 末位不是自研层 ${spec.bundleSpec}`)
    }
  } catch (error) {
    return {
      ok: false,
      action: 'error',
      name: spec.name,
      dir: spec.dir,
      bundleSpec: spec.bundleSpec,
      error: `profile 自举失败：${error.message}`,
    }
  }

  if (action !== 'unchanged') {
    note('info', `DSH profile「${spec.name}」${action === 'created' ? '已创建' : '已更新'}：${spec.dir}（自研层 ${spec.bundleSpec}）`)
  }
  return { ok: true, action, name: spec.name, dir: spec.dir, bundleSpec: spec.bundleSpec, created, updated }
}

/**
 * 校验单个 profile 目录（**通用**，不只 `nomad` 自建层；只读，Phase 3.1）。
 *
 * 校验面与放行标准：
 *   - `package.json` 必须可解析且为对象、含非空字符串数组 `dsh.profile.bundles`
 *     —— 这是 profile 能被 DSH 加载的最低要求，缺了 = FAIL；
 *   - bundle spec 仅在显式相对形态（`./` `../` 开头）时做**存在性**检查
 *     （scoped npm 包名同样含 `/`，不能按分隔符猜，见 AGENTS.md 铁律 20 的辨析）；
 *   - `cordis.patch.yml` / `cordis.yml` 存在时必须可解析、patch 顶层数组；
 *     **缺失不算问题** —— 上游 `initProfile` 每次启动都会补缺失文件（existsSync 守卫）。
 *
 * @param {string} dir - profile 目录（`<DSH_HOME>/profiles/<name>`）
 * @returns {{ dir: string, exists: boolean, manifestValid: boolean, bundles: string[], problems: string[] }} 校验结果
 */
function validateProfileDir(dir) {
  const result = { dir, exists: false, manifestValid: false, bundles: [], problems: [] }
  if (!fs.existsSync(dir)) {
    result.problems.push('目录不存在')
    return result
  }
  result.exists = true

  // ① 清单（唯一的 FAIL 面：缺它 profile 无法加载）
  const manifestPath = path.join(dir, 'package.json')
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      result.problems.push('package.json 必须是 JSON 对象')
    } else {
      result.manifestValid = true
    }
  } catch (error) {
    result.problems.push(`package.json 不可解析：${error.message}`)
  }
  if (result.manifestValid) {
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) {
      result.problems.push('package.json 缺少 dsh.profile.bundles（必须是字符串数组）')
    } else {
      result.bundles = bundles.filter((item) => typeof item === 'string')
      if (result.bundles.length !== bundles.length) {
        result.problems.push('dsh.profile.bundles 含非字符串项')
      }
      if (result.bundles.length === 0) {
        result.problems.push('dsh.profile.bundles 为空（DSH 将无 bundle 可加载）')
      }
      for (const spec of result.bundles) {
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const target = path.resolve(dir, spec)
          if (!fs.existsSync(target)) {
            result.problems.push(`bundle 相对路径不存在：${spec} → ${target}`)
          }
        }
      }
    }
  }

  // ② 补丁层：存在时必须可解析且顶层数组；缺失由上游 init 自动补，不算问题
  const patchPath = path.join(dir, PROFILE_PATCH_FILENAME)
  if (fs.existsSync(patchPath)) {
    try {
      const doc = readYamlTopArray(patchPath)
      if (!Array.isArray(doc)) result.problems.push(`${PROFILE_PATCH_FILENAME} 顶层必须是数组`)
    } catch (error) {
      result.problems.push(`${PROFILE_PATCH_FILENAME} 不可解析：${error.message}`)
    }
  }

  // ③ 根配置：存在时必须可解析（内容 DSH 每次启动无条件重写，不校验语义）
  const rootConfigPath = path.join(dir, PROFILE_ROOT_FILENAME)
  if (fs.existsSync(rootConfigPath)) {
    try {
      readYamlTopArray(rootConfigPath)
    } catch (error) {
      result.problems.push(`${PROFILE_ROOT_FILENAME} 不可解析：${error.message}`)
    }
  }
  return result
}

/**
 * 只读列出 `<DSH_HOME>/profiles/` 下全部 profile（Phase 3.1，供 CLI/doctor 使用）。
 *
 * 每行带 `kind`：`default` = 配置指定的启动 profile（`runtime.dsh.profile`，缺省 `nomad`），
 * `user` = 其余盘内目录。内置保留名（`SHIPPED_PROFILES`）是**模板名**而非盘内目录，
 * 不参与列举 —— DSH 会按需以模板初始化，盘内不存在对应目录是常态。
 *
 * @param {{ root: string, config: object }} options - NOMAD_ROOT 与已加载配置
 *      （测试可直接传 `{ paths: { dsh_home } }` 形状的最小 config）
 * @returns {{ base: string, defaultName: string, profiles: object[], reserved: string[] }} 结果
 */
function listProfiles(options) {
  const config = options.config
  const base = path.join(config.paths.dsh_home, PROFILES_DIR)
  const defaultName = config.runtime?.dsh?.profile ?? DEFAULT_PROFILE
  const profiles = []
  if (fs.existsSync(base)) {
    const names = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const name of names) {
      const check = validateProfileDir(path.join(base, name))
      profiles.push({ name, kind: name === defaultName ? 'default' : 'user', ...check })
    }
  }
  return { base, defaultName, profiles, reserved: Object.keys(SHIPPED_PROFILES) }
}

/**
 * 创建 profile 骨架（Phase 3.1）。
 *
 * 行为：
 *   - 名字过 `validateProfileName`（保留名 / 路径分隔符 / 保留目录名一律拒绝）；
 *   - 模板必须是上游内置名（bundles 直接取该模板的清单，与上游 `initProfile` 形状一致）；
 *   - `package.json` **已存在即拒绝**（绝不覆盖用户内容 —— 与 `ensureNomadProfile` 同姿态）；
 *   - 伴生文件（patch / pnpm workspace / 根配置）只补缺失。
 *
 * @param {{ root: string, config: object }} options - NOMAD_ROOT 与已加载配置
 * @param {string} name - 新 profile 名（kebab/dir 安全，非保留）
 * @param {string} [template] - 派生模板（上游内置名，缺省 `web`）
 * @returns {{ ok: boolean, name?: string, dir?: string, template?: string, bundles?: string[], created?: string[], error?: string }} 结果
 */
function createProfile(options, name, template = DEFAULT_TEMPLATE) {
  const { root, config } = options
  try {
    validateProfileName(name)
  } catch (error) {
    return { ok: false, error: error.message }
  }
  if (!Object.hasOwn(SHIPPED_PROFILES, template)) {
    return {
      ok: false,
      error: `模板必须是上游内置名（${Object.keys(SHIPPED_PROFILES).sort().join(' / ')}），实际 ${JSON.stringify(template)}`,
    }
  }
  const dir = path.join(config.paths.dsh_home, PROFILES_DIR, name)
  const manifestPath = path.join(dir, 'package.json')
  if (fs.existsSync(manifestPath)) {
    return { ok: false, name, dir, error: `profile「${name}」已存在（${manifestPath}）—— 绝不覆盖已有内容` }
  }
  const created = []
  try {
    fs.mkdirSync(dir, { recursive: true })
    const manifest = {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...SHIPPED_PROFILES[template]] } },
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
    created.push(manifestPath)
    const workspacePath = path.join(dir, 'pnpm-workspace.yaml')
    for (const [file, content] of [
      [path.join(dir, PROFILE_PATCH_FILENAME), PROFILE_PATCH_TEMPLATE],
      [workspacePath, PROFILE_PNPM_WORKSPACE],
      [path.join(dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG],
    ]) {
      if (fs.existsSync(file)) continue
      fs.writeFileSync(file, content, 'utf8')
      created.push(file)
    }
  } catch (error) {
    return { ok: false, name, dir, error: `创建失败：${error.message}` }
  }
  return { ok: true, name, dir, template, bundles: [...SHIPPED_PROFILES[template]], created }
}

module.exports = {
  ensureNomadProfile,
  inspectNomadProfile,
  resolveNomadProfile,
  validateProfileName,
  validateBundleSource,
  validateProfileDir,
  listProfiles,
  createProfile,
  SHIPPED_PROFILES,
  PROFILES_DIR,
  PROFILE_PATCH_FILENAME,
  PROFILE_ROOT_FILENAME,
  PROFILE_ROOT_CONFIG,
  PROFILE_PATCH_TEMPLATE,
  PROFILE_PNPM_WORKSPACE,
  DEFAULT_PROFILE,
  DEFAULT_TEMPLATE,
  DEFAULT_BUNDLE_SOURCE,
}
