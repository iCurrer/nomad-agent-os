# PORTABILITY.md — 可移植性与宿主隔离

> 核心命题：**USB 是 Agent 的 Home**，不是「把 DSH 装到 U 盘」。
> 目标：尽量不污染宿主机，且污染必须**可解释、可记录、可收敛**。

## 1. Runtime 与 Data 分离（第一原则）

| | Runtime | Data |
| --- | --- | --- |
| 路径 | `runtime/` | `data/` |
| 可替换 | ✅ | ❌ |
| 可升级 | ✅ | 只能迁移 |
| 可回滚 | ✅ | 靠备份 |
| 可重新下载 | ✅ | ❌（丢了就是丢了） |

版本化示例：

```
runtime/dsh/0.2.0/
runtime/dsh/0.2.1/
runtime/dsh/0.3.0/
runtime/dsh/current -> 0.2.1
```

## 2. Portable Launcher 职责

Launcher 是 Nomad 的核心，负责：

- 找到 USB 根目录（`NOMAD_ROOT`）
- 找到 Runtime
- 设置环境变量（进程级）
- 启动 DSH
- 启动 Web Server
- 打开浏览器
- 管理 PID / 日志
- 管理 Runtime（版本、切换、回滚）
- 管理退出（graceful shutdown）
- 检测兼容性

**所有路径必须从 `NOMAD_ROOT` 派生。**

**禁止**：`C:\Users\xxx\...`、`C:\Program Files\...`、`/Users/xxx/...`、`/home/xxx/...`

## 3. Host Isolation

启动时使用**进程级 environment override**，重点处理：

`HOME` ｜ `USERPROFILE` ｜ `APPDATA` ｜ `LOCALAPPDATA` ｜ `TEMP` ｜ `TMP` ｜ npm cache ｜ Node cache ｜ DSH writable state

> ⚠️ **已过时**：本节为手册原始描述。Phase 0 已完成源码级验证，**实际配方见 [`HOST_ISOLATION.md`](./HOST_ISOLATION.md)**，要点：
> - 单根机制：`DSH_HOME`（默认 `~/.dsh`）—— 会话记录默认就写在 `$DSH_HOME/sessions`
> - 官方先例：**环境白名单**（仅保留 `path/systemroot/windir/comspec/pathext`）+ 覆盖 `DSH_HOME / USERPROFILE / HOME / TEMP / TMP / TMPDIR` + 私有 `cwd`
> - `DSH_HOME` 属 bootstrap-only，**必须由 Launcher 注入进程环境变量**，写 `.env` 会被拒绝
> - 临时文件全部走 `os.tmpdir()` → 覆盖 `TEMP/TMP/TMPDIR` 即可搬走

**禁止**：

- 永久修改系统环境变量
- 自动修改 `PATH`
- 修改注册表（除非用户明确授权）

## 4. 「零污染」验收测试流程

1. 准备清洁 Windows 环境
2. 插入 Nomad
3. 启动
4. 打开 Web
5. 创建 Session
6. 调用 Tool
7. 创建 Project
8. 修改配置
9. 退出
10. 检查宿主机

检查范围：`AppData` / `LocalAppData` / `HOME` / npm cache / temp / registry / user config / 隐藏目录。

**允许**存在 OS 必要临时文件，但必须：**记录 → 解释 → 尽量减少**。

记录格式：

| 路径 | 产生原因 | 是否必需 | 可否收敛 |
| --- | --- | --- | --- |
| （待填） | | | |

## 5. Browser-first 与端口

```
Nomad Launcher → DSH Web Server → localhost → Browser
```

- 默认 `http://127.0.0.1:<port>`
- **端口不得永久写死**
- 默认端口被占用 → 自动寻找可用端口 → 再打开浏览器

## 6. 退出与异常

- 必须支持 graceful shutdown（PID 记录 + 超时强杀兜底 + 日志留痕）
- 崩溃后重启不得破坏 `data/`
- 热拔 USB 属未定义行为：文档必须明示风险，并尽量做到写操作原子化

## 7. 多平台抽象

Windows / Linux / macOS 均需抽象：runtime、launcher、path、environment、browser、process management。
**第一阶段只做 Windows x64**，不要同时解决全部平台问题。

---

## 8. 离线运行时策略（核心结论：**用户机永远不编译**）

> 证据等级：**源码级已复核**（commit `5badb15` / `0.2.1-alpha.1`）。其余标注见 `docs/DSH_SOURCE_MAP.md` §A。

### 8.1 已核实事实

| 事实 | 值 |
| --- | --- |
| npm 包 | `@deepseek-ai/dsh`，最新 `0.2.0-rc.2`（npm 上即**已构建产物**）；仓库 tag 已到 `0.2.1-alpha.1` |
| 默认 Web 地址 | `http://127.0.0.1:3080`，**默认自动打开系统默认浏览器**，`--no-open` 关闭 |
| 状态根 | **`DSH_HOME`**，profile 位于 `$DSH_HOME/profiles/<name>` |
| 源码运行 | `pnpm install && pnpm run build && pnpm dsh web`（需先构建一次） |
| 跑既有产物 | 官方脚本 `start:web`（不重新 build）／开发用 `dev:web`（build + watcher） |
| Electron 载体 | 存在 `apps/desktop`，`desktop` 为保留 profile 名（备选路线，非本阶段目标） |

### 8.2 便携支点：`DSH_HOME`

把 `DSH_HOME` 指向 U 盘（如 `<NOMAD_ROOT>/data/dsh-home`），则 profile、`cordis.patch.yml`、会话全部落在盘上。
**这是 Host Isolation 的头号变量**，其余变量清单待 Phase 0 实测补齐。

### 8.3 两条产物流派（二选一或混合）

| | **A. npm 包流派（推荐基线）** | **B. 源码构建流派** |
| --- | --- | --- |
| 来源 | npm 预置包（**已经是构建产物**） | 开发机 / CI 执行 `pnpm run build` |
| 用户机编译 | **零** | **零**（用 `pnpm start:web` 跑既有产物） |
| 体积 | 小 | 大（monorepo + node_modules） |
| 插件管理 | ⚠️ npm 版 CLI **拒绝**插件管理请求 | ✅ `dsh plugin --profile <name>` 可用 |
| 风险 | 插件依赖需手写进 profile 的 `package.json` | 产物管理与版本切换复杂 |

**建议基线**：A 作便携基线（小、官方发布、零编译）+ **自研 UI bundle 以「预构建独立包」形式**放入 profile 的 `node_modules`（自研包在开发机 / CI 编译一次）。

### 8.4 `npx` 禁令

`npx` 会联网访问 registry，**禁止出现在 U 盘启动路径**。
必须：预置包 + 直接调 node 入口（`launch_mode: node-entry`），或使用离线模式。

### 8.5 冷启动成本归位

| 角色 | 成本 |
| --- | --- |
| 开发机 / CI | 首次 `pnpm install && pnpm run build` 慢且重（**一次性**），之后增量 / `start:web` |
| 用户机（U 盘） | **零编译、零 npm、零 Node 安装** —— 只跑已构建产物 |

> 「普通电脑没环境 + 很慢」是**构建期问题**，不是运行期问题。把构建搬到开发机 / GitHub Actions，用户机只承担运行。

### 8.6 自研 UI 插件包的构建归位（Phase 0 新增）

「深度定制 UI」与「用户机不编译」如何同时成立 —— 答案是**构建只发生在开发机/CI，产出物随盘携带**：

```
开发机 / CI（一次）                          用户机 / U 盘（零构建）
─────────────────────────────              ──────────────────────────────
DSH 源码 → 构建 → 预置运行时产物      ┐
自研 @nomad/* UI 包 → tsdown 构建     ├─→  U 盘  →  Nomad Launcher
  → lib/index.js + lib/client.js      │             ↓
profile（bundles + patch）→ 预置      ┘        bundled Node（直接调入口）
                                                  ↓
                                          DSH 启动 → /plugins 现场读自研包
                                                  ↓
                                          浏览器打开（Nomad UI）
```

**关键机制**（源码级）：客户端插件 bundle 由宿主在**请求时 `readFileSync` 从包目录现场读取**
（`packages/client/modules/src/index.ts:1109`），且宿主**增量扫描** Loader 条目（同文件 `:1-20`）。
→ **自研 UI 包只要落进 profile 的 `node_modules` 并有一条 Loader 行，就会被服务**，无需重新打包 DSH 本体、无需重新生成 dist。

**因此 U 盘的 `app/` 目录承担的是「预构建 UI 插件包 + profile 定义」，不是源码。**
用户机不做 `pnpm install`、不做 `pnpm build`、不装 Node。

> 唯一仍需在开发机做的、且必须登记进 `UPSTREAM.md` 的产物：
> **对上游 roster 的「重述式 patch」**（`nomad-web-app` 的 `cordis.patch.yml`）。DSH 升级时需同步更新。
