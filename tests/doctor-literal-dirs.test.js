'use strict'

/**
 * `doctor.scanLiteralDirs` 的单元测试。
 *
 * 背景：实测在 workspace/ 下出现过 `%SystemDrive%/ProgramData/Microsoft/Windows/Caches/`
 * —— 目录名里的环境变量未被展开、被当字面量落了盘。真凶不在 Nomad 与打包运行时之内，
 * 故改为提供**可观测防线**。本文件锁死该防线的行为边界（能检出、不乱报、不卡死）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { scanLiteralDirs } = require('../launcher/lib/doctor.js')

/** 建一个具备盘内标准目录形态的 scratch root。 */
function makeScratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-literal-'))
  for (const dir of ['workspace', 'data', 'profiles', 'skills', 'mcp']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

/** 在相对路径下建目录，返回绝对路径。 */
function mkdirp(root, rel) {
  const full = path.join(root, rel)
  fs.mkdirSync(full, { recursive: true })
  return full
}

test('干净的盘 → 不报任何命中', () => {
  const root = makeScratchRoot()
  try {
    mkdirp(root, 'workspace/normal-dir')
    mkdirp(root, 'data/dsh-home/sessions')
    assert.deepEqual(scanLiteralDirs(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('★ 检出 Windows 形态 %VAR% 目录（本次缺陷的现场形态）', () => {
  const root = makeScratchRoot()
  try {
    // 复刻缺陷现场：%SystemDrive% 未被展开，整棵子树落在工作区下
    mkdirp(root, 'workspace/%SystemDrive%/ProgramData/Microsoft/Windows/Caches')
    const found = scanLiteralDirs(root)
    assert.equal(found.length, 1, '应恰好检出 1 条')
    assert.equal(
      found[0],
      path.join('workspace', '%SystemDrive%'),
      '应命中 %SystemDrive% 这一层，且为相对 root 的路径',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('检出 POSIX 形态 ${VAR} 目录', () => {
  const root = makeScratchRoot()
  try {
    mkdirp(root, 'data/${HOME}/.cache')
    const found = scanLiteralDirs(root)
    assert.equal(found.length, 1)
    assert.equal(found[0], path.join('data', '${HOME}'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('命中即不再深入（同一子树只报最外层一条）', () => {
  const root = makeScratchRoot()
  try {
    mkdirp(root, 'workspace/%TEMP%/a/b/%USERPROFILE%')
    const found = scanLiteralDirs(root)
    assert.equal(found.length, 1, '外层已命中，内层不再重复报告')
    assert.equal(found[0], path.join('workspace', '%TEMP%'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('跳过 node_modules 等重目录（保体检快速）', () => {
  const root = makeScratchRoot()
  try {
    mkdirp(root, 'data/node_modules/%NPM_TOKEN%/x')
    mkdirp(root, 'workspace/tmp/%TEMP%/y')
    assert.deepEqual(scanLiteralDirs(root), [], 'SKIP 名单内的目录不应被巡检')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('不误报：普通目录名（含 $ 或 % 但非变量形态）不命中', () => {
  const root = makeScratchRoot()
  try {
    mkdirp(root, 'workspace/100%done')
    mkdirp(root, 'workspace/price$')
    mkdirp(root, 'workspace/a%b')
    assert.deepEqual(scanLiteralDirs(root), [], '这些都不是 %VAR% / ${VAR} 形态')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('深度上限：过深的字面量目录不报（防遍历失控）', () => {
  const root = makeScratchRoot()
  try {
    // MAX_DEPTH = 4：从 SCAN_ROOTS 的下一层算起，这里放到第 6 层
    mkdirp(root, 'data/a/b/c/d/e/f/%DEEP%')
    assert.deepEqual(scanLiteralDirs(root), [], '超出深度上限应跳过')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('root 下目录不存在时不抛错（只读巡检的稳健性）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-literal-empty-'))
  try {
    // 一个标准目录都没建
    assert.deepEqual(scanLiteralDirs(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
