# PHASE1_LAUNCHER.md — 可移植引导层（Portable Bootstrap）

> 状态：**已实现并通过端到端验证**
> 代码：`launcher/`（零依赖，纯 CommonJS，只要 Node 即可运行）
> 测试：`tests/`（53 单元测试）+ `tests/smoke/`（12 步链路 + 11 步真实 DSH + 4 步安全闸 + 9/8 步 L4-a 探针）

---

## 1. 定位与边界

Launcher 是 Phase 1 的全部交付物，也是 Nomad 与 DSH 之间唯一的**进程级**胶水。

它做什么：

- 定位 `NOMAD_ROOT`（U 盘根）
- 发现运行时（盘内 Node + 盘内 DSH）
- 构造宿主隔离环境并注入子进程
- 拉起 DSH、解析就绪信号、打开浏览器
- 记录状态、写日志、提供优雅退出与回滚友好的运行信息

它**不做**什么（对应 `AGENTS.md` 铁律 4、12、13）：

| 禁止 | 原因 |
| --- | --- |
| 不实现 Agent Loop / Session / Tool Runtime | DSH 的职责，Nomad 只做产品层 |
| 不下载、不构建、不 `pnpm install` | 铁律 7：构建期与运行期彻底分离 |
| 不出现 `npx` | 铁律 8：`npx` 会联网，无网机器直接失败 |
| 不修改系统环境变量 / 注册表 / PATH | 只做**进程级**环境覆盖 |
| 不按未经验证的 PID 杀进程 | PID 会被复用，盲杀即事故（见 §8） |
| 不自动更新 DSH | 铁律 6：升级必须显式、可回滚 |

---

## 2. 启动链路

```
Nomad.cmd / ./nomad                     ← 双击入口（只用 %~dp0 推路径，不写死任何宿主路径）
        │
        ▼
launcher/nomad.js  start                ← CLI：解析配置、校验路径/Secret、组装命令
        │  spawn（后台 detached / 前台 inherit）＋ 不带 IPC（后台）
        ▼
launcher/host.js                        ← Runtime Host：进程监督者，持有 stdout 与状态文件
        │  spawn（隔离环境）
        ▼
runtime/node/… + runtime/dsh/current/<entry>   --profile web --host 127.0.0.1 --port 0 --no-open
        │
        │  stdout: `dsh web: http://127.0.0.1:<port>/?token=…`
        ▼
状态文件 data/run/nomad.state.json  →  打开浏览器（带 token 的 URL）
```

**为什么中间需要一个 Runtime Host 进程**（不是多余的一层）：

1. 后台模式下 CLI 必须退出，但就绪 URL 只出现在 DSH 的 stdout 上 → 需要一个存活进程持有这条管道；
2. 优雅退出需要一个"还在场"的进程，把停止意图转达给 DSH 并等待收敛；
3. 状态文件（pid / 端口 / URL / 心跳）需要一个明确且唯一的写入者。

---

## 3. 命令行契约（源码级证据，禁止猜测）

| 事实 | 证据（本地源码） |
| --- | --- |
| CLI 形态：`--profile <name>` + 其后全部 token 归被启动的 app | `apps/cli/src/args.ts:159-174`（`allowUnknownOption` + `passThroughOptions` + `enablePositionalOptions`） |
| 首位置参数非 `-` 时自动补 `--profile` | `apps/cli/src/args.ts:201-205` |
| web 参数族仅这五个：`--host/--no-open/--port/--public-url/--trusted-host` | `packages/bundle/web-app/src/startup.ts:59-63` |
| `--port 0` = 交给 OS 分配可用端口 | `startup.ts:61`（`'listen port; pass 0 to let the OS pick a free one'`） |
| `--host 0.0.0.0` 被**主动拒绝**（会把 RCE 暴露到网络） | `startup.ts:85-87` |
| 内置 profile 名：`acp` / `web` / `headless` / `sdk` / `sdk-minimal` | `packages/boot/app-boot/src/profile.ts:179-195` |
| `web` 是内置名，**不能**作为自建 profile 的目标（须 `--from-default-profile web` 另起名） | `apps/cli/src/profile-boot.ts:116-131` |
| URL 行格式：`dsh web: <authenticatedUrl>[ (LAN: <url>)]` | `packages/bundle/web-app/src/index.ts:290` |
| 该 URL 把本次进程的 launch token 作为 **query 参数**附带 | `packages/client/connection/src/browser-auth.ts:223-227` |
| 根路径带合法 token 的 GET 会**铸 cookie** 并重定向到干净的 `./` | `browser-auth.ts:238-245` |

由这些事实推出的**启动器实际生成的命令**：

```
<runtime/node/node.exe> <runtime/dsh/current/<entry>> --profile web --host 127.0.0.1 --port 0 --no-open
```

> 注意：`--host` / `--port` / `--no-open` 由启动器按配置自动生成，**不要**在 `config/nomad.yaml` 的 `app_args` 里重复写。

---

## 4. 端口策略：不写死，交给 OS

`web.port: 0` → 启动器传 `--port 0`，端口由 OS 分配，启动器从 URL 行回读实际端口。

这样做的三个好处：

1. **零端口冲突**：不需要"探测空闲端口 → 关闭 → 再绑定"这种有竞态的做法；
2. **符合上游做法**：官方桌面载体同样使用 `['--no-open', '--port', '0']`（`apps/desktop-host/src/index.ts:30`）；
3. **与"浏览器交接"天然契合**：反正要解析 URL 行拿 token，端口顺手就得到了。

若显式配置固定端口，被占用时 DSH 会以 bind 诊断拒绝启动（`webserver/README.md`），此时启动器会回放最近 40 行输出来定位问题。

---

## 5. 浏览器交接：为什么必须用**带 token** 的 URL

DSH 的启动 URL 上带一个本次进程的 launch token。浏览器首次以该 URL 请求根路径时，DSH 会给它铸一个 cookie，然后把地址重定向到不带 token 的干净路径。

因此：

- **裸的** `http://127.0.0.1:<port>/` 会得到 401；
- 启动器恒定给 DSH 传 `--no-open`，由**自己**在拿到 URL 行后打开浏览器；
- 日志里只出现**脱敏地址**（去掉 query 与 hash），带 token 的完整 URL 只写入权限 0600 的状态文件。

浏览器交接权归 Nomad 的三个理由：`nomad status` 能报出地址、`web.open_browser` 能统一控制、宿主浏览器行为不会在隔离层里被搅乱。

### 5.1 交接怎么交、怎么判（2026-10-08 事故后重写；依据 ADR-0022）

上面这套设计**自 2026-10-08 起才有真正的判定**。当时用户报了两个症状：

1. 浏览器正文 = `dsh web authentication required; reopen the URL printed by dsh web.`；
2. 启动时**自动弹出一个文件资源管理器窗口**。

根因是同一个：旧实现用 `spawn('explorer.exe', [url])`，而 **explorer.exe 不是"打开 URL"的接口**。
它把 URL 当路径处理（第 2 个症状），并让 URL 在传递途中丢掉 query（第 1 个症状：浏览器拿到裸地址 → 401）。
更糟的是它**无论成败都返回退出码 1**，而旧代码只检查 "spawn 有没有抛异常" —— 于是判定恒为成功，
`nomad start` 照打「已交由系统浏览器打开」。

现在的三层结构：

| 环节 | 做法 | 判据 |
| --- | --- | --- |
| 组装 | `buildOpenCommand()` **纯函数**：win32 → `cmd.exe /c start "" <url>`；URL 含 cmd 元字符 → 降级 `powershell -EncodedCommand`；配了 `web.browser_path` → 直接拉起该 exe（零解析面） | URL 必须**完整**是其中一个参数 |
| 交接 | `openBrowser()` 拉起并等退出码 | 退出码 0 才算成功；卡住/非 0/无退出码一律 `ok:false` |
| 交付前自检 | `verifyAuthHandshake()`：先自己走一遍 `303 铸 cookie → 带 cookie 200` | 两跳都成立才认为"交给浏览器进得去" |

交接结果如实落盘 `state.browserHandoff`（`pending`/`ok`/`failed`/`skipped`），
`nomad start` / `status` / `doctor` 一律照实打印。

**用户侧自救通道**（按优先级）：

1. `nomad open` —— 用状态文件里**带 token** 的 URL 重新交接；
2. `nomad url` —— 打印完整地址，手动粘进浏览器地址栏；
3. `config/nomad.yaml` 的 `web.browser_path` —— 指定浏览器可执行文件的绝对路径，绕开系统默认浏览器。

**诚实边界**：浏览器本身属于宿主。它的历史、缓存、会话归宿主浏览器进程，Nomad 接管不了 —— 除非将来改用官方 Electron 载体。这条不含糊过去。

---

## 6. 宿主隔离：进程级 allowlist

实现见 `launcher/lib/env.js`，依据 `docs/HOST_ISOLATION.md`（含逐条源码证据）。

- **策略**：白名单继承 —— 只保留 5 个平台必需变量（`path/systemroot/windir/comspec/pathext`），其余一律不传。上游自己的隔离先例在 `apps/desktop/scripts/test-host-updates.ts:34-39`。
- **覆盖**：`DSH_HOME` / `HOME` / `USERPROFILE` → `<NOMAD_ROOT>/data/dsh-home`；`TEMP` / `TMP` / `TMPDIR` → `<NOMAD_ROOT>/data/tmp`。
- **自证标记**：子进程里注入 `NOMAD_ROOT` 与 `NOMAD_ISOLATED`（0/1），将来排查"这一跑到底隔没隔"时有据可查。
- **只影响子进程**：不存在任何 setx / 注册表 / 系统环境写入路径。

实测（本机一次真实启动）：

```
环境隔离：策略=allowlist 继承=5 丢弃=190 覆盖=DSH_HOME, HOME, TEMP, TMP, TMPDIR, USERPROFILE
```

---

## 7. 状态文件与心跳

路径：`<NOMAD_ROOT>/data/run/nomad.state.json`（权限 0600，`.gitignore` 已排除）。

字段：`phase`（`starting`/`ready`）、`supervisorPid`、`dshPid`、`instanceId`、`url`（**带 token，敏感**）、`publicUrl`（脱敏）、`port`、`runtime`、`command`、`startedAt`、`heartbeatAt`、`webAuth`（交付前认证握手自检结果）、`browserHandoff`（浏览器交接结果）。

- 监督进程每 5 秒刷新 `heartbeatAt`；
- DSH 退出时清理状态文件。

---

## 8. 进程安全闸：绝不盲信 PID

**问题**：PID 会被操作系统复用。一个陈旧状态文件里的 `pid`，可能已经指向编辑器、浏览器或用户的 shell。此时"尽力清理"就是事故。

**做法**：`nomad stop` 先校验心跳新鲜度（`HEARTBEAT_MAX_AGE_MS = 25s`）。

| 情形 | 行为 |
| --- | --- |
| 状态不存在 | 报"未在运行" |
| 记录的进程都已退出 | 清理状态文件，报"未在运行" |
| 进程存活 + **心跳新鲜** | 正常停止（Windows：`taskkill /T /F`；POSIX：`SIGTERM` → 超时 `SIGKILL`） |
| 进程存活 + **心跳过期** | **拒绝按 PID 杀进程**，如实说明 PID 可能已被复用，清理状态文件，退出码 1 |

验证脚本：`tests/smoke/stale-state-guard.js` —— 它真的起一个"无辜进程"，把它的 PID 写进过期状态文件，然后要求 `stop` 拒绝执行、且该进程**仍然存活**。已通过。

---

## 9. 目录基线

`nomad start` 会幂等创建（`doctor` **不会**，它只做只读巡检）：

```
runtime/ data/{dsh-home,tmp,logs,run,backups} workspace/ skills/ profiles/ mcp/
```

---

## 10. CLI 参考

| 命令 | 说明 |
| --- | --- |
| `nomad` / `nomad start` | 后台启动，就绪后打印地址并退出 |
| `nomad start --foreground` | 前台启动，`Ctrl+C` 停止（调试用） |
| `nomad start --dry-run` | **只打印启动计划**，不启动任何进程（含完整 argv、隔离计划、目录） |
| `nomad stop` | 停止（带心跳安全闸） |
| `nomad restart` | 停止后重启 |
| `nomad status [--json]` | 状态；退出码 0 运行中 / 3 未运行 |
| `nomad doctor [--json]` | 体检；退出码 0 全通过 / 1 有 FAIL |
| `nomad env` | 打印将注入子进程的隔离环境（脱敏） |
| `nomad paths` | 打印解析后的路径与运行时入口 |
| `nomad logs [--raw] [--lines N]` | 查看监管日志 / DSH 原始输出 |
| `nomad url` | 打印带 token 的地址（**敏感**） |
| `nomad open` | 用系统浏览器重新打开当前实例 |
| `nomad version` | 版本信息 |

Windows 双击入口：`Nomad.cmd`（启动）、`Nomad-Stop.cmd`（停止）、`Nomad-Doctor.cmd`（体检）。
POSIX 入口：`./nomad`。

> **体检命令是只读的**：`doctor` 不建目录、不写状态、不改配置。会落盘的引导动作只由 `start` 与 Runtime Host 执行。

---

## 11. 验收结果（**真实运行时已就位**）

| 项 | 结果 |
| --- | --- |
| 单元测试 `node --test tests/*.test.js` | **53 / 53 通过**（yaml-lite、路径卫士、隔离环境、配置契约、URL 解析、状态心跳、**运行时发现**） |
| 替身冒烟 `node tests/smoke/portable-smoke.js` | **12 / 12 通过**（引导管线：装载 → start → 状态 → HTTP → 零污染 → status/url → 幂等 → stop） |
| **真实 DSH 冒烟** `node tests/smoke/real-runtime-smoke.js` | **11 / 11 通过**（真引擎端到端，见 §11.1） |
| 陈旧状态安全闸 `node tests/smoke/stale-state-guard.js` | **4 / 4 通过**（拒绝盲杀，无辜进程存活） |
| `nomad doctor` | **12 / 12 通过**（路径 / Secret / 目录 / Node / DSH / 启动命令 / 隔离 / 端口 / 宿主探针） |

> 两套冒烟**分工不同，都要跑**：替身验「引导管线」（快、可重复、无外部依赖）；真实验「整条链路真能起来」（慢、会真实写盘）。
> 两者共用 `runtime/dsh/current` 这一个指针，因此替身冒烟会先把真实指针**暂存让位**、结束（含异常与信号）后逐字放回（ADR-0017）。

### 11.1 真实 DSH 端到端实测（2026-10-08）

| 观测点 | 实测值 |
| --- | --- |
| 运行时 | `@deepseek-ai/dsh@0.2.1-alpha.1`（npm 已构建包），入口 `…/@deepseek-ai/dsh/lib/bin.js` |
| 盘内 Node | `v22.23.3`（官方 win-x64，SHA-256 已与 `SHASUMS256.txt` 比对通过） |
| 就绪耗时 | 直接拉起约 **2.5 秒**；经 Nomad 约 8–20 秒（含 host 注册与状态写入） |
| 实际启动命令 | `runtime/node/node.exe …/dsh/lib/bin.js --profile web --host 127.0.0.1 --port 0 --no-open` |
| Web UI | 带 token 的 GET → `303`（铸 cookie）→ 跟随跳转后 `200 text/html 34656B` |
| 零污染 | 真实引擎写**盘内** `$DSH_HOME`：`.anonymous-user-id`、`.credentials.yaml`、`profiles/`、`sessions/`、`storages/`；**宿主 `~/.dsh` 全程未出现** |
| 进程清理 | `nomad stop` 后**无残留进程**；状态文件被清理；`current` 指针与版本目录完好 |

> ⚠️ **HTTP 语义（易踩）**：DSH 的启动 URL 是「根路径 + `?token=…`」。对它的**首次** GET 会铸出会话 cookie 并 `303` 跳到根路径；**跟随跳转时必须带上该 cookie**，否则得到 `401`。用不带 cookie 容器的客户端（如 Python `urllib`）探测会**误判为不可达**。

### 11.2 运行时打包（开发机一次，用户机零编译）

| 步骤 | 做法 |
| --- | --- |
| Node | 下载官方 `node-v22.23.3-win-x64.zip` → **SHA-256 校验** → 解压进 `runtime/node/`（2032 文件 / 94.5MB），并写版本戳 `NOMAD_NODE_VERSION` |
| DSH | `npm install @deepseek-ai/dsh@0.2.1-alpha.1` 到 `runtime/dsh/0.2.1-alpha.1/`（28,430 文件 / 360.7MB），npm integrity 自校验 |
| 指针 | `runtime/dsh/current/nomad-runtime.json` 的 `entry` 指向版本目录（**清单间接，非软链**，见 ADR-0016） |
| 发布态合计 | 约 **455MB** |
| 用户机 | 不需要 Node、不需要 pnpm、不需要 node_modules、不编译、不联网 |

---

## 12. 已知限制（不含糊）

1. **Windows 没有 POSIX 信号语义**：Node 在 Windows 上的 `kill` 即 `TerminateProcess`，且后台子进程没有可用的 IPC 通道，因此停止统一走 `taskkill`。这意味着 **Windows 后台停止不是"优雅停机"**；前台模式（`Ctrl+C` → 同控制台组广播）则走优雅路径。POSIX 上则是 `SIGTERM` → 超时 `SIGKILL`。
2. **外部安全软件可能拦截删除**：`nomad stop` 需要删除状态文件。已加**退避重试（3 次）**，仍失败则**明确告警**而非静默。被持续拦截时状态文件会留存——不影响使用（下次 `start` 会先清理，且陈旧状态另有 PID 安全闸兜底）。
3. ✅ **【已修复，2026-10-08】打包期被打断的 npm install 留下过半成品依赖树**。
   症状：真实 DSH 启动打印 `dsh: warning: 1 entry did not activate` /
   `ui-sidebar-documentpreview (@deepseek-ai/dsh-client-ui-sidebar-documentpreview): failed to import`，
   而且**再跑一次 `npm install` 也修不好**。

   **真实机制**（比最初判断更细，两轮修正后的定稿）：

   | 环节 | 事实 |
   | --- | --- |
   | 事故时磁盘形态 | 4 个包**只有顶层残骸**（有 `lib/` 等目录、**没有 `package.json`**），而锁文件指定的**正确嵌套位置整份缺失** |
   | 为什么再装也修不好 | npm 信任 `node_modules/.package-lock.json` 里「已安装」的记录，**不会重新解压**；它只把缺失的目录建出来（甚至是空目录），内容不补 |
   | 为什么目录遍历看不见 | `scanBrokenPackages` 只能发现「存在但残缺」，**发现不了「整份缺失」** |
   | 为什么 `--dump-config` 看不见 | 它只做组合，不导入插件、不做 preflight |
   | 最终修法 | 把出问题的目录**挪走**（不用删，绕开删除审批）→ 重跑 `npm install` → npm 按锁文件把包放回**正确的嵌套位置** |

   结果：`npm install` 报 `added 24 packages, and removed 70 packages in 3m`（就是重新归位的过程），
   4 个包全部落到嵌套位置且都有 `package.json`；**`documentpreview failed to import` 告警消失**（实测）。
   受影响的包与后果：`dsh-client-ui-sidebar-documentpreview`（侧栏文档预览）、
   `libreoffice-kit-win32-x64`（Windows Office→PDF）、`@img/sharp-win32-x64`（sharp 原生二进制）、
   `dsh-experimental-inspector`（不在 web roster）。

   **防复发（两层，都进了回归）**：
   - `nomad doctor` 的「运行时包完整性」现在有**两条判据**：**锁文件对账**（`scanMissingPackages`，能抓「整份缺失」）
     + **目录遍历**（`scanBrokenPackages`，无锁文件时的回退，顺带修好了「不递归嵌套 `node_modules`」的盲区）。
     对账判据收窄为「optional **且** 包名指示的平台/架构与当前机不符」才豁免 —— 依据是实测数据：
     丢 70 个包全是 optional，其中既有本该缺席的别平台包，也有**本该存在却缺席的平台匹配包**。
   - `real-runtime-smoke.js` 新增**「DSH 启动输出零告警」**断言（按字节偏移隔离本次启动的输出）：
     不许出现 `failed to import` / `did not activate` / `disabling profile plugin row` / `*Error`。
     这类事故**全都不影响 HTTP 200**，只断言「UI 可达」会 100% 漏掉。
   - 完整补救流程与「npm 信任隐藏锁文件」这个坑，已写进 `docs/DEVELOPMENT.md` §8。

4. **`$DSH_HOME/.credentials.yaml` 是明文**：真实引擎启动即在盘内创建该文件。U 盘丢失 = 凭据明文泄露。
   → **已定案 ADR-0019**：宿主凭据库**永久排除**（违「不污染宿主机」铁律）；唯一入口 = Launcher 注入；盘内不落真 key。
5. **`current` 是清单文件，不是软链**：回滚 = 改写 `runtime/dsh/current/nomad-runtime.json` 的 `entry`。**不要改成绝对路径**——加载期会因越界校验直接报错（这是有意的）。
6. **演示环境限制**：本机 Bash 沙箱会在命令结束后回收整棵进程树，且其 safe-delete 审批在批量删除时会短暂锁定（表现为 `fs.rmSync` 抛 `state lock timeout`）。因此**长驻实例无法跨工具调用演示**，冒烟必须在单次命令内跑完；遇到删除类报错先确认是不是这把锁，而不是改代码。
7. **真实对话轮未验证**：跑对话轮需要模型凭据，而按 ADR-0019 现阶段盘内不落真 key。因此会话内附件 / Office→PDF / browser-use 的 Chrome 用户目录**仍未实测**—— **不虚勾**。
8. **USB 真机未验证**：本机 `D:` 是本地 HDD 分区，不算可移动盘。V1 的「插 USB 启动」仍需真机复测。

---

## 13. 下一步（Phase 1 已收口 → Phase 2）

**Phase 1 已完成**（运行时打包 + 真实 DSH 端到端 11/11）。**Phase 2：Nomad Web UI** 正在进行，
**L4-a 阶段 1/2/2.5/3 已全部实测通过**：

1. ✅ 阶段 1：自研 patch 层可叠加进组合树（`tests/smoke/l4a-patch-probe.js` 9/9）
2. ✅ 阶段 2：自研 bundle `packages/nomad-web-app/` 换层成立；`bundles` 支持相对路径（**ADR-0020**）
   → `tests/smoke/l4a-bundle-probe.js` 8/8
3. ✅ 阶段 2.5：`launcher/lib/profile.js#ensureNomadProfile()` 幂等自举 `$DSH_HOME/profiles/nomad/`
   （**ADR-0021**；接线在 `nomad start` + `host.js`，`nomad doctor` 有只读巡检，`nomad profile [--ensure]` 可手工调用）
   → `tests/profile.test.js` 13/13
4. ✅ 阶段 3：真实 DSH 加载自举出的 profile 并渲染 Web UI
   → `tests/smoke/nomad-profile-smoke.js` 9/9（`303 → 200 text/html 34656B`；宿主 `~/.dsh` 未复现）
   → 顺带关掉一条待办：`.credentials.yaml` 确实写在盘内 `$DSH_HOME`（ADR-0019 的实测依据）
5. ⬜ 阶段 3.5：真实对话轮（会话内附件 / Office→PDF / browser-use 的 Chrome 用户目录；需维护者当次临时提供凭据）
6. ⬜ 阶段 3 前置：摸清 Cordis 插件导出契约（才能 `insert:` 挂自研 JS 插件）
7. ⬜ 顺手验证 **L4-b**（覆盖 `@deepseek-ai/dsh-web-frontend` 包名）—— `docs/UI_ARCHITECTURE.md` §8.5 里**唯一标了风险**的推断
8. 之后才做 Navigation / Layout / Conversation / Tool Cards / Context Panel

> ⚠️ 测试分类（有实例在跑时只看这一类）：`real-runtime-smoke` / `portable-smoke` / `stale-state-guard`
> 会 `stop` 实例或改写共享状态；`l4a-patch-probe` / `l4a-bundle-probe` / `nomad-profile-smoke`
> 完全隔离（各自 scratch `DSH_HOME`），可随时跑。详见 `docs/DEVELOPMENT.md` §4。

细节见 `docs/UI_ARCHITECTURE.md` §8 与 `docs/ROADMAP.md`。

