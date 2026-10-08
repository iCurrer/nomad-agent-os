# AGENTS.md — Nomad 项目 AI 开发规则（执行宪法）

> 项目：**Nomad — Portable Agent OS**
> 适用对象：Codex / Claude Code / Cursor / DeepSeek Harness / 任何 AI 编程助手
> 本文档是 AI 在本仓库内的**最高行为约束**（仅次于当前真实源码）。
> 修改任何代码前，必须完整读完本文件。

---

## 0. 效力与优先级

冲突解决顺序（高 → 低）：

1. 当前仓库**实际源码**
2. 本文件 `AGENTS.md`
3. 本仓库 `docs/`
4. 官方 DSH 文档
5. 官方 GitHub README
6. 模型已有知识

**冲突处理**：以源码为准，并把冲突点与结论写入 `docs/DECISIONS.md`。

- 禁止：「我猜 DSH 应该是这样实现的，所以直接改。」
- 必须：「我已定位到真实代码位置（`文件:行`），因此这样修改。」

---

## 1. 项目定位（先对齐，再动手）

| 层 | 归属 | 职责 |
| --- | --- | --- |
| Agent Engine | **DSH**（DeepSeek Harness） | Agent Loop、Tool Calling、Tool Runtime、Session、Model、MCP、Events |
| Product / OS Layer | **Nomad** | Portable Runtime、Launcher、Web UI、Projects、Memory、Skills、Profiles、Permissions、Backup、Runtime 版本管理、USB 持久化、Host Isolation |
| Agent Home | **USB** | Data / Config / Skills / Workspace 的物理载体 |
| Agent Screen | **Browser** | 主 UI，`http://127.0.0.1:<port>` |

一句话：**DSH 是发动机，Nomad 是整辆车。不要把发动机拆了重造。**

Nomad **不得**重新实现：Agent Loop、Tool Calling、Session 基础机制、MCP、Model Provider、Tool Runtime、Agent 基础状态机 —— 除非已证实当前 DSH 架构确实无法满足需求（且必须留下 ADR 记录）。

---

## 2. Recon Gate — 动手前必做（不可跳过）

任何代码修改前，按顺序执行并**输出证据**：

1. 确认当前工作目录
2. `git status`
3. 查找并阅读 `AGENTS.md`
4. 阅读仓库 `README`
5. 阅读相关 package 的 README
6. 阅读相关 `docs/`
7. 搜索真实实现（不靠文件名猜测）
8. 找到调用链
9. 找到数据流
10. 找到事件流
11. 找到 API / Remote / Service
12. 找到 UI 与后端的边界
13. 找到现有扩展机制
14. 判断能否用 Plugin / Profile / Slot / Adapter 完成
15. 确认架构后才允许修改

修改前必须回答（写进回复里）：

- 当前实现在哪里？（`文件:行`）
- 谁调用它？
- 数据从哪里来、到哪里去？
- 修改会影响谁？
- **最小修改**是什么？

---

## 3. 修改优先级阶梯（越靠上越优先）

1. Configuration
2. 已有 Extension Point
3. Plugin
4. Profile
5. Adapter
6. UI Slot
7. Application Layer
8. Patch
9. **Core modification（最后手段）**

原则：越靠近 DSH Core，修改成本越高、upstream 冲突越严重。

### UI 定制的五级梯度（Phase 0 已实测，见 `docs/UI_ARCHITECTURE.md` §8.0）

| 级 | 手段 | 用户机构建 | fork |
| --- | --- | --- | --- |
| L1 | Theme Token（`ctx.theme` + `--dsw-*`） | ❌ | ❌ |
| L2 | Slot **增量**（list / 未占 keyed） | ✅ 仅开发机 | ❌ |
| L3 | Slot **接管**（single / 已占 keyed） | ✅ 仅开发机 | ❌ |
| L4 | **Bundle 整体替换**（`nomad-web-app`）← **Nomad 目标层级** | ✅ 仅开发机 | ❌ |
| L5 | Fork DSH 源码 | ✅ | ⚠️ 必登记 UPSTREAM |

**硬约束**：WorkBuddy / Coding Agent 做 UI 定制时**不得越过 L4 直接 fork**；
若判断 L1–L4 确实不可行，必须先在 `docs/DECISIONS.md` 记录理由，再进入 L5。

### Core 修改的强制记录

必须写入 `docs/UPSTREAM.md`：原始版本、修改 commit、修改原因、修改文件、修改行为、upstream 兼容性、升级风险。

---

## 4. 架构铁律

1. **Runtime 与 Data 必须分离**：`runtime/` 可替换/升级/回滚/重下；`data/` 必须长期存在。
2. **USB 是 Agent 的 Home**，不是「把 DSH 装进 U 盘」。一切路径从 `NOMAD_ROOT` 派生。
3. **禁止硬编码 Host 路径**：不得出现 `C:\Users\...`、`C:\Program Files\...`、`/Users/...`、`/home/...`。
4. **单一事实源**：DSH Session 是唯一 Session 事实源；不得建立第二套 Session / 第二套 Agent Loop / 第二套 Tool Runtime。
5. **Runtime 版本化**：`runtime/dsh/<version>/` + `runtime/dsh/current` 软指向；迁移失败可回滚。
6. **可回滚**：所有升级（Runtime、Schema、Migration）都必须有 rollback 路径。
7. **Portable Release 不含构建步骤**：目标机器不得要求 `pnpm install` / `pnpm build` / `node_modules`。**构建期与运行期彻底分离**，用户机零编译。
8. **启动路径禁止 `npx`**：`npx` 会联网访问 npm registry，无网机器直接失败。必须预置包 + 直接调 node 入口。
9. **优先走官方插件通道**：`cordis.patch.yml` → 自研 bundle（如 `nomad-web-app` 替换 `@deepseek-ai/dsh-web-app`）→ 万不得已才 fork **单个包**。**不 fork monorepo。**
10. **状态根是 `DSH_HOME`**：便携化时将其指向 `<NOMAD_ROOT>/data/dsh-home`，禁止落到宿主用户目录。该变量属 **bootstrap-only**，只能由 Launcher 以进程环境变量注入 —— 写进任何 `.env` 会被 DSH 直接拒绝并报错。
11. **零污染是硬需求且必须可验证**：U 盘运行产生的记录（会话、附件、缓存、临时文件）必须全部落在 `<NOMAD_ROOT>` 之内。完整配方与源码证据见 [`docs/HOST_ISOLATION.md`](docs/HOST_ISOLATION.md)。宿主机残留必须**记录 → 解释 → 尽量减少**，不得以「反正查不到」搪塞。
12. **接入面是「观察者 + 配置层 + 槽位」**：Nomad 只在 ① `ctx.on('session/event', …)`（自有数据层）② `agent/pre-step` / `agent/request-error` / `agent/turn-stopping`（策略层）③ `/plugins` + `dsh.client`（L2/L3 UI）④ `bundles` + `cordis.patch.yml`（L4 UI）四处介入。**不包装、不替换 `ctx.agents` / Agent Loop / Tool Runtime。**
13. **`Session.append()` 是唯一事实源**：它推进内存事件日志（`core/session/src/index.ts:757`），持久化/投影/遥测**都只是观察者**。禁止绕过 append 直接写 `messages.json` 并把它当成真实状态。
14. **Launcher 是路径与环境的唯一定义者**：只有 Launcher（`launcher/`）能解析 `NOMAD_ROOT`、注入 `DSH_HOME` 与其余隔离变量。配置中的任何路径都必须过 `launcher/lib/paths.js#resolveInside`（宿主绝对路径 / `../` 越界直接报错）。禁止在其它模块里自行拼路径或读写系统环境。
15. **DSH 命令行契约以源码为准**：web 参数族**只有** `--host/--public-url/--trusted-host/--no-open/--port`（`packages/bundle/web-app/src/startup.ts:59-63`）。新增任何 flag 前必须先在 `vendor/deepseek-harness` 里找到定义处并写进 `docs/DSH_SOURCE_MAP.md`；禁止凭记忆猜测，禁止出现 `npx`。
16. **进程操作必须可自证**：只允许结束"自己记录且持有新鲜心跳"的进程（`launcher/lib/state.js#isFresh`）。PID 会被系统复用，**没有新鲜心跳时禁止按 PID 杀进程**，只能如实报告并交给用户确认。禁止宽范围 `taskkill`、禁止 `pkill`/`killall` 式批量结束。
17. **宿主清理一律走回收站并留台账**：对宿主（尤其用户目录）的任何删除，必须 ① 先**只读盘点**、② 列出受影响路径与风险并取得逐项确认、③ 走**回收站**（Python `ctypes` 调 `SHFileOperationW` + `FOF_ALLOWUNDO`）、④ 台账写入 `data/backups/`（记录范围 / 体量 / API 返回码 / 回收站位置）。**禁止永久删除宿主文件。**
18. **删除前的盘点不得依赖沙箱内的 `find` / `du`**：本机实测它们返回**部分可见性**且静默吞错（29,695 个文件被报成 195 个）。一律以 Python `os.walk` 或回收站 API 的上报值为准。详见 `docs/DEVELOPMENT.md` §10。
19. **交接与外部动作必须「可判伪」，禁止假成功**：把 URL / 文件 / 命令交给操作系统完成时，判据必须是**对方给出的信号**（退出码、握手结果），而不是"我没抛异常"。
    - **浏览器交接不得用 `explorer.exe`**（它不是"打开 URL"的接口：会另开资源管理器窗口，并让 URL 丢掉 query → 浏览器必然 401）。Windows 走 `cmd.exe /c start "" <url>`，含 cmd 元字符时降级 `powershell -EncodedCommand`，配了 `web.browser_path` 时直接拉起该 exe。见 ADR-0022。
    - 交付前必须自检：`verifyAuthHandshake()` 走通 `303 铸 cookie → 带 cookie 200` 才算"这条地址交给浏览器进得去"。
    - 结果一律**如实落盘**（`state.webAuth` / `state.browserHandoff`）并照实打印；无条件的「已完成」式输出等同于 bug。
20. **两种相对路径的解析基准不同，禁止互相照抄**：`dsh.profile.bundles` 里的相对路径基准是 **profile 目录**
    （如 `../../../../packages/nomad-web-app`）；而 **roster 行 `name`** 的相对路径基准是**声明该补丁的包目录**
    （如 `../nomad-brand/lib/host.js`，写在 `packages/nomad-web-app/cordis.patch.yml` 里）。
    写错时 `--dump-config` 会把解析结果打印成绝对 file URL，先看它再改，不要凭感觉调 `..` 的层数。见 ADR-0023。
21. **自研客户端插件走零构建手写，不得引入构建链**：产物是
    `window.__ModuleLoader__.load({ id, factory: (require) => … })` 的 **UMD 式信封 + CJS 式 `require`（不是 ESM）**，
    加载器 `readFileSync` 原样吐出、**运行时不编译** ⇒ 纯 JS 可手写，用 `react/jsx-runtime` 的 `jsx`/`jsxs` 代替 JSX。
    **只有**要写 TS / JSX / CSS 模块时才需要 `tsdown` —— 那必须先取得维护者明确许可（铁律：未经允许不装任何软件）。
    本包形态依赖上游这一私有约定，故必须有断言兜底（`real-runtime-smoke.js` 第 19 步**四查**，
    末查为「官方占用者必须已让出」——见铁律 22）。另 `tests/nomad-brand.test.js` 用 `vm` 按浏览器方式
    执行 `client.js`、以**记录式 `jsx` 桩**断言**元素树**，补上"模块内容是否正确"这一层。
    见 ADR-0023 / ADR-0024。
22. **「被加载」≠「注册成功」：交付段与注册段必须各有断言**。客户端插件有**两段各自独立**的成败 ——
    **交付段**（被扫描器认领 / 被真实服务 / 进 `window.__DSH_BOOT__`）与
    **注册段**（`apply` 执行不抛错、槽真抢到）。只验交付段得到的是**哑弹**：
    服务端一切正常、断言全绿、界面零变化（2026-10-08 真实发生过一轮返工）。
    凡改"插件类"（bundle 层 / 客户端插件）都必须两段都断言。
    配套两条硬事实：① 槽位 `kind: 'single'` 时**后到者必被拒**（`duplicate declaration`，
    `ui-renderer/src/client/registry.ts:487`）——**"抢"不可行，要"让位"**
    （`- id: <上游占用者>` + `disabled: true`；注意 `name` 字段只能断言、不能改名）；
    ② 本构建的 profile **就是 `official`** —— 判据：上游 `ui-brand-official/lib/client.js` 里那句
    `if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return` **是否还存在**（被死代码消除即
    profile = official；全套 `.js` 里已无该标识符，只剩 README）。见 ADR-0024。
23. **动手改界面前，先看槽的基数**（决定"抢"还是"长"）：
    - `single` —— 单格，**占用即替换**。要与上游占用者抢，就必须先让它 `disabled: true` 让位（铁律 22）；
      替换上游**容器**槽（如 `sidebar`）还会**连带带走它声明的全部子槽** ——
      `ui-layout/src/client/index.ts:58-67` 原文：*"the seats it declares disappear with it"*
      ⇒ 会话列表 / 设置入口会一起消失，须自行重声明并重写。**代价极高，非必要不做**。
    - `list` / 未占用的 `keyed` —— **增量扩展点**，新 `id` / 新 `key` 即新增一格，**零冲突、零 disable**。首选。
    - **跨槽寻址必须共用一个 id 常量**：`main` 的 `key` 与 `sidebar.panellist` 的 `id` 若各写一份字面量，
      改动时极易只改一处 —— 那时侧栏入口**照常出现**，点下去才抛
      `layout.selectPanel: main panel "x" is not registered`。**不报错、不白屏、只在点击那一刻炸**，
      属最难发现的一类。故：只定义一次常量，并让单测与真实冒烟各锁一道。见 ADR-0025。
    - **改外观（配色/字体/圆角）不要占槽**：注入后置 `<style>` 覆盖 `--dsw-*` 变量即可 ——
      上游共 **433 个**变量，且主题样式本就是运行时 `<style>` 注入（`ui-theme/src/client/styles.ts`）。
      这是成本最低的一条通道。见 ADR-0025 附带发现。

目录基线：

```
Nomad/
├── Nomad.exe            # Launcher（Win）
├── launcher/
├── runtime/             # 可替换
│   ├── node/
│   ├── dsh/<version>/  +  current
│   └── platform/
├── app/                 # host/ + web/
├── data/                # 长期存在：sessions/ events/ memory/ projects/ logs/ cache/ backups/
├── workspace/           # projects/ sandbox/ downloads/
├── skills/
├── profiles/
├── mcp/
├── config/              # nomad.yaml providers.yaml permissions.yaml compatibility.yaml
├── tools/               # 开发机工具：deploy-usb.js（部署到可移动盘，ADR-0027）
└── VERSION
```

---

## 5. 数据规则

1. Session：DSH 为准。Nomad 只能**附加** metadata（project / tags / UI state / notes / memory refs），通过 metadata / sidecar / application layer 扩展，**不得破坏 DSH Session 基础结构**。
2. 若 DSH 使用事件流 / durable stream：**不得绕开**，不得自己存一份 `messages.json` 并让 UI 把它当真实状态。
3. 数据方向必须是：`DSH Event/Session → Nomad Adapter → UI`；禁止 `React Component → 自己复制一套 Agent State`。
4. Nomad 自有数据（memory / project metadata / preferences / UI state）可独立存储。
5. Schema 未经源码验证不得固化；字段以实际实现为准（见 `docs/DATA_MODEL.md`）。

---

## 6. UI 规则

- 目标：**深度改造 DSH Web Client，逐步长成 Nomad 自己的 Web Application**，不是套一层 CSS。
- 原则：**Logic 尽量继承 DSH，UI 可以高度定制。**
- 布局：左 Navigation ｜ 中 Conversation / Workspace ｜ 右 Context / Project / Git / Files / Skills / Runtime / Session。
- Tool 调用一律用**结构化 Tool Card**（Shell / Git / File Edit / File Read / Build / Test / MCP / Browser / Search / Agent / Error），不整坨纯文本。
- 主题：Dark（默认）/ Light / System；颜色走 **design tokens**（`--background --surface --border --text-primary --text-secondary --accent --danger --success --warning`），禁止硬编码。
- 风格：High-end、Minimal、Dark、Professional、Apple-like / Linear-like / Cursor-like / Notion-like。
- **禁止**：廉价紫色 AI UI、大量渐变、Cyberpunk、过度玻璃拟态、巨型发光、大面积粒子、花哨动画、AI 玩具感。
- 判定标准：「像一个真正的专业 Agent 工作站」，不是「像一个 AI Demo」。

---

## 7. 安全与 Secret

- 禁止 API Key 进入：Git / 日志 / Session / 截图 / config 仓库。
- 禁止文件名：`secrets.json`、`api_key.txt`、`provider_key.yaml`。
- 优先 OS Credential Store；若必须完全便携，则使用**加密 Secret Store**，USB 上只存密文。
- 详见 `docs/SECURITY.md`。

---

## 8. 权限分级（Agent 行为约束）

| 级别 | 默认策略 |
| --- | --- |
| Read | 自动允许 |
| Write | workspace 内自动允许 |
| Execute | 普通命令自动允许 |
| Network | 按工具判断 |
| Sensitive | 必须询问 |
| External Upload | 必须询问 |
| Git Push | 必须询问 |
| Production Deploy | 必须询问 |

配置落点：`config/permissions.yaml`。

---

## 9. 绝对禁止清单（26 条）

1. 删除大量文件后重新生成
2. 删除测试
3. 弱化测试
4. 修改测试来「通过测试」
5. 硬编码用户路径
6. 硬编码 API Key
7. 输出 Secret
8. 自动 `git push`
9. 自动生产部署
10. 自动修改系统环境变量
11. 自动修改注册表
12. 自动删除用户数据
13. 自动升级 DSH master
14. 猜测 DSH 内部 API
15. 引入未经确认的第三方代码
16. 复制无法确认许可证的代码
17. 用 TODO 代替真实实现
18. 用注释掩盖错误
19. 大规模无关重构
20. 创建第二套 Agent Loop
21. 创建第二套 Session 真相源
22. 把 DSH state 全部复制进 React global store
23. 把合规声明改写成**暗示官方背书 / 合作 / 认证**的措辞（违反上游 `BRAND_GUIDELINES`）
24. 在界面或文档里**指向未随包分发的文件**（如把依赖许可指向运行时分发包内不存在的 `THIRD_PARTY_NOTICES.md`）
25. **手工拖拽 / `xcopy` / 资源管理器复制**把项目搬到可移动盘 —— 那会把 `vendor/`（上游源码 152.6 MB）、
    `.cache-dev/`（下载缓存 318.3 MB）与 `data/` 里的**明文凭据**一并带走。
    部署**只走** `tools/deploy-usb.js`：它强制白名单、检查 exFAT 兼容性、并做文件数与字节对账（ADR-0027）
26. **目标盘实例还在运行时部署** —— 盘上实例占用着它加载过的文件，覆盖写入会 `EPERM`
    （Windows 上「新建」与「覆盖已存在文件」不是同一件事：新建总成功、覆盖可能被拒）。
    顺序必须是**先停 → 再推 → 后启**（`Nomad-Restart.cmd` 即后两步合一，见 `docs/DEVELOPMENT.md` §9.6）

---

## 10. Git 与提交

- 分支：`main` / `develop` / `feature/xxx`（如 `feature/portable-launcher`、`feature/nomad-ui`、`feature/memory`）
- 禁止一次提交大量无关修改。
- Commit 必须表达真实变化：`feat:` `fix:` `refactor:` `docs:` `test:` `build:`
- 不自动 push；不 `--force`；不跳过 hooks。

---

## 11. Quality Gate — 每次改完必做

至少执行：**Typecheck / Lint / Unit Test**

按改动范围追加：

| 改动涉及 | 追加验证 |
| --- | --- |
| Build | Build |
| Web | Web Build |
| Runtime | Runtime Smoke Test |
| Portable | Portable Smoke Test |
| **自研 bundle / profile / patch**（`packages/nomad-web-app/`） | `node tests/smoke/l4a-patch-probe.js` + `node tests/smoke/l4a-bundle-probe.js` + `node tests/smoke/nomad-profile-smoke.js` |
| **DSH profile 自举**（`launcher/lib/profile.js`） | `node --test tests/profile.test.js` |

**测试怎么跑**（踩过的坑，别再踩）：

```bash
node --test tests/*.test.js              # 单元测试（现 76 条）；直接传 tests/ 目录会整体失败
node launcher/nomad.js doctor            # 14 项：应 14 通过 / 0 警告
node launcher/nomad.js profile           # 自建 profile 状态（只读；--ensure 才写盘）
node tests/smoke/portable-smoke.js       # 12/12（替身）        ← 会 stop 实例；开头会自愈残留暂存
node tests/smoke/real-runtime-smoke.js   # 15/15（真实 DSH）     ← 会 stop 实例；含零告警 + 资源全量闸
node tests/smoke/stale-state-guard.js    # 4/4（PID 安全闸）     ← 会 stop 实例
node tests/smoke/l4a-patch-probe.js      # 9/9（L4-a 阶段 1）—— 完全隔离，可随时跑
node tests/smoke/l4a-bundle-probe.js     # 8/8（L4-a 阶段 2）—— 完全隔离，可随时跑
node tests/smoke/nomad-profile-smoke.js  # 9/9（L4-a 阶段 3）—— 完全隔离，可随时跑
node tests/smoke/web-ui-assets.js        # 资源全 200 —— **只读**，有实例在跑时随时可跑
```

> **`portable-smoke` 会把 `runtime/dsh/current` 临时换成替身**（跑完放回）。若它被信号打断
> （尤其别把输出用 `| head` 截断 —— SIGPIPE 会在「让位」与「放回」之间kill掉它），
> 盘上会留下「`current` 是替身或缺失 + 暂存躺在 `data/tmp/nomad-current-swap`」。
> **下次运行会自愈**（`recoverLeftoverStash()`），无需人工干预；诊断手段：
> `node launcher/nomad.js doctor` 会直接 FAIL 并指出运行时不可用。

> **「首页 200」不等于「UI 能渲染」**（2026-10-08 踩过）：`index.html` 只是壳，真界面靠
> `assets/*.js` + `plugins/??…`（客户端模块总包约 10.9MB）。任一资源 404 → 浏览器**白屏**，
> 而壳的 200 照样漂亮。所以：**改了任何与前端/bundle/profile 相关的东西，
> 必须跑 `web-ui-assets.js` 或 `real-runtime-smoke.js`，别只看首页字节数。**

> **有实例在跑时**只跑「完全隔离」那三个（各用 `data/tmp/` 下的独立 scratch `DSH_HOME`）；
> 前三项会 `stop` 实例 / 改写共享状态，先 `nomad status` 确认没人用。

收尾必查：`git diff` + `git status`，确认**无无关修改、无 Secret、无 Host path、无测试删除、无临时文件**。

---

## 12. 工作流与文档义务

固定节奏：

```
Understand → Locate → Trace → Plan → Modify → Test → Inspect Diff → Report
```

**禁止**：读 1 个文件 → 立刻重写整个项目。

文档维护义务（改了就要同步）：

| 触发 | 必须更新 |
| --- | --- |
| 首次读源码 | `docs/DSH_SOURCE_MAP.md` |
| 架构变化 | `docs/ARCHITECTURE.md` |
| 数据结构变化 | `docs/DATA_MODEL.md` |
| UI 结构变化 | `docs/UI_ARCHITECTURE.md` |
| 改动 DSH Core | `docs/UPSTREAM.md` |
| 部署流程 / 可移动盘清单 | `docs/DEPLOY.md` |
| 日常开发循环（改代码 → 上盘验证） | `docs/DEVELOPMENT.md` §9 |
| 任何技术选型决策 | `docs/DECISIONS.md` |
| DSH 升级 | `docs/DSH_SOURCE_MAP.md` + `docs/UPSTREAM.md` |

---

## 13. 路线与当前阶段

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| Phase 0 | Source Reconnaissance → 产出 `docs/DSH_SOURCE_MAP.md` | **已完成** |
| Phase 1 | Portable Bootstrap（Launcher 起 DSH + Web + Browser） | **已完成**（Launcher + 运行时打包 + 真实 DSH 端到端 11/11） |
| Phase 2 | Nomad Web UI（Navigation/Layout/Conversation/Tool Cards/Context/Project/Session/Settings/Theme） | **进行中**：L4-a 阶段 1/2/2.5/3 全部验证（补丁通道 + bundle 换层 + profile 自举 + 真启动）；下一步真实对话轮 |
| Phase 3 | Nomad Agent OS（Projects/Memory/Skills/Profiles/Permissions/Runtime Manager/Backup/Update/Rollback） | 待开始 |

**Phase 1 收尾状态（2026-10-08）**

- ✅ `runtime/node`（Node v22.23.3，SHA-256 对官方校验）+ `runtime/dsh/0.2.1-alpha.1` + `current` 清单指针（ADR-0016）
- ✅ 71 单元测试 + 12 步替身冒烟 + 12 步真实 DSH 冒烟 + 4 步 PID 安全闸 + 9/8/9 步三段 L4-a 验证
- ✅ 零污染**实测**：真实引擎全程未创建宿主 `~/.dsh`；宿主历史残留已清（台账见 `data/backups/`）
- ✅ 凭据方案定案：**宿主凭据库永久排除**（违「不污染宿主机」铁律）；唯一入口 = Launcher 注入（ADR-0019）
- ⬜ 真实对话轮未验证（需维护者当次临时提供模型凭据）—— **不虚勾**
- ⬜ USB 真机（可移动盘）验证 —— 本机 `D:` 是本地 HDD 分区，不算数

**Phase 2 第一步 = L4-a（不 fork 上游换 UI）**，当前进度：

- ✅ 阶段 1：自研 patch 层可叠加进组合树（9/9）
- ✅ 阶段 2：自研 bundle `packages/nomad-web-app/` 换层成立；`bundles` 支持相对路径（ADR-0020）
- ✅ 阶段 2.5：`ensureNomadProfile()` 幂等自举 `$DSH_HOME/profiles/nomad/`（13/13 单测，ADR-0021）；
  接线在 `nomad start` + `host.js`；`nomad doctor` 有巡检、`nomad profile [--ensure]` 可手工查看
- ✅ 阶段 3：真实 DSH 加载自举 profile 并渲染 Web UI（9/9；`303 → 200 text/html 34656B`）
- ⬜ 阶段 3.5：真实对话轮（需维护者当次临时提供凭据）
- ⬜ 阶段 3 前置：摸清 Cordis 插件导出契约，才能 `insert:` 挂自研 JS 插件
- ⬜ 阶段 4（可选）：验 L4-b（profile `node_modules` 覆盖 `@deepseek-ai/dsh-web-frontend`）

> **五条硬规则**（改 `packages/nomad-web-app/cordis.patch.yml` 前必读，有测试兜底）：
> ① `id:` 覆盖会替换目标行**整个 config** → 必须重述该行**所有**键，漏一个就静默丢配置；
> ② dump 里 YAML 折叠标量（`>-`）**会折行** → 断言长文本前先归一化空白，否则子串匹配假失败；
> ③ **profile 的 `package.json` 只能由 Launcher 算出来写**（bundle 路径是相对距离，见 ADR-0021）——
> 手工维护会在 `DSH_HOME` 移位时静默失效；手写前先跑 `nomad profile` 看实际值；
> ④ `insert:` 的 group 行**三个键缺一不可**：`name: cordis:group` + `group: true` + `config`（空写 `[]`）。
> 缺 `name` → 整行被**静默禁用**（`disabling profile plugin row "nomad": … startsWith`）；
> 缺 `config` → 运行期 `Group.update(undefined)` 抛 `TypeError: … reading 'map'`；
> ⑤ **`--dump-config` 不能代替真启动**（它不跑 preflight、不初始化插件，④ 的两类错误全看不见）——
> 改完 patch/profile/bundle **必须**跑 `tests/smoke/real-runtime-smoke.js`，它的「零告警」断言才是真闸门。

**当前阶段不开发**：Memory AI、Agent Marketplace、多 Agent Society。

完整验收项见 `docs/ROADMAP.md`。

**各阶段验收标准**

- Phase 0：能准确回答「**用户发送一条消息之后，DSH 内部发生了什么**」。
- Phase 1：插 USB → 启动 Nomad → 浏览器打开 → DSH 可用。
- Phase 2：Nomad 自己的 Web UI 可见可交互，且**全程未 fork 上游源码**。
- Phase 3：Projects / Memory / Skills / Profiles / Permissions / Runtime Manager / Backup / Update / Rollback 可用。

细节见 `docs/PHASE1_LAUNCHER.md`（Phase 1）与 `docs/UI_ARCHITECTURE.md`（Phase 2）。

---

## 14. 硬约束速查（复述用）

- Runtime 与 Data 分离
- USB 路径由 Launcher 管理（`NOMAD_ROOT`）
- 不硬编码 Host path
- 不保存 Secret 到 Git
- 不自动 git push / 不自动升级 DSH master
- 不删除测试 / 不弱化测试
- 不大规模无关重构
- 优先 Plugin / Profile / Adapter / Slot
- Core 修改必须记录
- 修改后必须测试 + 检查 `git diff`
- 合规声明不得暗示官方背书；不得指向未随包分发的文件（见 §9 第 23/24 条与 ADR-0026）
- 部署到可移动盘只走 `tools/deploy-usb.js`，禁止手工拖拽（见 §9 第 25 条与 ADR-0027）
- 部署前先停目标盘实例；改了插件 / 配置后必须**重启实例**才生效（见 §9 第 26 条与 `DEVELOPMENT.md` §9）

---

## 15. 新人（新会话）启动提示词

见 `docs/BOOTSTRAP_PROMPT.md` —— 每个新 AI 会话的第一条消息直接粘贴它。
