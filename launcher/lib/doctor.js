'use strict'

/**
 * `nomad doctor` —— 体检。
 *
 * 设计原则：**只报事实 + 只报证据**。每一项要么带源码/配置出处，要么明确标注
 * "未验证"。不知道就写不知道，不用"应该没问题"糊过去（AGENTS.md 第 11 节）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { inspectDirs, buildArgv } = require('./bootstrap.js')
const { buildEnv, describePlan } = require('./env.js')
const { isInside } = require('./paths.js')
const { readState, isAlive, stateFile } = require('./state.js')
const { probeHttp } = require('./probe.js')
const { sanitizeUrl } = require('./dsh-url.js')
const { buildOpenCommand } = require('./browser.js')
const { verifyAuthHandshake, describeHandshake } = require('./web-auth.js')
const {
  scanBrokenPackages,
  scanMissingPackages,
  countLockedPackages,
  findNodeModulesDir,
} = require('./runtime.js')
const { inspectNomadProfile } = require('./profile.js')

/** 状态标识。 */
const PASS = 'pass'
const WARN = 'warn'
const FAIL = 'fail'
const SKIP = 'skip'

/**
 * 运行体检。
 *
 * **只读保证**：本函数不创建目录、不写状态文件、不改任何配置。
 * 需要落盘的引导动作（建目录基线）只由 `start` / 运行时监督进程执行。
 *
 * @param {{ root: string, source: string, config: object, runtime: object }} options - 上下文
 * @returns {Promise<{ results: object[], summary: { pass: number, warn: number, fail: number, skip: number } }>} 结果
 */
async function runDoctor(options) {
  const { root, source, config, runtime } = options
  const results = []
  const add = (id, title, status, detail = '', hint = '') => {
    results.push({ id, title, status, detail, hint })
  }

  // 1. 根目录
  add('root', 'NOMAD_ROOT', PASS, `${root}（来源：${source ?? '未标注'}）`)

  // 2. 配置
  const version = config.raw?.nomad?.version ?? '(未声明)'
  add('config', '配置文件', PASS, `${config.file}（nomad.version = ${version}）`)

  // 3. 路径关卡：全部落在 NOMAD_ROOT 内
  const pathLines = Object.entries(config.paths).map(([key, value]) => `${key} → ${value}`)
  add('paths', '路径（全部相对 NOMAD_ROOT）', PASS, pathLines.join('\n'))

  // 4. Secret 关卡
  add('secrets', '配置内无密钥字段', PASS, '已在加载期强制校验（SECRET_KEY 扫描）')

  // 5. 目录基线（只读巡检；缺失由 start 补齐）
  const dirs = inspectDirs(config)
  if (dirs.unwritable.length > 0) {
    add(
      'dirs',
      '目录基线',
      FAIL,
      dirs.unwritable.map((item) => `${item.dir}: ${item.error}`).join('\n'),
      '检查盘符是否只读或权限不足',
    )
  } else if (dirs.missing.length > 0) {
    add(
      'dirs',
      '目录基线',
      WARN,
      `已存在 ${String(dirs.existing.length)} 个，缺失 ${String(dirs.missing.length)} 个（start 时自动创建）：\n${dirs.missing.join('\n')}`,
      '这是预期状态（首次启动前）；start 会调用 bootstrap 补齐',
    )
  } else {
    add('dirs', '目录基线', PASS, `全部 ${String(dirs.existing.length)} 个存在且可写`)
  }

  // 6. Node
  const bundled = typeof runtime.node.source === 'string' && runtime.node.source.startsWith('bundled:')
  add(
    'node',
    'Node 运行时',
    bundled ? PASS : WARN,
    `${runtime.node.source}（${runtime.node.version ?? '版本未探测到'}）`,
    bundled ? '' : 'V1 合格线要求随盘携带 Node：把 node 发行版放到 runtime/node/（不要要求用户机装 Node）',
  )

  // 7. DSH 运行时
  if (runtime.dsh.missing === true) {
    add(
      'dsh',
      'DSH 运行时',
      FAIL,
      runtime.dsh.reason ?? `未找到：${runtime.dsh.dir}`,
      '把已构建的 @deepseek-ai/dsh 包放到 runtime/dsh/<version>/，并让 runtime/dsh/current 指向它（零编译交付，见 docs/PORTABILITY.md §8）',
    )
  } else {
    add(
      'dsh',
      'DSH 运行时',
      PASS,
      `目录 ${runtime.dsh.dir}\n包名 ${runtime.dsh.name}  版本 ${runtime.dsh.version}\n入口 ${runtime.dsh.entry}（来自 ${runtime.dsh.entrySource}）\n可用版本: ${runtime.dsh.available.join(', ') || '(仅 current)'}`,
    )
  }

  // 8. 运行时包完整性（只读）
  //    真实缺陷来源（2026-10-08）：打包期一次被打断的 npm install 留下半成品树 ——
  //    顶层是「有内容但没有 package.json」的残骸，而**正确的嵌套位置整份缺失**。
  //    它不会让 DSH 起不来，只会让 roster 里某个条目静默 "failed to import"，
  //    所以必须由工具把它变成看得见的东西。
  //
  //    两条判据都要跑，谁也替代不了谁：
  //      · 锁文件对账（scanMissingPackages）：能发现「整份缺失」—— 权威判据
  //      · 目录遍历（scanBrokenPackages）：无锁文件时的回退；宁可少报也不误报
  //    注意：**重跑 npm install 修不好这类问题**（npm 信任隐藏锁文件里「已安装」的记录），
  //    必须先把问题目录挪走让它重新归位。详见 docs/DEVELOPMENT.md §8。
  if (runtime.dsh.missing !== true) {
    // ⚠️ 必须从**入口路径**定位 node_modules，不能用 runtime.dsh.dir 去拼：
    //    `current` 只是清单目录，其下没有 node_modules（曾因此假报 PASS）。
    const modulesDir = findNodeModulesDir(runtime.dsh.entry)
    if (modulesDir === null) {
      add('packages', '运行时包完整性', SKIP, `无法从入口定位 node_modules：${runtime.dsh.entry}`, '')
    } else {
      const versionDir = path.dirname(modulesDir)
      const missing = fs.existsSync(modulesDir) ? scanMissingPackages(versionDir) : null
      const broken = fs.existsSync(modulesDir) ? scanBrokenPackages(modulesDir) : []
      if (missing !== null && missing.length > 0) {
        add(
          'packages',
          '运行时包完整性',
          WARN,
          `${missing.length} 个包在锁文件里登记了、盘上却没有：\n`
          + missing.map((item) => `${item.optional ? '[可选] ' : '[必需] '}${item.name}  →  ${item.reason}`).join('\n'),
          'DSH 仍能启动，但 roster 里引用它们的条目会 failed to import（日志可见）。'
          + '补救：把上面这些目录挪走（或删掉 node_modules/.package-lock.json）后重跑 npm install '
          + '—— 务必让它跑完，别再中途打断（详见 docs/DEVELOPMENT.md §8）',
        )
      } else if (broken.length > 0) {
        add(
          'packages',
          '运行时包完整性',
          WARN,
          `${broken.length} 个残缺包（有子目录但缺 package.json）：\n`
          + broken.map((item) => `${item.name}  →  仅 ${item.contents.join(', ')}`).join('\n'),
          'DSH 仍能启动，但 roster 里引用它们的条目会 failed to import（日志可见）。'
          + '补救：把这些目录挪走后重跑 npm install（务必让进程跑完，别中途打断）',
        )
      } else if (missing === null) {
        add(
          'packages',
          '运行时包完整性',
          PASS,
          `${modulesDir}（未发现残缺包；无锁文件可对账，"整份缺失"这类缺陷本次未被覆盖）`,
        )
      } else {
        add(
          'packages',
          '运行时包完整性',
          PASS,
          `${modulesDir}（锁文件登记 ${String(countLockedPackages(versionDir))} 个包，逐一核对无缺失）`,
        )
      }
    }
  } else {
    add('packages', '运行时包完整性', SKIP, '缺少 DSH 运行时，无法扫描', '先补齐 runtime/dsh/current')
  }

  // 9. Nomad profile（只读巡检）
  //    profile = 「上游内置模板 + 自研 bundle 层」的组合体，由 Launcher 在 start 时自举。
  //    doctor 只巡检、不创建 —— 跑一次体检不该在盘上写任何东西（与 inspectDirs 同原则）。
  try {
    const info = inspectNomadProfile({ root, config })
    const spec = info.spec
    const lines = [
      `名称 ${spec.name}（派生自内置模板 ${spec.template}）`,
      `目录 ${spec.dir}`,
      `自研层 ${spec.bundleSpec} → ${spec.bundleSourceDir}`,
    ]
    if (info.exists) lines.push(`bundles: ${info.bundles.length > 0 ? info.bundles.join(', ') : '(空)'}`)
    if (!info.bundleSource.ok) {
      add('profile', 'Nomad profile', FAIL, lines.join('\n'), info.bundleSource.error ?? '')
    } else if (!info.exists) {
      add('profile', 'Nomad profile', WARN, lines.join('\n'), '尚未初始化：start 会按内置模板创建并追加自研层')
    } else if (!info.manifestValid) {
      add('profile', 'Nomad profile', FAIL, lines.join('\n'), '清单不是合法 JSON 对象；删掉该目录后 start 会重建')
    } else if (!info.bundleLast) {
      add(
        'profile',
        'Nomad profile',
        WARN,
        lines.join('\n'),
        '自研层缺失、或不在 bundles 末位（补丁会叠错顺序）—— start 会自动补正到末位',
      )
    } else {
      add('profile', 'Nomad profile', PASS, lines.join('\n'))
    }
  } catch (error) {
    add(
      'profile',
      'Nomad profile',
      FAIL,
      error instanceof Error ? error.message : String(error),
      '检查 config/nomad.yaml 的 runtime.dsh.profile / profile_template / bundle_source',
    )
  }

  // 10. 启动命令（dry-run：只组装，不执行）
  if (runtime.dsh.missing !== true) {
    const argv = buildArgv({ config, runtime })
    add('argv', '启动命令（仅组装，未执行）', PASS, `${argv.display}\ncwd = ${argv.cwd}`)
  } else {
    add('argv', '启动命令', SKIP, '缺少 DSH 运行时，无法组装', '先补齐 runtime/dsh/current')
  }

  // 11. 隔离计划
  const { report } = buildEnv({ root, isolation: config.isolation })
  const planText = describePlan(report, config.isolation.override, root).join('\n')
  // 用 isInside 而非裸前缀拼接（ADR-0028）：NOMAD_ROOT 在盘符根时带尾分隔符（`E:\`），
  // 拼 `` `${root}\\` `` 会得到 `E:\\`，于是盘内目标被误判成越界 —— doctor 会假 FAIL。
  const outside = Object.values(config.isolation.override)
    .filter((value) => typeof value === 'string' && !isInside(root, value))
  if (config.isolation.enabled === false || report.strategy === 'inherit-all') {
    add('isolation', '宿主隔离', FAIL, planText, 'isolation.enabled 必须为 true 且 strategy 为 allowlist（铁律 11）')
  } else if (outside.length > 0) {
    add('isolation', '宿主隔离', FAIL, `${planText}\n越界目标: ${outside.join(', ')}`)
  } else {
    add('isolation', '宿主隔离', PASS, planText)
  }

  // 12. 端口
  add(
    'port',
    '端口策略',
    PASS,
    config.web.port === 0
      ? 'web.port = 0 → 交给 OS 分配（等价 `--port 0`，上游 desktop-host 亦如此）'
      : `web.port = ${String(config.web.port)}（固定端口；被占用时 DSH 会以 bind 诊断拒绝启动）`,
  )

  // 13. 宿主污染探针（只读）
  const hostDsh = path.join(os.homedir(), '.dsh')
  if (fs.existsSync(hostDsh)) {
    add(
      'host-probe',
      '宿主污染探针',
      WARN,
      `宿主上存在 ${hostDsh}`,
      '该目录不属于 Nomad（我们只用 DSH_HOME → 盘内）。它可能是历史未隔离运行留下的。Nomad 不会读取或写入它；如需清理请由你手动确认后处理。',
    )
  } else {
    add('host-probe', '宿主污染探针', PASS, `宿主 ${hostDsh} 不存在（符合预期）`)
  }

  // 14. 当前实例
  const state = readState(root)
  if (state === null) {
    add('instance', '当前实例', PASS, '无运行中的实例')
  } else {
    const alive = isAlive(state.supervisorPid) || isAlive(state.dshPid)
    const probe = state.url === undefined ? { reachable: false } : await probeHttp(state.url, { timeoutMs: 1200 })
    add(
      'instance',
      '当前实例',
      alive ? PASS : WARN,
      `监管进程 pid=${String(state.supervisorPid)}（${isAlive(state.supervisorPid) ? '存活' : '已退出'}）\n`
      + `DSH 进程 pid=${String(state.dshPid)}（${isAlive(state.dshPid) ? '存活' : '已退出'}）\n`
      + `地址 ${state.url === undefined ? '(未记录)' : sanitizeUrl(state.url)}（HTTP ${probe.reachable ? String(probe.status) : '不可达'}）\n`
      + `认证 ${describeHandshake(state.webAuth)}\n`
      + `浏览器 ${state.browserHandoff === undefined ? '未记录' : `${String(state.browserHandoff.state)}${state.browserHandoff.method === undefined ? '' : `（${String(state.browserHandoff.method)}）`}`}\n`
      + `状态文件 ${stateFile(root)}`,
      alive ? '' : '实例已退出但状态文件仍在：下次 start 会自动清理',
    )
  }

  // 15. 浏览器交接命令（**静态自检**，不真的开浏览器）
  //
  //     为什么这个体检项存在（2026-10-08 真实事故）：
  //       旧实现 `spawn('explorer.exe', [url])` 不是"打开 URL"的接口 —— 它把 URL
  //       当路径处理，另开一个文件资源管理器窗口，同时让浏览器拿到**丢了 query**
  //       的裸地址 → DSH 回 401 `authentication required`。
  //       这个缺陷无法靠"看返回值"发现（explorer.exe 恒返回退出码 1，旧实现只
  //       检查 spawn 是否抛异常 → 永远"成功"）。所以必须把它变成一条**静态可断言**
  //       的检查：命令组装出来后，那个带 token 的 URL 必须原封不动是其中一个参数。
  //       真正的守卫在 tests/browser.test.js；体检项负责让它在真机上永远可见。
  try {
    const sample = `http://${config.web.host}:${config.web.port === 0 ? '4850' : String(config.web.port)}/?token=doctor-selfcheck-token`
    const built = buildOpenCommand(sample, { browserPath: config.web.browser_path })
    if (built.error !== undefined) {
      add(
        'browser',
        '浏览器交接命令',
        FAIL,
        `无法为样例 URL 组装交接命令：${built.error}`,
        '检查 web.browser_path；或把 DSH 升级到只输出单参数 token URL 的版本',
      )
    } else {
      const preserved = built.args.includes(sample)
      const exists = built.method !== 'configured-app' || fs.existsSync(built.command)
      const detail = [
        `平台 ${process.platform}  方式 ${built.method}`,
        `命令 ${built.command}`,
        `参数 ${JSON.stringify(built.args)}`,
        `URL 原样保留在参数中：${preserved ? '是' : '否'}`,
        config.web.browser_path === '' ? 'web.browser_path 未设置 → 走系统默认浏览器' : `web.browser_path = ${config.web.browser_path}`,
      ].join('\n')
      if (!preserved) {
        add('browser', '浏览器交接命令', FAIL, detail, 'URL 在交接途中被拆分/丢失，浏览器必然拿到未鉴权地址 —— 这是 401 的根因')
      } else if (!exists) {
        add('browser', '浏览器交接命令', FAIL, detail, `web.browser_path 指向的可执行文件不存在：${built.command}`)
      } else {
        add('browser', '浏览器交接命令', PASS, detail)
      }
    }
  } catch (error) {
    add('browser', '浏览器交接命令', FAIL, error instanceof Error ? error.message : String(error), '')
  }

  // 16. Web 认证握手（**动态**；仅当实例在运行且记录了带 token 的地址）
  //     回答的是"这条 URL 交给浏览器到底能不能进去"：303 铸 cookie → 200。
  //     401 则说明交付给浏览器的地址没带上有效 token（正是浏览器报的错）。
  if (state !== null && typeof state.url === 'string') {
    const aliveNow = isAlive(state.supervisorPid) || isAlive(state.dshPid)
    if (!aliveNow) {
      add('web-auth', 'Web 认证握手', SKIP, '实例已退出，无法自检', '实例运行中再跑 doctor 可验证令牌握手')
    } else {
      const handshake = await verifyAuthHandshake(state.url, { timeoutMs: 1500 })
      const chain = handshake.steps
        .map((step) => `${String(step.hop)}. ${String(step.status)}  ${step.target}${step.location === '' ? '' : ` → ${step.location}`}`)
        .join('\n')
      if (handshake.ok === true) {
        add('web-auth', 'Web 认证握手', PASS, `${chain}\ncookie ${String(handshake.cookieName ?? '(未铸)')}`)
      } else {
        add(
          'web-auth',
          'Web 认证握手',
          FAIL,
          `${chain}\n${String(handshake.error ?? '未知原因')}`,
          '若第 1 跳是 401，说明地址里的 ?token= 丢了 —— 用 `nomad open` 或 `nomad url` 取**带令牌**的地址；'
          + '浏览器使用不带 token 的同一地址**必然** 401，这是 DSH 的鉴权设计',
        )
      }
    }
  } else {
    add('web-auth', 'Web 认证握手', SKIP, '没有运行中的实例记录', '')
  }

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const item of results) summary[item.status] += 1
  return { results, summary }
}

/**
 * 渲染体检结果为文本。
 * @param {{ results: object[], summary: object }} report - runDoctor 的返回值
 * @returns {string} 文本
 */
function renderDoctor(report) {
  const glyph = { pass: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', skip: '[ -- ]' }
  const lines = []
  for (const item of report.results) {
    lines.push(`${glyph[item.status]} ${item.title}`)
    for (const line of String(item.detail).split('\n')) lines.push(`       ${line}`)
    if (item.hint !== '') lines.push(`       → ${item.hint}`)
    lines.push('')
  }
  const { pass, warn, fail, skip } = report.summary
  lines.push(`合计：通过 ${String(pass)} / 警告 ${String(warn)} / 失败 ${String(fail)} / 跳过 ${String(skip)}`)
  return lines.join('\n')
}

module.exports = { runDoctor, renderDoctor, PASS, WARN, FAIL, SKIP }
