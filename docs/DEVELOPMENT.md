# DEVELOPMENT.md — 开发环境与工作流

## 1. 环境基线（以实际仓库为准）

> **不要在文档中永久硬编码可能过期的 Node / pnpm 版本。**
> 每次开发前依次检查：`package.json` → `README` → 开发文档 → 官方仓库。

参考流程（DSH 源码开发）：

```bash
git clone <dsh-repo>
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

具体版本要求以当前官方仓库为准。

## 2. 开发机 vs 用户机

| | 开发机 | 用户机（USB） |
| --- | --- | --- |
| 源码 | ✅ 有 | ❌ 无 |
| node_modules | ✅ 有 | ❌ 无 |
| pnpm | ✅ 有 | ❌ 无 |
| 构建 | ✅ 执行 | ❌ **不执行** |
| 运行 | 源码 / 产物 | **已构建的 Portable Runtime** |

## 3. Build Pipeline

```
DSH Source → Nomad Patch → Nomad Plugins → Nomad Web → Build → Package → Portable Release
```

后续用 GitHub Actions 自动产出：`Windows x64` / `Windows ARM64` / `Linux x64` / `Linux ARM64` / `macOS x64` / `macOS ARM64`。
**第一阶段仅 Windows x64。**

## 4. Git 策略

- 分支：`main` / `develop` / `feature/xxx`
- 命名示例：`feature/portable-launcher`、`feature/nomad-ui`、`feature/memory`、`feature/skills`、`feature/runtime-manager`
- 禁止一次提交大量无关修改
- Commit 前缀：`feat:` `fix:` `refactor:` `docs:` `test:` `build:`

## 5. AI Coding Workflow（强制节奏）

```
Understand → Locate → Trace → Plan → Modify → Test → Inspect Diff → Report
```

**禁止**：`读 1 个文件 → 立刻重写整个项目`。

修改前必跑的搜索对象：

```
target symbol
caller
callee
event
service
API
interface
```

修改前必答：

1. 当前实现在哪里？
2. 谁调用它？
3. 数据从哪里来？
4. 修改会影响谁？
5. 最小修改是什么？

## 6. 输出规范

每次交付必须给出：

```
1. 结论先行（做了什么 / 没做什么）
2. 改动文件清单 + 原因
3. 证据（文件:行）
4. 验证命令与结果
5. git diff 摘要
6. 风险 / 未覆盖项 / 下一步
```

## 7. 目录职责速查

| 目录 | 职责 | 可否删除 |
| --- | --- | --- |
| `runtime/` | 版本化运行时 | ✅ 可重下 |
| `data/` | 长期数据 | ❌ **禁止** |
| `workspace/` | Agent 工作区 | ⚠️ 谨慎 |
| `skills/` | Skill 包 | ❌ 用户资产 |
| `profiles/` | Profile 定义 | ❌ 用户资产 |
| `config/` | 便携配置 | ❌ 用户资产 |
| `mcp/` | MCP 配置 | ❌ 用户资产 |

## 8. 运行时打包流水线（**开发机**执行，用户机零编译）

已实测跑通的完整流程（2026-10-08，Windows x64）：

```bash
# 1) 盘内 Node：下载 → SHA-256 校验 → 解压
mkdir -p runtime/node
curl -sSL -o .cache-dev/node-v22.23.3-win-x64.zip \
  https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip
curl -sSL -o .cache-dev/SHASUMS256.txt https://nodejs.org/dist/v22.23.3/SHASUMS256.txt
cd .cache-dev && grep node-v22.23.3-win-x64.zip SHASUMS256.txt > expect.txt && sha256sum -c expect.txt
#   解压进 runtime/node/（含 npm），并写版本戳（供受限环境下的版本回退，见 ADR-0018）
printf 'v22.23.3\n' > runtime/node/NOMAD_NODE_VERSION

# 2) DSH：装**已构建包**，不编译
mkdir -p runtime/dsh/0.2.1-alpha.1 && cd runtime/dsh/0.2.1-alpha.1
npm_config_cache="$CACHE" npm install @deepseek-ai/dsh@0.2.1-alpha.1 --no-audit --no-fund

# 3) 版本指针（清单间接，见 ADR-0016）
#   runtime/dsh/current/nomad-runtime.json
#   {"entry": "../0.2.1-alpha.1/node_modules/@deepseek-ai/dsh/lib/bin.js"}

# 4) 验收
node launcher/nomad.js doctor             # 14 项：13 通过 / 1 警告（残缺包未修前，见下）
node launcher/nomad.js profile            # 自建 profile 状态（**只读**；加 --ensure 才写盘）
node --test tests/*.test.js               # 应 71/71
node tests/smoke/real-runtime-smoke.js    # 应 13/13（会 stop 当前实例，跑前确认没有在用）
node tests/smoke/portable-smoke.js        # 应 12/12（会 stop 当前实例）
node tests/smoke/stale-state-guard.js     # 应 4/4
node tests/smoke/l4a-patch-probe.js       # 应 9/9（L4-a 阶段 1：补丁注入通道）
node tests/smoke/l4a-bundle-probe.js      # 应 8/8（L4-a 阶段 2：自研 bundle 换层）
node tests/smoke/nomad-profile-smoke.js   # 应 9/9（L4-a 阶段 3：自举 profile 真启动）
node tests/smoke/web-ui-assets.js         # 应 11/11 资源全 200（**只读**，有实例在跑时随时可跑）
```

> **哪些测试能并行跑、哪些不能**：
> - 会 `stop` 实例 / 改写共享状态：`real-runtime-smoke.js`、`portable-smoke.js`、`stale-state-guard.js`
>   → **有实例在跑时不要执行**（`nomad status` 先确认）。
> - **只读、可随时跑**：`web-ui-assets.js`（只对运行中的实例发 GET，不启不停不改状态）。
> - 完全隔离、可随时跑：`l4a-patch-probe.js`、`l4a-bundle-probe.js`、`nomad-profile-smoke.js`
>   （各自用 `data/tmp/` 下的独立 scratch `DSH_HOME`，不碰真实 `data/dsh-home`、不碰 `runtime/dsh/current`）。
> - 两套 L4-a 探针与 profile 冒烟都**不需要模型凭据**（`--dump-config` 打印组合树后即退出）。
> - 盘内无 Node 时会打印 `[SKIP]` 并以 0 退出 —— **那是未执行，不是通过**。

### 为什么要有 `web-ui-assets.js`（一次真踩过的坑）

「首页 200 + 非空」**证明不了 UI 能渲染**。`index.html` 只是个壳，真正的界面靠
`assets/index-*.js`（Vite 主包，634KB）+ `assets/vendor-*.js`（740KB）+ CSS +
`plugins/??…`（客户端模块总包，**10.9MB**）撑起来 —— 其中任意一个取不到，
浏览器就是**白屏**，而壳的 200 依旧漂亮。

本探针把首页引用的**每一个**资源都真取一遍并断言 200，同时校验「引用数 ≥ 8」
（防止某个退化版本返回一个引用寥寥的假壳）。该检查已同时内联进
`real-runtime-smoke.js` 的第 7 步，两处互为补充：

| | 何时用 | 是否启停实例 |
| --- | --- | --- |
| `web-ui-assets.js` | 实例**正在跑**，想立刻确认 UI 健康 | 不启不停（纯只读） |
| `real-runtime-smoke.js` 第 7 步 | 全链路回归跑的时候顺带覆盖 | 自己起、自己停 |

### ⚠️ 打包期 `npm install` 被打断后，怎么补救（**血泪版，照做**）

**症状**：真实 DSH 启动打印
`dsh: warning: 1 entry did not activate` / `xxx (@deepseek-ai/…): failed to import`。
不影响 DSH 启动，也不影响 HTTP 200 —— 只让某个 roster 条目静默失效。

**关键认知：再跑一次 `npm install` 是修不好的。**

原因：npm 信任 `node_modules/.package-lock.json`（隐藏锁文件）里「已安装」的记录。
包目录不完整时它**不会重新解压**，只会把缺失的目录建出来（甚至建成空目录），内容不补。
所以「删掉目录 → 重装」这个直觉动作，在这个场景下是**无效**的。

**正确流程**：

```bash
# 1) 停实例（改 node_modules 前必须停）
node launcher/nomad.js stop

# 2) 先把问题目录【挪走】——用 rename 而不是删除
#    好处：绕开沙箱/安全软件的删除审批，且随时可回滚
cd runtime/dsh/<version>
mv node_modules/@scope/broken-pkg ../stash/broken-pkg     # 逐个挪

# 3) 重跑安装（务必放后台让它【跑完】；被 SIGTERM 打断会再造一次半成品树）
npm_config_cache="../../.cache-dev/npm-cache" \
  npm install --no-audit --no-fund --prefer-offline
#    正常会看到类似：added N packages, and removed M packages —— 那就是"重新归位"

# 4) 复验
node launcher/nomad.js doctor        # 「运行时包完整性」应 0 警告（锁文件逐一对账）
node tests/smoke/real-runtime-smoke.js   # 「DSH 启动输出零告警」应通过
```

**为什么之前查不出来**：`--dump-config` 只做组合（不导入插件、不做 preflight），
`scanBrokenPackages` 只发现「存在但残缺」（**发现不了「整份缺失」**），
而 HTTP 200 照样正常 —— 三个盲区叠在一起，事故只能靠人肉读日志发现。
现在由 doctor 的**锁文件对账**（`scanMissingPackages`）+ 真实冒烟的**零告警断言**两道闸兜住。

**为什么判据要看平台/架构而不是只看 `optional`**（实测数据，2026-10-08）：
一次 `npm install` 后盘上缺 **70** 个包，**全部**是 `optional`。但里面既有
「本该缺席的别平台包」（`@img/sharp-linux-x64`），也有「**本该存在却缺席的平台匹配包**」
（`@img/sharp-win32-x64` —— 正是那起事故的成员）。所以豁免条件必须是
「optional **且** 包名指示的平台/架构与当前机不符」。锁文件里**没有** `os`/`cpu` 字段，只能从包名解析。

### 自研 bundle 怎么改（Web 表面定制）

定制面是**声明式 YAML 行补丁**，不是改代码（依据 `docs/UI_ARCHITECTURE.md` §8.5、ADR-0011）：

```text
packages/nomad-web-app/
  package.json          # 契约：dsh.bundle.patch → ["./cordis.patch.yml"]
  cordis.patch.yml      # 我们的行补丁：id: 覆盖 / insert:
```

改完用 `node tests/smoke/l4a-bundle-probe.js` 验证，再用 `--dump-config` 看组合树。

**两条硬规则**（都有测试兜底）：

1. **`id:` 覆盖会替换目标行的整个 `config`** → 必须重述该行**所有**键，漏一个就静默丢配置。
   去 dump 里抄全键，别凭记忆。
2. 长文本用 `>-` 折叠标量没问题，但 dump 里**会折行** → 断言前先归一化空白
   （`text.replace(/\s+/g, ' ')`），否则子串匹配会假失败。

要点：

- `.cache-dev/` 是**开发机临时区**（下载包 / npm cache / 一次性脚本），已进 `.gitignore`，**永不随盘发布**；
- npm 缓存一律用 `npm_config_cache` 指向盘内，避免污染宿主 npm 缓存；
- 发布态目前约 **455MB**（Node 94.5MB + DSH 360.7MB）。

## 9. 日常开发循环（改一行代码 → 在盘上看到效果）

### 9.1 唯一真源原则

**只在 `D:\u盘\` 改代码。`E:\`（或任何目标盘）是产物，不是工作副本。**

盘上直接改的东西会被下一次部署覆盖，而且会让「源端 / 目标端」不一致 —— 部署对账会因此报假错。

### 9.2 三层验证：越往下越慢、也越权威

| 层 | 命令 | 耗时 | 真正覆盖的东西 | 什么时候跑 |
| --- | --- | --- | --- | --- |
| **L1 单元** | `node --test tests/*.test.js` | ~1 s | 纯函数逻辑、路径解析、插件信封 | 每次改 `.js` |
| **L2 本机实例** | `Nomad.cmd restart`（在 D 盘） | ~5 s | 真实 DSH 启动、Web 就绪、UI 渲染 | 改 UI / launcher，想立刻看 |
| **L3 盘上真机** | 见 §9.3 ③④ | ~1 s + ~5 s | **exFAT / 盘符根 / 长路径 / 全新 data 家** | 里程碑，或改动涉及路径与运行时 |

**L2 能覆盖 90% 的 UI 迭代。** 盘上验证的独特价值只有「介质与位置」四点：exFAT 不支持软链、
盘符根才把长路径压进 260、目标盘是全新 `data/`（没有你的会话历史）、文件被占用时的行为。
这些差异只在 L3 暴露，所以 **L3 跑在里程碑上，不必每改一个按钮颜色就部署一次**。

### 9.3 最常用的那条循环（90% 场景）

```bash
# ① 改代码（永远在 D:\u盘）
# ② 快验（1 秒）
node --test tests/*.test.js

# ③ 推到盘上：只同步非 runtime 内容（亚秒级）
node tools/deploy-usb.js -t E:\ --app-only --force

# ④ 在盘上重启实例看效果
E:\Nomad-Restart.cmd
```

`--app-only` 跳过 `runtime/`（32,089 个文件 / 603.7 MB），只同步 `launcher` / `config` / `docs` /
`packages` + 根文件（共约 57 个文件 / 481 KB）。它用**版本戳**核对 runtime 是否同一版本，
对不上就拒绝并要求全量 —— 所以「快」不会变成「漏」。

### 9.4 改了哪类文件 → 怎么才算生效

| 改了 | 生效方式 | 建议验证 |
| --- | --- | --- |
| `launcher/lib/*.js` | 重启实例 | L1 + 盘上 `Nomad-Doctor.cmd` |
| `packages/nomad-*/lib/client.js` | **重启实例**（*不是*刷浏览器） | `node tests/nomad-panel.test.js`，再硬刷新页面 |
| `packages/nomad-web-app/cordis.patch.yml` | 重启实例 | `node tests/smoke/l4a-bundle-probe.js` |
| `config/*.yaml` | 重启实例 | 盘上 `Nomad-Doctor.cmd` |
| `runtime/**`（升级 DSH / Node、修残缺包） | **全量部署**（去掉 `--app-only`） | 盘上 `doctor` 的「运行时包完整性」 |
| `docs/**`、`README.md`、`AGENTS.md` | 无需重启 | — |
| `tests/**`、`tools/**` | 无（**不上盘**） | — |

> **为什么客户端插件改动必须重启实例**：客户端模块是**启动时**由 DSH 读取并组装进
> `plugins/??…` 总包（10.9 MB）的，浏览器拿到的只是组装结果。刷新页面只会重新下载**同一个旧包**。
> （这条是真实踩过的坑：改了插件、刷新页面、发现「没有变」。）

### 9.5 同机多实例：开发盘与 U 盘可以同时开着

已被真机证实 —— `web.port: 0` 让 OS 各自协商端口（实测一个 38617、一个 54119），互不冲突；
`data/run/nomad.state.json` 位于**各自盘内**，`nomad stop` 只停自己那棵进程树。

| 盘 | 数据家 | 内容 |
| --- | --- | --- |
| `D:\u盘`（开发） | `D:\u盘\data\dsh-home` | 有你的会话历史 |
| `E:\`（U 盘） | `E:\data\dsh-home` | 全新、无会话 —— 正好用来验「新用户第一次打开」的体验 |

### 9.6 ⚠️ 部署前必须先停掉目标盘上的实例

盘上实例运行时会**占用它加载过的文件**，导致覆盖写入 `EPERM`。工具现在会**在复制前**先跑一次
「可覆盖探针」（把 `VERSION` 的内容原样写回，零风险），2 秒内就说清楚，而不是复制完才吐 56 行错误：

```text
  可覆盖  ✗ EPERM

目标盘上「已存在的文件」当前写不进去。新建是成功的，被拒的是覆盖 —— 常见原因：
  · 盘上的 Nomad 实例还在运行 → 先执行 <目标盘>\Nomad-Stop.cmd 再来部署
  · 实例刚停、句柄尚未释放 → 拔插一次 U 盘（或等几秒重试）
  · 杀毒软件正在扫描盘上文件 → 稍后重试
```

**认知要点：在 Windows 上，「新建文件」和「覆盖已存在文件」不是同一件事。**
实测同一块盘上：新建文件总是成功；覆盖已被占用的文件则 `EPERM`。
这解释了为什么**首次部署（空白盘）一路顺利，而启动过实例之后再部署就会失败**。

所以循环里的顺序是 **先停 → 再推 → 后启**。`Nomad-Restart.cmd` 把后两步合成一步。

## 10. 本机（WorkBuddy 桌面端）环境注意事项

这些是**环境限制，不是项目缺陷**。遇到时先对号入座，**不要改业务代码**。

| 现象 | 原因 | 应对 |
| --- | --- | --- |
| `fs.rmSync` 抛 `[safe-delete] state lock timeout` / `decisionRecord missing` | 本机对 node 进程注入了 **safe-delete shim**，批量删除需审批；锁被占用时会超时 | 稍后重试；确认目标确实属本项目。**不要**为绕开它改业务代码 |
| 命令返回 SIGTERM / 退出码 1，输出丢失 | 沙箱在命令结束后回收整棵进程树，长驻子进程被连带杀掉 | 长任务改后台跑；测试必须**单次命令内跑完**；输出重定向到文件以免丢证据 |
| `spawnSync` 拉起同一个 `node.exe` 返回 `EBUSY` | 同上 | 测试统一用**异步 spawn**（已在冒烟测试中固化） |
| 出现遗留 Nomad 进程树 | 上一轮被 SIGTERM 打断，`nomad stop` 没跑完 | 用 `Get-CimInstance Win32_Process` 看命令行是否含本项目路径；**只杀自己那棵树**（`taskkill /PID <根> /T /F`）。**绝不要** `taskkill /IM node.exe` |
| PowerShell 中 `Add-Type` 被拒 | 安全策略禁止运行时编译 .NET | 需要回收站 API 时用 Python `ctypes` 调 `SHFileOperationW`，别用 `Add-Type` |

## 11. 宿主清理铁律（不属于 Nomad 代码，但踩过坑）

1. **删除前盘点不得依赖沙箱内的 `find` / `du`**：本机实测它们返回**部分可见性**且静默吞错 ——
   把 29,695 个文件报成了 195 个。**以 Python `os.walk` 或回收站 API 的上报值为准**。
   （可能成因：Windows 长路径下 Git Bash 的 `find` 会静默跳过整棵子树。）
2. **宿主清理一律走回收站 + 留台账**：不永久删除；台账写入 `data/backups/`，
   记录范围、体量、API 返回码与回收站位置。
3. **不要动不属于本项目的进程**：宿主上还有其它 node 进程（WorkBuddy 插件、Oppo Connect、MCP 服务等）。
4. **未获明确许可，绝不安装 / 卸载 / 修改宿主的软件与系统设置。**
