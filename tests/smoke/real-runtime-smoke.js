#!/usr/bin/env node
'use strict'

/**
 * Real Runtime Smoke Test —— 用**真实 DSH 运行时**跑完整生命周期。
 *
 * 与 `portable-smoke.js` 的分工（两者都要跑，不要互相替代）：
 *   portable-smoke.js      用替身验证「引导管线」：快、可重复、不依赖真实引擎
 *   real-runtime-smoke.js  用真 DSH 验证「整条链路真能起来」：慢、会真实写盘
 *
 * 本测试**只读**着 runtime/，绝不创建或覆盖 `runtime/dsh/current` ——
 * 它假设真实运行时已就位；若发现 current 是替身则中止。
 *
 * 同时也是一次**宿主零污染的实证**：以宿主 `~/.dsh` 为标尺 ——
 * 该目录已被清除，若在真实 DSH 运行后重新出现，说明隔离失败。
 *
 * 用法：node tests/smoke/real-runtime-smoke.js [--timeout <ms>]
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const NOMAD = path.join(ROOT, 'launcher', 'nomad.js')
const CURRENT = path.join(ROOT, 'runtime', 'dsh', 'current')
const CURRENT_MANIFEST = path.join(CURRENT, 'nomad-runtime.json')
const STATE = path.join(ROOT, 'data', 'run', 'nomad.state.json')
const DSH_HOME = path.join(ROOT, 'data', 'dsh-home')
const { localDate } = require(path.join(ROOT, 'launcher', 'lib', 'logger.js'))
const { buildOpenCommand } = require(path.join(ROOT, 'launcher', 'lib', 'browser.js'))

/** DSH 进程的原始 stdout/stderr 落点（host.js 用同一规则命名）。 */
const RAW_DSH_LOG = () => path.join(ROOT, 'data', 'logs', `dsh-${localDate()}.log`)

/** 宿主侧零污染标尺（只做只读探测，不写宿主任何位置）。 */
const HOST_HOME = os.homedir()
const HOST_CANARIES = [
  path.join(HOST_HOME, '.dsh'),
  path.join(HOST_HOME, '.dsh-2'),
]

const argv = process.argv.slice(2)
const timeoutIndex = argv.indexOf('--timeout')
const START_TIMEOUT = timeoutIndex === -1 ? '240000' : argv[timeoutIndex + 1]

/**
 * 异步执行 nomad 子命令并收集输出。
 * @param {string[]} args - 参数
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>} 结果
 */
function nomad(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NOMAD, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
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
    child.on('error', (error) => {
      resolve({ status: -1, stdout, stderr: `${stderr}\nspawn error: ${error.message}` })
    })
    child.on('exit', (code) => {
      resolve({ status: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 单跳 HTTP GET（可携带 cookie）。
 * @param {string} url - 完整 URL
 * @param {string|null} cookie - 上一步铸出的 cookie
 * @returns {Promise<object>} 响应摘要
 */
function singleGet(url, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      url,
      { timeout: 20000, headers: cookie === null ? {} : { cookie } },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          const setCookie = response.headers['set-cookie']
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location ?? null,
            contentType: String(response.headers['content-type'] ?? ''),
            bytes: Buffer.byteLength(body, 'utf8'),
            body,
            cookie: Array.isArray(setCookie)
              ? setCookie.map((item) => item.split(';')[0]).join('; ')
              : cookie,
          })
        })
      },
    )
    request.on('timeout', () => {
      request.destroy(new Error('HTTP 探测超时'))
    })
    request.on('error', reject)
  })
}

/**
 * 带 token 的 HTTP 探测，**跟随重定向并携带 cookie**。
 *
 * 为什么必须跟随：DSH 的鉴权 URL 形态是「根路径 + ?token=…」，对它的 GET 会
 * 铸出会话 cookie 后 302 跳到根路径（依据 upstream
 * packages/client/connection/src/browser-auth.ts:223-245）。只打第一跳会得到
 * 空响应体，误判为不可达。
 *
 * @param {string} url - 完整 URL（含 token）
 * @param {number} maxHops - 最多跟随几次
 * @returns {Promise<{ status: number, bytes: number, contentType: string, chain: object[], body: string, cookie: string|null, finalUrl: string }>} 结果
 */
async function fetchUrl(url, maxHops = 4) {
  const chain = []
  let current = url
  let cookie = null
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await singleGet(current, cookie)
    cookie = response.cookie
    chain.push({
      status: response.status,
      contentType: response.contentType,
      bytes: response.bytes,
      location: response.location,
    })
    if (response.status >= 300 && response.status < 400 && response.location !== null) {
      current = new URL(String(response.location), current).toString()
      continue
    }
    return {
      status: response.status,
      bytes: response.bytes,
      contentType: response.contentType,
      chain,
      body: response.body ?? '',
      cookie,
      finalUrl: current,
    }
  }
  const last = chain[chain.length - 1] ?? { status: 0, bytes: 0, contentType: '' }
  return { status: last.status, bytes: last.bytes, contentType: last.contentType, chain, body: '', cookie, finalUrl: current }
}

/**
 * 读取状态文件。
 * @returns {object|null} 状态对象
 */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

const SCENARIO = [
  ['前置：runtime/dsh/current 指向真实 DSH（不是替身）', () => {
    assert.ok(fs.existsSync(CURRENT_MANIFEST), `缺失 ${CURRENT_MANIFEST}`)
    const manifest = JSON.parse(fs.readFileSync(CURRENT_MANIFEST, 'utf8'))
    assert.ok(
      !String(manifest.name ?? '').includes('fake'),
      'current 指向的是替身运行时，本测试需要真实 DSH',
    )
    const entry = path.resolve(CURRENT, manifest.entry)
    assert.ok(fs.existsSync(entry), `清单声明的入口不存在：${entry}`)
    console.log(`       运行时 ${String(manifest.name)}@${String(manifest.version)}`)
  }],

  ['前置：宿主零污染标尺 —— 宿主 ~/.dsh 不存在', () => {
    for (const canary of HOST_CANARIES) {
      assert.equal(fs.existsSync(canary), false, `标尺目录已存在，无法作为判据：${canary}`)
    }
    console.log(`       标尺 ${HOST_CANARIES[0]}`)
  }],

  ['前置：记录 DSH 原始日志偏移（用于把本次启动的输出与历史隔离开）', () => {
    const file = RAW_DSH_LOG()
    SCENARIO.rawLog = file
    SCENARIO.rawOffset = fs.existsSync(file) ? fs.statSync(file).size : 0
    console.log(`       ${path.relative(ROOT, file)} @ ${String(SCENARIO.rawOffset)}B`)
  }],

  ['nomad start（真实 DSH，后台）就绪并返回 0', async () => {
    const result = await nomad(['start', '--no-browser', '--timeout', START_TIMEOUT])
    assert.equal(
      result.status,
      0,
      `start 退出码 ${String(result.status)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
    assert.ok(result.stdout.includes('Nomad 已就绪'), `未就绪：\n${result.stdout}\n${result.stderr}`)
  }],

  ['状态文件：phase=ready、profile 为自建 nomad、端口由 OS 协商、URL 带 token、命令无 npx', () => {
    const state = readState()
    assert.ok(state !== null, '状态文件未生成')
    assert.equal(state.phase, 'ready')
    assert.equal(state.profile, 'nomad', '应运行自建 profile（内置 web 是保留名，不能作为自建目标）')
    assert.match(String(state.url), /^http:\/\/127\.0\.0\.1:\d+\/\?token=/, `URL 形态异常：${String(state.url)}`)
    assert.ok(Number(state.port) > 0, '端口应来自 OS 协商')
    assert.ok(String(state.command).includes('--profile nomad'), '命令应使用 --profile nomad')
    assert.ok(String(state.command).includes('--port 0'), '命令应使用 --port 0')
    assert.ok(!String(state.command).includes('npx'), '命令中不应出现 npx（铁律 8）')
    assert.ok(String(state.node).includes('runtime'), `应使用盘内 Node 而非宿主 Node：${String(state.node)}`)
  }],

  ['profile 自举：盘内 nomad profile 已就位，自研 bundle 在 bundles 末位', () => {
    const manifestPath = path.join(DSH_HOME, 'profiles', 'nomad', 'package.json')
    assert.ok(fs.existsSync(manifestPath), `nomad profile 未自举：${manifestPath}`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    assert.ok(bundles.includes('@deepseek-ai/dsh-base'), `缺少上游 base 层：${bundles.join(', ')}`)
    assert.ok(bundles.includes('@deepseek-ai/dsh-web-app'), `缺少上游 web-app 层：${bundles.join(', ')}`)
    assert.match(bundles.at(-1), /packages[\\/]nomad-web-app$/, `自研层未在末位：${bundles.at(-1)}`)
    console.log(`       ${bundles.join(' → ')}`)
  }],

  ['真实 DSH Web UI 可达（带 token 的 GET → 铸 cookie → 跟随跳转 → 非空 HTML）', async () => {
    const state = readState()
    const response = await fetchUrl(String(state.url))
    for (const hop of response.chain) {
      console.log(`       ${String(hop.status)}  ${hop.contentType || '-'}  ${String(hop.bytes)}B${hop.location ? ` → ${String(hop.location)}` : ''}`)
    }
    assert.ok(response.status >= 200 && response.status < 400, `最终 HTTP ${String(response.status)}`)
    assert.ok(response.bytes > 0, `最终响应体为空（跟随 ${String(response.chain.length)} 跳）`)
    assert.match(response.contentType, /html/i, `content-type 不是 HTML：${response.contentType}`)
  }],

  ['认证设计确认：**裸地址必须 401**（2026-10-08 浏览器报错的真实来源）', async () => {
    // 为什么要这步：用户看到的
    //   `dsh web authentication required; reopen the URL printed by dsh web.`
    // 不是故障，是 DSH **故意**的行为（browser-auth.ts:302-310）。把它固化成断言，
    // 是为了让"浏览器 401"永远能被区分成两种情况：
    //   (a) 设计如此 —— 地址没带 token（本步）；
    //   (b) 真缺陷 —— 带 token 的地址也进不去（下一步会替我们守住）。
    const state = readState()
    const bare = String(state.publicUrl)
    const response = await singleGet(bare, null)
    console.log(`       ${String(response.status)}  ${bare}`)
    assert.equal(response.status, 401, `裸地址期望 401，实际 ${String(response.status)}`)
    assert.ok(
      String(response.body).includes('dsh web authentication required'),
      `401 正文形态变了（上游可能改了鉴权文案）：${String(response.body).slice(0, 120)}`,
    )
  }],

  ['认证握手自检已落盘：state.webAuth 为真通过（303 铸 cookie → 200）', async () => {
    // 这一步验证的是**新加的交付前自检**真的在真机上跑了，而不是只在单测里存在：
    // 监管进程拿到 URL 后先自证"这条地址交给浏览器能进去"，再交给浏览器。
    const deadline = Date.now() + 15000
    let state = readState()
    while (
      Date.now() < deadline
      && (state?.webAuth === undefined || state?.browserHandoff === undefined)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      state = readState()
    }
    assert.ok(state?.webAuth !== undefined, 'state.webAuth 未落盘（交付前自检没有执行）')
    console.log(`       webAuth: ${state.webAuth.ok === true ? '通过' : `未通过 ${String(state.webAuth.error)}`}`)
    for (const step of state.webAuth.steps ?? []) {
      console.log(`       ${String(step.hop)}. ${String(step.status)}  ${String(step.target)}`)
    }
    assert.equal(state.webAuth.ok, true, `认证握手自检未通过：${String(state.webAuth.error)}`)
    assert.equal(state.webAuth.steps?.[0]?.status, 303, '第 1 跳应为 303 铸 cookie')
    assert.ok(
      String(state.webAuth.cookieName ?? '').startsWith('dsh-auth-'),
      `cookie 名异常：${String(state.webAuth.cookieName)}`,
    )
    // 本冒烟以 --no-browser 启动，故交接应被如实标注为 skipped，而不是缺失或假装成功
    assert.equal(state.browserHandoff?.state, 'skipped', `browserHandoff 异常：${JSON.stringify(state.browserHandoff)}`)
  }],

  ['浏览器交接命令自检（静态组装，**不**真的开浏览器）', () => {
    // 这条是 2026-10-08 事故在真机上的守卫：交给系统打开器的参数里，
    // 带 token 的 URL 必须是**完整的那一个参数**。
    // 旧实现（explorer.exe）既开错窗口又把 query 吞掉 → 浏览器 401。
    const state = readState()
    const built = buildOpenCommand(String(state.url), { platform: process.platform })
    assert.equal(built.error, undefined, `无法组装交接命令：${String(built.error)}`)
    assert.ok(built.args.includes(String(state.url)), `URL 未被完整保留：${JSON.stringify(built.args)}`)
    assert.ok(!built.command.toLowerCase().includes('explorer'), '不得使用 explorer.exe 打开 URL（会把 query 吞掉并另开资源管理器窗口）')
    console.log(`       ${built.command} ${built.args.map((arg) => (arg === state.url ? '<带 token 的 URL>' : arg)).join(' ')}`)
  }],

  ['前端资源全量可达（防白屏：首页引用的每个 JS / CSS / 插件模块都必须 200）', async () => {
    // 为什么要这步（2026-10-08 补）：只断言「首页 200 + 非空」证明不了 UI 跑得起来。
    // index.html 只是个壳，真正的界面由 assets/*.js + plugins/??… 客户端模块撑起来；
    // 其中任意一个 404 都会让浏览器**白屏**，而壳的 200 依旧漂亮。
    const state = readState()
    const page = await fetchUrl(String(state.url))
    const refs = new Set()
    for (const match of String(page.body).matchAll(/(?:src|href)="([^"]+)"/g)) {
      const raw = match[1].replaceAll('&amp;', '&')
      if (raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('//')) continue
      refs.add(raw)
    }
    assert.ok(refs.size >= 8, `首页只引用了 ${String(refs.size)} 个资源，疑似不是完整的 SPA 壳`)
    const bad = []
    let total = 0
    const label = (ref) => (ref.length > 74 ? `${ref.slice(0, 74)}…` : ref)
    for (const ref of refs) {
      const target = new URL(ref, page.finalUrl).toString()
      const one = await singleGet(target, page.cookie)
      total += one.bytes
      if (one.status !== 200) bad.push(`${String(one.status)}  ${ref}`)
      console.log(`       ${String(one.status).padStart(3)}  ${label(ref)}`)
    }
    console.log(`       ${String(refs.size)} 个引用，合计 ${(total / 1024 / 1024).toFixed(1)}MB`)
    assert.deepEqual(bad, [], `有资源取不到（浏览器会白屏）：\n${bad.join('\n')}`)
  }],

  ['Nomad 品牌插件进入客户端模块图并被真实服务（L2 客户端插件链路贯通）', async () => {
    // 为什么要这步（2026-10-08 补）：Phase 2 此前只验证过「**能换 bundle 层**」，
    // **没有**验证过「自研客户端插件能被发现、被服务」—— 而 L2/L3 的全部 UI 工作都建在这上面。
    // 把它变成可判伪的断言，断成三环，任一环断裂都必须红：
    //   1) 扫描器认领我们的包 → 首页的模块引用里出现我们那个 client.js
    //   2) 服务端真吐得出字节 → 该地址 200（非 200 就是白屏素材）
    //   3) 吐出来的确实是我们的产物 → 正文含 module-loader 信封 / 我们的注册 id / 两个品牌槽名
    // 注意：这三环**都不影响首页 200**，所以只断言「UI 可达」会全部漏掉。
    // 引用形态（读 `client/modules` 源码确认）：模块是**合并请求**，
    //   `plugins/??<id1>/client.js,<id2>/client.js&rev=<rev>`（逗号分隔，不是每条一个 URL）。
    const state = readState()
    const page = await fetchUrl(String(state.url))
    const refs = new Set()
    for (const match of String(page.body).matchAll(/plugins\/\?\?[^"'\s\\)]+/g)) {
      if (match[0].includes('client.js')) refs.add(match[0].replaceAll('&amp;', '&'))
    }
    const ourId = '@nomad/dsh-client-brand'
    console.log(`       首页模块引用 ${String(refs.size)} 条`)
    for (const ref of refs) console.log(`       · ${ref.length > 96 ? `${ref.slice(0, 96)}…` : ref}`)
    const ours = [...refs].find((ref) => ref.includes('nomad'))
    assert.ok(
      ours !== undefined,
      `我们的插件没有进入客户端模块图 —— 扫描器未认领 packages/nomad-brand。`
      + `（多半是 roster 行 name/路径不对，或 package.json 的 dsh.client / exports["./client"] 不满足契约）\n`
      + `见到的引用：\n${[...refs].join('\n')}`,
    )
    const one = await singleGet(new URL(ours, page.finalUrl).toString(), page.cookie)
    console.log(`       ${String(one.status)}  ${String(one.bytes)}B  合并模块（含 ${ourId}）`)
    assert.equal(one.status, 200, `我们的客户端模块取不到：HTTP ${String(one.status)}`)
    assert.ok(one.body.includes('__ModuleLoader__.load'), '产物不是 module-loader 信封形态（浏览器无法注册这个模块）')
    assert.ok(one.body.includes(ourId), `产物里没有我们的注册 id：${ourId}`)
    assert.ok(
      one.body.includes('sidebar.brand.mark') && one.body.includes('sidebar.brand.name'),
      '产物里没有品牌槽注册 —— 即使加载成功也不会改变界面',
    )
    // 第四环，也是最容易被漏掉的一环：**官方品牌占用者必须已经让出**。
    // 为什么必须单独断言（2026-10-08 真机踩到，属"哑弹"型缺陷）：
    //   两个品牌槽都是 `kind: 'single'`，后到者会在 `SlotCore.register` 里撞
    //   `duplicate declaration` 被拒（依据 `ui-renderer/src/client/registry.ts:487`）。
    //   而本构建的 profile **就是 `official`** —— `ui-brand-official/lib/client.js` 里
    //   那句 `if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return` 被构建期
    //   **死代码消除**掉了（全套产物里该标识符只出现在 README），所以官方占用者一直在注册。
    //   ⇒ 没有这一步，上面三环**全绿**，插件照样是哑弹，界面零变化。
    //   失效模式不碰首页 200、也不碰模块可取性，只能靠"启动图里不该有 brand-official"判伪。
    const allRefs = [...refs].join('\n')
    assert.ok(
      !allRefs.includes('brand-official'),
      '官方品牌占用者仍在客户端启动图里 —— 它会先占住 sidebar.brand.mark / .name 两个 single 槽，'
      + '使我们的注册被 duplicate 拒绝，界面将毫无变化。\n'
      + '修法：packages/nomad-web-app/cordis.patch.yml 末尾 `- id: ui-brand-official` / `disabled: true`。\n'
      + `见到的引用：\n${allRefs}`,
    )
    console.log('       官方品牌占用者已让出（启动图里无 brand-official）')
  }],

  ['Nomad 自有面板插件进入客户端模块图并被真实服务（结构层：侧栏入口 + 主区面板）', async () => {
    // 为什么要这步（2026-10-08 补）：阶段 5-B 让 Nomad 在侧栏**增量长出一个入口**
    // （`sidebar.panellist` / list）+ 主区一个面板（`main` / keyed 新 key）。
    // 这两条槽与品牌槽**性质完全不同**：增量型**没有竞态**，所以不需要"让位"那一环；
    // 但也正因为没有冲突，**任何注册失败都不会报错** —— 只会安静地少一行。
    // 断成三环，任一环断裂都必须红：
    //   1) 扫描器认领我们的包 → 首页模块引用里出现该 client.js
    //   2) 服务端真吐得出字节 → 该地址 200
    //   3) 吐出来的确实是我们的产物 → 含信封 / 注册 id / 两条槽名 / 共用的寻址 id
    // 三环都**不影响首页 200**，所以只断言「UI 可达」会全部漏掉。
    const state = readState()
    const page = await fetchUrl(String(state.url))
    const refs = new Set()
    for (const match of String(page.body).matchAll(/plugins\/\?\?[^"'\s\\)]+/g)) {
      if (match[0].includes('client.js')) refs.add(match[0].replaceAll('&amp;', '&'))
    }
    const ourId = '@nomad/dsh-client-panel'
    const ours = [...refs].find((ref) => ref.includes('dsh-client-panel'))
    assert.ok(
      ours !== undefined,
      '自有面板插件没有进入客户端模块图 —— 扫描器未认领 packages/nomad-panel。'
      + '（多半是 roster 行 name/路径不对，或 package.json 的 dsh.client / exports["./client"] 不满足契约）\n'
      + `见到的引用：\n${[...refs].join('\n')}`,
    )
    const one = await singleGet(new URL(ours, page.finalUrl).toString(), page.cookie)
    console.log(`       ${String(one.status)}  ${String(one.bytes)}B  合并模块（含 ${ourId}）`)
    assert.equal(one.status, 200, `我们的面板模块取不到：HTTP ${String(one.status)}`)
    assert.ok(one.body.includes('__ModuleLoader__.load'), '产物不是 module-loader 信封形态（浏览器无法注册这个模块）')
    assert.ok(one.body.includes(ourId), `产物里没有我们的注册 id：${ourId}`)
    assert.ok(
      one.body.includes('sidebar.panellist'),
      '产物里没有侧栏入口注册（sidebar.panellist）—— 挂了也不会在侧栏出现',
    )
    assert.ok(one.body.includes('main'), '产物里没有主面板注册（main）')
    // 寻址闭环：侧栏行的 id 与主面板的 key **必须同源**。若两处各写一个字符串字面量，
    // 改动时极易只改一处 —— 那时侧栏行照常出现，点下去却抛
    // `layout.selectPanel: main panel "x" is not registered`（半通状态）。
    // 所以断言产物里存在那**唯一定义**，并由单元测试锁住两侧引用同一个常量。
    assert.match(
      one.body,
      /PANEL_ID\s*=\s*"nomad"/,
      '产物里没有找到共用的寻址 id 常量 PANEL_ID —— 两侧 id 一旦不同源，点击侧栏会抛 "main panel is not registered"',
    )
    console.log('       侧栏入口与主面板共用寻址 id「nomad」')
    // 第 4 环：**合规文案必须真的随产物抵达浏览器**。
    // 只断言"插件被送达"是不够的 —— 若 About 区块被误删、或上游归属被改写成营销话术，
    // 模块照旧送达、界面照旧能开，但 MIT 的版权声明与品牌规范的归属说明会**静默消失**。
    // 注意：这里检查的是**产物源码文本**，所以只能断言**字面量** ——
    // 版本号/年号在源码里是模板插值（`${UPSTREAM.holderYear}`），不会被这条断言覆盖，
    // 那部分由单元测试的「★ 上游版本锚定」负责。
    for (const [literal, why] of [
      ['DeepSeek Harness', '上游归属说明'],
      ['Copyright (c)', '上游版权声明（MIT 核心义务）'],
      ['注册商标', '商标声明'],
      ['无背书', '否认官方背书的关系声明（BRAND_GUIDELINES 第 4 条）'],
    ]) {
      assert.ok(
        one.body.includes(literal),
        `产物里缺少「${literal}」(${why}) —— 合规声明必须随界面抵达用户，不能只存在于仓库文档里`,
      )
    }
    console.log('       About：归属 / 版权 / 商标 / 无背书声明均已随产物抵达')
  }],

  ['Nomad 自有外观插件进入客户端模块图（阶段 5-C：换肤）', async () => {
    // 为什么要这步（2026-10-08 补）：阶段 5-C 新增 `nomad-theme`，通过
    // `ctx.theme.overrideTokens()` 换肤。它和 nomad-panel 一样是增量插件（不占槽、
    // 不 disable 任何上游行），故任何注册失败都**不会报错** —— 只会安静地不换肤。
    // 唯一能判伪的方式：扫描器认领 → 首页模块引用里出现 `dsh-client-theme`。
    const state = readState()
    const page = await fetchUrl(String(state.url))
    const refs = new Set()
    for (const match of String(page.body).matchAll(/plugins\/\?\?[^"'\s\\)]+/g)) {
      if (match[0].includes('client.js')) refs.add(match[0].replaceAll('&amp;', '&'))
    }
    const ours = [...refs].find((ref) => ref.includes('dsh-client-theme'))
    assert.ok(
      ours !== undefined,
      '自有外观插件没有进入客户端模块图 —— 扫描器未认领 packages/nomad-theme。'
      + '（多半是 roster 行 name/路径不对，或 package.json 的 dsh.client / exports["./client"] 不满足契约）\n'
      + `见到的引用：\n${[...refs].join('\n')}`,
    )
    const one = await singleGet(new URL(ours, page.finalUrl).toString(), page.cookie)
    console.log(`       ${String(one.status)}  ${String(one.bytes)}B  合并模块（含 dsh-client-theme）`)
    assert.equal(one.status, 200, `我们的外观模块取不到：HTTP ${String(one.status)}`)
    assert.ok(one.body.includes('__ModuleLoader__.load'), '产物不是 module-loader 信封形态')
    assert.ok(one.body.includes('@nomad/dsh-client-theme'), '产物里没有我们的注册 id')
    assert.ok(one.body.includes('overrideTokens'), '产物里没有换肤调用（ctx.theme.overrideTokens）')
    console.log('       换肤插件已进入模块图，overrideTokens 随产物抵达')
  }],

  ['DSH 启动输出零告警（不得出现 failed to import / did not activate / disabling profile plugin row / *Error）', () => {
    // 为什么要这步（2026-10-08 补）：`--dump-config` **只做组合、不做 peer 依赖预检、
    // 也不初始化插件**，所以它放过的行照样可能在运行期出事。真实启动的三类事故只有这里能发现：
    //   1) 运行时包残缺   → `… : failed to import` / `dsh: warning: N entry did not activate`
    //   2) 补丁行形状不对 → `dsh: disabling profile plugin row "x": its declared peer
    //                        dependencies cannot be validated: …`（缺 name）
    //   3) 补丁行形状不对 → `TypeError: Cannot read properties of undefined (reading 'map')`
    //                        + 栈里出现 `at profiles/<name>/#<row>`（缺 config）
    // 三者都**不影响 HTTP 200**，所以只断言「UI 可达」会全部漏掉。
    //
    // 单位陷阱（2026-10-08 修）：偏移量来自 `statSync().size`，是**字节**；
    // 而 `readFileSync(file,'utf8')` 得到的是**字符**串。日志里只要出现中文
    // （例如替身运行时的 `fake-dsh: profile=… 已绑定 …`），字节数就会大于字符数，
    // 于是"没被截断"的检查会**误报**截断。必须按字节比较，再解码成文本切行。
    const file = SCENARIO.rawLog
    assert.ok(fs.existsSync(file), `DSH 原始日志未生成：${file}`)
    const bytes = fs.readFileSync(file)
    assert.ok(
      bytes.length >= SCENARIO.rawOffset,
      `原始日志被截断（字节 ${String(bytes.length)} < 起始偏移 ${String(SCENARIO.rawOffset)}）`,
    )
    const lines = bytes.toString('utf8').slice(SCENARIO.rawOffset).split(/\r?\n/).filter((line) => line.trim() !== '')
    for (const line of lines) console.log(`       ${line}`)
    const offences = lines.filter((line) => /failed to import|did not activate|disabling profile plugin row|\b(Type|Reference|Syntax|Range|URI)Error\b/.test(line))
    assert.deepEqual(
      offences,
      [],
      `真实 DSH 启动有告警（运行时包残缺，或 profile 补丁行形状不对）：\n${offences.join('\n')}`,
    )
  }],

  ['零污染：DSH 状态落在盘内 $DSH_HOME', () => {
    assert.ok(fs.existsSync(DSH_HOME), `盘内 DSH_HOME 未创建：${DSH_HOME}`)
    const entries = fs.readdirSync(DSH_HOME)
    console.log(`       ${DSH_HOME} 下新增：${entries.join(', ') || '(空)'}`)
  }],

  ['零污染实证：真实 DSH 运行后宿主标尺仍未出现', () => {
    for (const canary of HOST_CANARIES) {
      assert.equal(
        fs.existsSync(canary),
        false,
        `宿主污染！真实 DSH 运行后出现了 ${canary} —— 隔离失效`,
      )
    }
  }],

  ['nomad status 报告运行中且可达', async () => {
    const result = await nomad(['status'])
    assert.equal(result.status, 0, `status 退出码 ${String(result.status)}\n${result.stdout}`)
    assert.ok(result.stdout.includes('运行中'), `未见运行中：\n${result.stdout}`)
    assert.ok(result.stdout.includes('可达'), `HTTP 不可达：\n${result.stdout}`)
  }],

  ['nomad stop 干净停止并清理状态文件', async () => {
    const result = await nomad(['stop'])
    assert.equal(result.status, 0, `stop 退出码 ${String(result.status)}\n${result.stdout}\n${result.stderr}`)
    assert.equal(fs.existsSync(STATE), false, '状态文件未被清理')
  }],

  ['停止后 status 返回未运行（退出码 3）', async () => {
    const result = await nomad(['status'])
    assert.equal(result.status, 3, `期望退出码 3，实际 ${String(result.status)}\n${result.stdout}`)
  }],

  ['stop 不得损伤运行时：版本目录与指针仍在', () => {
    assert.ok(fs.existsSync(CURRENT_MANIFEST), 'current 指针被破坏')
    const versions = fs.readdirSync(path.join(ROOT, 'runtime', 'dsh'))
      .filter((name) => name !== 'current')
    assert.ok(versions.length >= 1, `版本目录丢失：${versions.join(', ')}`)
    console.log(`       保留版本：${versions.join(', ')}`)
  }],
]

/**
 * 主流程。
 * @returns {Promise<void>} 完成
 */
async function main() {
  console.log('── Nomad Real Runtime Smoke Test ──')
  console.log(`NOMAD_ROOT = ${ROOT}`)
  console.log('')

  // 清掉可能残留的实例（不动 runtime/）
  await nomad(['stop'])

  let failed = 0
  let executed = 0
  for (const [name, run] of SCENARIO) {
    try {
      await run()
      executed += 1
      console.log(`[ OK ] ${name}`)
    } catch (error) {
      failed += 1
      console.log(`[FAIL] ${name}`)
      console.log(`       ${String(error.message).split('\n').join('\n       ')}`)
      await nomad(['stop'])
      break
    }
  }

  console.log('')
  if (failed === 0) {
    console.log(`合计：通过 ${String(executed)} / 失败 0 —— 真实 DSH 端到端闭环成立`)
  } else {
    const remaining = SCENARIO.length - executed - failed
    console.log(`合计：通过 ${String(executed)} / 失败 ${String(failed)}（首个失败即停；剩余 ${String(remaining)} 步未执行）`)
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`real-runtime-smoke: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 70
})
