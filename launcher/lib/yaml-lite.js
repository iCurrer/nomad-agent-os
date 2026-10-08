'use strict'

/**
 * yaml-lite —— 零依赖 YAML 子集解析器。
 *
 * 为什么不用现成库：Launcher 必须能在**只有 Node 的干净机器**上启动，
 * 不允许 `node_modules`（AGENTS.md 铁律 7）。因此这里只实现 Nomad 配置文件
 * 实际用到的子集，遇到子集之外的语法**报错而不是猜**。
 *
 * 支持的子集：
 *   - 缩进映射（`key: value`）与嵌套
 *   - 序列（`- value`、`- key: value`，可嵌套）
 *   - 标量：单/双引号字符串、整数、小数、true/false、null/~
 *   - 空集合字面量：`[]`、`{}`
 *   - 注释：整行 `# ...` 与行尾 ` # ...`（引号内不算）
 *   - 文档分隔符 `---` / `...`（忽略）
 *
 * 不支持（会报错或按普通字符串处理，不会静默猜错）：
 *   锚点与别名、多行标量（`|` / `>`）、流式集合 `[a, b]` / `{a: b}`、
 *   标签（`!!js`）、多文档。若将来需要，必须显式扩展本文件并补测试。
 */

/** 解析错误：带行号，便于直接定位到配置文件的具体位置。 */
class YamlLiteError extends Error {
  /**
   * @param {string} message - 错误描述
   * @param {number} [line] - 行号（1 起）
   */
  constructor(message, line) {
    super(line === undefined ? message : `YAML 第 ${line} 行: ${message}`)
    this.name = 'YamlLiteError'
    this.line = line
  }
}

/**
 * 去掉行尾注释，保留引号内的 `#`。
 * @param {string} line - 原始行
 * @returns {string} 去注释后的行
 */
function stripComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * 行 token 化：产出 `{ indent, text, line }`，跳过空行与注释。
 * @param {string} text - 文件内容
 * @returns {{ indent: number, text: string, line: number }[]} token 列表
 */
function tokenize(text) {
  const tokens = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (/^\s*\t/.test(raw) || /[^\s]\t/.test(raw)) {
      throw new YamlLiteError('不接受 Tab 缩进，请统一使用空格', i + 1)
    }
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    const body = stripped.trim()
    if (body === '---' || body === '...') continue
    const indent = stripped.length - stripped.replace(/^ +/, '').length
    tokens.push({ indent, text: body, line: i + 1 })
  }
  return tokens
}

/**
 * 在 `key: value` 中定位分隔冒号（忽略引号内、且冒号后必须是行尾或空格）。
 * @param {string} text - 行内容
 * @returns {{ key: string, rest: string } | null} 拆分结果，非映射则为 null
 */
function splitKey(text) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === ':' && !inSingle && !inDouble && (i === text.length - 1 || text[i + 1] === ' ')) {
      return { key: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

/**
 * 解析标量。
 * @param {string} text - 值文本（已 trim）
 * @param {number} line - 行号，用于报错
 * @returns {unknown} 解析结果
 */
function parseScalar(text, line) {
  if (text === '[]') return []
  if (text === '{}') return {}
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(.)/g, (_match, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number(text)
  if (/^-?\d+\.\d+$/.test(text)) return Number(text)
  if (text.startsWith('[') || text.startsWith('{')) {
    throw new YamlLiteError(`不支持流式集合 ${JSON.stringify(text)}，请改写为缩进块`, line)
  }
  if (text.startsWith('|') || text.startsWith('>')) {
    throw new YamlLiteError('不支持多行标量（| / >）', line)
  }
  return text
}

/**
 * 解析一个映射块。
 * @param {object[]} tokens - token 列表
 * @param {number} start - 起始下标
 * @param {number} indent - 本块缩进
 * @returns {{ value: Record<string, unknown>, next: number }} 结果与下一个未消费下标
 */
function parseMapping(tokens, start, indent) {
  const out = {}
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.indent < indent) break
    if (token.indent > indent) {
      throw new YamlLiteError(`意外的缩进（期望 ${indent} 空格，实际 ${token.indent}）`, token.line)
    }
    if (token.text === '-' || token.text.startsWith('- ')) {
      throw new YamlLiteError('此处期望 `key: value`，却遇到序列项 `-`', token.line)
    }
    const pair = splitKey(token.text)
    if (pair === null || pair.key === '') {
      throw new YamlLiteError(`无法解析为 \`key: value\`：${JSON.stringify(token.text)}`, token.line)
    }
    if (pair.rest === '') {
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const child = parseBlock(tokens, i + 1, tokens[i + 1].indent)
        out[pair.key] = child.value
        i = child.next
      } else {
        out[pair.key] = null
        i += 1
      }
    } else {
      out[pair.key] = parseScalar(pair.rest, token.line)
      i += 1
    }
  }
  return { value: out, next: i }
}

/**
 * 解析一个序列块。
 * @param {object[]} tokens - token 列表
 * @param {number} start - 起始下标
 * @param {number} indent - 本块缩进
 * @returns {{ value: unknown[], next: number }} 结果与下一个未消费下标
 */
function parseSequence(tokens, start, indent) {
  const out = []
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.indent < indent) break
    if (token.indent > indent) {
      throw new YamlLiteError(`意外的缩进（期望 ${indent} 空格，实际 ${token.indent}）`, token.line)
    }
    if (token.text !== '-' && !token.text.startsWith('- ')) break
    const rest = token.text === '-' ? '' : token.text.slice(2).trim()
    if (rest === '') {
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const child = parseBlock(tokens, i + 1, tokens[i + 1].indent)
        out.push(child.value)
        i = child.next
      } else {
        out.push(null)
        i += 1
      }
      continue
    }
    const pair = splitKey(rest)
    if (pair !== null && pair.key !== '') {
      // `- key: value`：把本行还原为映射起始行，并吞掉更深缩进的续行。
      const itemIndent = token.indent + (token.text.length - rest.length)
      const virtual = [{ indent: itemIndent, text: rest, line: token.line }]
      let j = i + 1
      while (j < tokens.length && tokens[j].indent >= itemIndent) {
        virtual.push(tokens[j])
        j += 1
      }
      out.push(parseBlock(virtual, 0, itemIndent).value)
      i = j
      continue
    }
    out.push(parseScalar(rest, token.line))
    i += 1
  }
  return { value: out, next: i }
}

/**
 * 按首行形态分派映射 / 序列。
 * @param {object[]} tokens - token 列表
 * @param {number} start - 起始下标
 * @param {number} indent - 本块缩进
 * @returns {{ value: unknown, next: number }} 解析结果
 */
function parseBlock(tokens, start, indent) {
  const first = tokens[start]
  if (first.text === '-' || first.text.startsWith('- ')) return parseSequence(tokens, start, indent)
  return parseMapping(tokens, start, indent)
}

/**
 * 解析 YAML 子集文本。
 * @param {string} text - 文件内容
 * @returns {unknown} 解析结果（空文档返回 null）
 * @throws {YamlLiteError} 语法不属于支持的子集时
 */
function parse(text) {
  const tokens = tokenize(text)
  if (tokens.length === 0) return null
  const result = parseBlock(tokens, 0, tokens[0].indent)
  if (result.next !== tokens.length) {
    const token = tokens[result.next]
    throw new YamlLiteError('存在无法归入任何块的剩余内容（缩进可能不一致）', token.line)
  }
  return result.value
}

module.exports = { parse, YamlLiteError }
