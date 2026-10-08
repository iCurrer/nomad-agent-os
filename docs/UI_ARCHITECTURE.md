# UI_ARCHITECTURE.md — Nomad Web UI 架构

> 目标：**深度改造 DSH Web Client，逐步长成 Nomad 自己的 Web Application。**
> 不是给 DSH 套一层 CSS。

## 1. 总原则

> **Logic 尽量继承 DSH，UI 可以高度定制。**

- 保留 DSH 的 Agent / Session / Event / Tool 逻辑
- 改造：Layout、Navigation、Conversation、Context Panel、Tool Cards、Settings、Project UI、Session UI、Theme、Workspace

## 2. 数据方向（不得违反）

```
Host / DSH State → Remote / API → Client Model → UI Adapter
   → Conversation / Presentation → Slots → React UI
```

**禁止**：在 React 组件里复制一套 Agent State；禁止双 Session 事实源。

## 3. 布局

```
+-------------------------------------------------------------+
| NOMAD                                                       |
+----------------+--------------------------------------------+
| Home           |                                            |
| Projects       |        Conversation / Workbench            |
| Agents         |                                            |
| Skills         |                                            |
| Memory         |                                            |
|                |                                            |
| Settings       |                                            |
+----------------+--------------------------------------------+
|                | Context / Inspector                        |
+----------------+--------------------------------------------+
```

桌面布局分区：

- **Left**：Navigation
- **Center**：Conversation / Workspace / Code / Agent Output
- **Right**：Context / Project / Git / Files / Skills / Runtime / Session

## 4. Conversation 目标

不是「复制 ChatGPT」，而是：

```
Chat  +  Coding Workspace  +  Agent Execution
```

每个 Agent 操作都应可**结构化展示**。

## 5. Tool Cards（结构化，不许整坨纯文本）

类型：`Shell` `Git` `File Edit` `File Read` `Build` `Test` `MCP` `Browser` `Search` `Agent` `Error`

示例：

```
┌──────────────────────────────┐
│ SHELL                        │
│ npm run build                │
│                              │
│ ✓ completed                  │
│ 12.4s                        │
└──────────────────────────────┘

┌──────────────────────────────┐
│ GIT DIFF                     │
│ + 34                         │
│ - 8                          │
│ 3 files changed              │
│                              │
│ [View Diff]                  │
└──────────────────────────────┘
```

## 6. Theme 与 Design Tokens

支持：`Dark`（默认）/ `Light` / `System`。

颜色**不得全部硬编码**，建立 tokens：

```
--background
--surface
--surface-hover
--border
--text-primary
--text-secondary
--accent
--danger
--success
--warning
```

> 这样以后才能快速换主题 / 换品牌。

## 7. 产品风格

关键词：High-end、Minimal、Dark、Professional、Productivity、Apple-like、Linear-like、Cursor-like、Notion-like、Modern native desktop feeling。

**禁止**：廉价紫色 AI UI、大量渐变、Cyberpunk、过度玻璃拟态、巨型发光、大面积粒子、花哨动画、AI 玩具感。

判定标准：

- ✅「像一个真正的专业 Agent 工作站」
- ❌「像一个 AI Demo」

## 8. 深度定制通道（**源码级已验证：五级梯度，前四级都不用 fork**）

> 证据等级：**源码级**（Phase 0 已复核，commit `5badb15` / `0.2.1-alpha.1`）。
> 结论先说：**深度定制 UI 不需要 fork monorepo，也不需要用户机编译。**
> 官方文档里对 presentation 层的原话是 *"consumables, expected to be rewritten wholesale"*（消费物，预期被整体重写）。

### 8.0 五级定制梯度（代价升序）——**这就是「能定制到什么程度」的答案**

| 级 | 手段 | 改什么 | 用户机要构建? | fork? | 适用 |
| --- | --- | --- | --- | --- | --- |
| **L1** | **Theme Token** | `ctx.theme` 别名令牌覆盖 + `--dsw-*` CSS | ❌ | ❌ | 换色、换字体、换深浅。**零代码** |
| **L2** | **Slot 注册（增量）** | 自研 client plugin 包，`ctx.slots.register()` 到已声明槽位（list/keyed 空位） | ✅ 一次 | ❌ | 加面板、加 Tool Card、加品牌标记 |
| **L3** | **Slot 替换（接管）** | 同上，但抢占 `single` 或已占用的 `keyed` 槽位 | ✅ 一次 | ❌ | 换掉整个 sidebar / toolview / composer 局部 |
| **L4** | **Bundle 整体替换** | 自研 `nomad-web-app` bundle，profile 的 `bundles` 里替掉 `dsh-web-app` | ✅ 一次 | ❌ | 换布局骨架、换 AppFrame 拓扑 |
| **L5** | **Fork 单包 / monorepo** | 改 DSH 自身源码 | ✅ | ⚠️ | 兜底。**必须登记 `UPSTREAM.md`** |

> **关键收益**：L1–L4 全部满足「深度定制 + 用户机零编译」。构建只在**开发机/CI 发生一次**，U 盘里躺的是**已构建产物**。
> L4 的形态：Nomad 自带一个 `nomad-web-app` bundle 包（预构建），profile 声明 `bundles: [dsh-base, nomad-web-app]`，
> roster 行由我们自己的 patch 重述 —— **不动 DSH 一行源码，却拿到整块 UI 的定义权。**

### 8.1 已验证的机制（源码级）

- **`@deepseek-ai/dsh-web-app` 是内置 bundle 之一** → **Web UI 本身就是可替换的插件**，与 `dsh-base` / `dsh-headless` / `dsh-sdk-app` / `dsh-acp-app` 同级。
- **profile 是「插件 bundle 补丁层的有序堆栈」**，组合顺序：

```
空根
 ↓ 各 bundle 的 patch（按 dsh.profile.bundles 顺序）
 ↓ profile 的 cordis.patch.yml       ← 用户自己的补丁层
 ↓ $DSH_HOME/cordis.patch.yml        ← home 级补丁
 ↓ --patch overlays                  ← 命令行叠加
```

- profile 目录 = `package.json`（含 `dsh.profile` 清单与有序 `bundles`）+ `cordis.patch.yml`
- `dsh-hmr` 可 watch profile manifest 与 patch 文件，**热重载重组**（开发 UI 时大幅提速）
- **`dsh plugin --profile <name> <pnpm args>`** 安装 out-of-tree 插件到 profile 的 `node_modules`
  ⚠️ 限制：**npm 安装的 CLI 拒绝插件管理请求**，仅 Desktop 安装版可用 → 影响流派选择（见 `PORTABILITY.md` §8.3）

**Phase 0 新增源码级事实**（均已带 `文件:行` 证据）：

| 事实 | 源码位置 | 对 Nomad 的意义 |
| --- | --- | --- |
| patch 按 **id 覆盖整行**，`insert:` 新增行 | `packages/bundle/web-app/cordis.patch.yml`（文件头注释明写：*"A patch replaces the targeted row's whole `config`"*） | 我们能新增/替换任意 roster 行 |
| profile 清单类型 `DshProfileManifest { bundles?: string[] }` | `packages/util/package-manifest/src/types.ts:75` | **自研 bundle 可进 `bundles` 列表** → L4 成立 |
| 客户端插件声明 `DshClientManifest` | 同上 `:81`（`platform` / `inject` / `immediately` / `external`） | 插件包契约只有 4 个字段，极易实现 |
| 宿主按 **Loader 条目扫描** `dsh.client`，**增量**（无全量重扫路径） | `packages/client/modules/src/index.ts:1-20`（模块头注释） | 装/卸插件是运行时可逆操作 |
| bundle 走 `/plugins/<id>/<file>`，**请求时 `readFileSync` 从包目录现场读**，带 `rev` 版本号缓存 | 同上 `:225 / :1088 / :1109` | **UI 插件可"后装"，无需重新打包 dist** |
| 客户端**主题持久化**在 `$DSH_HOME/cordis.patch.yml`；第三方主题经 `ctx.theme` 注册别名令牌 | `packages/client/ui-theme/README.md` | L1 是官方第一等公民，且**落盘在 U 盘** |
| 品牌包官方明示：**"deployments with another identity should provide a replacement brand package"** | `packages/client/ui-brand-official/README.md` | **官方邀请你换品牌包** —— Nomad 品牌包是合规动作 |
| 布局三列 `AppFrame` + `ctx.layout` + 主题呈现器 | `packages/client/ui-layout/README.md` | L4 的骨架替换对象已定位 |
| 插件/bundle 管理器服务 `ctx.pluginManager`（*Current-profile plugin and bundle management*） | `docs/capability-seams.md` | 运行时管理插件是既有能力，不必自研 |

### 8.2 三条定制路线（按代价升序）

| # | 路线 | 碰 DSH 源码 | 是否需要重新构建 DSH | 适用 |
| --- | --- | --- | --- | --- |
| 1 | **配置层 patch**：`cordis.patch.yml` 覆盖 / 替换 UI 插件行为 | ❌ | ❌ | 首选。调布局、换主题、增删面板 |
| 2 | **替换 web-app bundle**：自研 `nomad-web-app` 接管 UI，装进 profile `node_modules` | ❌ | ❌（只构建自研包） | **深度定制的正解** |
| 3 | **fork 单包**：只 fork `dsh-web-app` 这一个包 | ⚠️ 只 fork 一个 app 包 | 仅构建该包 | 路线 2 的扩展点不足时 |

> **关键收益**：路线 1 / 2 都不需要「下载整个 monorepo → `pnpm install` → `pnpm run build`」。用户机与开发机都不必编译 DSH 本体。

### 8.3 验证工具（不启动即可查看组合结果）

```bash
dsh --dump-default-config      # 默认组合树
dsh --dump-config              # 实际组合树
dsh --dump-config-schema       # 各插件声明 schema（JSON Schema）
```

> 另有**运行时**自查：`cordis_inspect what:"client"` 可查询**实时槽位树与单个槽位的精确契约**
> （基数 `cardinality` / 作用域 / owner props / 当前占用者 / 声明者 / **替换风险**）。
> 源码目录 `packages/catalog/client-catalog` 由 `pnpm run gen-client-catalog` 从 `SlotMap` 声明与 `slots.register()` 调用点生成。

### 8.4 Phase 0 已定案（原「待回答问题」）

| 问题 | 定案 | 证据 |
| --- | --- | --- |
| `dsh-web-app` 可替换粒度？ | **既可整块替换（L4），也可只挂槽位（L2/L3）** —— 三档都成立 | `bundles` 列表 + `DshProfileManifest` + slot registry |
| Conversation 能否插自定义 Tool Card？ | **能**，走 `tool.call.toolview` 槽位；`tool.call.images` 是其子槽 | `docs/subsystems/slots.md` 层级树 |
| 前端产物是否可静态托管？ | **可**：`web-runtime` 行解析**构建期 dist** 并由 `host-frontend-static` 作 fallback owner 托管 | `web-app/cordis.patch.yml` web-runtime 行注释 |
| `bundles` 能否声明自研 bundle 覆盖？ | **能**，`bundles` 是有序列表，后者覆盖前者 | `types.ts:75-78` |
| 主题机制是否已存在？ | **已存在**，直接复用（`ui-theme`：深浅/系统 + 字号 10–22px + 别名令牌） | `ui-theme/README.md` |
| Client Model 数据来源？ | Host Controller → 生成式 Remote → React-free Client Model → UI Adapter → Slot | `docs/subsystems/web-client.md`「Layers and ownership」表 |

### 8.5 L4 的第二条通道：前端 dist 是独立包（Phase 0 新增）

`require.resolve('@deepseek-ai/dsh-web-frontend/package.json')` 解析出 `dist/index.html`
（`packages/bundle/web-app/src/index.ts:181`，找不到直接 throw `:184`）。

而 `@deepseek-ai/dsh-web-frontend` **本身就是一个独立 npm 包**：

```jsonc
// apps/web/package.json
{ "name": "@deepseek-ai/dsh-web-frontend",
  "version": "0.2.1-alpha.1",
  "files": ["dist", "!dist/**/*.map", "!dist/preview.html", "!dist/preview"],
  "exports": { "./dist/*": "./dist/*", "./package.json": "./package.json" } }
```

且 `bundle/web-app` 只以 `workspace:*` 依赖它（`bundle/web-app/package.json:171`）。

**含义**：**「前端产物」与「bundle 组合定义」是解耦的两件事**。于是 L4 有两种实现姿态：

| 姿态 | 做法 | 特点 |
| --- | --- | --- |
| **L4-a（推荐）** | 自研 `nomad-web-app` bundle 重述 roster，**复用官方前端 dist** + 自己的 L2/L3 插件包 | 最稳，上游前端升级能吃到；改动面最小 |
| **L4-b** | 在 profile `node_modules` 覆盖 `@deepseek-ai/dsh-web-frontend`，换成自研前端 dist | 拿满控制权；但**包名覆盖是脆弱点，必须 Phase 1 实测验证** |

> ⚠️ L4-b **尚未验证**（包名覆盖能否在 profile 解析链上生效属推断）。Phase 1 用最小实验证伪/证实后再升级本表。
> L4-a 无此风险，**默认走 L4-a**。

### 8.5.1 ✅ L4-a 地基：已实测验证（2026-10-08，Phase 2 第一步）

**结论：在不 fork 上游源码的前提下，自研 patch 层确实能被叠加进 DSH 的 profile 组合树。**
证据脚本：`tests/smoke/l4a-patch-probe.js`（9/9 通过），探针补丁 `tests/fixtures/l4a/probe.patch.yml`。

验证手段（**不需要模型凭据**）：`dsh --profile web --dump-config` 打印组合树后退出，不绑端口、不挂模型；
`--patch <path>` 在 profile 层之上再叠一层，可重复。两者组合即可离线验证补丁机制。

**盘内实据（`runtime/dsh/0.2.1-alpha.1/node_modules/@deepseek-ai/`）**

| 项 | 实测值 |
| --- | --- |
| `@deepseek-ai/dsh-web-frontend` | **独立包确实在盘内**，`exports: {"./dist/*":"./dist/*"}`，`files:["dist"]`；`dist/` 含 `index.html` `assets/` `manifest.webmanifest` → **§8.5 的前提成立** |
| `dsh-base` | bundle 包，`dsh.bundle.patch = "./cordis.patch.yml"`（529 行 / 20.7KB，插入核心行） |
| `dsh-web-app` | bundle 包，`dsh.bundle.patch = ["./cordis.patch.yml", "./presets/{standard,ptc,minimal,cordis}.patch.yml"]`（web 层 583 行 / 22.5KB + 4 个 agent preset） |

**bundle 的本质已明确**：一个 npm 包只要声明 `dsh.bundle.patch`（字符串或字符串数组）指向自己的 patch 文件，
即可成为 profile 的有序补丁层。**这就是 L4-a 的接入面 —— 声明式 YAML 行补丁，不是改代码。**

**patch 语法（实测）**

```yaml
- id: <已有行的 id>      # 按 id 覆盖：替换该行的整个 config
  config: { ... }        # ⚠️ 必须重述该行拥有的所有键，未重述的键会静默丢失
- insert:                # 插入新插件行
    - id: <新 id>
      name: '@scope/pkg'
      config: { ... }
```

- 支持 `!!js` 表达式，如 `disabled: !!js process.platform === 'win32'`、`root: !!js dshHomePath('sessions')`
- **组合树自带来源链**，可审计，例如：
  `# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app, D:\…\probe.patch.yml`

**顺带关掉的两个 Phase 1 待办（同一批 dump 证据）**

| 待办 | 结论 |
| --- | --- |
| 组合树里是否有非 `DSH_HOME` 派生的绝对路径 | **没有。** 全树仅 2 处盘符字样，均为无害：一条 OTel URL（`https://` 被正则误匹配）、一条 prompt 里的字面示例 `Use native Windows paths (C:\...)`。`sessions` / `storages` 的 `root` 都是 `!!js dshHomePath(...)` |
| `settings` 域与 `session-query-sqlite` 落点 | `session-query-sqlite` 为 `path: ':memory:'` + `openAt: never` → **无盘上落点**（全内存、默认不打开）；`settings` 行无 path 配置，由 `disabled: !!js '!ctx.get(''profileContext'')'` 控制 |

> **对 Nomad 的直接含义**：`system-prompt`（人格）、`session-query-sqlite`（存储落点）、
> 以及各 `dsh-client-ui-*` 行都可**按 id 覆盖**，无需 fork。
> L4-a 的第一件真产物应当是 `@nomad/nomad-web-app`：声明 `dsh.bundle.patch` → 我们的 patch 列表 → 重述 roster。

### 8.5.2 ✅ L4-a 阶段 2：自研 bundle 换层已实测（2026-10-08）

**结论：`@nomad/nomad-web-app` 已被 DSH 当作 profile 的第三层补丁成功加载，组合树按预期改变且不丢任何行。**
证据脚本：`tests/smoke/l4a-bundle-probe.js`（8/8 通过）。真产物：`packages/nomad-web-app/`。

#### profile 的确切形状（实测生成，非推断）

`$DSH_HOME/profiles/<name>/` 下恰好四个文件：

| 文件 | 作用 |
| --- | --- |
| `package.json` | `dsh.profile.bundles` = **有序包名列表**；`private: true`；`dependencies: {}` |
| `cordis.yml` | **恒为空列表 `[]`** —— 树完全由 patch 层组合出来，文件头明确写 "Edit `cordis.patch.yml`, not this file" |
| `cordis.patch.yml` | profile 级补丁层（在**所有** bundle 层之后应用） |
| `pnpm-workspace.yaml` | `packages: [.]` / `nodeLinker: hoisted` / `autoInstallPeers: false` |

生成方式：`dsh <name> --from-default-profile web --dump-config`
→ 实测其组合树与内置 `web` **逐字一致**（1312 行），证明模板复现忠实。
（`--dump-config` 让它在建完 profile 后立刻退出，不会真的起服务。）

同名 profile 已存在时 `--from-default-profile` 会**直接报错退出**，不会覆盖。

#### 自研 bundle 的形状

`packages/nomad-web-app/package.json` 的关键只有一处：

```jsonc
{ "name": "@nomad/nomad-web-app",
  "dsh": { "bundle": { "patch": ["./cordis.patch.yml"] } } }
```

**纯声明式，没有一行 JS，不需要任何构建步骤。** `dsh.bundle.patch` 是关键契约：
有它才是 bundle，没有它只是普通包。

#### 挂载方式：`bundles` 支持**相对路径**（ADR-0020）

实测 `bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "../../../../packages/nomad-web-app"]`
与「把包物化进 profile 的 `node_modules` 再按包名引用」**组合结果逐字相同**（1319 行），
唯一差异是来源链回显了写法本身。

→ 因此**采纳相对路径**：源留在 repo（单一事实源、可版本控制）、零复制零漂移、免疫盘符变化。
→ 代价：相对路径深度取决于 `DSH_HOME` 位置，**必须由 Launcher 计算并写入，禁止手工维护**（见 ADR-0020）。

#### 验证到的三件事（合并为 8 步断言）

| 能力 | 证据 |
| --- | --- |
| `id:` 覆盖生效 | `system-prompt` 的 `personaSuffix` 变为 Nomad 身份文本 |
| `id:` 覆盖**必须全量重述** | `personaPrefix` 仍在 → 若漏重述会被测试直接抓住（把 §8.5.1 的铁律变成立即失败） |
| `insert:` 行成功插入 | 组合树末尾新增 `- id: nomad`，且上方标注 `# == <bundle 路径>` 来源 |
| **group 行三键齐全** | 必须同时含 `name: cordis:group`、`group: true`、`config`（空写 `[]`）—— 缺任一项都会在**运行期**出事（缺 `name` 被静默禁用；缺 `config` 抛 `TypeError`），而 `--dump-config` 看不见。详见 `packages/nomad-web-app/README.md` 铁律 ④ |
| 来源链可审计 | `# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app, ../../../../packages/nomad-web-app` |
| 不丢行 | 上游所有 `- id:` 仍在；新增 id **恰好只有** `nomad` |

#### ⚠️ 踩到的坑（写测试时必须知道）

1. **`--from-default-profile` 不幂等**：profile 已存在就报错退出。测试必须每次从干净现场开始。
2. **dump 里 YAML 折叠标量会折行**：`personaSuffix: >-` 注入的长句会被拆到多行，
   朴素子串断言会假失败 → 对长文本断言必须**先归一化空白**（`replace(/\s+/g, ' ')`）。
3. **`id:` 替换整行 config**：见 §8.5.1，是静默丢配置的唯一来源。

### 8.5.3 ✅ L4-a 阶段 2.5 / 3：profile 自举 + 真启动已实测（2026-10-08）

**结论：Launcher 自己写出来的 profile 能被真实 DSH 加载并渲染 Web UI；全程零 fork、零物化、零宿主污染。**

| 项 | 结果 |
| --- | --- |
| 自举实现 | `launcher/lib/profile.js` 的 `ensureNomadProfile()`（幂等；ADR-0021） |
| 接线点 | `nomad start`（早失败 + 好报错）与 `host.js`（权威执行点）**双重调用** |
| 单元测试 | `tests/profile.test.js` **13/13** |
| 真实引擎冒烟 | `tests/smoke/nomad-profile-smoke.js` **9/9** |
| 组合树 | 1320 行；来源链 13 处含 `nomad-web-app`；`personaSuffix` 已是 Nomad 身份文本 |
| Web UI | 带 token GET → `303`（铸 cookie）→ `200 text/html` **34656B** |
| 宿主污染 | 跑完自举 profile 后宿主 `~/.dsh` **仍未出现** |
| 盘内 DSH_HOME | `.anonymous-user-id` / `.credentials.yaml` / `profiles` / `storages`（凭据文件为 ADR-0019 的实测依据） |
| 顺带自证 | `runtime/dsh/current` **未被触碰**；运行中的实例不受影响 |

#### ⚠️ 上游漂移守卫（阶段 3 新增，重要）

我们手写了三份模板正文（`cordis.patch.yml` / `pnpm-workspace.yaml` / `cordis.yml`）。
它们**必须**与上游 `initProfile` 的产物逐字一致，否则 profile 会以微妙方式偏离上游语义。
→ `nomad-profile-smoke.js` 的**第 3 步**用 DSH 自己 `--from-default-profile web` 生成一份参考，
再与我们的常量**逐字**比对（含上游 `web` 模板的 bundles 与清单命名约定 `dsh-profile-<name>`）。
**上游一改模板，这一步立刻红。**

#### 阶段 3 的额外上游事实（读源码得到，非推断）

`@deepseek-ai/dsh-app-boot/lib/index.js`：

| 事实 | 出处 |
| --- | --- |
| profile 目录 = `<DSH_HOME>/profiles/<name>`（`PROFILES_DIR = "profiles"`） | :485、:524-527 |
| 清单 = `package.json` 的 `dsh.profile.bundles` | :581-597、:892-894 |
| **`cordis.yml` 由 DSH 每次加载无条件重写为空列表**（防 Loader 树回写把组合结果烘焙进去 → 下次启动 bundle 行重复） | `profile-boot-*.js:189,207` |
| **内置模板名即保留名**：`acp` / `web` / `headless` / `sdk` / `sdk-minimal` | :529-535，守卫 :146 |
| 上游初始化**从不覆盖已存在文件**（`existsSync` 守卫）→ 幂等是上游自己的姿态 | :584-596 |
| `web` 模板的 bundles 恒为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` | :531 |

#### 阶段 2 的坑（续）

4. **`spawnSync` 在本机沙箱里静默返回 `status: null`**（与 `probeNodeVersion` 的 EBUSY 同源），
   报出来只有一句 `code=-1`。测试里跑 DSH 一律用**异步 spawn**。
5. **JSDoc 里不能出现 `*/`**：写 `.dsh-*/lib/...` 这种路径会把块注释提前终结（已踩，改用 `.dsh-<随机串>/`）。

#### 尚未做（阶段 3.5 起）

- **真实对话轮**：覆盖会话内附件 / Office→PDF / browser-use 的 Chrome 用户目录；需维护者当次临时提供凭据（ADR-0019）
- 阶段 6（可选）：验 L4-b（profile `node_modules` 覆盖 `@deepseek-ai/dsh-web-frontend`）证伪/证实
- 随后才进 Core UX：Navigation → Layout → Conversation → Tool Cards → Context Panel → Project UI → Session UI → Settings → Theme
  （L2 契约已打通，见 §8.5.4，可以开始了）

### 8.5.4 ✅ L2「客户端插件」链路已实测贯通（2026-10-08）

**结论：自研客户端插件能被发现、被服务、被浏览器加载；且可以零构建手写。** 依据与实证见 **ADR-0023**。

这是 Phase 2 此前最大的未知 —— 在此之前我们只证明过「**能换 bundle 层**」，从未验证过 L2/L3 赖以存在的那条链。

| 环节 | 上游机制（源码级） | 我们的做法 |
| --- | --- | --- |
| 产物形态 | `window.__ModuleLoader__.load({ id, factory: (require) => … })` —— **UMD 式信封 + CJS 式 `require`，不是 ESM** | `packages/nomad-brand/lib/client.js` **手写**，用 `react/jsx-runtime` 的 `jsx`/`jsxs`，不写 JSX |
| 构建 | 上游用共享 `tsdown.client.ts`，但**只有写 TS / JSX / CSS 模块时才需要** | **零构建**：没有构建脚本、没有构建产物、没有新依赖 |
| 服务 | `@deepseek-ai/dsh-client-modules` 用 `readFileSync(exports["./client"])` **原样吐出、运行时不编译**，按 mtime/ctime/size 判重建 | 依赖此性质（若上游改成运行时编译，本包形态需重估；已由冒烟断言兜底） |
| 加载地址 | 合并请求 `/plugins/??<id1>/client.js,<id2>/client.js&rev=<rev>`（**逗号分隔，不是每条一个 URL**） | 冒烟按这个形态抓取 |
| 包定位 | `locatePkgJson` → **路径型名字也能被认领**：从模块向上找最近 `package.json`，要求 `dsh.client.platform === 'web'` + `exports["./client"]` | roster 行 `name` 写**相对路径**指向 `lib/host.js`，源留 repo、零物化（同 ADR-0020） |

**⚠️ 两个基准不同，不可互相照抄**（实测踩到）：

- `dsh.profile.bundles` 的相对路径 → 基准是 **profile 目录** ⇒ `../../../../packages/nomad-web-app`
- roster 行 `name` 的相对路径 → 基准是 **声明该补丁的包目录** ⇒ `../nomad-brand/lib/host.js`

写错时 `--dump-config` 会给出**可读的**错误证据（我们曾拿到 `file:///D:/packages/...`，一眼看出多爬了一层）。

**验证口径**：`real-runtime-smoke.js` 第 19 步**四查**（2026-10-08 由三查扩为四查）——
首页模块引用含 `@nomad/dsh-client-brand`（扫描器认领）→ 该合并模块 200
→ 正文含信封 / 注册 id / 两个品牌槽名 → **启动图里官方占用者 `brand-official` 必须已消失**。
**四环都不影响首页 200**，所以必须独立断言。

⚠️ **为什么第四查是必需的（当日返工教训）**：首版只做了前三查，**全绿却是哑弹**。
根因是客户端插件有**两段各自独立**的成败：

1. **交付段** —— 被发现 / 被服务 / 进 boot（前三查覆盖的是这一段）
2. **注册段** —— `apply` 不抛错、`single` 槽真抢到（前三查**完全不覆盖**）

本构建 profile = `official`，官方 `ui-brand-official` 一直在注册并占住两个 `single` 槽，
我们的行排位靠后 → 撞 `duplicate declaration` 被 core 层拒绝 → **界面零变化**。
修法不是抢而是**让位**（`- id: ui-brand-official` + `disabled: true`）。完整推演见 **ADR-0024**，
铁律见 `AGENTS.md` 21。

✅ **2026-10-08 人眼验收通过**：维护者重启后确认侧栏已显示 Nomad 标识 ——
沙箱起不了 GUI，**人眼是本机唯一判据**。至此本链路（ADR-0023 + ADR-0024）真正闭环。



### 8.6 Phase 0 已定案（架构级）

**结论：Nomad 的接入面是「观察者 + 配置层 + 槽位」，不是 Agent Loop。**（详见 `DSH_SOURCE_MAP.md` §F）

四个可挂的钩子：

| 钩子 | 位置 | 用途 |
| --- | --- | --- |
| `ctx.on('session/event', …)` | `core/session/src/index.ts:760` 派发 | Nomad 自有数据层的**唯一正确接入点**（持久化/投影/遥测都这么接） |
| `agent/pre-step` 瀑布 | `core/agent-loop/src/agent.ts:276` | 改写 / 拒绝即将进入模型的消息（上下文与权限策略） |
| `agent/request-error` 瀑布 | `agent.ts:494` | 重试 / 降级 |
| `agent/turn-stopping` 串行 | `agent.ts:360` | 轮级副作用 |

**硬红线**：`Session.append()` 推进的内存日志是**唯一事实源**（`core/session/src/index.ts:757`）。
**禁止**自建第二套 Session / Loop / Tool Runtime，**禁止**绕过 append 直接写 `messages.json` 并当成真实状态。

## 9. 槽位层级（Nomad UI 的改造坐标系）

源码级完整槽位树（`docs/subsystems/slots.md`，即**已发布**的声明树）。这是 L2/L3 定制的**全部落点清单**：

```text
root
├─ sidebar
│  ├─ sidebar.brand.mark / sidebar.brand.name      ← 品牌替换点（L3）
│  ├─ sidebar.panellist / sidebar.footer.action
│  ├─ sidebar.workspaces（+ directoryFlow / session.menu.item / session.row.action）
│  └─ sidebar.settings
│     ├─ settings.trigger / header / action / close / onboarding
│     └─ settings.section（general.item / models.provider-card / models.footer / plugins.tab）
├─ main
│  ├─ plugins.add.actions / item / bundle.config / row.config / detail.*
│  └─ main.conversation
│     ├─ conversation.session → conversation.view
│     │  └─ conversation.chat.node
│     │     ├─ conversation.chat.assistant-actions / commandview / turnTail
│     │     └─ tool.call.toolview                 ← **自定义 Tool Card 落点**
│     │        ├─ tool.call.images
│     │        └─ tool.view.cordis
│     ├─ conversation.header（+ leading / session.header.*）
│     ├─ conversation.composer（+ approval.detail / plan-review.actions）
│     ├─ conversation.composer.bar（+ input.attachments / permission / plan / model）
│     ├─ conversation.input.overlay / dock / left / right
│     ├─ conversation.composer.dock
│     ├─ conversation.hero.brand.mark / hero.workspace / hero.agentPreset
├─ rightbar
│  └─ rightbar.session → sidebar.right.pane.tab.* ← **右侧 Inspector 落点**
├─ shell.bottom
├─ shell.leading
└─ shell.overlay（+ shell.quota-notice）
```

**四轴契约**（决定「加」还是「换」）：

| 轴 | 值 | 语义 |
| --- | --- | --- |
| cardinality | `single` | 单格，优先级胜者渲染。**占用即替换点** |
| | `list` | 按必需 `id` 寻址，`order` 排序 → **增量扩展点** |
| | `keyed` | owner 派发 `entryKey` 命中渲染。**已占用的键是替换点** |
| | `chain` | 各条目提供 `select(owner)`，优先级最高的非空结果胜出 → **策略替换点** |
| scope | `root` | 单实例 |
| | `session-maybe` | 继承 Provider 绑定但可无绑定渲染 |
| | `session` | 必须已解析绑定，拿到确定 Session 值 |

> 官方扩展规则原文：**"Treat `single` and an occupied keyed cell as replacement points."**
> 即 —— 想「换掉」就抢 `single` / 已占 `keyed`；想「加上」就用 `list` 的 id 或未占用的 key。

**实操经验（2026-10-08，见 ADR-0025）** —— 上表是理论，落到 Nomad 上是这样的：

| 想做的事 | 该占哪里 | 要付什么 |
| --- | --- | --- |
| 换侧栏外形 | `sidebar`（`single`，被 ui-sidebar 占） | ⚠️ **代价极高**：契约原文 *"registering here replaces the navigation column outright … **and the seats it declares disappear with it**"* —— 连它声明的 `sidebar.workspaces`（会话列表）/ `sidebar.settings`（设置）一起消失，须自行重新声明并重写 |
| **长出 Nomad 自己的入口 + 面板** | `sidebar.panellist`（`list`）+ `main`（`keyed` 新 key） | **零冲突、零 disable** ✅ —— 已实现于 `packages/nomad-panel/`，侧栏面板行**注册即出现** |
| 换配色 / 字体 / 圆角 / 间距 | **不占槽**，注入后置 `<style>` 覆盖 `--dsw-*` | **最低** —— 上游 **433 个**变量，且主题样式本就是运行时 `<style>` 注入（见 ADR-0025 附带发现） |

两条铁律：

1. **先看基数再动手**。`single` 要抢，且必须让原占用者 `disabled: true` **让位**（ADR-0024）；
   `list` / 未占用的 `keyed` **直接长**，不需要动任何上游行。
2. **跨槽寻址必须共用同一个 id 常量**。`main` 的 `key` 与 `sidebar.panellist` 的 `id` 一旦不同源，
   侧栏行**照常出现**、点下去才抛 `layout.selectPanel: main panel "x" is not registered` ——
   这种半通状态不报错、不白屏，只在你点的那一刻炸，只能靠断言锁住。

## 10. 客户端插件包契约（自研 UI 包的最小形态）

> **2026-10-08 更新：本节已从"设计"变成"已证"。** 现有**两个**最小实现，按用途分开：
> - `packages/nomad-brand/` —— 占 `single` 槽（品牌）；链路实证见 §8.5.4 与 **ADR-0023 / ADR-0024**
> - `packages/nomad-panel/` —— 占**增量型**槽（`list` + `keyed`）；见 §9 实操经验与 **ADR-0025**
>
> 两处对原设计的修正：
> 1. **不需要构建**：产物是 `window.__ModuleLoader__.load({id, factory})` 的 UMD 式信封 + CJS 式 `require`
>    （**不是 ESM**），加载器 `readFileSync` 原样吐出、不编译 ⇒ **纯 JS 可手写**，`tsdown` 只在写 TS/JSX/CSS 时才需要。
> 2. 下文的"构建"一节描述的是**上游自己的做法**，不是我们的必要条件。

一个 Nomad UI 插件包 = **普通 npm 包 + 两个声明**，不需要进 monorepo：

```jsonc
{
  "name": "@nomad/ui-brand",
  "exports": {
    ".":        { "default": "./lib/index.js" },      // 宿主半（空 apply 即可）
    "./client": { "default": "./lib/client.js" }       // 浏览器半 ← 真正的 UI
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-sidebar"]
    }
  }
}
```

三条硬纪律（`packages/client/AGENTS.md`）：

1. **`./client` 是公开浏览器 API，不是 convenience barrel** —— 除 `apply` / `inject` / `Config` 与 store 工厂外**不导出任何值**。
2. **禁止 import 或 re-export 另一个 feature 插件的运行时值**；跨包共享走 **`import type` 声明 + Cordis service 注入 + Slot**。行为跨界只能靠注入，UI 跨界只能靠槽位。
3. **组件永远看不到 `ctx`** —— 所有数据/回调经派生 props 五份额进入
   （`PropsRuntime` / `PropsRenderSlots` / `PropsRenderFactories` / `PropsStore` / inject face）。

**数据访问阶梯**（官方指定顺序，不得越级）：
框架 hooks（`useSession` / `useSessions` / `useWorkspaces` / `useChat` / `useTrajectory` …）
→ 声明的 store（`useStore` / `actions`）
→ inject 回调
→ 越界即「新增框架扩展点」，需主线程仲裁。
**禁止**在业务组件里写 `useSyncExternalStore` / 手动订阅 / 把外部快照镜像进本地 state。

**构建**：客户端包由共享的 `tsdown.client.ts` 配置产出 `lib/client.js`（属主 → `/client` 导出）。
这一步**只在开发机/CI 跑**，产出物随 U 盘携带。

### 面板分区与合规职能（`nomad-panel`，2026-10-08 补）

`nomad-panel` 主区面板的分区顺序，以及各自的**职能**（不是外观约定，是职责边界）：

| # | 分区 | 职能 | 状态 |
| --- | --- | --- | --- |
| ① | 品牌头 | 身份：七星标识 + `Nomad` + `Portable Agent OS` | 已实现（阶段 4/5 铺垫） |
| ② | **About** | **产品介绍 + 合规声明**（归属 / 许可 / 商标关系 / 上游状态免责） | **已实现** ← 第一个真实内容 |
| ③ | 状态区 | 运行信息（构建标识 / 面板 id / 载体槽 / 骨架状态） | 已实现 |
| ④ | 计划分区 | 路线预告（Memory / Skills / Projects） | 占位 |
| ⑤ | 回程 | `selectPanel(null)` 回到对话 | 已实现 |

**About 不只是介绍 —— 它承担合规职能**（详见 **ADR-0026**）：

- 上游 `BRAND_GUIDELINES.zh.md` 要求真实准确说明与上游的关系，并明示此类**描述性**说明
  （"基于 DeepSeek Harness 构建"）**符合许可证的要求**；MIT 要求保留版权与许可声明。
  About 就是这两项义务在界面里的落点。
- 措辞是**有红线**的，改文案前必读 `lib/client.js` 中该区块的注释：
  说"构建在 X 之上" ✅；说"官方合作 / 推荐 / 认证" ❌（违反品牌规范第 4 条）。
- **不得指向未随包分发的文件**：依赖许可如实写"见各依赖包内 LICENSE"，
  而非指向 `THIRD_PARTY_NOTICES.md`（该聚合清单当前**不在**运行时分发包内）。
  此约束由 `tests/nomad-panel.test.js` 的**负向断言**守住。

**两处防漂移断言**（易腐点，改动前先看测试）：
上游版本号内联在 `client.js`（零构建客户端拿不到配置）→ 与 `config/nomad.yaml` 的
`pinned_version` 逐字比对；升级 DSH 时**两处同改**，漏改即红。

**已知技术债**：面板中英混排（About 行标签中文 / 状态区标签英文）。
统一留待一次性多语言时收拾，本次刻意不动既有英文标签。

## 11. 备选载体

官方另有 **Electron 桌面载体**（`apps/desktop`，`desktop` 为保留 profile 名），能管理插件、自带运行时。
本阶段**不采用**（需求是「浏览器即界面」），但作为 Phase 3 之后的可选形态记录在此。
