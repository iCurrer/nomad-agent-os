# ROADMAP.md — 阶段路线与验收标准

> 顺序不可跳跃。**Phase 0 / 1 未完成前，不得开发 Memory / Skills / AI UI。**

## Phase 0 — Source Reconnaissance（**已完成**）

**任务**：阅读 DSH 源码

**输出**：`docs/DSH_SOURCE_MAP.md`（状态 `PHASE 0 CORE COMPLETE`）

**必须确认**：DSH entry ｜ Web entry ｜ API ｜ Session ｜ Event ｜ Client ｜ Build ｜ Runtime

**验收**：Coding Agent 能解释 —— 「**用户发送一条消息之后，DSH 内部发生了什么。**」
→ ✅ **已达成**：`DSH_SOURCE_MAP.md` 调用链 A（10 段，逐段 `文件:行`）

- [x] 仓库结构 / package 划分清楚（`§B` 目录快照）
- [x] 各组件记录完成（**24/24**，Source Path 带行号）
- [x] 关键调用链 A/B/C/D 填写完成
- [x] 可写状态目录集合确认（`docs/HOST_ISOLATION.md`）
- [x] UI 深度定制上限实测定案（**五级梯度**，`UI_ARCHITECTURE.md` §8.0）
- [x] 客户端分层 + 槽位层级树（`UI_ARCHITECTURE.md` §9、`DSH_SOURCE_MAP.md` §C）
- [x] 宿主残留**实测**（配方已有，需在清洁环境跑一遍）
      → **已达成**：真实 DSH 全程未创建宿主 `~/.dsh`；宿主历史残留已清（`29695 文件 / 296.9MB` → 回收站，
      台账 `data/backups/host-dsh-inventory-2026-10-08.txt`）。备注：本机 `D:` 非可移动盘 ——
      **真机 U 盘复测已于 2026-10-08 完成**（部署到 `E:\` exFAT 盘并在盘上成功启动，见下方 V1 清单「USB 启动」）。
- [x] 凭据方案定案 → **ADR-0019**：**宿主系统凭据库永久排除**（会污染宿主机，违维护者铁律）；
      唯一入口 = Launcher 注入，盘内不落真 key；加密库排期 Phase 3


## Phase 1 — Portable Bootstrap（**已完成**：启动器 + 运行时打包 + 真实 DSH 端到端验证）

**目标链路**：

```
Nomad Launcher → 检测 USB Root → 检测 Runtime → 设置环境 →
启动 DSH → 启动 Web → 打开浏览器
```

**须完成**：nomad launcher ｜ USB root detection ｜ runtime discovery ｜ environment isolation ｜ DSH startup ｜ browser startup ｜ logging ｜ graceful shutdown

**验收**：`插 USB → 启动 Nomad → 浏览器打开 → DSH 可用`

- [x] Launcher + CLI（`launcher/nomad.js`）与 Windows 双击入口（`Nomad.cmd` / `-Stop` / `-Doctor`）
- [x] NOMAD_ROOT 探测（显式 → 环境变量 → 向上查找根标记，显式失败即报错不回退）
- [x] 运行时发现（盘内 Node + `runtime/dsh/current`，未就绪时干净失败并给指引）
- [x] 进程级环境隔离（allowlist + 强制覆盖 + 自证标记）
- [x] 端口不写死，交给 OS 协商（`--port 0`），端口从就绪行回读
- [x] 浏览器交接（恒定 `--no-open`，用带 token 的 URL；2026-10-08 修正打开通道为 `cmd /c start` 并以退出码为判据，见 ADR-0022）
- [x] 日志（监管日志 + DSH 原始输出）与状态文件（含心跳）
- [x] 优雅退出（POSIX `SIGTERM`；Windows 走 `taskkill`，限制已记录）
- [x] 体检 `nomad doctor`（只读：路径 / Secret / 目录 / 运行时 / 隔离 / 端口 / 宿主探针 / **盘内字面量巡检**）
- [x] 退出无残留进程（停止后状态清理；并带 PID 复用安全闸）
- [x] **98 单元测试** + 12 步替身冒烟 + **18 步真实 DSH 冒烟** + 4 步安全闸，全部通过
- [x] **打包运行时**：`runtime/node`（Node 22.23.3，SHA-256 与官方 `SHASUMS256.txt` 比对通过）
      + `runtime/dsh/0.2.1-alpha.1` + `current` **清单指针**（ADR-0016）
- [x] 用真实 DSH 复跑冒烟（`tests/smoke/real-runtime-smoke.js`，**18/18**，含零告警闸 + 前端资源全量闸 + 认证三道闸）
- [x] **真实引擎零污染实证**：宿主 `~/.dsh` 全程未出现；状态全部落盘内 `$DSH_HOME`

> 细节与证据：`docs/PHASE1_LAUNCHER.md`

## Phase 2 — Nomad Web UI

**第一步（已定）：L4-a 最小可行性验证** —— 先证明「自研 `nomad-web-app` bundle 重述 roster、复用官方前端 dist、
不 fork 上游」这条路真能跑通，再谈 UI 投入。理由：Phase 2 全部价值建立在这个前提上，
是**最大的技术不确定性**，而验证成本极低；万一路不通，方案要从"换 bundle"改成"fork/包装"，
是完全不同的工程量 —— 必须早发现。

- [x] **阶段 1：补丁层可叠加进组合树**（`tests/smoke/l4a-patch-probe.js`，9/9）
      → `dsh --profile web --patch <probe> --dump-config` 证明：哨兵只在该叠加层出现、
      总行数不变、被覆盖的行全部落在目标 row 块内、组合树自带来源链（`patched by …`）
- [x] 盘内实据核对：`@deepseek-ai/dsh-web-frontend` **确为独立包**（`dist/` 含 `index.html`），
      `dsh-base` / `dsh-web-app` 均为 `dsh.bundle.patch` 声明的 bundle 包 → **L4-a 前提成立**
- [x] patch 语义与语法摸清（`id:` 覆盖 / `insert:` 插入 / `!!js` 表达式）→ 记入 `UI_ARCHITECTURE.md` §8.5.1
- [x] **阶段 2：自研 bundle 换层**（`tests/smoke/l4a-bundle-probe.js`，8/8）
      → 产物 `packages/nomad-web-app/`（纯声明式 YAML，零构建）；`dsh.bundle.patch` 为 bundle 契约
      → 实测 `bundles` **支持相对路径** → 源留 repo、零复制零漂移（**ADR-0020**）
      → 断言覆盖：`id:` 覆盖生效 + **全量重述不丢键** + `insert:` 插入 + 来源链 + **上游行一行不丢**
- [x] **阶段 2.5：Launcher 接线**（`tests/profile.test.js` 13/13 + `nomad profile` 命令）
      → `launcher/lib/profile.js` 的 `ensureNomadProfile()`：幂等生成 `$DSH_HOME/profiles/nomad/` 三件套，
        bundle 路径**按实际相对距离算出**（禁止手工维护，ADR-0020/0021）
      → 由 `nomad start` 与 `host.js` 双重调用（host 为权威执行点）；保留名守卫 + 逃生舱 `ensure_profile`
      → `nomad doctor` 新增「Nomad profile」只读巡检；`nomad profile [--ensure]` 供人工查看/自举
- [x] **阶段 3：真启动**（`tests/smoke/nomad-profile-smoke.js`，9/9，真实 DSH）
      → 自举出的 profile 被真实 DSH 加载：组合树 1320 行、来源链含自研层、Nomad 身份生效
      → Web UI `303 → 200 text/html 34656B`；宿主 `~/.dsh` 全程未复现
      → 顺带关掉一条待办：`.credentials.yaml` 在盘内 `$DSH_HOME` 生成（ADR-0019 的实测依据）
      → 上游漂移守卫：我们的模板正文与 DSH `initProfile` 产物**逐字**一致

**阶段 4 已落地（2026-10-08）** —— 下面是当日的原计划（保留，作为"为什么这样选"的记录）与结果：

> **2026-10-08 当日更正**：本轮原拟「阶段 4 = L1 纯 YAML 改品牌色，零构建」，**核查上游源码后该假设不成立**：
> `ui-theme` 的 `Config` 只有 `preference`（light/dark/system）+ `fontSize`（10–22），
> `locale` 的 `Config` 只有 `preference`（语言）；颜色令牌 / 界面文案的覆盖**都必须经 `ctx.theme` / `ctx.locale`
> 由插件注册** → 纯 YAML 改不了颜色。但同一轮核查也带回了**更好的消息**（见下）。

- [x] **阶段 4：零构建客户端插件 `nomad-brand`** —— 占侧栏品牌槽，换成 Nomad 北斗七星标识。
      **已实现并在真实 DSH 上验证。**
      → 产物：`packages/nomad-brand/`（`lib/host.js` 空 apply + `lib/client.js` **手写信封** + `package.json`）
      → 挂载：`packages/nomad-web-app/cordis.patch.yml` 的 `nomad` 组内加一行 `nomad-brand`
      → **零构建、零安装、零新依赖**（连 `tsdown` 都不需要），铁律冲突消失。依据与实证见 **ADR-0023**
      → 关键实测更正①：roster 行**相对名的解析基准 = 声明该补丁的包目录**（`packages/nomad-web-app/`），
        **不是** profile 目录 —— 与 `dsh.profile.bundles` 的基准不同，不可互相照抄
      → ⚠️ **关键实测更正②（当日真机返工）**：首版是**哑弹** —— 维护者真机反馈「没有变」。
        根因：**本构建的 profile 就是 `official`**（官方包那句 `if (profile !== 'official') return`
        被构建期死代码消除），官方占用者一直在注册；而两个品牌槽都是 `single`，
        后到者撞 `duplicate declaration` 被拒。⇒ **光挂插件不够，必须让它让位**。
        修法：`cordis.patch.yml` 末尾 `- id: ui-brand-official` + `disabled: true`。
        完整根因、被排除的两条路、以及"为何禁用真能腾出槽"的三处机制依据，见 **ADR-0024**
      → L2 链路已从"未知"变"已证"：真实冒烟第 19 步**四环**断言（进模块图 / 合并模块 200 /
        正文含信封与槽名 / **启动图里官方占用者必须已消失**），缺一即红
      → 另有 `tests/nomad-brand.test.js`（8 例）守住模块**内容**：按浏览器方式执行 client.js，
        断言组件产出的元素树（7 颗星 + 1 条连线 + 枢纽星唯一 + 字标 Nomad + 无硬编码色值）
      → ✅ **2026-10-08 维护者真机人眼确认：侧栏已显示 Nomad 标识，生效。**
        （沙箱起不了 GUI，人眼是本机唯一判据 —— 本条从"实现并验证"正式补记为"人眼验收"。）
- [x] 相关测试债：`l4a-bundle-probe` 里一条关于 group 行的**假失败**断言已修正 ——
      规则是「`config` **必须存在**」，不是「必须为空」（上游 11 处 group 行**全部**装着子行）
- [x] **阶段 5-A：结构层第一步 —— 增量长格（Nomad 自有面板）** —— 2026-10-08 完成
      → 产物：`packages/nomad-panel/`（`lib/host.js` 空 apply + `lib/client.js` 手写信封 + `package.json`）
      → 占两条**增量型**槽：`sidebar.panellist`（list，侧栏入口）+ `main`（keyed，主区面板），
        **两者共用同一个 id 常量 `PANEL_ID = "nomad"`**。挂载 = bundle patch 里一行 `nomad-panel`。
      → **零冲突、零 disable**（与品牌槽的"抢占 + 让位"完全不同 —— 增量型没有竞态）
      → 关键否决记录：**不替换 `sidebar` 槽**。契约原文 *"the seats it declares disappear with it"* ——
        会连带丢掉 `sidebar.workspaces`（会话列表）与 `sidebar.settings`（设置），须自行重写。见 **ADR-0025**
      → 附带修正 ADR-0023 的一处推论：**"改外观"的最优通道是 CSS 变量**（上游 **433 个 `--dsw-*`**，
        主题样式运行时 `<style>` 注入），不是槽位 —— 该通道**保留为后续换肤首选**
      → 骨架内容：品牌头 + 状态区（Build / Panel / Surface / Status）+ 三个计划分区占位 + 回对话按钮
      → **仍待维护者人眼确认**：侧栏是否多出一个 Nomad 图标、点开是否是这块面板
- [x] **阶段 5-B：给面板填真实内容（第一版）** —— 2026-10-08 完成（见 ADR-0030）
      → 数据通道选「路径 B 独立只读端点」：`launcher/lib/status-server.js` 复用 `runDoctor()`+`readState()`+
        读 `VERSION`，聚合成「身份 / 运行态 / 健康度」三类合一的 JSON；面板 `client.js` 低频轮询（缺省 5s）。
      → **固定端口**（`config.status.port`，缺省 3090）桥接 —— 面板是零构建手写产物，读不到运行时随机端口，
        固定端口是唯一零魔法的桥接（`DSH_CLIENT_*` 是构建期内联、`nomad.state.json` 浏览器访问不到）。
      → 生命周期**遵循 DSH**（维护者拍板）：host.js 就绪后起、退出时关，不引入独立长驻进程。
      → 安全三条底线（有测试守）：只读（405）/ 白名单过滤不泄露 token / 只绑 127.0.0.1。
      → 已显示内容：Nomad/DSH/Node 版本、Stage、Phase、URL、Heartbeat、健康度汇总（pass/warn/fail/skip）。
      → 待后续扩展：Session 数、盘内占用、16 项健康度明细列表（数据已就绪，只是第一版未铺开）。
- [x] **阶段 5-C：Nomad 自有外观（换肤）** —— 2026-10-08 完成（见 ADR-0031）。
      → 通道 = `ctx.theme.overrideTokens()`（**非**早期 ADR-0025 的「注入 `<style>`」——后者会被
        `ThemePresenter.apply()` 的内联样式覆盖，overrideTokens 走官方 API、正确协同主题生命周期）。
      → 新增 `packages/nomad-theme/`（零构建手写）：浅色换暖米白大地色系（主背景 #F5EEE8 /
        主色 #C99F8A / 强调 #A87560 / 文字 #332B27 等 9 个 `--dsw-alias-*`），**暗色保持 DSH 默认**。
      → 覆盖 9 个 alias token：bg-base / bg-layer-1/2 / brand-primary / button-primary-hover /
        label-primary/secondary / border-l1/l2（light 换、dark 原值）。
      → 验证：`tests/nomad-theme.test.js` 7 项 + 真实冒烟新增「换肤插件进入模块图」步，21/21 全绿。
- [x] **阶段 3.5：接真实对话轮** —— 2026-10-08 完成（`tests/smoke/real-conversation-smoke.js`）。
      → 用上游 `dsh --profile headless`（one-shot 直接驱动 Agent，不弹 UI、纯 stdout、机器可判定）跑通真实对话。
      → **负向**（零成本）：空 HOME 干净失败于 `MISSING_CREDENTIAL`，证明 key 来自盘内 `.credentials.yaml`、
        不来自宿主环境；**正向**：真实盘内 key 跑通一轮，`session → text → turn_end(completed) → final("NOMAD-OK")`。
      → Session 落盘 `session.v4.jsonl.zstd`（11KB 真实事件日志）。
      → 一次性关掉 V1 清单三条 `~`（DSH Agent 正常工作 / Session 持久化 / 凭据注入）。
      → 关键确认：**key 不需要每次手动填** —— 盘内 `.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 同盘永久有效；
        宿主 `HKCU\Environment` 那份因不在隔离白名单而**不会**进子进程（这反而保住便携性，见 ADR-0019）。
- [ ] **Cordis 客户端插件契约勘探（大部分已完成，见上）** —— 剩余：读 `packages/client/AGENTS.md` 的三条硬纪律
      与 `docs/subsystems/slots.md`，确认 `sidebar.brand.*` 槽的**基数与 props 契约**（已知 props 含 `size`）。
      另：运行时 `cordis_inspect what:"client"` 可查实时槽位树与单槽精确契约（基数 / 占用者 / 替换风险）。
- [ ] **阶段 6（可选）：再验 L4-b**（profile `node_modules` 覆盖 `@deepseek-ai/dsh-web-frontend`）证伪/证实

三个已知硬约束（Phase 0 已定位，`DSH_SOURCE_MAP.md` / ADR-0021）：
- **内置模板名 = 保留名**：`acp / web / headless / sdk / sdk-minimal`（`dsh-app-boot/lib/index.js:529-535`）
  不能作为自建 profile 的目标 → Nomad 自建 `nomad`，由 Launcher 按内置模板 `web` 的 bundles 派生
- L4-b（在 profile `node_modules` 覆盖 `@deepseek-ai/dsh-web-frontend`）**尚未验证**，
  包名覆盖能否在 profile 解析链上生效属推断 → 默认走 **L4-a**
- ⚠️ npm 版 CLI **拒绝插件管理请求**（`dsh plugin`，仅 Desktop 安装版可用）→
  Nomad 的 profile / bundle 需**自己写文件**（`$DSH_HOME/profiles/nomad/package.json` + 自研 bundle 目录），
  不能依赖 `dsh plugin` 命令

随后：Navigation → Layout → Conversation → Tool Cards → Context Panel → Project UI → Session UI → Settings → Theme

**先把 Core UX 做扎实。**

**本阶段不开发**：大型 Memory AI、自动化 Agent Marketplace、多 Agent Society。


## Phase 3 — Nomad Agent OS

> 细化于 2026-10-09（基于实测侦察，见各项「现状」）。铁律不变：**launcher-only**、
> 零新依赖、路径从 `NOMAD_ROOT` 派生、不碰 DSH 模块图、不打"看起来能工作"的勾。
> DSH 内部契约一律以 `vendor/deepseek-harness/` 上游源码为准（npm 包只发 `lib/`，
> 无源码树 —— 2026-10-09 实测）。

### 3.0 契约勘探（前置，全部只读）

- [ ] **Skill 契约**：上游 `packages/skill/` 的 skill 存放目录、清单格式、加载时机
      （`DSH_SOURCE_MAP.md` 第 8 行仅记了包位置，无目录契约）→ 产出补进 `DSH_SOURCE_MAP.md`
- [ ] **存储全景勘探**：`data/dsh-home/` 下 `sessions/` `storages/session_projcache` `storages/workspace.json`
      `AppData/` `Documents/` 逐一体积、增速、归属（哪些是"记忆"，哪些是缓存可清理）
- [ ] **Permissions 消费方勘探**：上游 DSH 的权限系统长什么样（`packages/` 里有无
      permission/approval 机制）、Nomad 的 `config/permissions.yaml` 模板该由谁消费
      （launcher 注入？面板展示？还是仅作规范文档）—— 勘探完才定 3.4 的形状

### 3.1 Profiles 管理器（基础最厚，先做）

现状：引擎已真实创建 `headless` / `nomad` 两个 profile（`data/dsh-home/profiles/`），
Launcher 自举 `nomad` profile 已被真实 DSH 加载；`web` 是**内置保留名**不可占用
（`profile-boot.ts:116-131`）；profile 结构 = `package.json`（bundles 相对 profile 目录）
+ `cordis.yml`（恒 `[]`）+ `cordis.patch.yml`（insert: group 三键缺一不可）。

- [x] `nomad profile list` —— 列出全部 profile + 哪个是当前启动用的 + 来源（自举/引擎/用户）
      **（2026-10-09 完成**：真实盘列出 headless/nomad/web 三个全部有效，default 打标）
- [x] `nomad profile create <name>` —— 从模板生成合法骨架（校验保留名、名字合法性）
      **（2026-10-09 完成**：4 文件骨架与上游 `initProfile` 形状一致；已存在即拒绝绝不覆盖；
      实测中一次「刚建就说已存在」的怪象定性为**沙箱拦截部分写盘 + 提权重试撞残留**，非代码缺陷）
- [x] `nomad profile validate <name>` —— 结构校验（package.json 可解析、bundles 路径存在、
      patch 语法），集成进 `doctor` 第 18 项 —— **（2026-10-09 完成**，doctor 18 项全通过；
      含一个重要发现：上游模板 patch 文件是流式 `[]`，`yaml-lite` 只支持块式 →
      校验器短路兼容，不改公共解析器）
      （注：3.2 落地后 doctor 为 **19 项**）
- [x] 启动选择：`nomad start --profile <name>`（默认仍 `nomad`）—— **（2026-10-09 完成**：
      dry-run 实测 argv 正确携带覆盖名；保留名/路径分隔符在启动前即拒绝）
- [x] 单测 + 替身冒烟覆盖上述每条 —— **（2026-10-09 完成**：`tests/profiles.test.js` 9 例，
      全量 **177/177 全绿**）

### 3.2 Skills 管理（依赖 3.0 的契约结论）

现状：`skills/` 是空目录基线，无任何管理能力。

- [x] `nomad skill list` —— 按 3.0 确定的格式列出盘内 skill（名称/形态/启用态）
      **（2026-10-09 完成**：目标目录锁定 `data/dsh-home/skills/`（user-dsh 根，rank 400）；
      两种合法形态 `<name>/SKILL.md` / `<name>.md` 逐字对齐上游 `isPotentialSkillPath`；
      无效项带问题清单（DSH 对非法 skill 只是**静默跳过** —— list 把它变成看得见）；
      `.system` 保留名与非 skill 条目归入 ignored 并说明原因）
- [x] `nomad skill add <path>` / `remove <name>` —— 目录级安装与卸载（不碰网络下载，
      安装源=本地路径或 git URL 由维护者手动 clone，保持零依赖）
      **（2026-10-09 完成**：装前校验「会被 DSH 忽略的 skill」直接拒绝安装，把
      「装了但不生效」挡在门外；已存在绝不覆盖；复制不用 `fs.cpSync` 而是自写递归
      复制（行为可控 + 兼容受限执行环境）；热生效 —— DSH 对 skill 根做文件 watch
      （`skills/change` 事件），装/删无需重启实例，真机实测通过）
- [x] 状态端点展示已安装 skill 数与清单（5-B 数据面扩展）—— **（2026-10-09 完成**：
      `/status` 新增 `skills` 段（base/total/valid/invalid/ignored/items），
      面板状态区新增 Skills 行（数量 + 有效项名称））
- [x] 单测覆盖（含畸形 skill 目录不崩溃）—— **（2026-10-09 完成**：
      `tests/skills.test.js` 11 例；`doctor` 第 19 项「Skills 巡检」同步落地）
- [x] 内置示例 skill `docs/examples/skills/hello-nomad/`（随盘入库；
      `nomad skill add docs/examples/skills/hello-nomad` 一键安装体验全链路）

### 3.3 Memory / 数据面管理（依赖 3.0 的存储全景）

现状：`nomad projects` 已能读 `workspace.json`；sessions 落盘格式已验证（阶段 3.5）。
**3.0-B 勘探结论（2026-10-09 实测，全盘 data/ 仅 ≈5 MB）**：

| 归属 | 目录 | 实测 | 3.3 处置 |
| --- | --- | --- | --- |
| 长期-核心 | `dsh-home/sessions` `dsh-home/storages` `dsh-home/profiles` | 28.9 KB / 16.6 KB / 2.2 KB | **永不清理**，备份覆盖 |
| 长期-引擎私有 | `dsh-home/AppData`（HOME 重定向产物）`dsh-home/Documents` | 1.5 KB / 空 | 不清理 |
| 半长期 | `logs/`（诊断）`backups/` | 96.6 KB / 22.5 KB | 可轮转，不在 3.3 范围 |
| 运行时态 | `run/` | 1.5 KB | 生命周期管理已覆盖 |
| **可清理** | `data/tmp/`（quarantine / smoke 残留 / 引擎 `dsh-acl-skill-*` 临时目录）`dsh-home/tmp` | **4.3 MB / 393 文件** | `storage clean` 白名单目标 |
| 增长源观察 | 引擎每次运行生成 `dsh-acl-skill-*`（实测已有 5 个同型 51 KB 目录） | — | clean 需按前缀+时间规则清 |

- [x] `nomad storage` —— 盘内数据全景报告：各目录体积/文件数/最近写入时间，
      区分「长期数据」（sessions/workspace/profiles）与「可清理」（tmp/AppData 缓存）
      —— **（2026-10-09 完成**，`launcher/lib/dataman.js`；data/ 一级目录三档归类
      （长期-核心 / 可清理 / 轮转 / 其他），dsh-home 拆分展示「不含 tmp」长期部分）
- [x] `nomad storage clean --dry-run` / 实际清理（只清 3.0 勘探确认可清理的白名单目录，
      **绝不进 sessions**；清理前强制确认 flag）—— **（同日完成**，白名单写死
      `data/tmp` + `data/dsh-home/tmp`；时间规则 = 整条目递归最新 mtime 超过
      `--min-age`（默认 120 分钟）才可清，运行中实例的 ACL 授权目录自动受保护；
      `--dry-run` 预览、实际清理必须 `--yes`；doctor 第 20 项「数据面巡检」超
      10MB/500 文件 WARN；/status 新增 data 段，面板加 Data 行）
- [ ] 会话导出（可选）：`session.v4.jsonl.zstd` 解包为可读 Markdown（给"换机带走记忆"一个人类可读形态）
      —— **推迟**：zstd 解码需要第三方依赖，违反零依赖铁律；等上游暴露可复用解码入口再评估
- [ ] 单测 + 只读保证验证

### 3.4 Permissions 落地（依赖 3.0 的消费方勘探结论）

现状：`config/permissions.yaml` 是完整模板（8 级 + never 硬禁止清单），**但无任何代码消费它**。
**3.0-C 勘探结论（2026-10-09 源码级）**：上游有完整原生权限体系 —— 两个正交旋钮
`SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`
（`sandbox/sandbox-policy/src/session-mode.ts:42`）× `ApprovalPolicy = 'ask' | 'never'`
（`interaction/user-approval/src/index.ts:70`），由 `permission-presets` 服务组合成
用户档位（`/permission` 命令写入 + settings `defaultPreset`；sandbox 切换本身是
事件溯源的 `sandbox/mode` session 事件）。**Nomad 的 8 级模型与上游不对应，
禁止 launcher 侧自造桥接改写上游旋钮**（会对抗其事件溯源设计）。

- [x] 按 3.0 结论接线：launcher 在 `--dry-run` 与 `doctor` 中展示生效的权限档位（最低限度）；
      若上游有原生 approval 机制则评估桥接而非自造 —— **（2026-10-09 完成**：
      `launcher/lib/permissions.js` 只读展示 + never 机械自证；**明确不桥接**——上游
      SandboxMode × ApprovalPolicy 是事件溯源设计，Nomad 8 级模板保持契约声明身份，
      上游原生体系才是生效面。自证锚点：宿主隔离 allowlist（modify_system_env/registry）、
      路径守卫（write_outside）、清单指针 + track_master=false（upgrade_dsh_master）；
      delete_user_data/auto_git_push 无机械锚点，诚实标注「契约级约束」不假装通过）
- [x] `never` 清单（改环境变量/改注册表）至少在 `doctor` 中自证与宿主隔离约束一致 ——
      **（并入上条：doctor 第 21 项逐条 ✓/✗ 展示，失锚条目 FAIL）**
- [x] 单测覆盖配置解析与非法值拒绝 —— **（tests/permissions.test.js 10 例：未知类别/
      未知取值/未知 never id/重复条目/敏感类别提升为 allow/缺类别/文件缺失/顶层非映射）**

### 3.5 Runtime Manager（CLI 已有底子，补"更新"与自动化）

现状：`rollback`（列表/切换/校验）与 `backup`/`restore` 已在 V1 落地。

- [x] `nomad update --check` —— 只读查询 npm registry 上游 `@deepseek-ai/dsh` 最新版本，
      与盘内 `current` 对比（不自动升级 —— 铁律：升级必须维护者手动触发）
      —— **（2026-10-09 完成**：`launcher/lib/updater.js`，自带 semver 比较器（含 prerelease
      规则）；真机实测：registry 最新 0.2.0-rc.2 < 盘内 0.2.1-alpha.1 → 判「盘内更新，不动作」）
- [x] `nomad update` —— 下载新版到 `runtime/dsh/<version>/`（SHA-256 校验沿打包流水线），
      **完成后指向新版的仍是 current 指针改写**，旧版本目录保留 → 回滚天然可用
      —— **（2026-10-09 完成**：校验锚点用 registry `dist.integrity`（sha512 SSRI，强于
      SHA-256，不匹配绝不落盘）；链路 = 下载 → 校验 → 系统 tar 解包拍平 → 盘内 npm-cli
      `install --omit=dev` 重建依赖树 → `buildNextManifest` 改指针（入口真实存在才写）；
      **实际升级必须 `--yes`**，运行实例存活时改指针必须 `--force`（与 rollback 同姿态）；
      版本目录已存在不覆盖）
- [x] 备份自动化（可选）：start 时检查上次备份距今天数，超阈值在 `status` 提示（不自动执行）
      —— **（2026-10-09 完成**：`lastBackupInfo`（30 天阈值 `BACKUP_HINT_DAYS`），start 输出
      备份提示行；/status data 段带 `lastBackup`（面板渲染归 3.6））
- [x] 单测（registry 查询用注入的 fetch 替身，测试不碰网络）—— **（tests/updater.test.js
      11 例**：semver 比较 / fetch 替身四种判定 / 完整性校验与拒落盘 / 真实 tgz 夹具解包拍平 /
      npm argv 形状与 spawn 注入 / 指针改写守卫；**依赖安装的 spawn 全部异步**——沙箱杀
      spawnSync 的记忆教训再次生效）

### 3.6 面板整合（把 3.1–3.5 的能力变成看得见的）

- [x] 状态端点扩展：profiles 段（数量/默认 profile/逐项有效性）、permissions 段（档位摘要/never 条数/问题数）、update 段（回读 `data/run/update-check.json` 检查留档）；skills/data 两段 3.2/3.3 已有，直接复用。**端点零网络**：可更新提示不走轮询路径上的 registry 查询，而是 CLI `nomad update` 检查成功时落盘留档（`saveUpdateCheck` 白名单字段 + checkedAt），端点只回读 —— 与 doctor 30s 缓存同一设计哲学（5s 轮询路径上只允许单文件级 I/O）
- [x] 面板新增区块渲染：状态区新增 Profile / Permissions / Backup / Update 四行（Skills/Data 行已有）；降级契约不变 —— 段缺失就跳过该行，绝不崩
- [ ] 真机闭环：U 盘部署 → 全部新命令在盘上实跑 → 面板人眼确认（V1 验收清单同款标准）
      ⚠️ **2026-10-09 卡点**：E 盘「既有文件」被系统级写保护（写/改名/删除全拒，新建放行；
      非沙箱进程同样被拒；凌晨 02:50 时仍可写 —— 当日新变化，疑似安全软件/U 盘保护开关）。
      代码已全量 223/223 绿并提交；等保护解除或由维护者在本机终端手动执行
      `node tools/deploy-usb.js --target E:\ --app-only --force` 后补真机验收

### Phase 3 验收总原则

1. 每个子项完成 = 代码 + 单测 + 文档三件套齐，缺一不勾
2. 所有新命令遵守现有 CLI 风格（`launcher/nomad.js` 分派 + `launcher/lib/` 纯函数拆分）
3. 涉及 DSH 内部契约的结论必须先落 `DSH_SOURCE_MAP.md` 再写代码
4. 阶段完成时更新 `VERSION` 的 `STAGE` 与本清单

---

## V1 验收清单

> 标注规则：`[x]` = 已实现**且已验证**；`[~]` = 已实现但缺真机/真运行时确认；`[ ]` = 未开始。
> 不打"看起来能工作"的勾（AGENTS.md 第 11 节）。

- [x] USB 启动 —— **2026-10-08 真机闭环**：部署到 `E:\`（**exFAT** 30GB U 盘，32,145 文件 / 604.2 MB），
      在该盘上 `doctor` 报 14 OK / 1 WARN（profile 未初始化，属全新盘的预期状态）；`nomad start` 成功
      自举 profile 并起 Web（认证握手 `303 → 200`，端口 44640 由 OS 协商），浏览器交接完成。
      工具 `tools/deploy-usb.js`；见 `docs/DEPLOY.md`、**ADR-0027**（部署）、**ADR-0028**（盘符根假越界修复）
- [x] 不要求目标机器安装 Node（盘内 `runtime/node` v22.23.3 已打包，真实冒烟实测走的就是它）
- [x] 不要求目标机器安装 pnpm（启动器零依赖，全程无构建步骤）
- [x] 浏览器打开 Web UI —— **2026-10-08 维护者真机人眼确认：界面正常打开**。交接链路：带 token URL +
      `--no-open` + `cmd /c start`（**不再用 `explorer.exe`**，见 ADR-0022）+ 退出码判据 +
      交付前认证握手自检（`303 铸 cookie → 200`）；`nomad open` 在真机以退出码 0 完成交接。
      此前留 `~` 是因为沙箱内起不了 GUI、我无法自证渲染 —— 现由维护者人眼闭环
- [x] DSH Agent 正常工作 —— **2026-10-08 真实对话轮跑通**（阶段 3.5）：`dsh --profile headless` 用真实盘内
      凭据完成一轮对话，模型返回 `NOMAD-OK`，`turn_end: completed`（此前只验证过「Web UI 能起」，现补上「真能对话」）
- [x] Session 持久化 —— **2026-10-08 真实会话落盘**：`session.v4.jsonl.zstd`（11KB 压缩事件日志），
      磁盘布局 `sessions/<projectKey(cwd)>/<sessionId>/session.<v>.jsonl.zstd` 与源码契约一致
- [x] Project 持久化（**2026-10-08 收尾**：`nomad projects` 只读列出盘内 DSH 工作区/项目，
      数据已在 `data/dsh-home/storages/workspace.json` 持久化，命令把"Persistent"价值变成可见可验证事实）
- [~] Skill 持久化（目录基线已建，管理能力属 Phase 3）
- [~] Profile 持久化（真实引擎已在盘内建立 `profiles/web`；**自建 `nomad` profile 已由 Launcher 自举
      并被真实 DSH 加载**，组合树 1320 行含自研层来源链 —— 见阶段 2.5/3。剩「用户自定义 profile 管理」属 Phase 3）
- [x] 配置持久化（`config/nomad.yaml` + 强制校验；占位符展开有测试）
- [x] Runtime 与 Data 分离（目录分离 + 版本化 runtime 布局 + 启动器约束）
- [x] 基本 Host Isolation（白名单 + 覆盖 + 自证标记；单测、替身冒烟与**真实引擎**三重验证）
- [x] Launcher
- [x] CLI（`nomad start/stop/restart/status/doctor/env/paths/logs/url/open/version` **+ 2026-10-08 新增
      `rollback` / `backup` / `restore` / `projects`**）
- [x] Logs（监管日志 + DSH 原始输出 + 尾部查看）
- [x] Doctor（只读体检，**21 项**：含宿主污染探针、**盘内字面量目录巡检**、**全部 profile 巡检（3.1）**、运行时包完整性（**锁文件对账**）、
      Nomad profile 巡检、浏览器交接命令、Web 认证握手、**Skills 巡检（3.2）**、**数据面巡检（3.3）**、**权限档位与 never 自证（3.4）**）
      > 2026-10-08 更新：新增第 17 项「盘内字面量目录巡检」（`scanLiteralDirs`）——
      > 检出形如 `%VAR%` / `${VAR}` 的目录名（环境变量未展开的痕迹）。见 ADR-0033。
- [x] **修复运行时残缺包**（4 个：`dsh-client-ui-sidebar-documentpreview`、`dsh-experimental-inspector`、
      `libreoffice-kit-win32-x64`、`@img/sharp-win32-x64`）—— **已修复并验证**。
      真实根因（**更正**：原先记的「打包期被中断的 npm install」是错归因）：
      顶层 `node_modules` 下只剩残骸（有 `lib/` 无 `package.json`），**正确嵌套位置整份缺失**；
      而 npm 信任 `.package-lock.json`，所以**重跑 `npm install` 无效** ——
      必须先 `rename` 把这 4 个目录挪走再装，才能触发真实补齐（实测 `added 24 / removed 70`）。
      修后 `documentpreview failed to import` 告警消失；检测器改为**锁文件对账**，
      `nomad doctor` 第 8 项守这条。
- [x] Runtime version（`runtime/dsh/0.2.1-alpha.1` + `current` 清单指针，doctor 会列可用版本）
- [x] Rollback（**2026-10-08 收尾**：`nomad rollback <version>` 改写 `current` 的 `entry` 即回滚；
      运行实例存活时拒绝除非 `--force`，因只影响下次启动。依据 ADR-0032）
- [x] Backup（**2026-10-08 收尾**：`nomad backup` 把 `data/dsh-home` 零依赖递归复制到
      `data/backups/nomad-backup-<ts>/` 并附 `backup-manifest.json`；`nomad restore` 合并回放。依据 ADR-0032）
- [~] Typecheck / Lint（本项目无 TS/构建工具链；以 `node --test` 单元测试 + 冒烟测试替代，见 §Quality Gate 说明）
- [x] Test（**159 单元测试 / 12 步替身冒烟 / 20 步真实冒烟（含零告警 + 前端资源全量 + 认证三闸 +
      L2 客户端插件四查 + Nomad 自有面板三查）/ 4 步安全闸 / 9 步 L4-a patch 探针 / 8 步 L4-a bundle 探针 /
      9 步自举 profile 真实冒烟 / 只读 UI 资源巡检**）
- [x] Build（运行时打包完成并通过 SHA-256 校验；打包产物经真实冒烟验证可运行）
- [x] Portable Smoke Test（`tests/smoke/portable-smoke.js` 替身 + `real-runtime-smoke.js` 真实）
- [x] **开源发布** —— **2026-10-08 已上线**：公开仓库
      [**iCurrer/nomad-agent-os**](https://github.com/iCurrer/nomad-agent-os)（**MIT**，Copyright (c) 2026 iCurrer），
      首推提交 `d2dd64a`（97 文件 / 17,925 行 / 854 KB）。合规四件套齐备：`LICENSE`、
      `THIRD_PARTY_NOTICES.md`（561 个传递依赖，**无 GPL/AGPL 强 copyleft**，MIT 发布无传染）、
      `.gitattributes`、README「归属与许可」章节；上游 DSH 亦为 MIT；**Core Patch 数 = 0**。
      入库红线（已逐项核验线上确实不含）：`data/`（含明文凭据）、`runtime/`(664M)、`vendor/`、
      `.cache-dev/`、`.workbuddy/`。

---

## 最终产品哲学（验收总纲）

**不要做**：「DeepSeek Harness 的一个皮肤。」
**要做**：「一个以 DSH 为 Agent Engine 的 Portable Agent OS。」

7 大核心价值：Portable ｜ Persistent ｜ Personal ｜ Extensible ｜ Upgradable ｜ Recoverable ｜ Secure

| 用户行为 | 期望结果 |
| --- | --- |
| 换电脑 | Agent 不换 |
| 换系统 | Agent 不换 |
| 换 USB | Agent 可迁移 |
| 升级 Runtime | Memory / Project / Session 不丢 |
| 升级 DSH | Nomad 可回滚 |
