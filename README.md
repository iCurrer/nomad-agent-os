# Nomad — Portable Agent OS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 把 Agent 的家装进 U 盘，把浏览器变成它的屏幕。

Nomad 不是从零开发的 Agent，而是构建在 **DeepSeek Harness（DSH）** 之上的 **Portable Agent OS**。

```
DSH      = Agent Engine
Nomad    = Product / OS Layer
USB      = Agent Home
Browser  = Agent Screen
```

## 目标体验

```
插入 USB → 启动 Nomad → 浏览器打开 Nomad Web UI
   → 使用 Agent → 重要状态写入 USB → 拔走 USB
   → 换另一台电脑 → 继续工作
```

## 核心价值

1. Portable　2. Persistent　3. Personal　4. Extensible
5. Upgradable　6. Recoverable　7. Secure

换电脑：Agent 不换。换系统：Agent 不换。换 USB：Agent 可迁移。
升级 Runtime：Memory / Project / Session 不丢。升级 DSH：Nomad 可回滚。

## 架构一览

```
Nomad (Web UI / CLI / Launcher)
        ↓
Nomad Application Layer (Projects / Memory / Skills / Profiles / Context / Permissions)
        ↓
DeepSeek Harness Engine (Agent Loop / Tools / MCP / Sessions / Models / Events)
        ↓
Portable Runtime → USB
```

## 从源码运行

> **本仓库不包含 `runtime/`**（Node + DSH 共 ≈664 MB）。运行时按版本独立管理、由 `.gitignore`
> 排除，**永不进版本库**。仓库内容是 Nomad 自身的**产品层与可移植层**源码。

克隆后有两种用法：

**A. 阅读 / 参与开发 —— 零安装**

`launcher/`、`packages/`、`docs/`、`tests/` 全部是**零依赖纯 JS / Markdown**：
无 TypeScript、无构建步骤、无 npm 依赖。唯一需要的是本机 Node 20+ 用于跑测试。

```bash
node --test tests/*.test.js       # 159 项单元测试，零依赖
```

**B. 完整复现便携运行时（开发机流程）**

Agent 引擎 [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) 是**公开 npm 包**，
可按官方版本自行装配运行时（Node 官方包 SHA-256 校验 + `npm install @deepseek-ai/dsh@<version>`）。
完整流水线见 [`docs/DEVELOPMENT.md` §8 运行时打包流水线](docs/DEVELOPMENT.md)。

> 装配完成后，`runtime/dsh/current/nomad-runtime.json` 即为版本指针 ——
> **回滚 = 改写它的 `entry` 一行**（清单间接而非符号链接，见 ADR-0016）。

## 快速开始（Phase 1 启动器）

```bash
# 体检：路径 / Secret / 目录 / 运行时 / 隔离 / 端口 / 宿主污染探针（只读）
nomad doctor

# 只看启动计划，不启动任何进程（含完整 argv 与隔离计划）
nomad start --dry-run

# 启动（后台）→ 就绪后自动打开浏览器
nomad start

# 前台运行（Ctrl+C 停止，便于调试）
nomad start --foreground

# 状态 / 地址 / 日志 / 停止
nomad status
nomad url          # 打印带 token 的地址（敏感，勿外传）
nomad open         # 浏览器显示 authentication required 时，用它重开
nomad logs
nomad stop
```

生命周期管理：

```bash
nomad backup                    # 备份盘内数据（零依赖递归复制 + 清单）
nomad restore <backup-dir>      # 从备份合并恢复（覆盖同名、不删多余）
nomad projects                  # 只读列出盘内 DSH 工作区 / 项目
nomad rollback [<version>]      # 列出或切换到可用 DSH 运行时版本
```

Windows 可直接双击：`Nomad.cmd`（启动）｜`Nomad-Restart.cmd`（重启）｜`Nomad-Stop.cmd`（停止）｜`Nomad-Doctor.cmd`（体检）。

> 改了插件或配置后**必须重启实例**才生效（客户端模块在启动时组装），所以开发循环里 `Nomad-Restart.cmd`
> 是最常用的那一个。日常开发流程见 `docs/DEVELOPMENT.md` §9。

> **浏览器显示 `dsh web authentication required`？** 这不是故障，是 DSH 的鉴权设计：
> 访问地址必须带上本次启动的 `?token=…`，裸地址（如手动敲 `http://127.0.0.1:4850/`）必然 401。
> 依次尝试：① `nomad open`；② `nomad url` 拿完整地址手动粘进浏览器；
> ③ 在 `config/nomad.yaml` 设置 `web.browser_path` 指定浏览器可执行文件。
> `nomad doctor` 会分别报出「浏览器交接命令」与「Web 认证握手」两项，可直接定位断在哪一环。

自检：

```bash
node --test tests/*.test.js          # 159 项单元测试
node tests/smoke/portable-smoke.js   # 12 步端到端冒烟（使用替身运行时）
node tests/smoke/stale-state-guard.js # 4 步 PID 复用安全闸
node tests/smoke/real-runtime-smoke.js # 20 步真实 DSH 端到端（会停掉在跑的实例）
```

> 打包好的 `runtime/`（Node v22.23.3 + DSH 0.2.1-alpha.1，共 32,089 文件 / 603.7 MB）
> 让用户机做到**零编译、零 npm、零 Node 安装**。运行时与数据严格分离 —— `runtime/` 可替换、可升级、
> 可回滚、可重新下载；`data/` 必须长期存在，两者**永不混放**。详见 `docs/PHASE1_LAUNCHER.md`。

## 部署到 U 盘（可移动盘）

```bash
node tools/deploy-usb.js --target E:\ --dry-run              # 预检：只读，打印计划
node tools/deploy-usb.js --target E:\                       # 全量部署：32,146 文件 / 604 MB
node tools/deploy-usb.js --target E:\ --app-only --force    # 日常开发：只推 app 层（亚秒级）
```

- **日常开发用 `--app-only`**：跳过 `runtime/`（占 99.5% 体量），只同步约 57 个文件 / 481 KB，
  实测 **1.3 s**。它用版本戳核对 runtime，对不上会拒绝并要求全量 —— 快，但不会漏。
- **用盘符根**（`E:\`），不要套子目录 —— 树里有 1 条 264 字符路径，靠 Node 的 libuv 长路径支持通过，
  余量越小风险越大。
- **白名单驱动**：`vendor/`（上游源码）/ `.cache-dev/`（下载缓存）/
  `.workbuddy/` / `data/` **一律不随盘**；目标盘 `data/` 全新初始化为空骨架
  （盘内不落真 key，ADR-0019）。
- **断点续传**：目标端已存在且大小一致的文件会跳过，中断后**原样重跑**即可。
- **部署前先停掉目标盘上的实例**：盘上实例占用着它加载过的文件，覆盖会 `EPERM`
  （工具会在复制前用「可覆盖探针」提前报出）。
- 部署完成后在盘上双击 `Nomad-Doctor.cmd` 体检、`Nomad.cmd` 启动（已在运行时用 `Nomad-Restart.cmd`）。
- 详见 `docs/DEPLOY.md` 与 **ADR-0027**。

## 目录

| 路径 | 说明 |
| --- | --- |
| `LICENSE` | **MIT 许可全文** |
| `THIRD_PARTY_NOTICES.md` | 第三方组件与许可聚合声明 |
| `AGENTS.md` | **AI 开发规则宪法（必读）** |
| `launcher/` | **启动器（零依赖 Node CLI + 运行时监督进程）** |
| `tools/` | 开发机工具（**部署到可移动盘**：`tools/deploy-usb.js`） |
| `tests/` | 单元测试 + 端到端冒烟 + 替身运行时 fixture |
| `docs/` | 架构 / 源码地图 / 数据模型 / 可移植性 / 安全 / 测试 / 上游 / 决策 / UI / 开发 / 路线 / 启动器 / **部署** |
| `config/` | `nomad.yaml` `providers.yaml` `permissions.yaml` `compatibility.yaml` |
| `runtime/` | 可替换运行时（node / dsh 版本化 + `current`）—— **不进版本库** |
| `data/` | 长期数据（dsh-home / sessions / logs / tmp / run / backups）—— **不进版本库** |
| `workspace/` | Agent 工作区与沙箱 |
| `skills/` `profiles/` `mcp/` | 用户的技能 / 档案 / MCP 配置（盘上长期存在） |

> `runtime/` 可被替换、升级、回滚、重新下载；`data/` 必须长期存在。两者**永不混放**。

## 开发阶段

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| Phase 0 | Source Reconnaissance → `docs/DSH_SOURCE_MAP.md` | 已完成 |
| Phase 1 | Portable Bootstrap（Launcher → DSH → Web → Browser） | **已完成**（运行时已打包，真实 DSH 端到端闭环） |
| Phase 2 | Nomad Web UI | **已完成 V1**：L4-a 通道全通（补丁层 → 自研 bundle → profile 自举 → 真实启动渲染 UI）；侧栏品牌已换（L2 客户端插件）、Nomad 自有面板已长出（含 **About：产品介绍 + 合规声明**）、外观已换肤；**V1 清单已闭环**（含 `rollback` / `backup` / `projects` 生命周期命令）；不 fork 上游 |
| Phase 3 | Nomad Agent OS（Projects / Memory / Skills / Profiles / Permissions / Runtime Manager） | 待开始 |

里程碑与勾选明细见 [`docs/ROADMAP.md`](docs/ROADMAP.md)，技术决策见 [`docs/DECISIONS.md`](docs/DECISIONS.md)。

## 给 AI 编程助手

每个新会话第一条消息粘贴 `docs/BOOTSTRAP_PROMPT.md`，并遵守 `AGENTS.md`。

## 归属与许可

- **Nomad 基于 DeepSeek Harness（DSH）构建** —— Agent 引擎由上游提供，Nomad 只做产品层与可移植层。
- **上游许可**：`@deepseek-ai/dsh` 为 **MIT · Copyright (c) 2026 DeepSeek**
  （上游仓库 <https://github.com/deepseek-ai/deepseek-harness>）。
- **本项目许可**：**MIT** —— 见 [`LICENSE`](LICENSE)；各 `packages/*/package.json`
  均已声明 `"license": "MIT"`。
- **第三方组件**：运行时含 561 个传递依赖（以 MIT / Apache-2.0 / ISC / BSD 为主，
  **无 GPL / AGPL 等强 copyleft**），聚合清单见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
- **未修改上游源码**：Core Patch 数 = **0**，全部定制通过官方文档化扩展点完成
  （Cordis 插件 / `cordis.patch.yml` 行补丁 / 客户端插件槽位 / 主题 token 覆盖）。
- **商标声明**：DSH / DeepSeek Harness 是深度求索公司的注册商标，未经授权不得用作项目名
  —— 本项目名 `Nomad` 不含该商标。Nomad 为独立项目，与 DeepSeek
  **无隶属、无赞助，亦无背书关系**。「基于 DeepSeek Harness 构建」属上游
  `BRAND_GUIDELINES` 明确许可的描述性用法。
- 界面内亦有一份同源声明：Nomad 面板 → **About** 区块。

## 免责与边界

- Nomad 不重写 DSH 的引擎能力，只做产品层与可移植层。
- DSH 仍处于 developer preview：**不追踪 master、不自动升级**，一律走版本化 Runtime + 可回滚流程。
- 宿主隔离是**进程级**的：Nomad 不修改系统环境变量、不改注册表、不动 PATH。
  但**浏览器是宿主的**——它的历史/缓存/会话不归 Nomad 管理（见 `docs/HOST_ISOLATION.md`）。
- **凭据安全**：模型 API key 保存在盘内 `data/dsh-home/.credentials.yaml`（明文）。
  请自行妥善保管载体；`data/` 永不入库。
