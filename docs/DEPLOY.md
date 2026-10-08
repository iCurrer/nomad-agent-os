# DEPLOY.md — 把 Nomad 部署到可移动盘

> 目标体验：**插盘 → 双击 → 浏览器打开 Nomad**。没有安装步骤，没有编译，不联网。
> 依据：**ADR-0027**（白名单驱动 + Node 原生复制）、ADR-0016（`current` 用清单指针而非软链）、
> ADR-0019（盘内不落真 key）。

## 0. 一条命令

```bash
# 预检：只读，打印计划，不写盘
node tools/deploy-usb.js --target E:\ --dry-run

# 首次部署（或升级 DSH / Node 版本后）：全量
node tools/deploy-usb.js --target E:\

# 日常开发循环：只推 app 层（亚秒级）
node tools/deploy-usb.js --target E:\ --app-only --force
```

### `--app-only`：日常开发用的快车道

跳过 `runtime/`（32,089 文件 / 603.7 MB），只同步 `launcher` / `config` / `docs` / `packages`
与根文件 —— 约 **57 个文件 / 481 KB**，实测 **1.3 s**（其中复制本身 0.3 s，其余是启动与预检）。

**它不会静默漏同步**：会用 `runtime/dsh/current/nomad-runtime.json` 与
`runtime/node/NOMAD_NODE_VERSION` 两个版本戳核对目标盘，对不上就拒绝并要求全量。
所以判据很简单：**只要没动 `runtime/`，就用 `--app-only`。**

盘上自带 Node，所以也可以**从一块 Nomad 盘部署到另一块盘**：

```cmd
E:\runtime\node\node.exe E:\tools\deploy-usb.js --target F:\
```

> 注意：`tools/` 默认**不随盘**（见 §3）。要让盘具备「再分发」能力，把 `'tools'`
> 从 `tools/deploy-usb.js` 的 `EXCLUDE` 挪到 `DEPLOY_DIRS` 即可。

## 1. 为什么不是「拖过去」

一块盘上的 Nomad 是 **32,144 个文件 / 604.1 MB**，其中 `runtime/` 独占 32,089 个文件。
手工拖拽有三个问题：慢、不可靠、**无法对账**（你不知道少拷了没有）。而且开发机上有
约 471 MB 的内容**不该上盘**。本工具把这四件事变成可执行检查与清单。

## 2. 目标盘选择（一条硬约束）

**用盘符根（`E:\`），不要套子目录（`E:\Nomad\`）。**

树里有 1 条 **264 字符**的路径：

```
runtime/dsh/0.2.1-alpha.1/node_modules/@deepseek-ai/dsh-experimental-inspector-profile/
  node_modules/@deepseek-ai/dsh-experimental-inspector/lib/devtools/models/
  issues_manager/descriptions/selectElementAccessibilityInteractiveContentAttributesSelectDescendant.md
```

- `E:\` 前缀 3 字符 → 全长 **264**（已是最短，无法再压）
- `E:\Nomad\` 前缀 9 字符 → 全长 **270**

**Node 运行时不受 260 限制**：libuv 在 Windows 上会自动给绝对路径加 `\\?\` 前缀
（ADR-0027 实测：在 exFAT 上写入并回读 264 字符路径**成功**）。但资源管理器、`copy`
命令等非 Node 工具有可能读不到那个文件。所以：**盘符根 = 把余量留到最大**。

## 3. 带什么 / 不带什么

工具是**白名单驱动**的 —— 不在此列者**默认不上盘**。源根若出现未分类条目，工具会当场告警
（不会静默带上），需要你显式归类。

### 随盘（`DEPLOY_DIRS` + `DEPLOY_FILES`）

| 条目 | 体积 | 作用 |
| --- | --- | --- |
| `runtime/` | 603.7 MB / 32,089 文件 | Node 22.23.3 + DSH 0.2.1-alpha.1（已构建，零编译） |
| `launcher/` | 165.7 KB | 启动器（零依赖 Node CLI + 运行期监督进程） |
| `docs/` | 203.9 KB | 架构 / 隔离 / 上游 / 决策 / 部署文档 |
| `config/` | 10.8 KB | `nomad.yaml` 等四份配置（全部相对 `NOMAD_ROOT`） |
| `packages/` | 45.3 KB | `nomad-web-app`（自研 bundle）+ `nomad-brand` + `nomad-panel` |
| 根文件 9 个 | 33.8 KB | `Nomad.cmd` / `nomad` / `VERSION` / `README.md` / `AGENTS.md` 等 |

### 不上盘

| 条目 | 体积 | 为什么 |
| --- | --- | --- |
| `vendor/` | 152.6 MB | 上游 DSH 源码，**仅开发机阅读**；`.gitignore` 亦排除 |
| `.cache-dev/` | 318.3 MB | 下载缓存与一次性脚本（node zip、npm cache） |
| `.workbuddy/` | — | 工作区记忆与当日日志：含内部推理与宿主路径 |
| `data/` | — | **含明文凭据**（ADR-0019）→ 目标盘全新初始化 |
| `workspace/` `skills/` `profiles/` `mcp/` | — | 运行态与用户数据；目标盘重建为**空骨架** |
| `tests/` `tools/` | — | 决策为「运行最小集」：盘上不需要自检与部署能力 |

### 目标盘上会新建的空骨架（9 个）

```
data/dsh-home/   data/tmp/   data/logs/   data/run/   data/backups/
workspace/   skills/   profiles/   mcp/
```

这些正是 `nomad doctor` 的「目录基线」检查对象。首次 `nomad start` 会往里填充。

## 4. 工具做的六件事

| 步 | 做什么 | 判据 |
| --- | --- | --- |
| 1 | 定位源根与目标，写可写探针 | 显式给出的路径不成立即**报错不回退**（AGENTS.md 铁律 2） |
| 2 | 展开白名单、统计规模 | 逐条目列出文件数 / 体积 |
| 3 | 四项可移植性风险 | **软链**（致命：exFAT 不支持）/ **长路径**（警告 + 定量提示）/ **大小写冲突**（致命：会互相覆盖）/ **非法文件名**（致命） |
| 4 | 目标盘空间 | 部署集占可用空间比例；>80% 时提示簇对齐浪费 |
| 5 | 复制 | 先并发建目录，再 `--concurrency` 并发复制 |
| 6 | 对账 | 目标端**文件数与总字节**必须与源端完全一致，否则非零退出 |

### 三项设计取舍（来自 ADR-0027）

- **不用 robocopy**：本环境 `spawnSync('robocopy', …)` 恒返回 `EBUSY`；改用 Node 原生复制后
  反而更稳 —— libuv 自带长路径支持，且跨平台同一套逻辑。
- **断点续传**：目标已存在且**大小一致**的文件直接跳过。所以中断后**原样重跑**即可，
  不需要 `--force`（`--force` 只用于目标盘已是一块 Nomad 盘的场景）。
- **不保留 mtime**：零构建场景没有 mtime 消费者，而每文件多一次 `utimes` 会明显拖慢 USB 写入。

## 5. 已知残缺（明确记录，不含糊）

1. **1 个文件是 264 字符路径**（见 §2）。Node 读写正常；资源管理器可能不可见。
   这是上游 `dsh-experimental-inspector` 的内嵌副本带来的，**不是我们造的**。
2. **不复制 ACL / 时间戳**：目标盘是 exFAT，本就不支持 NTFS ACL。
3. **盘符会变**（`E:` → `F:` → `G:`）：这是**有意的设计**，不影响使用 ——
   `Nomad.cmd` 用 `%~dp0`（脚本自身目录）推导 `NOMAD_ROOT`，
   `runtime/dsh/current` 是**清单文件**而非软链，全部路径都与盘符无关。

## 6. 部署后验证

在目标盘上双击（或命令行）：

```cmd
E:\Nomad-Doctor.cmd     :: 体检：路径 / 运行时 / 隔离 / 端口 / 宿主污染探针
E:\Nomad.cmd            :: 启动 → 就绪后自动打开浏览器
E:\Nomad-Stop.cmd       :: 停止
```

`doctor` 应报「目录基线：全部 11 个存在且可写」「Node 运行时：bundled:…（v22.23.3）」。

## 7. 拔盘纪律

- **先安全弹出，再拔。** exFAT 有写入缓存，直接拔可能丢最近写入。
- 停止实例（`Nomad-Stop.cmd`）后再弹出，避免 DSH 正在写 session 时断电。
- 热拔属未定义行为（`PORTABILITY.md` §6 已明示风险）。

## 8. 常见问题

| 现象 | 原因 | 做法 |
| --- | --- | --- |
| `可覆盖 ✗ EPERM` | 目标盘上的实例还在运行（文件被句柄占用），或句柄未释放 | 先 `<目标盘>\Nomad-Stop.cmd`；仍失败则**拔插一次 U 盘**再重跑 |
| `✗ 目标盘看起来已经是一块 Nomad 盘` | 目标根已存在 `VERSION` / `AGENTS.md` | 确认是你要续写的盘，再加 `--force` |
| `✗ --app-only 不可用：runtime 不一致` | 源端升级过 DSH / Node，目标盘还是旧版本 | 去掉 `--app-only` 做一次全量 |
| `✗ 最长路径 … ≥ 260` | 目标层级太深 | 改用盘符根 `E:\` |
| `✗ 符号链接 N 个` | 树里有链接（不该出现） | 不要用 pnpm 装的依赖树；上报 |
| 浏览器显示 `dsh web authentication required` | 裸地址缺 `?token=` | 用 `Nomad.cmd` 重开，或 `nomad open` |
| 复制中断 | 拔盘 / 断电 / 目标盘满 | **原样重跑**，会自动续传 |

### 关于 `EPERM`：新建 ≠ 覆盖（实测踩坑，2026-10-08）

同一块 exFAT 盘上的实测结论：

| 操作 | 结果 |
| --- | --- |
| 新建文件 | **总是成功** |
| 覆盖「盘上实例加载过」的已存在文件 | **EPERM**（rename 也失败 ⇒ 句柄占用） |

这解释了为什么**首次部署（空白盘）顺畅，启动过实例之后再部署就大面积失败** ——
首次全是「新建」，之后全是「覆盖」。排查时已排除：只读属性（`readonly=False`）、
卷写保护（`attrib` 报「为读写」）、路径级保护（我自建的文件可覆盖）、Node 专属 shim
（Python / bash / Node 三个通道表现一致）。

工具现在用「可覆盖探针」把这件事提前到**复制之前**报出来（见 §0），避免白跑 10 分钟才失败。

## 9. 实测记录（2026-10-08 · 首次可移动盘真机部署）

| 项 | 值 |
| --- | --- |
| 源 | `D:\u盘`（本地 HDD 分区，**不是**可移动盘） |
| 目标 | `E:\`（**exFAT**，30 GB U 盘，可用 29,993 MB） |
| 部署集 | **32,145 文件 / 604.2 MB**（其中 `runtime/` 占 32,089 个） |
| 目录 | 3,941 个 |
| 耗时 | **644.4 s ≈ 10.7 分钟 · 0.9 MB/s**（并发 12） |
| 预检 | 符号链接 0 / 大小写冲突 0 / 非法文件名 0 |
| 长路径 | 1 条 264 字符 —— **Node 在目标盘成功读取**（272 字节，实测） |
| 终态对账 | 文件数与总字节**完全一致** |
| 骨架 | 9 个空目录已建 |

本次是 V1 验收项「USB 启动（需**可移动盘真机**验证）」在**部署侧**的闭环。

### 启动侧闭环（在同一块 `E:\` 盘上）

```
$ cd E: && E:\runtime\node\node.exe launcher\nomad.js start
DSH profile「nomad」已创建（自研层 ../../../../packages/nomad-web-app）
Nomad 已就绪。
  地址   http://127.0.0.1:44640/
  端口   44640（由 OS 协商，非写死）
  浏览器 已交由系统浏览器打开（cmd-start）
  认证   通过（303 铸 cookie → 200）
  进程   监管 pid=58800  DSH pid=36556
```

盘上 `nomad doctor` 结果：**14 项 OK / 1 项 WARN**。
那 1 项 WARN 是「Nomad profile 尚未初始化：start 会按内置模板创建并追加自研层」——
属**全新盘首次启动前的预期状态**，`start` 已按预期自动消除它。

> ⚠️ **自动化环境里进程活不过命令结束**：本机 Bash 沙箱会在命令返回后回收整棵进程树
> （`PHASE1_LAUNCHER.md` §12.6 已记）。所以"已就绪"能实测到、"常驻"实测不到。
> 想让实例常驻请在**真实桌面**双击 `E:\Nomad.cmd`（照 §6）。
> 状态文件残留已由 `nomad stop` 清理；下次 `start` 也会先清理陈旧状态（另有 PID 安全闸兜底）。

### 本次真机部署顺带修掉的一个 bug

`doctor` 在盘符根部署下**假报** `[FAIL] 宿主隔离`（声称 `E:\data\dsh-home` 不在 `E:\` 之内）。
根因是判越界时用 `` `${root}\\` `` 做前缀比较，而盘符根的 `root` 自带尾分隔符 → 拼出双反斜杠。
开发机的 `NOMAD_ROOT` 是子目录（`D:\u盘`），所以这个 bug 一直潜伏。详见 **ADR-0028**。

### 一条踩坑记录（写下来免得下次再踩）

首次部署报「对账不一致：文件差 0，体积差 1.7 KB」——**原因不是磁盘，是部署期间有人改了源树**。
部署花了 10.7 分钟，而"预检数字"是启动那一刻的快照；期间源端的 `README.md` / `AGENTS.md` 被编辑、
`docs/DEPLOY.md` 被新建，于是快照与终态自然对不上。

两条修法都已进代码：
1. **对账改为「重新扫描当前源端」**，不再沿用预检数字；不一致时明确提示「源树在部署期间变化过」。
2. **非 `runtime/` 的文件每次强制覆盖**（文档 / 配置 / 启动器 / 自研包合计仅 46 个文件），
   避免"大小恰好相同但内容已变"被 size 判据漏掉；`runtime/` 仍用 size 判据以保证续传速度。

> **纪律**：部署期间**不要修改源树**。若不得不改，跑完重跑一次即可对齐（续传会只补差异）。

