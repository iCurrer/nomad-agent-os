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
const { startStatusServer, collectStatus, sanitizeState, readVersionFile, STATE_WHITELIST } = require('../launcher/lib/status-server.js')
const { loadConfig } = require('../launcher/lib/config.js')
const { discoverRuntime } = require('../launcher/lib/runtime.js')
const { detectRoot } = require('../launcher/lib/root.js')

/** 构造一份真实上下文（root/config/runtime），供端点与 collectStatus 复用。 */
function makeContext() {
  const { root, source } = detectRoot({})
  const config = loadConfig({ root })
  const runtime = discoverRuntime({ root, config })
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
