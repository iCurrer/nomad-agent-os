'use strict'

/**
 * 列出已持久化的 DSH 工作区（项目）。
 *
 * 设计依据（ADR-0032）：
 *   - DSH 把"项目"建模为 workspace，持久化在盘内 `data/dsh-home/storages/workspace.json`
 *     （纯 JSON，已验证：tables.workspaces[<uuid>] 含 path/title/sessionIds/createdAt/updatedAt）。
 *   - Runtime/Data 分离（ADR-0001）保证这些数据在 runtime 升级时**不丢**——本命令的存在就是把
 *     "Persistent" 价值变成**可验证、可见**的事实（否则用户无从确认项目是否真的持久化）。
 *   - 纯只读解析，**不碰 Agent Loop / Session / Tool Runtime**，契合 CLI 的 project-management 职责边界。
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * 解析工作区清单。
 * @param {string} root - NOMAD_ROOT
 * @param {object} config - 已加载配置
 * @returns {{ file: string, workspaces: Array<object>, defaultId: string|null, totalSessions: number }|null}
 *   清单不存在时返回 null（DSH 尚未初始化过工作区）
 */
function parseWorkspaces(root, config) {
  const file = path.join(config.paths.dsh_home, 'storages', 'workspace.json')
  if (!fs.existsSync(file)) return null
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`projects: ${file} 不是合法 JSON：${error.message}`)
  }
  const tables = (doc && typeof doc.tables === 'object' && doc.tables !== null) ? doc.tables : {}
  const workspacesMap = (tables.workspaces && typeof tables.workspaces === 'object') ? tables.workspaces : {}
  const global = (doc && typeof doc.global === 'object' && doc.global !== null) ? doc.global : {}
  const list = Object.entries(workspacesMap).map(([id, ws]) => ({
    id,
    title: typeof ws.title === 'string' ? ws.title : '(未命名)',
    path: typeof ws.path === 'string' ? ws.path : '',
    sessionCount: Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0,
    createdAt: ws.createdAt ?? null,
    updatedAt: ws.updatedAt ?? null,
  }))
  list.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
  const totalSessions = list.reduce((sum, ws) => sum + ws.sessionCount, 0)
  return {
    file,
    workspaces: list,
    defaultId: typeof global.defaultWorkspaceId === 'string' ? global.defaultWorkspaceId : null,
    totalSessions,
  }
}

module.exports = { parseWorkspaces }
