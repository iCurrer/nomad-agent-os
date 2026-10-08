#!/usr/bin/env node
'use strict'

/**
 * L4-a Bundle Probe —— Phase 2 第二步：**自研 bundle 换层**。
 *
 * 要证明的事（见 `docs/UI_ARCHITECTURE.md` §8.5 / §8.5.2）：
 *   1. 自研 `@nomad/nomad-web-app` 能被 DSH 当作 profile 的补丁层加载；
 *   2. 它的 `id:` 覆盖与 `insert:` 都能按预期改变组合树，且**不丢任何行**；
 *   3. profile 的 `bundles` 支持**相对路径** → 源可留在 repo 内被版本控制，**无需物化同步**。
 *
 * 与 `l4a-patch-probe.js` 的分工：
 *   - 那个验证「`--patch` 叠加层」进组合树（阶段 1，机制地基）；
 *   - 本测试验证「自研 bundle 经 profile 的 bundles 列表换层」（阶段 2，L4-a 的落地形态）。
 *
 * 隔离保证：本测试在 `data/tmp` 下自建 DSH_HOME，**不碰**真实 `data/dsh-home`，
 * 也不占用 `runtime/dsh/current`，可与其它冒烟测试并行跑。
 *
 * 用法：node tests/smoke/l4a-bundle-probe.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { findBundledNode } = require('../../launcher/lib/runtime.js')

const ROOT = path.resolve(__dirname, '..', '..')
const NODE_DIR = path.join(ROOT, 'runtime', 'node')
const CURRENT = path.join(ROOT, 'runtime', 'dsh', 'current')
const BUNDLE_DIR = path.join(ROOT, 'packages', 'nomad-web-app')
const SCRATCH_ROOT = path.join(ROOT, 'data', 'tmp', 'l4a-bundle-probe')
const SCRATCH_HOME = path.join(SCRATCH_ROOT, 'home')
const DUMP_DIR = path.join(SCRATCH_ROOT, 'dumps')

const PROFILE = 'nomad'
const UPSTREAM_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const NOMAD_BUNDLE_SPEC = '@nomad/nomad-web-app'
const NOMAD_IDENTITY = 'Nomad portable drive'
const MIN_EXPECTED_ROWS = 1000

function resolveDshEntry() {
  const manifestFile = path.join(CURRENT, 'nomad-runtime.json')
  assert.ok(fs.existsSync(manifestFile), `未找到运行时清单：${manifestFile}（请先完成 Phase 1 打包）`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const entry = path.resolve(CURRENT, manifest.entry)
  assert.ok(fs.existsSync(entry), `清单声明的 entry 不存在：${entry}`)
  return { entry, version: manifest.version }
}

function runDsh(nodePath, entry, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [entry, ...args], {
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

const dump = (nodePath, entry, profile) => runDsh(nodePath, entry, ['--profile', profile, '--dump-config'])

const profileDir = (name) => path.join(SCRATCH_HOME, 'profiles', name)
const profileManifest = (name) => path.join(profileDir(name), 'package.json')

function readProfileBundles(name) {
  const manifest = JSON.parse(fs.readFileSync(profileManifest(name), 'utf8'))
  return manifest?.dsh?.profile?.bundles
}

function writeProfileBundles(name, bundles) {
  const file = profileManifest(name)
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.dsh.profile.bundles = bundles
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** 抽出组合树里所有行的 id（顶层 `- id: X`），用于「不丢行」断言。 */
function rowIds(lines) {
  const ids = []
  for (const line of lines) {
    const match = /^- id: (.+)$/.exec(line)
    if (match !== null) ids.push(match[1].trim())
  }
  return ids
}

function prepareScratch() {
  // 每次运行都从干净现场开始：上一次失败会**有意保留**现场供排查，
  // 而 `--from-default-profile` 在 profile 已存在时会直接报错退出，导致第二次跑必假失败。
  // 这里删的是本测试自己的专用目录（data/tmp/l4a-bundle-probe），不涉及其它任何路径。
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true })
  fs.mkdirSync(DUMP_DIR, { recursive: true })
  fs.mkdirSync(SCRATCH_HOME, { recursive: true })
}

function cleanupScratch() {
  try {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true })
  } catch {
    /* 清理失败不改变结论，残留位于 data/tmp 内 */
  }
}

async function main() {
  const bundled = findBundledNode({ nodeDir: NODE_DIR })
  if (bundled === null) {
    console.log('[SKIP] 盘内未找到 Node 运行时（runtime/node），无法进行 L4-a bundle 探针。')
    console.log('       这是未执行，不是通过。')
    return
  }
  assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'package.json')), `自研 bundle 源缺失：${BUNDLE_DIR}`)

  const { entry, version } = resolveDshEntry()
  console.log(`L4-a bundle 探针：Node=${bundled.version ?? '未知'}  DSH=${version}  profile=${PROFILE}`)
  console.log(`自研 bundle 源：${path.relative(ROOT, BUNDLE_DIR)}`)
  console.log('')

  prepareScratch()

  const SCENARIO = [
    ['自研 bundle 源自洽（声明了 dsh.bundle.patch）', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, 'package.json'), 'utf8'))
      assert.equal(pkg.name, NOMAD_BUNDLE_SPEC, `bundle 包名应为 ${NOMAD_BUNDLE_SPEC}`)
      const patches = pkg?.dsh?.bundle?.patch
      assert.ok(patches !== undefined, 'package.json 缺少 dsh.bundle.patch —— 没有它就不是 bundle')
      const list = Array.isArray(patches) ? patches : [patches]
      for (const rel of list) {
        assert.ok(fs.existsSync(path.join(BUNDLE_DIR, rel)), `dsh.bundle.patch 声明的补丁文件不存在：${rel}`)
      }
    }],

    ['从内置 web 模板生成 nomad profile（基线等价于 web）', async () => {
      const init = await runDsh(bundled.path, entry, [PROFILE, '--from-default-profile', 'web', '--dump-config'])
      assert.equal(init.code, 0, `生成 nomad profile 失败，退出码 ${init.code}\n${init.stderr.slice(0, 800)}`)
      assert.ok(fs.existsSync(profileManifest(PROFILE)), `未生成 profile 清单：${profileManifest(PROFILE)}`)

      assert.deepEqual(readProfileBundles(PROFILE), UPSTREAM_BUNDLES, '新生成的 profile 应当只含两个上游 bundle')

      const web = await dump(bundled.path, entry, 'web')
      assert.equal(web.code, 0, `内置 web profile dump 失败\n${web.stderr.slice(0, 800)}`)
      assert.equal(
        init.stdout,
        web.stdout,
        '新生成的 nomad profile 组合树应与内置 web 模板逐字一致（否则模板复现不忠实）',
      )
      SCENARIO.base = init.stdout.split(/\r?\n/)
      fs.writeFileSync(path.join(DUMP_DIR, 'base.txt'), init.stdout)
    }],

    ['bundles 支持相对路径（源可留在 repo，免物化同步）', () => {
      const spec = path.relative(profileDir(PROFILE), BUNDLE_DIR).split(path.sep).join('/')
      assert.ok(spec.startsWith('..'), `期望得到向上相对路径，实际：${spec}`)
      assert.ok(
        !path.isAbsolute(spec),
        '相对路径断言失败 —— 若 bundles 只接受绝对路径，则必须改为「由 Launcher 计算并写入」，不能硬编码盘符',
      )
      SCENARIO.spec = spec
      writeProfileBundles(PROFILE, [...UPSTREAM_BUNDLES, spec])
      assert.deepEqual(readProfileBundles(PROFILE).slice(-1), [spec], 'profile 的 bundles 未被改写成功')
    }],

    ['加载自研 bundle 后组合树仍完整导出', async () => {
      const patched = await dump(bundled.path, entry, PROFILE)
      assert.equal(patched.code, 0, `加载自研 bundle 后 dump 失败，退出码 ${patched.code}\n${patched.stderr.slice(0, 800)}`)
      assert.equal(patched.stderr.trim(), '', `不应有 stderr 输出，实际：\n${patched.stderr.slice(0, 800)}`)
      SCENARIO.patched = patched.stdout.split(/\r?\n/)
      fs.writeFileSync(path.join(DUMP_DIR, 'patched.txt'), patched.stdout)
      assert.ok(SCENARIO.base.length >= MIN_EXPECTED_ROWS, `基线组合树过短（${SCENARIO.base.length} 行），dump 可能不完整`)
    }],

    ['来源链体现自研 bundle 已入层', () => {
      const chained = SCENARIO.patched.filter(
        (line) => line.trimStart().startsWith('# ==') && line.includes('patched by') && line.endsWith(SCENARIO.spec),
      )
      // ⚠️ 规则是「**至少一条**」，不是「恰好一条」（2026-08-… 起写死 1，2026-10-08 误报后修正）。
      //    来源链是**按被覆盖的目标行所属 bundle 分组**的：只覆盖 base 层行时恰好出现 1 条；
      //    一旦补丁同时覆盖 web-app **自己定义**的行（如 `- id: ui-brand-official`），
      //    就会出现第 2 条从 web-app 起算的链 —— 那是**正确**的，不是缺陷。
      //    真正要守的是两件事：
      //      ① **层序**：凡以自研 bundle 结尾的链，自研 bundle 必须处于**末位**
      //         （由下面的 endsWith 过滤直接保证 —— 我们只能是最后一层）；
      //      ② **完整链路可见**：至少有一条链完整体现 base → web-app → 自研。
      assert.ok(
        chained.length >= 1,
        `没有任何来源链以自研 bundle 结尾，补丁层可能没生效。含 patched by 的行：\n${
          SCENARIO.patched.filter((line) => line.includes('patched by')).join('\n')
        }`,
      )
      const full = chained.find(
        (line) => line.includes(UPSTREAM_BUNDLES[0]) && line.includes(UPSTREAM_BUNDLES[1]),
      )
      assert.ok(
        full !== undefined,
        `应至少有一条来源链完整体现「base → web-app → 自研 bundle」的层序，`
        + `实际以自研 bundle 结尾的链：\n${chained.map((line) => line.trim()).join('\n')}`,
      )
      // 插入行前也应有独立来源注释，标明该行由本 bundle 引入（而非 profile 或 --patch）。
      const insertIndex = SCENARIO.patched.indexOf('- id: nomad')
      assert.ok(insertIndex > 0, '未找到插入行')
      assert.equal(
        SCENARIO.patched[insertIndex - 1].trim(),
        `# == ${SCENARIO.spec}`,
        '插入行上方应标注「本行由自研 bundle 引入」',
      )
    }],

    ['id: 覆盖生效且全量重述（未丢键）', () => {
      // ⚠️ 坑：dump 里 YAML 折叠标量（`>-`）会按宽度**折行**，长句会被拆到多行。
      //    所以对补丁注入的长文本必须**归一化空白**后再匹配，否则子串断言会假失败。
      const text = SCENARIO.patched.join('\n').replace(/\s+/g, ' ')
      assert.ok(
        text.includes(NOMAD_IDENTITY),
        `组合树里未出现 Nomad 身份文本「${NOMAD_IDENTITY}」—— id: 覆盖没生效`,
      )
      assert.ok(
        text.includes('personaPrefix: You are a coding agent powered by the {{model}} model.'),
        'personaPrefix 丢失 —— 覆盖 system-prompt 时必须重述该行**所有**键（见 §8.5.1 铁律）',
      )
      const suffixBase = SCENARIO.base.filter((line) => line.includes('personaSuffix: Your working directory') && !line.includes('Nomad'))
      assert.equal(suffixBase.length, 1, '基线里应恰好有一处原 personaSuffix')
    }],

    ['insert: 行成功插入，且形状满足运行期 preflight（必须带 name: cordis:group）', () => {
      const inserted = SCENARIO.patched.filter((line) => line === '- id: nomad')
      assert.equal(inserted.length, 1, `期望组合树里恰好出现一行 \`- id: nomad\`，实际 ${inserted.length} 行`)
      const at = SCENARIO.patched.indexOf('- id: nomad')
      // 取到下一个同级 `- id:` 或块结束为止，避免"只看下一行"这种脆弱写法。
      const block = []
      for (let i = at + 1; i < SCENARIO.patched.length; i += 1) {
        if (SCENARIO.patched[i].startsWith('  - id: ')) break
        block.push(SCENARIO.patched[i])
      }
      const text = block.join('\n')
      // ⚠️ 这两条都是**运行期实测踩到的**（2026-10-08），`--dump-config` 全看不出来：
      //    ① 只写 `group: true` 而不给 `name: cordis:group` → preflight 里
      //       `manifestOf(ctx, row.name, base)` 读到 undefined 而抛错，整行被静默禁用：
      //         dsh: disabling profile plugin row "nomad": … reading 'startsWith'
      //    ② 不给 `config`（子行数组）→ `Group.update(undefined)` 在第 82 行
      //       `config.map(...)` 抛 `TypeError: Cannot read properties of undefined (reading 'map')`
      //    上游 11 处 group 行两项都齐，无一例外。
      assert.match(text, /^\s*name: cordis:group$/m, `group 行缺少 \`name: cordis:group\`（会被运行期静默禁用）：\n${text}`)
      assert.match(text, /^\s*group: true$/m, `插入行应为 group 容器：\n${text}`)
      // ⚠️ 规则是 `config` **必须存在**，不是"必须为空"。曾经这里写死了 `config: []`
      //    （假定 nomad 组永远是空容器）—— 2026-10-08 往组里挂第一个真实子行即误报，
      //    而那是**假失败**：上游 11 处 group 行**无一例外**都装着子行。
      //    这里要守住的运行期事故只有一个：`config` 整个缺失 →
      //    `Group.update(undefined)` 在 `config.map(...)` 抛 TypeError。
      assert.match(text, /^\s*config:/m, `group 行缺少 \`config\`（必须存在：空容器写 []，有子行写子行列表。缺了它运行期 Group.update 抛 TypeError）：\n${text}`)
      // 子行必须真的**落在组内**（缩进更深，因此不会被上面的 break 提前截断）
      assert.match(text, /^\s+- id: nomad-brand$/m, `nomad 组内未发现品牌子行（子行没进组，等于没挂）：\n${text}`)
      assert.match(
        text,
        /packages\/nomad-brand\/lib\/host\.js/,
        `品牌子行未指向 packages/nomad-brand —— 相对路径解析基准是**声明该补丁的包目录**，见 ADR-0023：\n${text}`,
      )
    }],

    ['不丢任何上游行（roster 未被意外截断）', () => {
      const before = rowIds(SCENARIO.base)
      const after = new Set(rowIds(SCENARIO.patched))
      const missing = before.filter((id) => !after.has(id))
      assert.deepEqual(missing, [], `以下上游行在加载自研 bundle 后消失了：${JSON.stringify(missing)}`)
      const added = rowIds(SCENARIO.patched).filter((id) => !before.includes(id))
      assert.deepEqual(added, ['nomad'], `新增行应只有 nomad，实际：${JSON.stringify(added)}`)
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
    console.log(`合计：通过 ${String(executed)} / 失败 0 —— 自研 bundle 换层成立，L4-a 阶段 2 通过`)
  } else {
    console.log(`合计：通过 ${String(executed)} / 失败 ${String(failed)}（首个失败即停；剩余 ${String(SCENARIO.length - executed - failed)} 步未执行）`)
  }

  if (failed === 0) cleanupScratch()
  else console.log(`（保留现场供排查：${path.relative(ROOT, DUMP_DIR)}）`)

  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`l4a-bundle: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 70
})
