'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mkdtempSync, mkdirSync, writeFileSync } = fs

const { parseWorkspaces } = require('../launcher/lib/projects.js')

function makeConfig(root) {
  return { paths: { root, dsh_home: path.join(root, 'data', 'dsh-home') } }
}

function writeWorkspace(root, doc) {
  const dir = path.join(root, 'data', 'dsh-home', 'storages')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(doc))
}

test('parseWorkspaces 解析工作区并按更新时间排序', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-proj-'))
  writeWorkspace(root, {
    global: { defaultWorkspaceId: 'ws-b' },
    tables: {
      workspaces: {
        'ws-a': {
          title: 'alpha', path: 'D:/x/alpha', sessionIds: ['s1'],
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        },
        'ws-b': {
          title: 'beta', path: 'D:/x/beta', sessionIds: ['s2', 's3'],
          createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z',
        },
      },
    },
  })
  const parsed = parseWorkspaces(root, makeConfig(root))
  assert.ok(parsed !== null)
  assert.strictEqual(parsed.workspaces.length, 2)
  assert.strictEqual(parsed.defaultId, 'ws-b')
  assert.strictEqual(parsed.totalSessions, 3)
  // 按 updatedAt 升序：alpha 在前
  assert.strictEqual(parsed.workspaces[0].id, 'ws-a')
  assert.strictEqual(parsed.workspaces[0].title, 'alpha')
  assert.strictEqual(parsed.workspaces[0].sessionCount, 1)
  assert.strictEqual(parsed.workspaces[1].title, 'beta')
  assert.strictEqual(parsed.workspaces[1].sessionCount, 2)
})

test('parseWorkspaces 清单缺失时返回 null', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-proj-'))
  const parsed = parseWorkspaces(root, makeConfig(root))
  assert.strictEqual(parsed, null)
})

test('parseWorkspaces 畸形 JSON 抛错', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nomad-proj-'))
  writeWorkspace(root, { broken: true }) // 不是合法结构但合法 JSON
  // 合法 JSON 但缺 tables → 应返回空列表而非抛错
  const parsed = parseWorkspaces(root, makeConfig(root))
  assert.ok(parsed !== null)
  assert.strictEqual(parsed.workspaces.length, 0)

  const dir = path.join(root, 'data', 'dsh-home', 'storages')
  writeFileSync(path.join(dir, 'workspace.json'), '{not json')
  assert.throws(() => parseWorkspaces(root, makeConfig(root)), /不是合法 JSON/)
})
