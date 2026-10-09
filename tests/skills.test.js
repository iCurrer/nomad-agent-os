'use strict'

/**
 * Phase 3.2 Skills 管理器单测 —— validateSkillEntry / listSkills / addSkill / removeSkill。
 *
 * fixture 形状与 profiles.test.js 同款：临时 root + `data/dsh-home/skills/`。
 * 只测 launcher 侧纯函数，不碰真实 DSH_HOME。
 * 契约依据：vendor/deepseek-harness/packages/skill/（3.0-A 勘探，docs/DSH_SOURCE_MAP.md）。
 */

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } = fs

const {
  skillsDir,
  validateSkillEntry,
  validateSkillEntryName,
  listSkills,
  addSkill,
  removeSkill,
  SKILL_NAME_RE,
  RESERVED_ENTRY,
} = require('../launcher/lib/skills.js')

function makeRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'nomad-skill-'))
}

function makeConfig(root) {
  return { paths: { root, dsh_home: path.join(root, 'data', 'dsh-home') } }
}

/** 写一个目录束 skill。 */
function writeBundleSkill(root, name, { frontmatter = null, body = '正文', omit = [] } = {}) {
  const dir = path.join(root, 'data', 'dsh-home', 'skills', name)
  mkdirSync(dir, { recursive: true })
  if (!omit.includes('SKILL.md')) {
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      frontmatter === null
        ? `---\nname: ${name}\ndescription: 测试技能 ${name}\n---\n\n${body}\n`
        : frontmatter,
    )
  }
  return dir
}

/** 写一个扁平 .md skill。 */
function writeFlatSkill(root, name, frontmatter = null) {
  const file = path.join(root, 'data', 'dsh-home', 'skills', `${name}.md`)
  writeFileSync(
    file,
    frontmatter ?? `---\nname: ${name}\ndescription: 扁平技能 ${name}\n---\n\n正文\n`,
  )
  return file
}

test('SKILL_NAME_RE 与上游正则逐字一致', () => {
  assert.ok(SKILL_NAME_RE.test('demo-skill'))
  assert.ok(SKILL_NAME_RE.test('a'))
  assert.ok(SKILL_NAME_RE.test('a1-b2'))
  assert.ok(!SKILL_NAME_RE.test('Demo'))
  assert.ok(!SKILL_NAME_RE.test('-lead'))
  assert.ok(!SKILL_NAME_RE.test('trail-'))
  assert.ok(!SKILL_NAME_RE.test('a--b'))
  assert.ok(!SKILL_NAME_RE.test('中文'))
})

test('validateSkillEntry：合法目录束 / 扁平文件各自通过，字段正确提取', () => {
  const root = makeRoot()
  const base = path.join(root, 'data', 'dsh-home', 'skills')
  writeBundleSkill(root, 'alpha-skill')
  writeFlatSkill(root, 'beta-skill')

  const bundle = validateSkillEntry(base, 'alpha-skill')
  assert.strictEqual(bundle.kind, 'bundle')
  assert.strictEqual(bundle.valid, true)
  assert.deepStrictEqual(bundle.problems, [])
  assert.strictEqual(bundle.skill.name, 'alpha-skill')
  assert.strictEqual(bundle.skill.description, '测试技能 alpha-skill')

  const flat = validateSkillEntry(base, 'beta-skill.md')
  assert.strictEqual(flat.kind, 'flat')
  assert.strictEqual(flat.valid, true)
  assert.strictEqual(flat.skill.name, 'beta-skill')

  // whenToUse 可选字段
  writeBundleSkill(root, 'gamma', {
    frontmatter: '---\nname: gamma\ndescription: d\nwhenToUse: 需要时\n---\n\n正文\n',
  })
  const withWhen = validateSkillEntry(base, 'gamma')
  assert.strictEqual(withWhen.skill.whenToUse, '需要时')
})

test('validateSkillEntry：畸形条目全部带 problems 且不崩溃（ROADMAP 验收项）', () => {
  const root = makeRoot()
  const base = path.join(root, 'data', 'dsh-home', 'skills')

  // ① 目录无 SKILL.md → ignored 形态（kind unknown）
  mkdirSync(path.join(base, 'empty-dir'), { recursive: true })
  const empty = validateSkillEntry(base, 'empty-dir')
  assert.strictEqual(empty.kind, 'unknown')
  assert.ok(empty.problems[0].includes('缺少 SKILL.md'))

  // ② 缺 frontmatter → DSH 会忽略
  writeBundleSkill(root, 'no-fm', { frontmatter: '没有围栏的正文' })
  const noFm = validateSkillEntry(base, 'no-fm')
  assert.ok(noFm.problems.some((p) => p.includes('缺少 YAML frontmatter')))

  // ③ 缺 name
  writeBundleSkill(root, 'no-name', { frontmatter: '---\ndescription: 有描述\n---\n\n正文\n' })
  assert.ok(validateSkillEntry(base, 'no-name').problems.some((p) => p.includes('缺少 name')))

  // ④ 缺 description
  writeBundleSkill(root, 'no-desc', { frontmatter: '---\nname: no-desc\n---\n\n正文\n' })
  assert.ok(validateSkillEntry(base, 'no-desc').problems.some((p) => p.includes('缺少 description')))

  // ⑤ name 非 kebab-case
  writeBundleSkill(root, 'bad-name', { frontmatter: '---\nname: BadName\ndescription: d\n---\n\n正文\n' })
  assert.ok(validateSkillEntry(base, 'bad-name').problems.some((p) => p.includes('kebab-case')))

  // ⑥ 扁平文件非 .md（random 文件）→ kind unknown
  writeFileSync(path.join(base, 'notes.txt'), 'x')
  assert.strictEqual(validateSkillEntry(base, 'notes.txt').kind, 'unknown')

  // ⑦ 不存在的条目 → unknown，不抛错
  assert.strictEqual(validateSkillEntry(base, 'ghost').kind, 'unknown')
})

test('validateSkillEntry：多行标量语法走近似路径（notes 提示，不算 broken）', () => {
  const root = makeRoot()
  const base = path.join(root, 'data', 'dsh-home', 'skills')
  writeBundleSkill(root, 'multiline', {
    frontmatter: '---\nname: multiline\ndescription: |\n  第一行\n  第二行\n---\n\n正文\n',
  })
  const check = validateSkillEntry(base, 'multiline')
  // yaml-lite 不支持 | 多行标量 → 近似路径提取单行。name 在首行可取到。
  assert.strictEqual(check.skill.name, 'multiline')
  assert.ok(check.notes.length > 0 && check.notes[0].includes('近似'))
  // 近似提取到了 description 的第一行，字段齐全 → 仍判有效
  assert.strictEqual(check.valid, true)
})

test('listSkills：归类正确（skills vs ignored），.system 保留名被识别', () => {
  const root = makeRoot()
  const base = path.join(root, 'data', 'dsh-home', 'skills')
  writeBundleSkill(root, 'zeta')
  writeFlatSkill(root, 'alpha')
  writeBundleSkill(root, 'broken', { frontmatter: '正文无围栏' })
  mkdirSync(path.join(base, 'not-a-skill'), { recursive: true })
  mkdirSync(path.join(base, RESERVED_ENTRY), { recursive: true })
  writeFileSync(path.join(base, RESERVED_ENTRY, 'keep.md'), 'x')

  const scan = listSkills({ config: makeConfig(root) })
  assert.deepStrictEqual(scan.skills.map((s) => s.entryName), ['alpha.md', 'broken', 'zeta'])
  assert.deepStrictEqual(scan.ignored.map((s) => s.entryName), [RESERVED_ENTRY, 'not-a-skill'])
  assert.ok(scan.ignored.find((s) => s.entryName === RESERVED_ENTRY).reason.includes('保留名'))

  const broken = scan.skills.find((s) => s.entryName === 'broken')
  assert.ok(broken.problems.length > 0)
})

test('listSkills：目录缺失 → exists=false 空结果不抛错', () => {
  const root = makeRoot()
  const scan = listSkills({ config: makeConfig(root) })
  assert.strictEqual(scan.exists, false)
  assert.deepStrictEqual(scan.skills, [])
  assert.strictEqual(scan.base, skillsDir(makeConfig(root)))
})

test('addSkill：目录束与扁平文件安装成功，listSkills 立即可见', () => {
  const root = makeRoot()
  const config = makeConfig(root)

  // 源 1：临时目录里的目录束
  const srcDir = path.join(root, 'staging', 'my-skill')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(path.join(srcDir, 'SKILL.md'), '---\nname: my-skill\ndescription: 外来技能\n---\n\n正文\n')
  const r1 = addSkill({ config }, srcDir)
  assert.strictEqual(r1.ok, true)
  assert.strictEqual(r1.format, 'bundle')
  assert.strictEqual(r1.skill.name, 'my-skill')
  assert.ok(existsSync(path.join(r1.dir, 'SKILL.md')))

  // 源 2：扁平文件
  const srcFile = path.join(root, 'staging', 'flat-one.md')
  writeFileSync(srcFile, '---\nname: flat-one\ndescription: 扁平外来\n---\n\n正文\n')
  const r2 = addSkill({ config }, srcFile)
  assert.strictEqual(r2.ok, true)
  assert.strictEqual(r2.format, 'flat')
  assert.strictEqual(r2.name, 'flat-one')

  const scan = listSkills({ config })
  assert.deepStrictEqual(scan.skills.map((s) => s.skill.name).sort(), ['flat-one', 'my-skill'])
  assert.ok(scan.skills.every((s) => s.problems.length === 0))
})

test('addSkill：相对路径按 NOMAD_ROOT 回退解析（cwd 无关）', () => {
  const root = makeRoot()
  const config = makeConfig(root)

  mkdirSync(path.join(root, 'docs', 'examples', 'skills', 'hello-nomad'), { recursive: true })
  writeFileSync(
    path.join(root, 'docs', 'examples', 'skills', 'hello-nomad', 'SKILL.md'),
    '---\nname: hello-nomad\ndescription: 示例\n---\n\n正文\n',
  )

  // 相对路径（NOMAD_ROOT 视角），当前进程 cwd 是别处 —— 依然能装
  const r = addSkill({ config }, 'docs/examples/skills/hello-nomad')
  assert.strictEqual(r.ok, true, `回退解析应成功：${r.error || ''}`)
  assert.strictEqual(r.name, 'hello-nomad')
  assert.ok(existsSync(path.join(root, 'data', 'dsh-home', 'skills', 'hello-nomad', 'SKILL.md')))

  // 两边都解析不到 → 报错信息提示两种基准
  const bad = addSkill({ config }, 'no/such/dir')
  assert.strictEqual(bad.ok, false)
  assert.match(bad.error, /源路径不存在/)
})

test('addSkill：已存在拒绝 / 网络地址拒绝 / 非法形态拒绝 / 会被 DSH 忽略的拒绝', () => {
  const root = makeRoot()
  const config = makeConfig(root)
  const base = path.join(root, 'data', 'dsh-home', 'skills')

  // ① 已存在（绝不覆盖）
  writeBundleSkill(root, 'exists-skill')
  const srcDir = path.join(root, 'staging', 'exists-skill')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(path.join(srcDir, 'SKILL.md'), '---\nname: exists-skill\ndescription: d\n---\n\nx\n')
  const r1 = addSkill({ config }, srcDir)
  assert.strictEqual(r1.ok, false)
  assert.ok(r1.error.includes('绝不覆盖'))

  // ② 网络 URL 拒绝
  assert.ok(addSkill({ config }, 'https://example.com/skill.git').error.includes('网络'))
  assert.ok(addSkill({ config }, 'git@github.com:foo/bar.git').error.includes('网络'))

  // ③ 源不存在
  assert.ok(addSkill({ config }, path.join(root, 'no-such-dir')).error.includes('不存在'))

  // ④ 目录但没有 SKILL.md
  const emptyDir = path.join(root, 'staging', 'empty')
  mkdirSync(emptyDir, { recursive: true })
  assert.ok(addSkill({ config }, emptyDir).error.includes('形态'))

  // ⑤ 缺 frontmatter（会被 DSH 静默忽略 → 装前拦截）
  const noFmDir = path.join(root, 'staging', 'no-fm-skill')
  mkdirSync(noFmDir, { recursive: true })
  writeFileSync(path.join(noFmDir, 'SKILL.md'), '只有正文')
  const r5 = addSkill({ config }, noFmDir)
  assert.strictEqual(r5.ok, false)
  assert.ok(r5.error.includes('忽略'))

  assert.ok(!existsSync(path.join(base, 'no-fm-skill')))
})

test('removeSkill：目录束与扁平文件各自卸载，未知名报错并列出现有条目', () => {
  const root = makeRoot()
  const config = makeConfig(root)
  const base = path.join(root, 'data', 'dsh-home', 'skills')
  writeBundleSkill(root, 'gone-bundle')
  writeFlatSkill(root, 'gone-flat')

  const r1 = removeSkill({ config }, 'gone-bundle')
  assert.strictEqual(r1.ok, true)
  assert.strictEqual(r1.format, 'bundle')
  assert.ok(!existsSync(r1.path))

  const r2 = removeSkill({ config }, 'gone-flat')
  assert.strictEqual(r2.ok, true)
  assert.strictEqual(r2.format, 'flat')
  assert.ok(!existsSync(r2.path))

  // 未知名：报错 + 现有条目提示
  writeBundleSkill(root, 'stay')
  const r3 = removeSkill({ config }, 'ghost')
  assert.strictEqual(r3.ok, false)
  assert.ok(r3.error.includes('不存在') && r3.error.includes('stay'))

  // 保留名 / 路径分隔符拒绝
  assert.ok(removeSkill({ config }, RESERVED_ENTRY).error.length > 0)
  assert.ok(removeSkill({ config }, 'a/b').error.includes('分隔符'))
})

test('validateSkillEntryName：空值 / 点开头结尾 / 保留名全部拒绝', () => {
  assert.throws(() => validateSkillEntryName(''))
  assert.throws(() => validateSkillEntryName('.hidden'))
  assert.throws(() => validateSkillEntryName('tail.'))
  assert.throws(() => validateSkillEntryName('..'))
  assert.throws(() => validateSkillEntryName(RESERVED_ENTRY))
  assert.strictEqual(validateSkillEntryName('ok-name'), 'ok-name')
})

test('端到端：add → list 有效 → doctor 视角零问题 → remove → 空', () => {
  const root = makeRoot()
  const config = makeConfig(root)
  const srcDir = path.join(root, 'staging', 'round-trip')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(path.join(srcDir, 'SKILL.md'), '---\nname: round-trip\ndescription: 往返测试\n---\n\n正文\n')

  assert.strictEqual(addSkill({ config }, srcDir).ok, true)
  let scan = listSkills({ config })
  assert.strictEqual(scan.skills.length, 1)
  assert.strictEqual(scan.skills[0].valid, true)
  assert.strictEqual(scan.ignored.length, 0)

  assert.strictEqual(removeSkill({ config }, 'round-trip').ok, true)
  scan = listSkills({ config })
  assert.strictEqual(scan.skills.length, 0)
  assert.strictEqual(scan.ignored.length, 0)
})
