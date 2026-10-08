#!/usr/bin/env node
'use strict'

/**
 * L4-a Patch Probe —— Phase 2（Nomad Web UI）第一步的前置实验。
 *
 * 要证明的事（见 `docs/UI_ARCHITECTURE.md` §8.5「L4-a 推荐姿态」与 §8.0 五级梯度）：
 *   **在不 fork 上游源码的前提下，自研 patch 层能被叠加进 DSH 的 profile 组合树。**
 *
 * 这是 Phase 2 全部价值的地基：Phase 2 的方案是「自研 nomad-web-app bundle 重述 roster、
 * 复用官方前端 dist」，而不是改 DSH 源码。地基不通，方案就得整体从「换 bundle」改成
 * 「fork / 包装」，是完全不同的工程量 —— 所以必须最先验证。
 *
 * 为什么不需要模型凭据：`dsh --dump-config` 打印组合后的 profile 树**然后退出**
 * （不绑端口、不挂模型、不读凭据）。于是这条验证可以完全离线、可重复。
 *
 * 隔离保证（本测试可与其它冒烟测试并行跑）：
 *   - **不占用** `runtime/dsh/current`，只读它的清单指针；
 *   - DSH_HOME 指向本测试自己的临时目录，**不碰**真实 `data/dsh-home`。
 *
 * 用法：node tests/smoke/l4a-patch-probe.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { findBundledNode } = require('../../launcher/lib/runtime.js')

const ROOT = path.resolve(__dirname, '..', '..')
const NODE_DIR = path.join(ROOT, 'runtime', 'node')
const CURRENT = path.join(ROOT, 'runtime', 'dsh', 'current')
const PROBE_PATCH = path.join(ROOT, 'tests', 'fixtures', 'l4a', 'probe.patch.yml')
const SCRATCH_ROOT = path.join(ROOT, 'data', 'tmp', 'l4a-patch-probe')
const SCRATCH_HOME = path.join(SCRATCH_ROOT, 'home')
const DUMP_DIR = path.join(SCRATCH_ROOT, 'dumps')

const SENTINEL = 'NOMAD-L4A-PROBE-OK'
const PROFILE = 'web'
const MIN_EXPECTED_ROWS = 1000

/**
 * 已知无害的「盘符路径字样」允许清单。
 *
 * 组合树里出现盘符字样未必是问题，必须逐条判断：
 *   - `https://…` 是 URL，被 `X:` 形式的正则误匹配；
 *   - prompt 文本里 `C:\...` 是给人看的**字面示例**，不是真实路径。
 * 除此之外**任何**盘符路径字面量都视为「硬编码了宿主机路径」，测试必须失败。
 */
function allowedPathLine(line) {
  if (line.includes('://')) return true
  if (line.includes('native Windows paths')) return true
  return false
}

function resolveDshEntry() {
  const manifestFile = path.join(CURRENT, 'nomad-runtime.json')
  assert.ok(fs.existsSync(manifestFile), `未找到运行时清单：${manifestFile}（请先完成 Phase 1 打包）`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const entry = path.resolve(CURRENT, manifest.entry)
  assert.ok(fs.existsSync(entry), `清单声明的 entry 不存在：${entry}`)
  return { entry, version: manifest.version }
}

function runDump(nodePath, entry, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [entry, '--profile', PROFILE, ...extraArgs, '--dump-config'], {
      cwd: ROOT,
      env: { ...process.env, DSH_HOME: SCRATCH_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => { resolve({ code, stdout, stderr }) })
  })
}

function splitLines(text) {
  return text.split(/\r?\n/)
}

/** 求「按行计数」的多重集合差，得到真正新增 / 消失的行。 */
function diffLines(before, after) {
  const count = (list) => {
    const map = new Map()
    for (const line of list) map.set(line, (map.get(line) ?? 0) + 1)
    return map
  }
  const b = count(before)
  const a = count(after)
  const added = []
  const removed = []
  for (const [line, n] of a) {
    const extra = n - (b.get(line) ?? 0)
    for (let i = 0; i < extra; i += 1) added.push(line)
  }
  for (const [line, n] of b) {
    const extra = n - (a.get(line) ?? 0)
    for (let i = 0; i < extra; i += 1) removed.push(line)
  }
  return { added, removed }
}

/** 取出 dump 里某一行 row 的完整文本块（从 `- id: <id>` 到下一个顶层 `- ` 之前）。 */
function rowBlock(lines, id) {
  const start = lines.findIndex((line) => line.trimEnd() === `- id: ${id}`)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('- ')) { end = i; break }
  }
  return lines.slice(start, end)
}

function prepareScratch() {
  fs.mkdirSync(DUMP_DIR, { recursive: true })
  fs.mkdirSync(SCRATCH_HOME, { recursive: true })
}

function cleanupScratch() {
  try {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论，残留位于 data/tmp 内 */
  }
}

async function main() {
  const bundled = findBundledNode({ nodeDir: NODE_DIR })
  if (bundled === null) {
    console.log('[SKIP] 盘内未找到 Node 运行时（runtime/node），无法进行 L4-a 探针。')
    console.log('       Phase 1 打包完成后本测试即可运行 —— 这不是通过，是未执行。')
    return
  }

  const { entry, version } = resolveDshEntry()
  console.log(`L4-a 探针：Node=${bundled.version ?? '未知'}（${bundled.versionSource ?? 'n/a'}）  DSH=${version}  profile=${PROFILE}`)
  console.log(`探针补丁：${path.relative(ROOT, PROBE_PATCH)}`)
  console.log('')

  prepareScratch()

  const SCENARIO = [
    ['基线与探针两次 dump 都正常退出', async () => {
      const base = await runDump(bundled.path, entry, [])
      assert.equal(base.code, 0, `基线 dump 退出码应为 0，实际 ${base.code}\n${base.stderr.slice(0, 800)}`)
      assert.ok(base.stdout.trim() !== '', '基线 dump 输出为空')

      const patched = await runDump(bundled.path, entry, ['--patch', PROBE_PATCH])
      assert.equal(patched.code, 0, `叠加探针后退出码应为 0，实际 ${patched.code}\n${patched.stderr.slice(0, 800)}`)

      fs.writeFileSync(path.join(DUMP_DIR, 'base.txt'), base.stdout)
      fs.writeFileSync(path.join(DUMP_DIR, 'patched.txt'), patched.stdout)
      SCENARIO.base = splitLines(base.stdout)
      SCENARIO.patched = splitLines(patched.stdout)
    }],

    ['组合树规模合理（确认导出的是完整 profile 树）', () => {
      assert.ok(
        SCENARIO.base.length >= MIN_EXPECTED_ROWS,
        `基线组合树仅 ${SCENARIO.base.length} 行，少于预期的 ${MIN_EXPECTED_ROWS} 行 —— dump 可能不完整`,
      )
    }],

    ['哨兵只在叠加探针后出现（证明补丁层确实进了组合树）', () => {
      const inBase = SCENARIO.base.filter((line) => line.includes(SENTINEL))
      const inPatched = SCENARIO.patched.filter((line) => line.includes(SENTINEL))
      assert.equal(inBase.length, 0, `基线里不应出现哨兵，实际出现 ${inBase.length} 处`)
      assert.equal(inPatched.length, 1, `叠加探针后哨兵应恰好出现 1 处，实际 ${inPatched.length} 处`)
    }],

    ['组合树自带来源链（补丁叠加可审计）', () => {
      const provenance = SCENARIO.patched.filter(
        (line) => line.trimStart().startsWith('#') && line.includes('patched by') && line.includes('probe.patch.yml'),
      )
      assert.ok(provenance.length >= 1, 'patched dump 里未找到指向探针补丁的来源注释行')
      const chainLine = provenance[0]
      assert.ok(
        chainLine.includes('dsh-base') && chainLine.includes('dsh-web-app'),
        `来源链应体现「base → web-app → 本次覆盖」的顺序，实际：${chainLine.trim()}`,
      )
    }],

    ['补丁只动目标行、不增删行数（最小侵入）', () => {
      assert.equal(
        SCENARIO.patched.length,
        SCENARIO.base.length,
        `叠加探针后总行数应不变（${SCENARIO.base.length}），实际 ${SCENARIO.patched.length}`,
      )
      const { added, removed } = diffLines(SCENARIO.base, SCENARIO.patched)

      const unexpectedAdded = added.filter((line) => !line.includes(SENTINEL) && !line.trimStart().startsWith('# =='))
      assert.deepEqual(unexpectedAdded, [], `除哨兵与来源注释外不应有新增行，实际：${JSON.stringify(unexpectedAdded)}`)

      const target = rowBlock(SCENARIO.base, 'system-prompt')
      assert.ok(target !== null, '基线组合树里未找到 system-prompt 行，无法校验覆盖范围')
      const outsideTarget = removed.filter((line) => !target.includes(line))
      assert.deepEqual(
        outsideTarget,
        [],
        `被覆盖的行必须全部落在 system-prompt 块内，越界行：${JSON.stringify(outsideTarget)}`,
      )
    }],

    ['覆盖会替换整行 config（把该行为固定成断言）', () => {
      const { removed } = diffLines(SCENARIO.base, SCENARIO.patched)
      assert.ok(removed.length > 0, '探针覆盖了 system-prompt，却没有任何原配置行消失 —— 与「替换整行 config」的文档描述不符')
      const stillPresent = SCENARIO.patched.filter((line) => line.includes('personaSuffix: Your working directory'))
      assert.equal(
        stillPresent.length,
        0,
        '未在探针里重述的 personaSuffix 应当被丢弃；若仍在，说明覆盖语义变了，需立即复核 UI_ARCHITECTURE §8.5',
      )
    }],

    ['组合树不含硬编码的宿主机绝对路径', () => {
      const hits = SCENARIO.base.filter((line) => /[A-Za-z]:[\\/]/.test(line) && !allowedPathLine(line))
      assert.deepEqual(
        hits.map((line) => line.trim()),
        [],
        '组合树里出现了未被允许清单覆盖的盘符路径字面量 —— 这会破坏「换电脑 Agent 不换」的前提',
      )
    }],

    ['session-query-sqlite 无盘上落点', () => {
      const block = rowBlock(SCENARIO.base, 'session-query-sqlite')
      assert.ok(block !== null, '基线里未找到 session-query-sqlite 行')
      const text = block.join('\n')
      assert.ok(text.includes("path: ':memory:'"), `期望 path 为内存库，实际块：\n${text}`)
      assert.ok(text.includes('openAt: never'), `期望默认不打开，实际块：\n${text}`)
    }],

    ['sessions 与 storages 均由 DSH_HOME 派生', () => {
      const roots = SCENARIO.base
        .filter((line) => /^\s+root:/.test(line))
        .map((line) => line.trim())
      const derived = roots.filter((line) => line.includes('dshHomePath('))
      assert.ok(derived.length >= 2, `期望至少 2 处 root 由 dshHomePath 派生，实际：${JSON.stringify(roots)}`)
      const literals = roots.filter((line) => /[A-Za-z]:[\\/]/.test(line))
      assert.deepEqual(literals, [], `root 不应是绝对路径字面量：${JSON.stringify(literals)}`)
    }],
  ]

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
      break
    }
  }

  console.log('')
  if (failed === 0) {
    console.log(`合计：通过 ${String(executed)} / 失败 0 —— 自研补丁层可叠加进组合树，L4-a 地基成立`)
  } else {
    console.log(`合计：通过 ${String(executed)} / 失败 ${String(failed)}（首个失败即停；剩余 ${String(SCENARIO.length - executed - failed)} 步未执行）`)
  }

  if (failed === 0) cleanupScratch()
  else console.log(`（保留现场供排查：${path.relative(ROOT, DUMP_DIR)}）`)

  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`l4a-probe: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 70
})
