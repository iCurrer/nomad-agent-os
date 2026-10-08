'use strict'

/**
 * yaml-lite 子集解析器测试。
 * 目标：证明它能正确解析 Nomad 实际使用的语法，并且**对子集之外的东西报错**。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { parse, YamlLiteError } = require('../launcher/lib/yaml-lite.js')

test('映射 / 嵌套 / 标量类型', () => {
  const doc = parse([
    'nomad:',
    '  version: "0.0.1-dev"',
    '  stage: phase1-bootstrap',
    'web:',
    '  host: "127.0.0.1"',
    '  port: 0',
    '  open_browser: true',
    '  browser_path: ""',
    '  nothing: null',
  ].join('\n'))

  assert.equal(doc.nomad.version, '0.0.1-dev')
  assert.equal(doc.nomad.stage, 'phase1-bootstrap')
  assert.equal(doc.web.host, '127.0.0.1')
  assert.equal(doc.web.port, 0)
  assert.equal(doc.web.open_browser, true)
  assert.equal(doc.web.browser_path, '')
  assert.equal(doc.web.nothing, null)
})

test('序列（含 nested 与 `- key: value`）', () => {
  const doc = parse([
    'isolation:',
    '  inherit_allowlist:',
    '    - path',
    '    - systemroot',
    '    - windir',
    '  rules:',
    '    - name: read',
    '      auto: true',
    '    - name: push',
    '      auto: false',
    '  empty: []',
  ].join('\n'))

  assert.deepEqual(doc.isolation.inherit_allowlist, ['path', 'systemroot', 'windir'])
  assert.deepEqual(doc.isolation.rules, [
    { name: 'read', auto: true },
    { name: 'push', auto: false },
  ])
  assert.deepEqual(doc.isolation.empty, [])
})

test('注释：整行与行尾，且引号内 # 不被当注释', () => {
  const doc = parse([
    '# 整行注释',
    'a: 1   # 行尾注释',
    'b: "has # inside"',
    "c: 'also # inside'",
  ].join('\n'))

  assert.equal(doc.a, 1)
  assert.equal(doc.b, 'has # inside')
  assert.equal(doc.c, 'also # inside')
})

test('占位符按普通字符串保留（由 config.js 负责展开）', () => {
  const doc = parse([
    'paths:',
    '  root: "${NOMAD_ROOT}"',
    'isolation:',
    '  override:',
    '    DSH_HOME: "${paths.dsh_home}"',
  ].join('\n'))

  assert.equal(doc.paths.root, '${NOMAD_ROOT}')
  assert.equal(doc.isolation.override.DSH_HOME, '${paths.dsh_home}')
})

test('文档分隔符被忽略', () => {
  const doc = parse('---\na: 1\n...')
  assert.deepEqual(doc, { a: 1 })
})

test('空文档返回 null', () => {
  assert.equal(parse('\n# 只有注释\n'), null)
})

test('Tab 缩进报错（带行号）', () => {
  assert.throws(() => parse('a:\n\tb: 1\n'), (error) => {
    assert.ok(error instanceof YamlLiteError)
    assert.match(error.message, /第 2 行/)
    assert.match(error.message, /Tab/)
    return true
  })
})

test('流式集合报错（不静默猜错）', () => {
  assert.throws(() => parse('a: [1, 2]\n'), (error) => {
    assert.match(error.message, /流式集合/)
    return true
  })
})

test('多行标量报错', () => {
  assert.throws(() => parse('a: |\n  text\n'), (error) => {
    assert.match(error.message, /多行标量/)
    return true
  })
})

test('缩进不一致报错', () => {
  assert.throws(() => parse('a:\n  b: 1\n   c: 2\n'), (error) => {
    assert.match(error.message, /缩进/)
    return true
  })
})
