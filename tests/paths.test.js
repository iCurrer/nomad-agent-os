'use strict'

/**
 * 路径卫士测试：铁律 3（禁止宿主绝对路径）与"不越出 NOMAD_ROOT"。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { resolveInside, isHostAbsolute, assertInside, stripTrailingSep, isInside } = require('../launcher/lib/paths.js')

const ROOT = path.resolve(__dirname, '..')

test('相对路径解析到 NOMAD_ROOT 之下', () => {
  assert.equal(resolveInside(ROOT, 'data/dsh-home', 't'), path.join(ROOT, 'data', 'dsh-home'))
  assert.equal(resolveInside(ROOT, './runtime', 't'), path.join(ROOT, 'runtime'))
  assert.equal(resolveInside(ROOT, 'data/../config', 't'), path.join(ROOT, 'config'))
})

test('拒绝宿主绝对路径（两种平台形态）', () => {
  for (const bad of ['C:/Users/someone/AppData', 'D:\\other', '/home/user', '\\\\server\\share']) {
    assert.throws(() => resolveInside(ROOT, bad, 't'), /禁止宿主绝对路径|路径越出/, `应拒绝 ${bad}`)
  }
})

test('拒绝越界（../ 逃逸）', () => {
  assert.throws(() => resolveInside(ROOT, '../outside', 't'), /越出 NOMAD_ROOT/)
  assert.throws(() => resolveInside(ROOT, 'data/../../x', 't'), /越出 NOMAD_ROOT/)
})

test('拒绝空值', () => {
  assert.throws(() => resolveInside(ROOT, '', 't'), /非空字符串/)
  assert.throws(() => resolveInside(ROOT, undefined, 't'), /非空字符串/)
})

test('isHostAbsolute 跨平台识别', () => {
  assert.equal(isHostAbsolute('/tmp'), true)
  assert.equal(isHostAbsolute('C:/tmp'), true)
  assert.equal(isHostAbsolute('data/tmp'), false)
})

test('assertInside 校验外部来源路径', () => {
  assert.equal(assertInside(ROOT, path.join(ROOT, 'runtime', 'a'), 't'), path.join(ROOT, 'runtime', 'a'))
  assert.throws(() => assertInside(ROOT, path.resolve('D:/elsewhere/a'), 't'), /不在 NOMAD_ROOT/)
  assert.throws(() => assertInside(ROOT, ROOT, 't'), /不在 NOMAD_ROOT/)
})

// ── ADR-0028：盘符根场景（**只有把 Nomad 部署到盘符根才会暴露**）────────────
// 开发机的 NOMAD_ROOT 是 `D:\u盘`（子目录，不带尾分隔符），所以这两条一直潜伏；
// 首次真机部署到 `E:\` 时 doctor 立刻假 FAIL，据此立回归。

test('stripTrailingSep 去掉尾分隔符', () => {
  assert.equal(stripTrailingSep('E:\\'), 'E:')
  assert.equal(stripTrailingSep('E:/'), 'E:')
  assert.equal(stripTrailingSep('D:\\u盘\\'), 'D:\\u盘')
  assert.equal(stripTrailingSep('D:\\u盘'), 'D:\\u盘')
  assert.equal(stripTrailingSep('/home/x/'), '/home/x')
  assert.equal(stripTrailingSep('/'), '/') // 纯分隔符不得被抹成空串
})

test('isInside：NOMAD_ROOT 为盘符根时不得误判越界', { skip: process.platform !== 'win32' ? 'Windows 专属' : false }, () => {
  assert.equal(isInside('E:\\', 'E:\\data\\dsh-home'), true)
  assert.equal(isInside('E:\\', 'E:\\'), true)
  assert.equal(isInside('E:\\', 'E:\\runtime'), true)
  assert.equal(isInside('E:\\', 'E:/data/tmp'), true) // 正斜杠形态也要认
})

test('isInside：按段边界判断，不做裸前缀匹配', { skip: process.platform !== 'win32' ? 'Windows 专属' : false }, () => {
  assert.equal(isInside('D:\\u盘', 'D:\\u盘\\data'), true)
  assert.equal(isInside('D:\\u盘', 'D:\\u盘2\\data'), false) // 裸 startsWith 会误判成 true
  assert.equal(isInside('D:\\u盘', 'D:\\other'), false)
})

test('isInside：非字符串输入安全返回 false', () => {
  assert.equal(isInside('E:\\', undefined), false)
  assert.equal(isInside(undefined, 'E:\\a'), false)
  assert.equal(isInside(null, null), false)
})
