'use strict'

/**
 * Nomad 状态端点 —— 只读 HTTP 服务。
 *
 * 回答「面板（浏览器半）要显示的盘内真实数据从哪来」这一 5-B 地基问题（见
 * docs/HOST_TO_CLIENT.md §4/§6）：不碰 Typert 生成器、不造毫秒流式、不引入 TS 构建，
 * 只用 Node 原生 http 起一个**只读**端点，把 `runDoctor()` + `readState()` + `VERSION`
 * 三类已存在的数据聚合成一个 JSON，供面板低频轮询。
 *
 * ── 安全边界（铁律，缺一不可）──────────────────────────────────────────────
 *   1. **只读**：只调 runDoctor / readState / 读 VERSION，**绝不写盘**、绝不碰
 *      Agent Loop / Session / Tool Runtime（AGENTS.md 铁律 12、13）。
 *   2. **只绑 127.0.0.1**：与 DSH 的 web 一致，不暴露到网络。
 *   3. **不泄露 token**：readState 里 `url` 字段带 launch token（浏览器铸 cookie 用，
 *      见 state.js 顶部安全说明），端点**原样输出会泄露**。故这里只挑白名单字段，
 *      绝不把 `url` 整条吐出去。
 *   4. **生命周期收敛**：由 host.js 在 DSH 就绪后 start、退出时 stop，不引入独立
 *      长驻进程（「遵循 DSH 生命周期」——维护者 2026-10-08 拍板）。
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const { runDoctor } = require('./doctor.js')
const { readState } = require('./state.js')
const { dataSummary } = require('./dataman.js')
const { listSkills } = require('./skills.js')

/** 状态端点返回的 state 字段白名单（其余一律丢弃，尤其带 token 的 `url`）。 */
const STATE_WHITELIST = [
  'phase',
  'publicUrl',
  'port',
  'profile',
  'runtime',
  'startedAt',
  'readyAt',
  'heartbeatAt',
  'instanceId',
  'supervisorPid',
  'dshPid',
  'configFile',
]

/**
 * 从 nomad.state.json 里挑出白名单字段。
 * @param {object|null} state - readState 的返回值
 * @returns {object} 已过滤的运行态
 */
function sanitizeState(state) {
  if (state === null || typeof state !== 'object') return null
  const out = {}
  for (const key of STATE_WHITELIST) {
    if (state[key] !== undefined) out[key] = state[key]
  }
  return out
}

/**
 * 读 VERSION 文件（`KEY=VALUE` 纯文本）为对象。
 * @param {string} root - NOMAD_ROOT
 * @returns {object} 键值对象；文件缺失返回空对象
 */
function readVersionFile(root) {
  const out = {}
  try {
    const text = fs.readFileSync(path.join(root, 'VERSION'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx <= 0) continue
      out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
    }
  } catch {
    /* VERSION 缺失不致命：身份段留空即可 */
  }
  return out
}

/**
 * 组装 skills 数据段（5-B 数据面扩展，Phase 3.2）。
 *
 * 只挑面板展示所需的最小字段：数量 + 有效 skill 的名称/描述（描述截断到 120 字符，
 * 避免个别长描述把 5s 轮询的 payload 撑大）。无效项只报数量 —— 修复指引由
 * doctor 的 skills 巡检项（面板 health.results 里现成可见）承担，不在这里重复。
 *
 * @param {object} config - 已加载配置
 * @returns {{ base: string, exists: boolean, total: number, valid: number, items: object[], ignored: number, invalid: number }} 摘要
 */
function buildSkillsSummary(config) {
  const scan = listSkills({ config })
  const items = []
  for (const item of scan.skills) {
    if (item.problems.length > 0 || item.skill === null) continue
    items.push({
      name: item.skill.name,
      format: item.kind,
      description: item.skill.description.length > 120
        ? `${item.skill.description.slice(0, 120)}…`
        : item.skill.description,
    })
  }
  return {
    base: scan.base,
    exists: scan.exists,
    total: scan.skills.length,
    valid: items.length,
    invalid: scan.skills.length - items.length,
    ignored: scan.ignored.length,
    items,
  }
}

/**
 * 数据面摘要（Phase 3.3）：可清理白名单的体积/文件数（轻量，不做清理计划）。
 *
 * @param {object} config - 已加载配置
 * @returns {{ tmpBytes: number, tmpFiles: number, human: string }} 摘要
 */
function buildDataSummary(config) {
  return dataSummary({ config })
}

/**
 * doctor 结果缓存：健康度不必每次请求全量现算。
 *
 * 为什么（2026-10-09 真机反馈）：面板每 5s 轮询一次 /status，而 doctor 20 项里
 * 「运行时包完整性」要逐一核对 533 个包 —— 在 U 盘 exFAT 上单次就要数秒，轮询
 * 请求堆积、响应忽快忽慢，面板在「骨架 ↔ 数据」之间来回翻页（用户感知为闪屏）。
 * 缓存 TTL 30s：体感仍是「低频刷新的健康度」，但 U 盘 I/O 从每 5s 一次全量
 * 降到每 30s 一次；state/identity/skills/data 等轻量段仍然每次现算（真实新鲜）。
 */
const DOCTOR_CACHE_MS = 30 * 1000
let doctorCache = null // { at: number, doctor: object }

/**
 * 组装一次完整状态 JSON（身份 + 运行态 + 健康度 + Skills + 数据面，五类合一）。
 *
 * 健康度走 30s 缓存（见 DOCTOR_CACHE_MS 注释）；其余轻量段每次现算。
 * @param {{ root: string, source: string, config: object, runtime: object }} options - 上下文
 * @returns {Promise<object>} 状态对象
 */
async function collectStatus(options) {
  const { root, source, config, runtime } = options
  const now = Date.now()
  if (doctorCache === null || now - doctorCache.at >= DOCTOR_CACHE_MS) {
    const doctor = await runDoctor({ root, source, config, runtime })
    doctorCache = { at: now, doctor }
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    identity: readVersionFile(root),
    state: sanitizeState(readState(root)),
    skills: buildSkillsSummary(config),
    data: buildDataSummary(config),
    health: {
      summary: doctorCache.doctor.summary,
      results: doctorCache.doctor.results,
      cachedForMs: Math.max(0, DOCTOR_CACHE_MS - (now - doctorCache.at)),
    },
  }
}

/**
 * 启动只读状态端点。
 *
 * @param {{ root: string, source: string, config: object, runtime: object, logger?: object }} options
 *   - root/source：来自 detectRoot（source 供 doctor 标注 NOMAD_ROOT 来源）
 *   - config/runtime：供 runDoctor 复用（与 host.js 同源）
 *   - logger：可选，host.js 传入的 logger（含 .info/.warn/.debug）
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 *   端口与实际关闭函数。
 *
 * 端口策略：**固定端口**（`config.status.port`，缺省 3090）。为什么不用 OS 协商的随机端口：
 * 面板是**零构建手写**产物，运行在 DSH 的浏览器半里，无法通过 `process.env.DSH_CLIENT_*`
 * （那是构建期内联）得知运行时随机端口，也读不到盘内 `nomad.state.json`。固定端口是唯一
 * 「零魔法、可解释」的桥接：面板直接 fetch 一个可预测地址。端口可在 config 里改，冲突时
 * 端点启动失败（host 记 warn，面板退化为静态骨架，其余功能不受影响）。
 */
async function startStatusServer(options) {
  const { root, source, config, runtime, logger } = options

  const server = http.createServer(async (req, res) => {
    // 只读端点：无论什么路径/方法，一律回同一个 JSON（拒绝写操作，天然幂等只读）。
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'GET, HEAD' })
      res.end(JSON.stringify({ ok: false, error: 'method not allowed (read-only)' }))
      return
    }
    try {
      const payload = await collectStatus({ root, source, config, runtime })
      const body = JSON.stringify(payload)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        // 面板跑在 DSH 的 Web 页面里，其 origin 是 `http://127.0.0.1:<随机端口>`（DSH
        // 用 `--port 0` 由 OS 协商，端口不可预知），所以不能用写死的 origin。端点只读、
        // 无凭据、只绑 127.0.0.1，`*` 无安全暴露面，是唯一正确的跨源放行策略。
        'Access-Control-Allow-Origin': '*',
        'Vary': 'Origin',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      // 端点内部出错也不崩：回 500 + 错误摘要（不泄露堆栈细节）。
      const summary = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: summary }))
    }
  })

  // 固定端口（默认 3090，见 config.status.port）。只绑 127.0.0.1。
  const desiredPort = Number(config.status?.port) || 3090
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(desiredPort, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : desiredPort

  const close = () => new Promise((resolve) => {
    server.close(() => resolve())
    // close 等不到残留连接时强退（keep-alive 连接不会自动断）。
    server.closeAllConnections?.()
  })

  if (logger) logger.info(`状态端点已启动：http://127.0.0.1:${String(port)}/status（只读，固定端口，跟随 DSH 生命周期）`)

  return { port, close }
}

module.exports = { startStatusServer, collectStatus, sanitizeState, readVersionFile, STATE_WHITELIST }
