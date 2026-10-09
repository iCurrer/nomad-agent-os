// status-server 只读端点的契约与安全回归。
//
// 为什么这个文件要单独存在：端点是把盘内真实数据送进面板的唯一桥接（路径 B，
// docs/HOST_TO_CLIENT.md §4）。它有三条**不可妥协**的安全/契约底线，任何一条破了
// 都是事故：
//   1. **只读**：除 GET/HEAD 外一律 405，绝不写盘；
//   2. **不泄露 token**：nomad.state.json 的 `url` 字段带 launch token，端点必须白名单
//      过滤，绝不能把带 token 的 URL 吐给浏览器；
//   3. **生命周期收敛**：close() 后端口必须真正释放（不留下游离的只读服务）。

const test = require('node:test')
const assert = require('node:assert')
const { startStatusServer, collectStatus, sanitizeState, readVersionFile, buildProfilesSummary, buildPermissionsSummary, buildUpdateSummary, STATE_WHITELIST } = require('../launcher/lib/status-server.js')
const { loadConfig } = require('../launcher/lib/config.js')
const { discoverRuntime } = require('../launcher/lib/runtime.js')
const { detectRoot } = require('../launcher/lib/root.js')

/**
 * 测试用的监听端口 —— **刻意避开生产的固定端口 3090**。
 *
 * `config.status.port` 缺省 3090 是刻意设计（面板零构建、手写，读不到运行时随机端口，
 * 只能靠可预测地址 fetch，见 ADR-0030）。但本机只要有 Nomad 实例在跑，它就正占着 3090；
 * 测试若再绑同一端口会 EADDRINUSE **假红** —— 失败原因与代码无关，纯粹是与运行实例抢端口。
 *
 * 因此测试改用「按 pid 派生」的高位端口（20000~39999，通常落在 Windows 动态端口范围之外）。
 * 这**不改变任何断言语义**：`端点端口必须等于 config.status.port` 这条契约仍被完整验证，
 * 只是被验证的具体数值由 3090 换成测试端口。3090 这个**具体数值**另有断言守着 ——
 * tests/nomad-panel.test.js 用纯文本断言 client.js 的 STATUS_ENDPOINT 与
 * config/nomad.yaml 的 status.port 一致（不监听端口，故不受运行实例影响）。
 */
const TEST_PORT = 20000 + (process.pid % 20000)

/** 构造一份真实上下文（root/config/runtime），供端点与 collectStatus 复用。 */
function makeContext() {
  const { root, source } = detectRoot({})
  const config = loadConfig({ root })
  const runtime = discoverRuntime({ root, config })
  config.status.port = TEST_PORT
  return { root, source, config, runtime }
}

test('sanitizeState：白名单过滤，token 所在的 url 字段必须被剔除', () => {
  const sanitized = sanitizeState({
    url: 'http://127.0.0.1:1234/?token=SUPER-SECRET',
    publicUrl: 'http://127.0.0.1:1234/',
    phase: 'ready',
    port: 1234,
    secretField: 'should-be-dropped',
  })
  assert.ok(!('url' in sanitized), '带 token 的 url 绝不能进入端点输出')
  assert.ok(!('secretField' in sanitized), '白名单之外的字段必须丢弃')
  assert.equal(sanitized.phase, 'ready', '白名单内的字段应保留')
  assert.equal(sanitized.publicUrl, 'http://127.0.0.1:1234/', '脱敏的 publicUrl 应保留')
})

test('sanitizeState：null / 非对象输入安全返回 null', () => {
  assert.equal(sanitizeState(null), null)
  assert.equal(sanitizeState(undefined), null)
})

test('readVersionFile：解析 VERSION 的 KEY=VALUE 行', () => {
  const version = readVersionFile(require('node:path').resolve(__dirname, '..'))
  assert.equal(typeof version.NOMAD_VERSION, 'string', '应读到 NOMAD_VERSION')
  assert.equal(typeof version.DSH_VERSION, 'string', '应读到 DSH_VERSION')
})

test('STATE_WHITELIST：不包含 url（防止未来有人把 token 加回白名单）', () => {
  assert.ok(!STATE_WHITELIST.includes('url'), '白名单里绝不能出现 url —— 它带 launch token')
})

test('collectStatus：返回三类合一的结构（identity / state / health）', async () => {
  const ctx = makeContext()
  const status = await collectStatus(ctx)
  assert.equal(status.ok, true)
  assert.ok(typeof status.generatedAt === 'string', '应有生成时间戳')
  assert.ok(status.identity !== null && typeof status.identity === 'object', '应有身份段')
  assert.ok(typeof status.health.summary.pass === 'number', '应有健康度汇总')
  assert.ok(Array.isArray(status.health.results), '应有健康度明细')
})

test('端点：GET 返回 200 + 三类合一 JSON，且不泄露真实 token', async () => {
  const ctx = makeContext()
  const { port, close } = await startStatusServer(ctx)
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/status`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.ok(body.identity && typeof body.identity.NOMAD_VERSION === 'string', '应含身份')
    assert.ok(body.health && typeof body.health.summary.pass === 'number', '应含健康度')

    // 核心防线 0：CORS 必须放行任意本地 origin（面板跑在 DSH 的 `127.0.0.1:<随机端口>`
    //   页面里，origin 不可预知；端点只读、无凭据、只绑 127.0.0.1，`*` 无暴露面）。
    //   这是「Failed to fetch」类跨源拦截的回归锚点：写死成 'null' 或漏发都会红。
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      '*',
      '端点必须放行跨源（面板 origin 是 DSH 随机端口）',
    )

    // 核心防线 1：state 段必须被白名单过滤，绝不含带 token 的 url 字段。
    assert.ok(!('url' in (body.state ?? {})), 'state 段绝不能含 url（它带 launch token）')

    // 核心防线 2：若当前有运行实例，端点输出里绝不能出现**真实** launch token。
    //   （doctor 的 browser 检查项含一个假的 `token=doctor-selfcheck-token` 样例串，
    //     那是刻意构造的自检占位，不是凭据 —— 所以不能简单断言「不含 token=」，
    //     而要断言「不含真实的 token 值」。）
    const { readState } = require('../launcher/lib/state.js')
    const live = readState(ctx.root)
    if (live !== null && typeof live.url === 'string') {
      const token = new URL(live.url).searchParams.get('token')
      if (token !== null && token !== '') {
        assert.ok(
          !JSON.stringify(body).includes(token),
          '端点输出绝不能泄露真实 launch token',
        )
      }
    }
  } finally {
    await close()
  }
})

test('端点：只读 —— POST / PUT 返回 405', async () => {
  const ctx = makeContext()
  const { port, close } = await startStatusServer(ctx)
  try {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${String(port)}/status`, { method })
      assert.equal(res.status, 405, `${method} 应被拒绝（只读端点）`)
    }
  } finally {
    await close()
  }
})

test('端点：close 后端口释放（不留下游离服务）', async () => {
  const ctx = makeContext()
  const { port, close } = await startStatusServer(ctx)
  await close()
  // close 后再连同一端口，应失败（端口已释放，无服务监听）。
  await assert.rejects(
    fetch(`http://127.0.0.1:${String(port)}/status`),
    /fetch failed|ECONNREFUSED|network/i,
    'close 后端口应已释放，再访问应连接失败',
  )
})

test('端点：使用 config.status.port 固定端口（面板靠可预测地址 fetch）', async () => {
  const ctx = makeContext()
  const { port, close } = await startStatusServer(ctx)
  try {
    assert.equal(port, ctx.config.status.port, '端点端口必须等于 config.status.port（固定端口是面板桥接的前提）')
  } finally {
    await close()
  }
})

// ── 3.6 面板整合：profiles / permissions / update 三段 ─────────────────────────
// 契约：轻量段每次现算（单文件级读取），update 段只回读 CLI 留档（端点零网络）。

test('collectStatus：3.6 整合段齐全且形状正确', async () => {
  const ctx = makeContext()
  const status = await collectStatus(ctx)
  // profiles：数量 + 默认名 + 每项最小字段
  assert.ok(status.profiles && typeof status.profiles === 'object', '应有 profiles 段')
  assert.ok(typeof status.profiles.count === 'number' && status.profiles.count >= 0, 'profiles.count 应是数字')
  assert.ok(typeof status.profiles.defaultName === 'string', 'profiles.defaultName 应是字符串')
  assert.ok(Array.isArray(status.profiles.items), 'profiles.items 应是数组')
  for (const item of status.profiles.items) {
    assert.ok(typeof item.name === 'string' && item.name !== '', 'profile 项应有名称')
    assert.ok(item.kind === 'default' || item.kind === 'user', `profile 项 kind 只能是 default/user，实际 ${item.kind}`)
    assert.ok(typeof item.bundles === 'number' && typeof item.problems === 'number', 'profile 项应有 bundles/problems 计数')
  }
  // permissions：exists + never 计数 + problems 计数
  assert.ok(status.permissions && typeof status.permissions === 'object', '应有 permissions 段')
  assert.ok(typeof status.permissions.exists === 'boolean', 'permissions.exists 应是布尔')
  assert.ok(typeof status.permissions.never === 'number', 'permissions.never 应是数字')
  assert.ok(typeof status.permissions.problems === 'number', 'permissions.problems 应是数字')
  // update：从未检查为 null；有留档则 checkedAt 可解析
  assert.ok(
    status.update === null || (typeof status.update.checkedAt === 'string' && !Number.isNaN(Date.parse(status.update.checkedAt))),
    'update 段要么为 null（从未检查），要么带可解析的 checkedAt',
  )
})

test('buildProfilesSummary：默认 profile 必须被标记为 default', () => {
  const ctx = makeContext()
  const summary = buildProfilesSummary({ root: ctx.root, config: ctx.config })
  if (summary.count === 0) return // 空盘也是合法状态
  const marked = summary.items.find((item) => item.kind === 'default')
  assert.ok(marked !== undefined, '配置指定的启动 profile 应被标记为 default')
  assert.equal(marked.name, summary.defaultName, 'default 标记必须落在 defaultName 上')
})

test('buildPermissionsSummary：真实盘内模板应可加载（存在或如实报告缺失）', () => {
  const ctx = makeContext()
  const summary = buildPermissionsSummary(ctx.root)
  assert.equal(typeof summary.exists, 'boolean')
  if (summary.exists && summary.problems === 0) {
    assert.ok(summary.summary !== '', '模板有效时必须给出档位摘要字符串')
  }
  assert.ok(summary.never >= 0 && summary.never <= 6, 'never 条数应在 NEVER_IDS 范围内')
})

test('buildUpdateSummary：无留档返回 null（端点零网络的回读契约）', () => {
  const ctx = makeContext()
  const summary = buildUpdateSummary(ctx.root)
  assert.ok(summary === null || typeof summary === 'object', '返回 null 或留档对象，绝不抛')
})
