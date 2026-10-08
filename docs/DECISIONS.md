# DECISIONS.md — 架构决策记录（ADR）

> 规则：任何「为什么这么做」的结论都写在这里，而不是散落在代码注释或聊天记录里。
> 新决策**追加**，不覆盖历史。

## 模板

```
### ADR-XXXX 标题
- 日期：
- 状态： proposed | accepted | deprecated | superseded by ADR-XXXX
- 背景：
- 决策：
- 放弃的方案：
- 后果（正面 / 负面）：
- 验证方式：
```

---

## ADR-0001 Runtime 与 Data 分离
- 日期：2026-10-08
- 状态：accepted
- 背景：DSH 处于 developer preview，Runtime 必须能升级；而用户的 Session / Memory / Project 是不可再生的核心资产。
- 决策：`runtime/` 与 `data/` 物理分离；`runtime/` 可替换/升级/回滚/重下，`data/` 长期存在；一切路径从 `NOMAD_ROOT` 派生。
- 放弃的方案：Runtime 与 Data 混放（升级即丢数据）；把数据放宿主机用户目录（不可移植）。
- 后果：升级路径清晰、可回滚；代价是启动器需要处理版本切换与迁移。
- 验证方式：Runtime Smoke Test（切版本后 `data/` 不变）。

## ADR-0002 不重写 DSH 引擎，做产品层
- 日期：2026-10-08
- 状态：accepted
- 背景：从零实现 Agent Loop / Session / Tool Runtime 的成本与维护风险极高，且会与上游持续冲突。
- 决策：Nomad = Product / OS Layer；DSH = Agent Engine。优先 Configuration > Extension Point > Plugin > Profile > Adapter > Slot，Core 修改为最后手段并强制登记。
- 放弃的方案：Fork 后大面积改 Core；自建第二套 Session / Agent Loop。
- 后果：可跟随上游演进；代价是部分需求可能受扩展点限制。
- 验证方式：`docs/UPSTREAM.md` 中 Core patch 数量保持最小。

## ADR-0003 Browser-first，CLI 管生命周期
- 日期：2026-10-08
- 状态：accepted
- 背景：主 UI 需要跨平台、零安装、可深度定制。
- 决策：主 UI 走浏览器（`127.0.0.1:<port>`，端口自动协商）；CLI 只负责生命周期、诊断、Runtime、Project 管理，**不复制 Agent Loop**。
- 放弃的方案：Electron 优先（包体大、便携性差）；纯 CLI（体验差）。
- 后果：跨平台成本低；代价是浏览器环境能力受限。
- 验证方式：Portable Smoke Test 第 3 步。

## ADR-0004 Windows x64 优先
- 日期：2026-10-08
- 状态：accepted
- 背景：多平台同时推进会让 Launcher / 环境隔离 / 进程管理复杂度爆炸。
- 决策：第一阶段只交付 Windows x64；Linux x64 第二；macOS 第三。平台差异通过抽象层（runtime / launcher / path / environment / browser / process）隔离。
- 放弃的方案：一开始就全平台并行。
- 后果：可快速拿到可用版本；代价是抽象层设计需要预留。
- 验证方式：Phase 1 在 Windows x64 通过 Portable Smoke Test。

## ADR-0005 Portable Release 不含构建步骤
- 日期：2026-10-08
- 状态：accepted（后被 **ADR-0006** 强化，见下）
- 背景：目标机器不应要求 Node / pnpm / node_modules，也不应现场编译。
- 决策：发布物 = 已构建的 Portable Runtime；开发机负责 Source → Patch → Build → Package。
- 放弃的方案：用户机首次启动时 `pnpm install && build`（不可控、慢、易失败）。
- 后果：启动快、依赖可控；代价是发布流水线更重（后续用 GitHub Actions 生成多平台产物）。
- 验证方式：无 Node 环境机器上执行 Portable Smoke Test。

## ADR-0006 用户机零编译 + 离线运行时
- 日期：2026-10-08
- 状态：accepted
- 背景：需求明确要求「U 盘插上打开就是浏览器页面」，而 DSH 源码运行需要 `pnpm install && pnpm run build`，普通电脑无环境且极慢。
- 决策：**构建期与运行期彻底分离**。构建只在开发机 / CI 发生一次；U 盘内是**已构建产物 + 自带 Node**，用户机零编译、零 npm、零 Node 安装。启动路径**禁止出现 `npx`**（会联网访问 registry）。
- 放弃的方案：首次启动现场安装构建（不可控、慢、极易失败）；要求用户装 Node。
- 后果：启动快、体验是「双击即用」；代价是发布产物体积大、需要在开发机维护构建流水线。
- 验证方式：`docs/TESTING.md` §4 Portable Smoke Test（在无 Node 的清洁机器上执行）。

## ADR-0007 便携基线采用 npm 已构建包（流派 A）
- 日期：2026-10-08
- 状态：accepted
- 背景：`@deepseek-ai/dsh` 在 npm 上的发布物**已经是构建产物**，无需编译即可运行；而源码流派体积大。
- 决策：`runtime/dsh/` 基线放**预置的 npm 包**（`delivery: npm-bundled`，锁定版本，不自动升级）；自研 UI 以「预构建独立 bundle 包」形式放入 profile 的 `node_modules`。
- 放弃的方案：以源码流派为基线（体积大、版本管理复杂）。
- 后果：体积小、启动快；代价是 ⚠️ **npm 版 CLI 拒绝插件管理请求**，插件依赖需手写进 profile `package.json`（Phase 0 需验证该限制的实际影响与绕过方式）。
- 验证方式：Phase 0 在本地源码中确认插件解析路径是否依赖 `dsh plugin`；若必须，则对特定 profile 切换为流派 B。

## ADR-0008 UI 深度定制走 web bundle / patch，不 fork monorepo
- 日期：2026-10-08
- 状态：accepted
- 背景：需求要求页面「深度定制」，但 fork 整个 DSH monorepo 会导致构建重、上游冲突大。
- 决策：走官方插件通道，顺序为 ① `cordis.patch.yml` 配置层覆盖 → ② 自研 `nomad-web-app` bundle 替换 `@deepseek-ai/dsh-web-app` → ③ 万不得已才 fork 单个 `dsh-web-app` 包。**不 fork monorepo、不改 DSH Core。**
- 放弃的方案：fork monorepo 后大面积改前端。
- 后果：可跟随上游升级；代价是定制能力受插件扩展点上限约束（Phase 0 需测出该上限）。
- 验证方式：用 `dsh --dump-config` 确认组合树；`docs/UI_ARCHITECTURE.md` §8.4 的 6 个问题全部有答案。

## ADR-0009 UI 定制上限已实测：五级梯度，L1–L4 均无需 fork
- 日期：2026-10-08
- 状态：**verified**（由 ADR-0008 的候选升级为定案）
- 背景：ADR-0008 留下的悬案是「定制能力受插件扩展点上限约束」——上限到底在哪。
- 证据（源码级，commit `5badb15`）：
  - profile 清单类型 `DshProfileManifest { bundles?: string[] }`（`util/package-manifest/src/types.ts:75`）→ **自研 bundle 可进 `bundles` 列表**
  - `cordis.patch.yml` 手写语义：**按 id 覆盖整行**、`insert:` 新增行（`bundle/web-app/cordis.patch.yml` 文件头）
  - 客户端插件契约仅 4 字段：`DshClientManifest { platform, inject?, immediately?, external? }`（`types.ts:81`）
  - 宿主**按 Loader 条目增量扫描** `dsh.client`，bundle 走 `/plugins/<id>/<file>`，**请求时 `readFileSync` 从包目录现场读**（`client/modules/src/index.ts:1-20 / :225 / :1088 / :1109`）
  - 官方层级树 + 四轴基数（`single`/`list`/`keyed`/`chain`）× 三作用域（`docs/subsystems/slots.md`）
  - 官方对表现层的定性：*"consumables, expected to be rewritten wholesale"*（`packages/client/AGENTS.md`）
  - 品牌包官方明示：*"deployments with another identity should provide a replacement brand package"*（`ui-brand-official/README.md`）
- 决策：确定 **L1 Token → L2 Slot 增量 → L3 Slot 接管 → L4 Bundle 整体替换 → L5 Fork** 五级梯度；
  Nomad 的目标定在 **L4**（自研 `nomad-web-app` bundle 接管 UI），**不进入 L5**。
- 后果：
  - ✅ 深度定制与「用户机零编译」不再矛盾 —— 自研 UI 包在**开发机/CI 构建一次**，产出物随 U 盘携带
  - ✅ UI 插件可在运行时装卸（增量扫描 + 现场读取），换肤/换品牌无需重打包 dist
  - ⚠️ 代价：Nomad 必须自行维护一个对上游 roster 的**重述式 patch**；DSH 升级时该 patch 需同步（登记进 `UPSTREAM.md`）
- 验证方式：在开发机构建一个最小 `nomad-web-app` bundle（品牌槽位替换），确认 ① profile `bundles` 能加载 ② 浏览器显示 Nomad 品牌 ③ 全程无 DSH Core 改动。

## ADR-0010 Nomad 的接入面 = 观察者 + 配置层 + 槽位，绝不碰 Agent Loop
- 日期：2026-10-08
- 状态：accepted
- 背景：Phase 0 走读完「用户发一条消息 → DSH 内部发生了什么」（`docs/DSH_SOURCE_MAP.md` 调用链 A）后，需要确定 Nomad 到底「挂在哪里」。
- 证据（源码级）：
  - 心跳是 **收件箱 → 驱动器 → 轮 → 步 →（模型流 | 工具执行）→ 事件追加** 六段式；`ReactLoopAgent.kick/turn/step`（`core/agent-loop/src/agent.ts:252/296/398`）
  - **唯一事实源是 `Session.append()` 推进的内存日志**（`core/session/src/index.ts:757`）：先 `deepFreeze` + schema 校验（`:740-748`），push 后**同步**派发 `session/event`（`:760`）
  - **持久化只是观察者**：`ctx.on('session/event', …)` → `storage.append()`（`session-persistence-jsonl/src/storage.ts:535 / :187`）；投影缓存、遥测、标题生成同样是观察者
  - 三个现成瀑布/串行扩展点：`agent/pre-step`（`:276`）、`agent/request-error`（`:494`）、`agent/turn-stopping`（`:360`）
- 决策：Nomad 只在四类位置介入 —— ① `session/event` 全局观察者（自有数据层）② `agent/pre-step` / `agent/request-error` / `agent/turn-stopping`（策略层）③ `/plugins` + `dsh.client`（L2/L3 UI）④ `bundles` + `cordis.patch.yml`（L4 UI）。
  **不实现、不包装、不替换 Agent Loop / Session / Tool Runtime。**
- 放弃的方案：自建编排层包装 `ctx.agents`（会立刻产生第二事实源与双写风险）。
- 后果：与上游升级解耦，Nomad 的体积与复杂度集中在「产品层」；代价是策略能力受这三个瀑布的既有契约约束。
- 验证方式：Nomad 自有数据层实现后，断言**不修改**任何 `packages/core/*` 文件；`UPSTREAM.md` 的 Core patch 计数保持 0。

## ADR-0011 L4 默认走「复用官方前端 dist + 自研 bundle/插件」（L4-a）
- 日期：2026-10-08
- 状态：accepted（L4-b 待 Phase 1 实测）
- 背景：发现前端产物 `@deepseek-ai/dsh-web-frontend` 是**独立 npm 包**（`apps/web/package.json`），
  `bundle/web-app` 只以 `workspace:*` 依赖它并在运行时 `require.resolve` 取 `dist/index.html`（`bundle/web-app/src/index.ts:181`）→ 前端与 bundle 解耦，L4 出现两条通道。
- 决策：**默认走 L4-a** —— 自研 `nomad-web-app` bundle 重述 roster，**复用官方前端 dist**，深度定制由 L2/L3 插件包（Slot）承载。
  仅当 L2–L4-a 被证明不足时，才考虑 L4-b（覆盖 `@deepseek-ai/dsh-web-frontend` 包名换自研 dist）。
- 放弃的方案：一上来就整体替换前端 dist（L4-b）—— 包名覆盖的解析链**尚未验证**，是脆弱点。
- 后果：改动面最小、上游前端升级可继承；代价是布局骨架级改造必须通过 bundle 与槽位完成。
- 验证方式：Phase 1 做最小实验 —— ① L4-a 加载自研 bundle 成功 ② 单独试探 L4-b 覆盖是否在 profile 解析链上生效，结论回写 `UI_ARCHITECTURE.md` §8.5。

## ADR-0012 引入 Runtime Host 监督进程（三层进程模型）
- 日期：2026-10-08
- 状态：accepted（已实现并验证）
- 背景：后台启动时 CLI 必须退出，但 DSH 的就绪 URL 只出现在它的 stdout 上（`bundle/web-app/src/index.ts:290`）；
  同时"优雅退出"需要一个仍在场的进程把停止意图转达给 DSH 并等待收敛；状态文件也需要唯一写入者。
- 决策：采用三层进程模型 —— **CLI（`launcher/nomad.js`）→ Runtime Host（`launcher/host.js`）→ DSH**。
  Host 只负责进程与生命周期，**不碰** Agent Loop / Session / Tool Runtime。
- 放弃的方案：① CLI 直接拉 DSH（后台模式无法读取就绪行，且无法优雅停止）；
  ② 用 `messages.json` 之类的旁路手段让 CLI 猜状态（违反铁律 13，且事实源会被污染）。
- 后果：多一层进程，换来可解析的就绪信号、可验证的停止路径、明确的状态所有权；Host 层也天然成为日志与诊断的边界。
- 实现要点：后台模式下 Host **不建立 IPC 通道** —— 一个打开的 IPC 通道会把 CLI 的事件循环钉住，
  导致 `nomad start` 打印完就绪信息后无法退出（这是实现期真实踩到的 bug，已修）。
- 验证方式：`tests/smoke/portable-smoke.js` 第 3 步断言 `nomad start` 必须**返回退出码 0**（即 CLI 确实退出）。

## ADR-0013 端口交给 OS 协商，启动器从 URL 行回读
- 日期：2026-10-08
- 状态：accepted（已实现并验证）
- 背景：手册要求"端口不要永久写死，占用时自动寻找可用端口"。
  常规做法（探测空闲端口 → 关闭 → 再绑定）存在**竞态窗口**。
- 决策：`web.port: 0` → 启动器直接传 `--port 0`（`bundle/web-app/src/startup.ts:61` 明确支持），
  端口由 OS 分配，启动器从 `dsh web:` 就绪行回读实际端口。配置非 0 时才使用固定端口。
  依据还包括上游自身的做法（`apps/desktop-host/src/index.ts:30`）。
- 放弃的方案：自己实现端口扫描 —— 徒增竞态面，且需要额外的失败重试路径。
- 后果：零端口冲突；端口与 URL 天然一致（同一个来源，不会出现"报告端口 ≠ 实际端口"）。
- 验证方式：冒烟测试断言 `state.port > 0` 且 `state.command` 含 `--port 0`，并对 `publicUrl` 做 HTTP 探测。

## ADR-0014 浏览器交接权归 Nomad（恒定 `--no-open` + 带 token 的 URL）
- 日期：2026-10-08
- 状态：accepted（已实现并验证）
- 背景：DSH 默认会自己打开浏览器（`openBrowser` 默认 true，`bundle/web-app/src/index.ts:71`），
  且必须用**带 launch token 的 URL**（否则根路径 401，见 `browser-auth.ts:223-245`）。
- 决策：启动器恒定传 `--no-open`，由 Runtime Host 解析就绪行后**自己**打开浏览器。
  日志与 `status` 只显示脱敏地址；带 token 的完整 URL 仅写入权限 0600 的状态文件，`nomad url` 才输出。
- 放弃的方案：让 DSH 自己开（那时 Nomad 拿不到地址，`status` 无法报告；
  且 `web.open_browser` / `web.browser_path` 失去统一控制点）。
- 后果：控制点统一、诊断能力增强；代价是启动器必须正确解析就绪行（已由测试覆盖）。
- 诚实边界：**浏览器本身属于宿主**，其历史/缓存/会话不归 Nomad 管理；这条已写入 `docs/HOST_ISOLATION.md` 与 `PHASE1_LAUNCHER.md` §5。
- 验证方式：冒烟测试断言命令含 `--no-open`、`state.url` 带 token 而 `state.publicUrl` 不带。

## ADR-0015 停止操作必须过心跳安全闸，拒绝盲杀 PID
- 日期：2026-10-08
- 状态：accepted（已实现并验证）
- 背景：状态文件里的 PID 会被**操作系统复用**。陈旧状态里的 pid 可能已指向编辑器、浏览器或用户的 shell；
  此时若"尽力清理"，就是一起真实事故。
- 决策：Runtime Host 每 5 秒刷新 `heartbeatAt`；`nomad stop` 先校验心跳新鲜度（上限 25s）。
  - 心跳新鲜 → 正常停止（Windows `taskkill /T /F`；POSIX `SIGTERM` → 超时 `SIGKILL`）；
  - 心跳过期 → **拒绝按 PID 杀进程**，如实说明 PID 可能已被复用，清理状态文件，退出码 1。
- 放弃的方案：为"清理干净"而无条件按 PID 强杀 —— 后果不可控，且用户无从知晓被误杀的是什么。
- 后果：极端情况下可能留下需要人工确认的残留进程，但**永远不会误杀无关进程**。这是一个明确的取舍：宁可留残留，不可误杀。
- 验证方式：`tests/smoke/stale-state-guard.js` —— 真的起一个"无辜进程"，把其 PID 写入过期状态文件，
  断言 `stop` 退出码 1、说明中包含"已跳过停止操作"、且该进程**仍然存活**。

## ADR-0016 `current` 指针用「清单间接」，不用 junction / symlink
- 日期：2026-10-08
- 状态：accepted（已实现并验证）
- 背景：Runtime 版本化要求 `runtime/dsh/current` 指向当前版本。直觉做法是 NTFS junction 或 symlink。
- 问题（三条都是致命的，任一条就足以否掉链接）：
  1. **exFAT / FAT32 不支持链接** —— 而这正是 U 盘最常见的格式，也是"跨机器携带"的前提；
  2. **junction 存的是绝对路径** —— 本机是 `D:\u盘`，换台机器插成 `E:\u盘` 立即失效；
  3. Windows 上创建链接还需开发者模式或管理员权限，与"插上就能用"冲突。
- 决策：`current` 是一个**普通目录**，只放一个 `nomad-runtime.json`，其 `entry` 用**相对路径**指向版本目录：
  `{"entry": "../0.2.1-alpha.1/node_modules/@deepseek-ai/dsh/lib/bin.js"}`
- 放弃的方案：junction / symlink（跨文件系统与盘符漂移都不可靠）。
- 后果：跨文件系统、跨盘符、纯文本可人工审阅；回滚 = 改写一行 `entry`。代价是多一次路径解析（可忽略）。
- 验证方式：`nomad doctor` 报告「入口 `…\0.2.1-alpha.1\node_modules\@deepseek-ai\dsh\lib\bin.js`（来自 nomad-runtime.json）」「可用版本: 0.2.1-alpha.1」；真实冒烟全绿。

## ADR-0017 两套冒烟共用同一指针时「暂存让位」，禁止中止也禁止丢弃
- 日期：2026-10-08
- 状态：accepted（已实现并验证）
- 背景：`runtime/dsh/current` 只有一个。替身冒烟要占它来造假运行时；真实冒烟要求它就是真运行时。
- 第一版实现：发现真实运行时后**直接中止**（退出码 2）。安全，但不合用 ——
  运行时一旦打包完成，替身冒烟就**永久跑不了**，"引导管线"这条快速回归线等于废掉。
- 决策：替身冒烟先把真实 `current` **整目录重命名**暂存到 `data/tmp/portable-smoke-current-<ts>/`；
  测试结束（含 `exit` / `SIGINT` / `SIGTERM`）**逐字放回**，并比对内容与暂存前一致。
- 放弃的方案：① 直接中止（管线测试不可用）；② 直接删掉真实指针（一旦中断就是真丢失）。
- 后果：两套冒烟可安全轮流跑；中断时会打印暂存路径供人工恢复。
- 验证方式：替身冒烟末步断言 `current` 的 manifest 与暂存前**逐字一致**；真实冒烟首步断言 `current` 指向的不是替身。

## ADR-0018 Node 版本以「打包期版本戳」为回退，不依赖 spawnSync
- 日期：2026-10-08
- 状态：accepted（已实现并验证）
- 背景：`nomad doctor` 曾报「Node 运行时（版本未探测到）」。根因是 `probeNodeVersion()` 用 `spawnSync`
  拉 node.exe，而受限环境（沙箱 / 安全软件）下对同一 exe 会返回 **EBUSY**，拿不到 stdout。
- 决策：探测失败时回退读与 binary 同目录的 `NOMAD_NODE_VERSION` 戳（**打包期写入**），
  并在结果里标注 `versionSource: probe | stamp | unknown`。
- 理由：打包期本来就知道版本；一枚纯文本戳让体检不依赖拉起外部进程，更快，也更可审计。
- 后果：体检在受限环境下同样能给出准确版本；代价是打包流程多写一个文件（已写进 §11.2 流水线）。
- 验证方式：`tests/runtime.test.js` 三条用例（有戳回退 / 无戳标记 unknown / 版本化目录布局）。

## ADR-0019 凭据只能由 Launcher 注入，盘内不落真 key；**宿主凭据库永久排除**
- 日期：2026-10-08
- 状态：accepted（**架构部分定案**；加密实现排期 Phase 3）
- 背景：DSH 的 `$DSH_HOME/.credentials.yaml` 是**明文 YAML**，且真实引擎**首次启动即创建**
  （`data/dsh-home/.credentials.yaml`，161 字节模板 —— §6.1 实测，非理论风险）。
  另 `$DSH_HOME/.env` 是只读回退层，且 bootstrap 变量（含 `DSH_HOME`）**不能**写进 `.env`（§6.2）。
- **维护者约束（2026-10-08 拍板）：「不能污染宿主机」** —— 这是本次决策的最高判据。
- 决策：
  1. **宿主 OS 凭据库（原选项 B）永久排除。** 它会往宿主 Windows 凭据管理器写数据，拔盘后仍留在宿主机上，
     直接违反 `SOUL.md` 的零污染边界与 Nomad「换电脑 Agent 不换、不留痕」的核心价值。
     → `HOST_ISOLATION.md` §6.1 的选项 B 及「A+B 混合」一并**作废**。
  2. **唯一合法凭据入口 = Launcher 以进程环境变量注入**（与 `DSH_HOME` 走同一条通道）。
     盘内 `$DSH_HOME/.credentials.yaml` 必须维持**空模板**，不得承载真 key。
  3. **现阶段盘内不落真 key。** 需要真实对话轮时，由维护者**当次**启动前临时提供（临时环境变量 / 交互输入），
     `nomad stop` 之后不保留。
  4. 完整的**盘内加密 Secret Store**（原选项 A 的完整形态：AES-GCM + 主密码派生 scrypt/Argon2，
     Launcher 启动解密注入）**排期 Phase 3**。**Phase 2 不被它阻塞** —— Web UI 定制不需要模型凭据。
- 放弃的方案：
  - 宿主机凭据库 —— 污染宿主，违铁律（同上）
  - A+B 混合 —— B 那半同样污染宿主
  - 裸选项 C（只告警不做控制）—— 仍会允许明文落进可丢失介质，且无法阻止用户在 DSH 自带 UI 里录入并落盘
- 后果：Phase 2 可**立即开工**；代价是现阶段跑真实对话轮需手动提供凭据（可接受，Phase 2 主体是 UI）。
- 遗留待办：① 需确认 DSH 是否提供「禁用自带凭据录入」的开关；若无，则在 Launcher 启动横幅 +
  `nomad doctor` 明确标注盘内凭据文件状态；② 真实对话轮验证时断言宿主 `~/.dsh` 未出现。
- 验证方式：`nomad doctor` 增列「盘内凭据文件状态」（**空模板 / 已含真 key**）并纳入体检结论。

## ADR-0020 自研 bundle 挂载：源在 repo、`bundles` 用**相对路径**、免物化
- 日期：2026-10-08
- 状态：accepted（已实测验证，见 `docs/UI_ARCHITECTURE.md` §8.5.2）
- 背景：L4-a 要落地，就得让 Nomad 自己的补丁层进入 profile。DSH 的 profile 由
  `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles`（**有序包名列表**）声明，
  树的其余部分全由 patch 层组合（`cordis.yml` 恒为 `[]`）。
  于是「Nomad 的 bundle 放哪、怎么被找到」有三个候选：
  (a) 源留在 repo `packages/nomad-web-app/`，`bundles` 里写**相对路径**；
  (b) **物化**（复制）进 `$DSH_HOME/profiles/nomad/node_modules/@nomad/nomad-web-app`，`bundles` 写包名；
  (c) `bundles` 写**绝对路径**。
- 实测结论：**(a) 与 (b) 的组合结果逐字相同**（1319 行，仅来源链回显的写法不同）。
  `bundles` **接受相对路径**，DSH 会正确解析。
- 决策：**采纳 (a)**。源留在 repo 内，profile 的 `bundles` 指向它。
- 理由：
  1. **单一事实源** —— 源在 repo，可版本控制、可 review、可 diff；
  2. **零复制 = 零漂移** —— 物化会产生第二份拷贝，"同步失败"会退化成静默使用旧 bundle（最难查的一类 bug）；
  3. **免疫盘符漂移** —— 相对路径不随 U 盘盘符变化失效，与 ADR-0016 同一哲学；
  4. **目标机零构建** —— 本 bundle 是纯声明式 YAML，不需要任何构建步骤。
- 放弃的方案：(b) 多一份拷贝 + 必须写同步逻辑；(c) 绝对路径违反 ADR-0016 的既定原则，盘符一变即失效。
- 代价与风险：相对路径的深度**取决于 `DSH_HOME` 相对 `NOMAD_ROOT` 的位置**。
  → 因此 **profile 的 `package.json` 必须由 Launcher 按实际相对距离计算并写入，禁止手工维护**。
  好处是 DSH_HOME 位置一旦变更，Launcher 重算即可自愈。
- 遗留：~~Launcher 侧的 `ensureNomadProfile()` 尚未实现~~ → **已实现**，见 **ADR-0021**。
- 验证方式：`tests/smoke/l4a-bundle-probe.js`（8/8），覆盖「bundles 支持相对路径」「不丢任何上游行」
  「`id:` 覆盖必须全量重述」「`insert:` 行成功插入」「来源链体现自研 bundle 入层」。

## ADR-0021 Nomad profile 由 Launcher 自举：幂等、只写盘内、绝不覆盖用户内容

- 背景：Nomad 必须跑**自己的** profile（`nomad`）而不是上游内置的 `web`。而 npm 版 DSH **拒绝
  `dsh plugin`**（与 ADR-0019 同批发现，`UI_ARCHITECTURE.md` §8.5.1），profile 只能由我们**写文件**造出来。
- 上游契约（逐条来自盘内运行时源码，**不是推断**；`@deepseek-ai/dsh-app-boot/lib/index.js`）：
  - profile 目录 = `<DSH_HOME>/profiles/<name>`（`PROFILES_DIR = "profiles"`，:485；`resolveProfileDir`，:524-527）
  - 清单 = `package.json` → `dsh.profile.bundles`（`initProfile`，:581-597；`writeProfileManifest`，:892-894）
  - 伴生文件 = `cordis.patch.yml`（:487、模板正文 :563-567）、`pnpm-workspace.yaml`（:568-573）
  - **`cordis.yml` 由 DSH 每次加载时无条件重写为空列表**（`profile-boot-*.js:189,207`），
    目的是防止 Loader 的树回写把组合结果烘焙进该文件、导致下次启动 bundle 行重复
    → **它不是我们的维护对象**（我们仍写一份，只为工具可读）
  - **内置模板名即保留名**：`acp / web / headless / sdk / sdk-minimal`（:529-535；守卫 :146）
    → 同名不可作为自建 profile 目标
  - 上游初始化**从不覆盖已存在文件**（:584-596 的 `existsSync` 守卫）→ 幂等是上游自己的姿态
- 决策：
  1. 自举点 = `launcher/lib/profile.js` 的 `ensureNomadProfile()`，由 **CLI `nomad start` 与
     `host.js` 双重调用**（host 是权威执行点 —— 真正组装启动命令的是它；CLI 那次负责早失败 + 好报错）。全程幂等。
  2. **不 fork、不物化**：profile 就是盘内三个文本文件 + 一条指向 repo 的相对路径（承接 **ADR-0020**）。
  3. bundle 路径**按实际相对距离算出**（`path.relative(profileDir, bundleSourceDir)` 后转 POSIX），
     **禁止手工维护** —— `DSH_HOME` 位置一变，Launcher 重算即自愈。
  4. 写入姿态与上游一致：伴生文件**只在缺失时补**，绝不覆盖已存在内容（用户改过的东西不动）；
     自研层**只追加到 `bundles` 末位**（它的补丁必须叠在上游 `dsh-web-app` 层之上），
     已存在时先移除再追加（位置纠偏）。写后**回读校验**末位，不满足即报错而非静默成功。
  5. **保留名守卫前置**：`profile` 命中 `acp/web/headless/sdk/sdk-minimal` 直接报错，
     绝不往内置 profile 目录里写任何东西。
  6. 逃生舱：`runtime.dsh.ensure_profile = false` → 完全跳过，由人手工维护。
- 为什么不让 DSH 自己 `--from-default-profile` 生成：那需要**再起一个 DSH 进程**，
  而启动期 `$DSH_HOME` 可能已被正在运行的实例占用；且它只在 profile 缺失时可用、无法做「追加自研层」。
  我们自己写文件是确定性的、无副进程、可单测。
- 反过来的风险：上游若改模板正文，我们的抄本会漂移。
  → 由 `tests/smoke/nomad-profile-smoke.js` 的**漂移守卫**兜住：用它自己生成一份参考 profile，
  与我们的三份模板正文**逐字**比对；上游一改即红。
- 验证方式：
  - `tests/profile.test.js`（13 例：名字守卫 / 落点 / 越界拒绝 / 创建形状 / 幂等 /
    补正且不丢键 / 不覆盖用户补丁层 / 非法 bundle 源失败且不留半成品 / 逃生舱 / 只读巡检 / 模板漂移守卫）
  - `tests/smoke/nomad-profile-smoke.js`（**9 步真实引擎**：漂移守卫 → 自举 → 幂等 → 组合树来源链 →
    真启动 Web UI（`303 → 200 text/html 34656B`）→ 宿主零污染）
  - `nomad doctor` 新增「Nomad profile」巡检（**只读**）；`nomad profile [--ensure]` 供人工查看 / 自举

## ADR-0022 浏览器交接：用 `cmd /c start`（不用 explorer），且以「退出码 + 交付前握手自检」为判据

- 日期：2026-10-08
- 状态：accepted（已在真机 + 活实例上验证）
- 背景：用户报告两个症状，逐字对应同一个根因 ——
  1. 浏览器正文 = `dsh web authentication required; reopen the URL printed by dsh web.`；
  2. 启动时会**自动弹出一个文件资源管理器窗口**。
  而 `nomad start` 照旧打印「（已交由系统浏览器打开）」，一路绿灯。
- 根因（**不是推测**：代码事实 + 上游源码对齐）：
  - 旧实现 `spawn('explorer.exe', [url])`。**explorer.exe 不是"打开 URL"的接口** ——
    它的参数解析器面向 shell 路径与开关。它把 URL 当路径处理 → 另开资源管理器窗口（症状 2）；
    交给浏览器的 URL 丢掉 query → 浏览器拿到裸 `http://127.0.0.1:<port>/`
    → `browser-auth.ts:302-310` 直接 401（症状 1）。两者同源。
  - 对齐上游鉴权契约：`browser-auth.ts:223-227` 把进程 launch token 挂成**唯一** query；
    根路径带合法 token 才 `303 → Set-Cookie: dsh-auth-…`；其余一律 401。
    即 **401 只可能来自"交付给浏览器的地址没带上有效 token"**，与服务器无关。
- 决策：
  1. **不再用 explorer.exe**。Windows 默认走 `cmd.exe /c start "" <url>`
     （ShellExecute 语义、单参数、经 `spawn(shell:false)` 传数组，不经 shell 拼接）；
     URL 含 cmd 元字符（`& | < > ^ ( ) % !`）时降级到 `powershell -EncodedCommand`
     （URL 编进 base64 负载，命令行上不出现原文）；显式配置 `web.browser_path` 时直接拉起该
     可执行文件（零解析面，最可靠，也是用户的逃生舱）。
  2. **判据从"spawn 没抛异常"换成"打开器退出码"**。旧判据无法判伪：explorer.exe
     **无论成败都返回退出码 1**，所以"成功"恒为真 —— 这是假成功，与 ADR-0015 同一类问题。
     长驻应用（configured-app）单独对待：只等 spawn 成功，不拿退出码当判据。
  3. **交付前自检认证握手**（新模块 `launcher/lib/web-auth.js`）：拿到 URL 后先自己走一遍
     `303 铸 cookie → 带 cookie 200`，结果落盘 `state.webAuth`。没有这一步，
     "这条地址交给浏览器到底进不进得去"就只能靠猜。自检**无副作用**（token 可重放，
     cookie 是 HMAC 客户端凭据，服务端不落状态）。
  4. **交接结果如实落盘**（`state.browserHandoff: pending | ok | failed | skipped`），
     `nomad start` / `status` / `doctor` 一律照实打印，**不再出现无条件的「已交由系统浏览器打开」**。
  5. `nomad url` 继续承担手动通道角色（它一直打印**含 token** 的完整地址）；
     `nomad open` 是浏览器 401 之后的第一自救入口。
- 放弃的方案：
  (a) 保留 explorer.exe 再补一次 HTTP 校验 —— 治不了"另开资源管理器窗口"，且其退出码无信息量；
  (b) `rundll32 url.dll,FileProtocolHandler` —— 交接正确，但被主流主机安全策略归为 LOLBin，
      交付物不应依赖它；
  (c) 固定端口 + 免鉴权 —— 违反 ADR-0013，且等于把 loopback 服务暴露给本机任意进程。
- 后果（正面）：两个症状同源同修；401 从"玄学"变成 `nomad doctor` 里一项可复现的断言；
  交接失败不再被掩盖。
- 后果（负面 / 代价）：`cmd /c start` 只在 URL 满足 `CMD_SAFE_URL` 时可用 ——
  若上游将来给鉴权 URL 加上第二个 query 参数（必然含 `&`），会自动降级到 PowerShell 档。
  这是有意的：宁可多起一个 PowerShell，也不开放注入面。
- 验证方式：
  - `tests/browser.test.js`（13 例：三平台参数完整性回归 / cmd→PS 降级 / 退出码判据 /
    卡住不谎报 / spawn 失败 / browser_path 不存在 / 畸形 URL 拒绝 / 长驻应用 detach）
  - `tests/web-auth.test.js`（7 例：复刻上游鉴权语义的假服务器，覆盖 303→200 通过 /
    token 错 401 / 303 无 Set-Cookie / 第 2 跳非 200 / 不可达 / 自检幂等）
  - `tests/smoke/real-runtime-smoke.js` 新增 3 步：**裸地址必须 401**（固化为设计确认）、
    `state.webAuth` 真通过且 `browserHandoff` 如实标注、交接命令静态自检（URL 完整保留、非 explorer）
  - `nomad doctor` 新增 2 项：**浏览器交接命令**（静态组装，防回归）、**Web 认证握手**（对活实例真跑）
  - 真机实证：对当时**仍在运行的实例**（pid 43968，端口 4850）跑 doctor → 握手 `303 → cookie → 200`
    通过；`nomad open` 两次均以退出码 0 完成交接

## ADR-0023 客户端插件走**零构建手写**；roster 行相对名的解析基准 = **声明该补丁的包目录**

- 日期：2026-10-08
- 状态：accepted（已在**真实 DSH** 上端到端验证）
- 背景：Phase 2 至此只证明了「**能换 bundle 层**」（L4-a 三段全绿），**没**证明过「能挂客户端插件」——
  而 L2/L3 的全部 UI 工作都建在这上面。上游文档说客户端包由共享 `tsdown.client.ts` 产出
  `lib/client.js`，读起来像「必须装构建工具链」，直接撞维护者铁律「未经允许不得安装/修改任何软件」。
  ⇒ 动手前先做了一次**只读核查**，结论把这条冲突整个绕开了。
- 核查（上游源码 + 盘内**已构建产物**，不是推断）：
  1. **产物形态**：`window.__ModuleLoader__.load({ id, factory: (require) => { …; return module.exports } })`
     —— **UMD 式信封 + CJS 式 `require`，不是 ESM**；内部用 `require("react/jsx-runtime").jsx(...)`。
     即：**只有写 TS / JSX / CSS 模块才需要构建**。
     参照物：`@deepseek-ai/dsh-client-ui-brand-official/lib/client.js` **仅 1863 字节**。
  2. **加载器不编译**：`@deepseek-ai/dsh-client-modules` 用 `readFileSync(pkg.exports["./client"])`
     **原样吐出**，按 mtime/ctime/size 判重建，挂到 `/plugins/??<id>/client.js,…&rev=<rev>`（**合并请求**）。
  3. **包定位**（`locatePkgJson`）：**路径型名字也能被认领** —— 从该模块向上找最近的 `package.json`，
     再看它是否声明 `dsh.client.platform === 'web'` 与 `exports["./client"]`。
  ⇒ **纯 JS 可手写，零构建、零安装、零新依赖。**
- 决策：
  1. 新增 `packages/nomad-brand/`：`lib/host.js`（空 `apply`，只为给 loader 一个宿主行）
     + `lib/client.js`（**手写信封**，不写 JSX，用 `react/jsx-runtime` 的 `jsx`/`jsxs` 直接构造元素）
     + `package.json`（`exports["./client"]` + `dsh.client.platform/inject`）。零构建产物，无构建脚本。
  2. roster 行 `name` 用**相对路径**指向宿主半 —— 源留在 repo、零物化（与 ADR-0020 同策略）。
  3. ⚠️ **相对名的解析基准 = 声明该补丁的那个包目录**（`packages/nomad-web-app/`），
     **不是 profile 目录**。这与 `dsh.profile.bundles` 里那个 `../../../../…` 的基准**不同**，
     **两者不可互相照抄**。实证：先按 profile 基准写了四级 `..`，`--dump-config` 输出
     `name: file:///D:/packages/nomad-brand/lib/host.js`（丢了 `/u盘`，多爬一层）；
     改为 `../nomad-brand/lib/host.js` 后输出 `file:///D:/u%E7%9B%98/packages/nomad-brand/lib/host.js`。
  4. **品牌落地方式 = 占槽**：`sidebar.brand.mark`（`single`/`root`，props `{size}`）
     + `sidebar.brand.name`（`single`/`root`，props `{}`，占位者自持宽度）。
     上游 `ui-brand-official` 只在 `official` 构建里注册，其余构建落 shell 兜底
     （**鱼标 + `brand.localBuild` 文案**）。
     ⚠️ **本条后半截当日即被真机证伪**：「只在 official 构建注册」是事实，
     但**本构建的 profile 就是 `official`** —— 所以官方占用者一直在注册，
     **单挂这一行是个哑弹**（界面零变化），必须配合 **ADR-0024** 的「让位」才生效。
     ADR-0024 是本次返工的完整根因与修法。
- 放弃的方案：
  (a) **纯 YAML 换品牌色** —— `ui-theme` 的 `Config` 只有 `preference` + `fontSize(10–22)`，
      `locale` 的 `Config` 只有 `preference`；颜色令牌与界面文案**必须由插件**走
      `ctx.theme` / `ctx.locale.register()` 注册 ⇒ 纯 YAML 做不到；
  (b) **裸包名 + profile `node_modules`** —— 裸说明符走 `bareModuleBaseUrl`（已安装宿主），
      且要物化副本、要装依赖；
  (c) **改前端 dist** —— `web-runtime` 行的 dist 路径注释明写
      "an assembly fact of dsh-web-app, **never user config**" ⇒ 只能走尚未验证的 L4-b 或 fork。
- 后果（正面）：**零构建路线打开**，铁律冲突消失；侧栏品牌可见；
  Phase 2 最大的未知（客户端插件能否被加载）从"未知"变成"已证"。
- 后果（负面 / 代价）：手写没有 TS 类型与 JSX 语法糖，样式只能内联或字符串注入；
  **信封协议是上游私有约定**，上游若改形态我们不会有编译期报错 —— 已由真实冒烟的断言兜底。
- 验证方式：
  - `tests/smoke/real-runtime-smoke.js` 新增第 19 步：首页模块引用里**必须**出现
    `@nomad/dsh-client-brand`（扫描器认领）→ 该合并模块 **200** → 正文含
    `__ModuleLoader__.load` / 注册 id / 两个品牌槽名（三查缺一即红）。
    ⇒ 真实 DSH **19/19**（旧 18/18 + 本步）。第 19 步的三环**都不影响首页 200**，所以它必须独立存在。
  - `tests/smoke/l4a-bundle-probe.js`：修正了一条**假失败**断言 —— group 行的规则是
    「`config` **必须存在**」，不是「必须为空」（上游 11 处 group 行**全部**装着子行）；
    并新增「子行确实落在组内」+「指向 `nomad-brand`」两条 ⇒ **8/8**。
  - 自举 profile 冒烟 9/9（组合树 1320 → **1324** 行）
  - 单元 **98/98** · 替身 12/12 · 安全闸 4/4 · L4-a patch 9/9 · doctor 15/0/0 + 1 skip

## ADR-0024 品牌槽要「让位」而非「抢占」：`single` 槽后到即被拒，且本构建 profile **就是 `official`**

- 日期：2026-10-08
- 状态：accepted（真机复现 → 已修复 → 端到端验证通过）
- 背景：ADR-0023 落地后，维护者真机反馈「**没有变**」。
  而服务端侧**一切正常**：插件被扫描器认领、进了 `__DSH_BOOT__`、合并模块 200、
  正文含信封 / 注册 id / 两个槽名 —— ADR-0023 设的三环断言**全绿**，界面却毫无变化。
  ⇒ 说明那三环只覆盖了「交付」，没覆盖「注册」。
- 根因（三层，逐层实测坐实，**不是推断**）：
  1. **本构建的 profile 就是 `official`**，所以官方品牌占用者**一直在注册**。
     实证：`@deepseek-ai/dsh-client-ui-brand-official/lib/client.js` 里
     `if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return` 这句**整段消失**（构建期死代码消除）；
     对全套 `runtime/dsh/0.2.1-alpha.1/node_modules/@deepseek-ai` 做
     `Grep DSH_CLIENT_BUILD_PROFILE`，**只命中两个 README，无任何 `.js`**。
     被消除即该条件构建期恒成立 ⇒ profile = `official`。
     ⚠️ **「产物里还有没有那句 `if`」是判断构建 profile 最省事的探针**，记为经验。
  2. **两个品牌槽都是 `kind: 'single'`**，`SlotCore.register` 对重复占用**抛错** ——
     `ui-renderer/src/client/registry.ts:487` 注释原文：core write first，
     undeclared target / **duplicate declaration** / kind conflicts 都在 core 层先抛。
     我们的插件排第 **57** 位、官方排第 **30** 位 ⇒ **后到 → 被拒 → 界面零变化**。
  3. 这类失效**不碰首页 200、也不碰模块可取性**，所以「UI 可达 + 模块能取」的断言全都漏掉它。
- 决策：
  1. **抢占改为让位**：`packages/nomad-web-app/cordis.patch.yml` 末尾加
     `- id: ui-brand-official` + `disabled: true`，让官方行不进 roster，槽空出来后由我们独占。
  2. **不用「改它的 `name` 指向我们的包」**：`dsh-app-boot` 的 `applyEntryPatches()` 逐字规定 ——
     `if (name && name !== target.name) { warn('patch: name mismatch …'); continue }`，
     即 `name` **只能断言目标行的既有名字、不能改名**（schema 原文亦同："A truthy `name`
     asserts the existing plugin name rather than renaming it."），不匹配时**该补丁被 warn 并跳过**；
     其余字段则**直接覆盖** —— `disabled` 正是其一（`target[key] = value`）。
  3. **不用「插到官方行之前抢先注册」**：能赢，但会把官方包的 `apply` 逼成抛错（被核心吞掉），
     属"靠制造失败取胜"，不干净。
  4. **禁用安全性的三项依据**：① 官方包只做占槽一件事，宿主半 `lib/index.js` 是空 `apply`；
     ② 上游自己**不**注册 conversation hero（其源码注释明说留在声明包的兜底上）；
     ③ 没有任何插件 inject 它（启动图里各条 `inject` 只引 renderer / sidebar）。
- 禁用为何真能腾出槽（三处机制，缺一不成立；**第三处是唯一不能靠推理的一处**）：
  · schema：`disabled` **只接受布尔 `true`** —— "The Loader coerces other truthy values as
    disabled; this schema rejects them."（写 `yes` / `1` 会被校验**拒绝**）；
  · Loader：`if (row.disabled === true && !row.group) continue` → 该行**不被加载**；
  · 客户端 roster：`@deepseek-ai/dsh-client-modules` 扫描 **Loader 的 entries**，且
    `if (entry.options.name !== entryName || entry.fiber === undefined || entry.disabled) continue`
    → 该行**不进 `window.__DSH_BOOT__`**。
    若只有前两条，会出现"行没加载、但仍在启动图里"的中间态，槽照样被占。
- 验证（可判伪）：
  · `--dump-config` → 该行带 `disabled: true`，来源链标注
    `# == @deepseek-ai/dsh-web-app, patched by ../../../../packages/nomad-web-app`；
  · 真启动解析首页 `__DSH_BOOT__` → 条目 **67 → 66**，`brand-official` **消失**，
    `@nomad/dsh-client-brand` 占 index 56；
  · 上述已固化为真实冒烟第 19 步的**第四环**断言（前三环全绿也可能是哑弹，故这一环必加）；
  · 新增 `tests/nomad-brand.test.js`（8 例）：用 `vm` 按浏览器方式执行 `client.js`，
    以**记录式 `jsx`/`jsxs` 桩**断言组件产出的**元素树**（1 条连线 + 恰好 7 颗星、
    枢纽星唯一、字标为 `Nomad`、全树无硬编码色值）——
    这补上了「模块内容是否正确」这一层，是冒烟三环给不出的证据。
  · ✅ **2026-10-08 真机人眼验收通过**：维护者重启后确认侧栏已显示 Nomad 标识。
    这是本机 GUI 的**唯一判据**（沙箱起不了 GUI，退出码与握手只能证明"交付没错"，
    不能证明"渲染出来是什么"）。至此 ADR-0023 + 0024 的链路才算真正闭环。
- 后果（正面）：品牌槽真正归 Nomad；`single` 槽的竞态语义第一次被写成可判伪的断言。
- 后果（负面 / 代价）：**与上游 `web-app` bundle 形成隐性契约** ——
  上游一旦改动品牌槽的声明方或基数，`disabled: true` 就会命中不到行（warn 并跳过），
  而 `nomad doctor` **不会**报这个。缓解：真实冒烟的第四环断言会红。
- 教训（已入 AGENTS 铁律 21）：**「模块被加载」≠「注册成功」**。
  客户端插件有两段各自独立的成败 —— **交付段**（被发现 / 被服务 / 进 boot）与
  **注册段**（`apply` 不抛错、槽真抢到）。ADR-0023 只验了交付段就宣布贯通，
  这是本轮返工的直接原因；凡是"插件类"改动，两段都必须各有断言。

## ADR-0025 结构层：**增量长格**（不替换上游侧栏），且侧栏入口与主面板共用寻址 id

- 日期：2026-10-08
- 状态：accepted（已实现；真实端到端 20/20 全绿；静待真机人眼确认）
- 背景：三条通道（patch / bundle / L2 客户端插件）均已实证后，维护者选定阶段 5-B「结构层」——
  要让 Nomad 在界面上有自己的位置，而不只是换个 logo。第一件事是决定「改哪一层、怎么改」。

### 三条路的代价（源码级实测，非估计）

| 做法 | 能改到什么 | 代价 / 风险 |
| --- | --- | --- |
| 占 `sidebar` 槽（整块替换侧栏） | 侧栏外形完全自主 | **高，已否决**。`ui-layout/src/client/index.ts:58-67` 原文：*"registering here replaces the navigation column outright rather than adding to it, **and the seats it declares disappear with it**"* —— 会连带丢掉 `sidebar.workspaces`（会话列表）与 `sidebar.settings`（设置），必须**自己重新声明并重写**（上游 SidebarRoot 316 行 + 折叠动画 + 滚动条跟随指针管理） |
| **占子槽（增量）** ✅ | 侧栏里长出 Nomad 入口 + 主区一个面板 | **低**。`sidebar.panellist` 是 `list`、`main` 是 `keyed` ⇒ **新 id/key 就是新增一格**，零冲突、**不需要 disable 任何上游行** |
| 注入 CSS 变量（改外观） | 配色 / 字体 / 圆角 / 间距 | **极低**。见下方「附带发现」。本次未采用（维护者要的是结构，不是配色），**保留为后续首选** |

### 附带发现：`--dsw-*` 令牌体系（**修正 ADR-0023 推出的一处结论**）

ADR-0023 记有：「`ui-theme` 的 `Config` 只有 `preference` + `fontSize`，**没有颜色令牌**」——
该**事实正确，但由此推出的"改不了外观"是错的**。实情：

- 上游前端有 **433 个 `--dsw-*` CSS 变量**（`--dsw-static-*` 调色板 / `--dsw-alias-*` 语义别名 /
  `--dsw-specific-*` 组件专用 / `--dsw-radius-*` …）。
- 侧栏样式**全部走变量**（`--dsw-specific-sidebar-fill` / `--dsw-alias-label-primary` / `--dsw-alias-border-l3` / …）。
- 主题样式由 `ui-theme` 的 `installThemeStyles()` 在**运行时**以 `document.createElement('style')` 注入
  （`ui-theme/src/client/styles.ts`），变量定义在 `:root`（base.css）与 **`body`**（design-platform.css，383 处）上。
- ⇒ **任何客户端插件注入一个后置 `<style>` 即可覆盖全部可变量** —— 零结构改动、零 disable、后加载胜出。

即：**"改外观"的最优通道是 CSS 变量，不是槽位。** 本次未走（维护者选了结构），记为后续首选。

### 决策

1. **增量，不替换**：新增 `packages/nomad-panel/`，占两条**增量型**槽 ——
   `sidebar.panellist`（list，侧栏入口）+ `main`（keyed，主区面板）。
2. **两侧共用同一个寻址 id 常量 `PANEL_ID = "nomad"`**，且**只定义一次**。
   理由：`ui-layout` 的 `selectPanel(id)` 会先查 `hasMainPanel(id)`（`service.ts:72-78`），
   两处 id 不同源时会出现**半通状态** —— 侧栏行照常出现，点下去抛
   `layout.selectPanel: main panel "x" is not registered`。
   这种失效**不报错、不白屏**，只在你点的那一刻炸，故必须用断言锁住。
3. **不注册 `locale`**：`label` 直接给 `() => "Nomad"`（产品名不随界面语言变）。
4. **样式不硬编码任何色值**：全部走 `--dsw-*` 变量，兜底只用 `currentColor` / `transparent`
   —— 连中性灰都不写死（写死的中性色会在明暗主题之一里失真）。
5. **自备回程入口**：`PanelRow.onClick` 只做 `selectPanel(id)`、**没有 toggle**，
   再点一次图标回不到对话；故面板内放 `selectPanel(null)` 按钮
   （AppFrame 把 `null` 解为 `conversation`）。

### 被排除的方案

- **禁用 `ui-settings` 去占 `sidebar.settings`**：等于把整个设置面板拿走，代价与收益完全不成比例。
- **整块替换 `sidebar` 槽**：见上表 —— 会丢会话列表与设置且须自行重写，而"外形自主"现阶段并不需要。
- **改 `ui-theme` 的 Config 换色**：其 schema 只有 `preference` / `fontSize`，无颜色面（ADR-0023 已证）。

### 验证（可判伪）

- `tests/nomad-panel.test.js`（**13 例**）：用 `vm` 按浏览器方式执行 `client.js`，记录式 `jsx` 桩断言元素树 ——
  信封 / 导出契约 / **只注册两条增量槽（不碰任何 single 槽）** / **两侧 id 必须相等** /
  图标 7 星且 active 只改不透明度 / 面板含回程入口 / **点击回程真的调 `selectPanel(null)`** /
  `layout` 缺失时静默降级 / 构建标识读得到且读不到时不渲染 `undefined` / **全树无硬编码色值** / 包声明。
- `tests/smoke/real-runtime-smoke.js` 第 **20** 步：进模块图 → 合并模块 200 → 正文含信封 / 注册 id /
  两条槽名 / **`PANEL_ID = "nomad"` 唯一定义**。真实端到端合计 **20/20**。
- 静态组合树：`--dump-config` 中 `nomad` 组内出现 `- id: nomad-panel`，
  解析为 `file:///D:/u%E7%9B%98/packages/nomad-panel/lib/host.js`（stderr 干净）。

### 后果（正面）

- 零冲突、零 disable，**上游怎么改都不会踩**（除非 `list` / `keyed` 语义本身变了）。
- 侧栏面板行**注册即出现**（`ui-sidebar` 直接取自 `entriesOfSlot('sidebar.panellist')`），无需触碰上游文件。
- 结构层的"增量范式"确立：**先看槽的基数 —— `single` 要抢（且需让位），`list` / `keyed` 直接长。**

### 后果（负面 / 代价）

- **面板的 owner props 是空的**（`renderSlot('main', {}, { entryKey })`），拿不到 Session 上下文；
  要展示会话数据得走框架 hooks / 各自 inject。
- 与上游 `ui-layout` / `ui-sidebar` 的**槽基数**形成隐性契约：上游若把 `keyed` 改成 `single`，
  本包会退化成"抢占"并可能与 `conversation` 冲突。缓解：真实冒烟第 20 步会红。
- `order: 20` 是硬编码的排序位；上游若新增同序面板，相对次序将取决于注册顺序。

### 附：本包同时是后续 Nomad 自有 UI 的**模板**

`lib/host.js`（空 apply）+ `lib/client.js`（手写 UMD 信封 + 槽注册）+ `package.json`（`dsh.client` + `exports["./client"]`），
零构建、零依赖，挂载 = bundle patch 里一行。

---

## ADR-0026 合规声明的落点：面板内 About 区块；文案**不得**指向未随包分发的文件

- 日期：2026-10-08
- 状态：accepted（已实现；单元 19/19、全量 **125/125** 全绿；静待真机人眼确认）

### 背景

维护者问「DSH 官方说可以这样魔改吗 / 这个开源协议要求符合吗」。审计结论是**行为合规**，
但暴露出一个真实缺陷：**合规义务没有落地载体** ——
上游 `BRAND_GUIDELINES.zh.md` 要求"真实、准确地说明与上游的关系"，
MIT 要求"保留版权声明与许可声明"，而当时整个界面**没有任何一处**承载它们。
维护者随即提出「UI 页面上加一个 About 说明介绍」——方向与合规需求天然重合。

### 审计得到的三轴结论（**互相独立，不可替代**）

| 轴 | 依据（上游原文） | 判定 |
| --- | --- | --- |
| **MIT 许可**（管代码） | `LICENSE` 逐字授权 `use / copy / modify / merge / publish / distribute / sell` | ✅ 我方 Core patch 数 = 0，属"基于之上构建" |
| **官方机制**（管架构） | `ui-brand-official/README.zh.md`：*"自有身份的部署不组合本包，而是组合另一个占据侧栏 slot 的包。**占据 slot 是唯一的组合路径**"* | ✅ 换品牌是官方明示的正路 |
| **品牌规范**（管商标） | `BRAND_GUIDELINES.zh.md`：描述性引用**符合许可证要求**；不得用完整商标作项目名；不得暗示背书 | ✅ 项目名 Nomad；README 首句为描述性引用 |

补充两条支撑「不是魔改」的官方原文：
`docs/cookbook/extension-cookbook.zh.md:104`「每个产品功能都映射到一个**文档化扩展点**上的监听器……
**没有任何一行修改循环本身**」；`docs/cookbook/adding-a-settings-card.zh.md:60`
「生成它的 tsdown 预设……不在任何已发布的包里，**因此仓库之外的包要自己复刻这一步构建**」
（＝ 我们零构建手写 `lib/client.js` 的正面授权）。

### 关键事实修正（**推翻本条 ADR 起草时的初判**）

起草时曾判定「运行时分发包里没有 LICENSE ⇒ MIT 通知义务未履行」。**实测推翻**：

- `runtime/dsh/0.2.1-alpha.1/node_modules/@deepseek-ai/` 下共 **287 个包、290 个 LICENSE 文件**，**全覆盖**；
- 非 scoped 顶层包 **164 个，155 个自带许可**（其中 `bignumber.js` 用英式 `LICENCE.md`，初次普查被漏判）。

⇒ **包级通知义务已满足**。真正缺的是**聚合清单** `THIRD_PARTY_NOTICES.md`
（上游仓库有、运行时分发包里没有），它恰好覆盖那 **9 个未自带许可**的包：
`brotli` / `data-uri-to-buffer` / `dfa` / `fontkit` / `proxy-agent-negotiate` /
`saxes` / `sherpa-onnx-node` / `sherpa-onnx-win-x64` / `standardwebhooks`。

### 决策

1. **About 放进面板内**（复用 `packages/nomad-panel/`），不新开侧栏入口、不碰设置面板槽位。
   理由：零新槽位 = 零新增冲突面；且面板本就有品牌头，About 是其自然延伸。
   （官方另有 `plugins.detail.section` 专槽，用于"对**别的**包有话要说"，记录为备选，本次不用。）
2. **分区顺序 = ① 品牌头 ② About ③ 状态区 ④ 计划分区 ⑤ 回程**。About 紧随品牌头，
   保证「这是什么」在首屏可见。
3. **About 内容 = 定位 + 说明 + 归属/许可四行 + 商标与关系声明 + developer preview 免责。**
   不放开源仓库链接（维护者选的是"合规声明+产品介绍"，链接属被搁置的"完整版"选项）。
4. **依赖许可如实写「许可见各依赖包内 LICENSE」，不指向 `THIRD_PARTY_NOTICES.md`** ——
   理由见上（细节见下条）。

### 后果（正面）

- 合规义务第一次有了**产品化载体**：用户看是介绍，法务看是声明。
- 两条**防漂移断言**把最易腐化的两处钉住：
  「★ 上游版本锚定」（与 `config/nomad.yaml` 的 `pinned_version` 逐字比对）、
  「★ 不得指向未随包分发的聚合清单」（**负向断言** —— 防止把"合规"写成"失信"）。
- 品牌规范第 4 条（禁止暗示官方背书）在界面上**主动否认**，而非留给读者自行推断。

### 后果（负面 / 代价）

- 上游版本号**内联**在 `client.js`（零构建客户端拿不到配置、也无构建期替换）⇒
  升级 DSH 时必须**两处同改**；漏改即单元测试变红。
- 面板出现**中英混排**（About 行标签中文 vs 状态区标签英文）。
  记为 **i18n 债务**，统一留待一次性做多语言时收拾；本次**刻意不动**既有英文标签，以免扩大改动面。

### 待办（本次**未做**，需维护者拍板）

- [ ] **仓库根 `LICENSE`。** 所有 `packages/*/package.json` 已声明 `"license": "MIT"`，
      About 的「本项许可」亦据此写 MIT，但根目录**尚无 LICENSE 文件** —— 对外发布前须补。
- [ ] **`packages/nomad-web-app/` 补出处声明。** 经 `diff -rq` 证实它是官方
      `packages/bundle/web-app` 的派生副本（`README.md` / `cordis.patch.yml` / `package.json` 三处同源），
      按 MIT "substantial portions" 义务应注明来源。
- [ ] **运行时分发包补 `THIRD_PARTY_NOTICES.md`**（覆盖上述 9 个未自带许可的依赖）。
- [ ] 若将来把 `runtime/` 做成可分发产物：打包流程须**内嵌 LICENSE 与聚合清单**。

### 验证

- 单元：`tests/nomad-panel.test.js` **19/19**（本次新增 6 条 About 用例）；全量 **125/125**。
- 真实端到端：待跑（会停掉在跑实例，故与人眼确认串行安排）。

## ADR-0027 部署到可移动盘：白名单驱动 + Node 原生复制；长路径交给 libuv

- 日期：2026-10-08
- 状态：accepted（已实现；真实部署到 exFAT U 盘并完成对账）

### 背景

维护者插入一块 30 GB 的 U 盘（`E:`，**exFAT**），要求把 Nomad 部署上去。
这正是 `ROADMAP` 里长期挂着的那条待办：「USB 启动（需**可移动盘真机**验证；
本机 `D:` 是本地 HDD 分区，不算数）」。

### 问题（四条，全部实测得出，不是推断）

1. **部署不是「拖过去」**：随盘内容是 **32,144 个文件 / 604.1 MB**，
   其中 `runtime/` 独占 32,089 文件 / 603.7 MB。手工拖拽不可靠，且无法对账。
2. **开发机有约 471 MB 专属内容不该上盘**：`vendor/`（上游源码 152.6 MB）、
   `.cache-dev/`（下载缓存 318.3 MB）、`.workbuddy/`（内部记忆与日志）、
   `data/`（**含明文凭据** —— 与 ADR-0019 直接冲突）。
3. **长路径**：树里有 **1 条 264 字符**的路径（`dsh-experimental-inspector` 内嵌副本里的
   axe-core 描述 markdown），超过 Windows 传统 260 上限，且**放盘符根也超**
   （`E:\` 前缀 3 字符已是最短）。
4. **robocopy 在本环境不可用**：`spawnSync('robocopy', …)` 恒返回 `EBUSY`
   （沙箱限制，不是 robocopy 自身的缺陷）。

### 决策

1. **白名单驱动**：`DEPLOY_DIRS` + `DEPLOY_FILES` 显式列出随盘内容，不在此列者**默认不上盘**。
   源根出现未分类条目时**明确告警**（本次即当场抓出新建的 `tools/`），
   而不是静默带上 —— 防止将来新增的敏感目录被误发出去。
2. **复制用 Node 原生 `fs.promises.copyFile`，不用 robocopy**。三条理由：
   - 零外部依赖，Windows / Linux / macOS 同一套逻辑；
   - **libuv 在 Windows 上会自动给绝对路径加 `\\?\` 前缀 ⇒ 长路径天然可用**
     （实测：在目标盘写入并回读 264 字符路径**成功**）；
   - 「已存在且大小一致则跳过」⇒ 中断后可原样重跑，**天然断点续传**。
3. **长路径降级为警告，不再中止**：Node 运行时不受影响；只有资源管理器 / `copy` 等
   非 Node 工具可能读不到那 1 个文件。工具会列出该路径与缩短办法，由人决定是否接受。
4. **目标强制为盘符根**（`E:\`）：目标前缀越短，长路径余量越大；工具在越界时给定量提示。
5. **目标盘 `data/` 全新初始化**：不迁移会话与凭据，只建 9 个空骨架目录
   （承接 ADR-0019「盘内不落真 key」）。
6. **落地载体**：`tools/deploy-usb.js`（正式工具，非一次性脚本）+ `docs/DEPLOY.md`。

### 后果（正面）

- 「插 USB 就能用」从**架构承诺**变成**已验证事实**：ADR-0016 当年为 exFAT 选
  「清单指针而非软链」，本次在真实可移动盘上得到回报 —— 整个部署过程**没有任何一步**
  需要回避文件系统特性。
- 白名单 + 未分类告警构成**防漂移闸**：新增顶层目录会被立刻发现。
- 断点续传使部署可安全重跑，`--force` 语义也随之简单（只增不删）。

### 后果（负面 / 代价）

- **Node 复制比 robocopy 慢**（没有 `/MT` 线程池，只能靠 `--concurrency` 模拟并发）。
  用速度换零依赖与跨平台一致。
- **不保留文件时间戳**（`copyFile` 不带 mtime）。理由：零构建场景下没有 mtime 消费者，
  而每个文件多一次 `utimes` 会显著拖慢 USB 写入。
- 那 **1 个 264 字符文件**在资源管理器里可能不可见 —— 属已知残缺，已在 `DEPLOY.md` 明示。

### 验证

- 预检实测：符号链接 0 / 大小写冲突 0 / 非法文件名 0；
  `E:` 为 exFAT，可用 29,992 MB，部署集占 **2.0%**。
- 长路径实测：Node 在 `E:\` 下**写入 + 回读 + 删除 264 字符路径成功**；robocopy `EBUSY`。
- 部署对账：目标端文件数与总字节与源端**完全一致**。
  （首次部署曾报「文件差 0、体积差 1.7 KB」—— 原因是部署那 10.7 分钟里源树被改动，
  而对账基准还是启动瞬间的快照。已改为按**当前源端**重新统计；详见 `docs/DEPLOY.md` §9。）

## ADR-0028 盘符根部署暴露的「假越界」：前缀比较必须先去掉尾分隔符

- 日期：2026-10-08
- 状态：accepted（已修复；真机复验通过）

### 背景

首次把 Nomad 部署到 U 盘（`E:\`，**盘符根**）后，在盘上跑 `nomad doctor` 立刻报 FAIL：

```
[FAIL] 宿主隔离
  DSH_HOME = E:\data\dsh-home   ⚠️ 不在 NOMAD_ROOT 之内
  HOME / USERPROFILE / TEMP / TMP / TMPDIR 同样误报
  越界目标: E:\data\dsh-home, E:\data\dsh-home, …, E:\data\tmp
```

而 `E:\data\dsh-home` 明显就在 `E:\` 之内。

### 根因

两处判越界都写成「拼一个分隔符再做前缀比较」：

```js
value === root || value.startsWith(`${root}\\`) || value.startsWith(`${root}/`)
```

当 `NOMAD_ROOT` 是**盘符根**时，它的值天然**带尾分隔符**（`E:\`）。于是上面拼出 `` `E:\\` ``（双反斜杠），
而实际路径是 `E:\data\…` —— `startsWith` 恒为 false，**盘内目标被判成越界**。

**为什么一直没暴露**：开发机的 `NOMAD_ROOT` 是 `D:\u盘`（子目录，不带尾分隔符），
拼出来是 `D:\u盘\`，比较正常通过。这个 bug **只在部署到盘符根时出现** ——
而盘符根恰恰是本项目推荐的目标（长路径余量最大，见 ADR-0027）。

### 决策

1. 在 `launcher/lib/paths.js` 新增两个共用工具，**取代表各处的裸前缀拼接**：
   - `stripTrailingSep(p)` —— 去掉尾分隔符（`E:\` → `E:`；`/` 保持为 `/`，不被抹成空串）
   - `isInside(root, target)` —— 去尾分隔符后按**段边界**判断（`t[r.length]` 必须是分隔符）
2. 三个调用点改用它们：
   - `launcher/lib/env.js#describePlan`（doctor 的隔离计划展示行）
   - `launcher/lib/doctor.js`（越界目标过滤 —— **真正决定 PASS/FAIL 的那一处**）
   - `launcher/lib/browser.js#defaultPowerShellPath`（同类隐患：拼 `SystemRoot + '\\System32\\…'`）
3. **不用 `path.relative` 实现 `isInside`**：段边界法既避开尾分隔符陷阱，
   又天然拒绝 `D:\u盘2` 被裸 `startsWith` 误判为在 `D:\u盘` 之内。

### 后果（正面）

- 消除一处「界面说谎」：部署到推荐位置（盘符根）不再假 FAIL。
- 一处实现、三处复用，同类的「拼分隔符再比较」被永久收口。
- 补 4 条回归（`tests/paths.test.js` 6 → **10**），其中两条标注「Windows 专属」并按平台 skip。

### 后果（负面 / 代价）

- 可忽略：多一层函数调用。
- **诚实记录**：这个 bug 逃过了此前全部单元测试与真实端到端冒烟 ——
  **因为它们的 `NOMAD_ROOT` 都是子目录**。教训：关乎「根」的逻辑，
  必须**同时**用「子目录」与「盘符根」两种形态验证，只测一种等于没测。

### 验证

- `tests/paths.test.js` **10/10**（含 `isInside('E:\\', 'E:\\data\\dsh-home') === true`）。
- 全量单元测试 **129/129**。
- 真机复验：把修复同步到 `E:\` 后再跑 `doctor` → `[ OK ] 宿主隔离`，6 个覆盖项全部正常显示。

---

## ADR-0029 日常开发循环：`--app-only` 快车道 + 「可覆盖探针」把 EPERM 提前到复制之前

**日期**：2026-10-08
**状态**：已采纳
**背景**：维护者问「我以后该如何开发和部署到 U 盘测试」。审计现状发现：`docs/DEVELOPMENT.md` 讲了
「怎么打包运行时」（§8）、`docs/DEPLOY.md` 讲了「怎么部署」，**中间那段日常循环没有写** ——
改一行代码后如何最快在盘上看到效果。同时实测暴露两个具体摩擦点。

### 决策

**1. 新增 `--app-only`：日常只同步 app 层（亚秒级）**

`runtime/` 占部署集 99.5% 的文件量与 99.9% 的体量（32,089 文件 / 603.7 MB），而日常开发**从不碰它**。
`--app-only` 跳过它，只同步 `launcher` / `config` / `docs` / `packages` + 根文件
（约 57 文件 / 481 KB）。实测 **1.3 s**（复制本身 0.3 s，其余为启动与预检）。

**安全阀**：跳过扫描就不能靠扫描来发现问题，故用**版本戳**代替 ——
只读两个极小文件 `runtime/dsh/current/nomad-runtime.json` 与 `runtime/node/NOMAD_NODE_VERSION`，
与目标盘比对；不一致即拒绝并提示改用全量。判据简单：**只要没动 `runtime/`，就用 `--app-only`。**

**2. 新增「可覆盖探针」：把最贵的失败提前到 2 秒内**

`VERSION` 已存在时，把它**原样读出来再写回去**（零风险），若抛 `EPERM` 则立即终止。
理由见下面的实测发现 —— 否则要白跑一趟（复制完 57 个文件）才报 56 行错误。

**3. 新增 `Nomad-Restart.cmd`**

`nomad restart` 命令早已存在，但一直没有 Windows 双击入口。而「改了插件 → 重启实例看效果」
是开发循环里频率最高的一步。补上 `.cmd` 包装，并加入 `DEPLOY_FILES` 白名单（否则不会上盘）。

**4. 三层验证模型写进 `docs/DEVELOPMENT.md` §9**

L1 单元（~1 s）/ L2 本机实例（~5 s）/ L3 盘上真机（~1 s + ~5 s）。
明确 L2 覆盖 90% 的 UI 迭代，L3 的独特价值仅在「介质与位置」四点
（exFAT 无软链、盘符根才压进 260、目标盘 `data/` 全新、文件占用行为）。

### 实测发现（本次最有价值的认知）

**在 Windows 上，「新建文件」与「覆盖已存在文件」不是同一件事。**

| 操作（同一块 exFAT 盘） | 结果 |
| --- | --- |
| 新建文件 | **总是成功** |
| 覆盖「盘上实例加载过」的已存在文件 | `EPERM`（且 `rename` 也失败 ⇒ 句柄占用） |

这解释了完整时间线：**首次部署（空白盘）顺畅，因为全是「新建」；启动过实例之后再部署就大面积失败**，
因为全是「覆盖」。

**已排除的错误假设**（都做了实验）：
- 只读属性 —— Python `os.stat` 报 `readonly=False`；
- 卷写保护 —— `fsutil` 报「为读写」；
- 路径级保护（工作区外不可写）—— 我在同一目录**新建**文件成功；
- Node 专属 shim —— Python / bash / Node **三个通道表现一致**；
- 沙箱策略 —— `dangerouslyDisableSandbox` 下行为相同；
- 目标盘实例仍在运行 —— `nomad stop` 后仍失败（故探针文案把「句柄未释放」也列为可能原因）。

### 后果（正面）

- 日常循环从「10 分钟全量」降到「1.3 s 同步 + 重启」，且**不会漏同步 runtime**（版本戳把关）。
- 失败从「跑完才报」提前到「2 秒内报」，且给出三条可操作处置。
- 两层文档补齐：`DEVELOPMENT.md` §9 讲循环、`DEPLOY.md` §8 讲排障。

### 后果（负面 / 代价）

- `--app-only` 增加一个模式分支（预检 / 空间 / 复制 / 对账四处都要按 `deployDirs` 走，已统一收口）。
- **诚实记录一项未闭环**：本机对 `E:\` 上「已部署文件」的覆盖写入被**环境层**拦截（非本项目代码问题），
  故 `--app-only` 的**成功路径只在 D 盘源端与 E 盘新建文件上验证过**，
  首次全量部署（纯新建）在会话内跑通过。**「覆盖已存在文件」这一步需维护者在其自身终端复验一次。**

### 验证

- `tools/deploy-usb.js` 语法通过；`--dry-run` 预检输出正确（32,146 文件 / 604.2 MB，根文件含 `Nomad-Restart.cmd`）。
- `--app-only --dry-run`：57 文件 / 481.4 KB，runtime 版本戳 ✓ 一致。
- 可覆盖探针：在 `E:\`（当前被占用）**实测拦截成功**，2 s 内退出码 2，不再进入复制阶段。
- 全量单元测试 **129/129**。













## ADR-0030 面板数据通道选「路径 B 独立只读端点」：固定端口桥接，不碰 Typert 生成器

**日期**：2026-10-08
**状态**：已采纳
**背景**：阶段 5-B「面板填真实内容」需把盘内数据（身份/运行态/健康度）送进浏览器半。勘探
（`docs/HOST_TO_CLIENT.md`）确认正规通道 Typert RPC 依赖上游代码生成器 `dsh-typert-generator`
（构建产物 `typert.host.js` 首行明示），复刻成本 ≈ 引入整套 TS 构建 + 代码生成流水线。维护者拍板
「实时」后，进一步确认要显示的数据全是**低频状态**（版本/占用/隔离状态不会毫秒变化），毫秒级
流式是伪需求。

### 决策

**选路径 B：`launcher/lib/status-server.js` 独立只读 HTTP 端点，面板低频轮询。**

- 端点内部**复用已存在的** `runDoctor()`（16 项健康度）+ `readState()`（运行态）+ 读 `VERSION`
  （身份），**零新逻辑**，只是把三类数据聚合成一个 JSON。
- **固定端口**（`config.status.port`，缺省 3090），不是 OS 协商随机端口。理由：面板是零构建手写
  产物，读不到运行时随机端口（`DSH_CLIENT_*` 是构建期内联、`nomad.state.json` 浏览器访问不到），
  固定端口是唯一「零魔法、可解释」的桥接。
- **生命周期遵循 DSH**（维护者 2026-10-08 拍板）：host.js 在 DSH 就绪后 start、退出时 close，不引入
  独立长驻进程。

### 安全边界（三条不可妥协）

1. **只读**：除 GET/HEAD 外一律 405，绝不写盘、不碰 Agent Loop / Session / Tool Runtime。
2. **不泄露 token**：`nomad.state.json` 的 `url` 字段带 launch token，端点用 `STATE_WHITELIST`
   白名单过滤，绝不把 `url` 整条吐出去（`publicUrl` 已脱敏）。
3. **只绑 127.0.0.1**：与 DSH web 一致，不暴露网络；鉴权与 DSH token 解耦（面板本身已在 DSH
   鉴权后的页面内）。

### 后果（代价 / 已记录）

- 新增一条**旁路服务**，不在 DSH 的 Typert 体系内 —— 但**没拆发动机**，只是新增一条不经过 DSH
  的只读通道。已在本 ADR 记录「为什么不用 RPC」。
- 固定端口有「被占用」风险：冲突时端点启动失败，host 记 warn，**面板退化为静态骨架，其余功能
  不受影响**（容错契约，非致命）。
- 「实时」实为「低频轮询」（`status.poll_interval_ms` 缺省 5000ms），不承诺毫秒级推送。

### 验证

- `tests/status-server.test.js` 9 项：只读性（405）、JSON 形状、token 不泄露（含真实 token 断言）、
  close 后端口释放、固定端口锚定。
- `tests/nomad-panel.test.js` 增「端点端口锚定」用例（client.js 的 3090 与 config 的 status.port
  逐字比对），20/20 绿。
- 全量单元 **138/138**（129 + 9 新增）。
- 真机冒烟：端点 GET 200 返回三类合一 JSON，`state.url` 不泄露，`health.summary` = 15 pass / 1 warn，
  POST 405，close 干净收敛。

## ADR-0031 阶段 5-C 换肤走 `ctx.theme.overrideTokens()`，而非「注入 `<style>` 覆盖变量」

**日期**：2026-10-08
**状态**：已采纳
**背景**：阶段 5-C「Nomad 自有外观」。早期 ADR-0025 附带发现曾说「注入后置 `<style>` 覆盖
`--dsw-*` 即可换肤」。但本次深挖 `ui-theme` 源码发现该结论有一个**隐患**。

### 关键事实（源码级）

- `ThemeRuntime`（`ui-theme/src/client/index.ts`）通过 `ctx.provide('theme', theme)` 暴露为
  Cordis service，提供**两条官方换肤通道**：
  - `register(definition)`：注册完整主题 id（重，要维护完整 token 集，出现在外观设置里）
  - `overrideTokens(source, {token: {light, dark}})`：堆叠一层 token 覆盖（轻，全局立即生效）
- `ThemePresenter.apply()`（`ui-layout/src/client/theme-presenter.ts:61-67`）把 resolved 后的
  `active.tokens` 用 `body.style.setProperty()` 写成**内联样式**。
- 内联样式优先级 **高于** `<style>` 里的 `:root`/`body` 规则 ⇒ 若走「注入 `<style>` 覆盖变量」，
  主题切换（light↔dark）时会被 presenter 的内联写入**打回原形**。

### 决策

**走 `ctx.theme.overrideTokens()`**，新增 `packages/nomad-theme/`（零构建手写客户端插件）：

- 覆盖 9 个 `--dsw-alias-*` 语义变量（bg-base / bg-layer-1/2 / brand-primary /
  button-primary-hover / label-primary/secondary / border-l1/l2）。
- **浅色换暖米白大地色系**（维护者定的配色：主背景 #F5EEE8 / 次背景 #EDE2D9 / 主色 #C99F8A /
  强调 #A87560 / 文字 #332B27 / 次文字 #81746D / 边框 #DED1C7）。
- **暗色保持 DSH 默认**（维护者拍板）——`overrideTokens` 强制 `{light, dark}` 双值（README：
  "both palette modes are mandatory"），dark 侧填 DSH 默认暗色的解析后值（`--dsw-static-neutral-bluish-*`）。

### 后果（代价 / 已记录）

- 本项目**唯一**写死色值的模块（换肤本质就是注入具体色值）。为守住「不写死会漂移的色」纪律，
  dark 侧值全部标注 `--dsw-static-*` 来源，token 键名由测试锚定到官方 alias 清单。
- 第三方主题是「进程内扩展，不跨 settings schema」（README）⇒ 换肤**随实例启动生效**，
  不依赖用户手动选；`overrideTokens` 的 source = 包 id，重复调用替换同源 layer（幂等）。
- 若将来要「用户可切换的多套主题」，再升级到 `register()` + 外观设置行，本 ADR 的
  `overrideTokens` 是那个方向的正确地基。

### 验证

- `tests/nomad-theme.test.js` 7 项：source=包id / token键名=官方alias清单 / light-dark双值齐全 /
  浅色=暖米白逐字锚定 / 暗色=DSH默认逐字锚定 / inject声明theme / 宿主半空apply。
- `tests/smoke/real-runtime-smoke.js` 新增「换肤插件进入客户端模块图」步：扫描器认领
  `@nomad/dsh-client-theme` → 合并模块 200 → 含 `overrideTokens`。真实 DSH **21/21** 全绿。
- 顺带清理宿主残留 `C:/Users/<user>/.dsh`（阶段 3.5 headless 测试污染，4 个小文件，已备份到
  `data/backups/`），恢复「宿主零污染标尺」可验证。

## ADR-0032 收尾 V1 三缺口：rollback / backup / projects 三命令

- 日期：2026-10-08
- 状态：accepted（已实现；单元 **13/13** 全绿：rollback 5 + backup 5 + projects 3；真实 CLI 三命令均跑通）
- 背景：V1 主体（Phase 0–2 全子阶段 + 阶段 3.5 真实对话轮 + 5-A/B/C 换肤）已闭环，但 ROADMAP 的
  V1 清单仍有三处未勾：**Rollback**（机制有、无 `nomad rollback` 命令）/ **Backup** / **Project 持久化**。
  三者分别对应 7 大核心价值里的 **Upgradable / Recoverable / Persistent**——不补完，V1 不可称"交付"。
- 决策（三个 launcher-only 命令，均不进 DSH 模块图、不碰 Agent Loop、零新依赖）：
  1. **`nomad rollback [<version>]`**（`launcher/lib/runtime-rollback.js`）：改写 `runtime/dsh/current/nomad-runtime.json`
     的 `entry`+`version` 指向已安装旧版本（`entry` 相对 current 目录，越界校验；保留 name/profile/app_args）。
     候选版本来自既有 `listRuntimeVersions()`（ADR-0016 既定"回滚=改一行 entry"）。运行实例存活时拒绝（除非
     `--force`），因回滚只影响下次启动、当前实例不受影响，避免"切了但当前没变"的错觉。
  2. **`nomad backup [--include-config] [--to <dir>]` / `nomad restore <dir> [--force]`**
     （`launcher/lib/backup.js`）：纯 Node `fs` 递归复制（**不调 tar/7z/robocopy**，后者本环境受限，见 ADR-0027；
     Windows 长路径由 libuv 自动加 `\\?\`）。源 = `paths.dsh_home`（sessions/profiles/projects/documents/storages）；
     `--include-config` 额外备份 `paths.config`。落点 = `paths.backups/nomad-backup-<ts>/`，结构按相对 NOMAD_ROOT
     路径镜像，附 `backup-manifest.json`。排除 `tmp`/`run`/`node_modules`、跳符号链接防环。`restore` 是**合并复制**
     （覆盖已有、不删多余），存活实例拒绝除非 `--force`。
  3. **`nomad projects`**（`launcher/lib/projects.js`）：只读解析 `paths.dsh_home/storages/workspace.json` 的
     `tables.workspaces`（DSH 把"项目"建模为 workspace，纯 JSON 已验证），列出每个工作区的 title/path/会话数/
     更新时间。把"Persistent"价值变成**可验证、可见**的事实（否则用户无从确认项目是否真持久化）。
- 放弃的方案：① 把 Backup 做成"打包成 zip/7z"——需要额外依赖或调用外部工具，违背"用户机零依赖"；
  ② 给 rollback 加"自动停实例再切版本"——会模糊"回滚影响下次启动"的语义，且停实例是用户意图、不该由命令擅作主张；
  ③ projects 做成"写 DSH 项目"——越界到 Agent 领域，本命令只做只读展示。
- 后果（正面）：V1 三缺口补完，ROADMAP 清单三项勾 `[x]`；VERSION 的 STAGE 由 `phase2-l6-usb-devloop` 改为
  `v1-gaps-closed`；三个命令均有单测（含一个"嵌套目录计数精确"用例，专门防 copyTree 递归重复累加的回归）。
- 后果（负面 / 代价）：`backup`/`restore` 是文件级复制，非块级快照，运行期备份可能捕获写入中途文件（已提示先
  `nomad stop`）；`restore` 不删多余文件（合并语义），如需"精确还原到备份时刻"需额外清理——本期刻意不做，避免误删。
- 验证：`tests/runtime-rollback.test.js` 5/5、`tests/backup.test.js` 5/5、`tests/projects.test.js` 3/3；
  真实 CLI 三命令在 `/d/u盘` 实跑通过（projects 列出 default-workspace/2 会话；rollback 列出当前 0.2.1-alpha.1；
  backup 落盘 22 个文件）。

---

## ADR-0033 隔离白名单增补 `systemdrive`（声明性对齐）+ 盘内字面量目录巡检（可观测防线）

- 日期：2026-10-08
- 状态：accepted（已实现；单元 **168/168** 全绿，新增 8 例巡检单测；doctor 由 16 项增至 **17 项**）
- 背景：在做开源前审计时，于盘内发现字面量目录
  `workspace/%SystemDrive%/ProgramData/Microsoft/Windows/Caches/`（4 文件 / ≈966 KB），
  内容为 **Windows 兼容性/字体缓存库**（文件名与系统侧 `C:\ProgramData\Microsoft\Windows\Caches\`
  一一对应、版本号为初始值 → 是**重建**而非复制）。
- **调查过程与自我纠错（本 ADR 的核心价值）**：
  1. 初判「白名单缺 `SystemDrive` → `%SystemDrive%` 展开失败 → 退化为相对路径落到 cwd」，
     逻辑自洽且证据链看似完整（时间对得上、文件名一一对应），**随即实施"修复"**。
  2. **但反向验证推翻了它**：用隔离配置构造子进程并**直接读 `process.env`**，发现
     `env={}`（完全空）时子进程**仍能看到** `SystemDrive="C:"`、`SystemRoot`、`USERPROFILE`、`TEMP`
     —— Windows 创建进程时会**自动补全/注入系统关键变量**，白名单拦不住。
     故「环境里没有该变量」这一前提不成立，原因果链**作废**。
  3. 真凶逐一排除后**不在可控范围**：全量搜字面量 `%SystemDrive%` 在 `runtime/` 与 Nomad 侧
     0 命中；`libreoffice-kit-win32-x64` 系误判（命中的是 C++ 符号名 `GrGLSLProgramDataManager`，
     不是路径）；`@modelcontextprotocol/client` 只是**声明要继承**该变量；`node-gyp` 有 `|| 'C:'` 兜底。
- 决策（两条，均不依赖"定位真凶"）：
  1. **白名单增补 `systemdrive`**（`config/nomad.yaml` + `launcher/lib/env.js#DEFAULT_ALLOWLIST`）——
     明确定性为**声明性对齐，不是安全修复**：上游 `@modelcontextprotocol/client` 的
     `DEFAULT_INHERITED_ENV_VARS`（win32）明确列出 `SYSTEMDRIVE`，生态本就期望它在场；
     该值仅为盘符（`C:`），无隐私、对隔离强度影响可忽略。
  2. **新增 doctor 第 17 项「盘内字面量目录巡检」**（`launcher/lib/doctor.js#scanLiteralDirs`）——
     扫 `workspace/ data/ profiles/ skills/ mcp/` 下形如 `%VAR%` / `${VAR}` 的目录名并告警；
     命中即不再深入、跳过 `node_modules/runtime/vendor/.cache-dev/.git/tmp`、深度上限 4。
     与既有「宿主污染探针」互补：**前者查宿主被写，后者查盘内被非预期写**。
- 放弃的方案：① 继续深挖真凶并做"精确修复" —— 创建者不在 Nomad 与打包运行时之内，
  继续投入属**不可控范围**的考古；改为提供**可观测防线**，任何来源的此类污染都能被发现。
  ② 只用裸 `$VAR` 形态也匹配 —— 误报率过高（任何含 `$` 的目录名都会命中），只保留
  `%VAR%` 与 `${VAR}` 两种明确形态。③ 把已生成的子树直接删除 —— 改为隔离到
  `data/tmp/quarantine/`，保留可恢复性与取证可能，清理由维护者确认。
- 后果（正面）：① 澄清了白名单的**真实边界**（管得住普通变量、管不住 Windows 注入的系统变量），
  同时**确认敏感变量确实被隔离**（宿主 `DEEPSEEK_API_KEY` len=35 → 子进程为 `null`），
  §1 的隔离结论**依然成立**；② 新增防线不依赖根因，属长期有效资产；
  ③ 沉淀了一条方法论：**不要止步于"解释得通"的假设，必须做反向验证**。
- 后果（负面 / 代价）：doctor 每次体检多一次浅层目录遍历（已用深度上限 + 跳过名单控制）；
  字面量目录的**源头仍未定位**，若再次出现只能发现而不能阻止。
- 验证：对照实验（空 env 子进程可见系统变量 / 传入值被尊重 / `cmd /c echo %VAR%` 被证明为**无效测法**）；
  `tests/doctor-literal-dirs.test.js` 8/8（含"命中不再深入""跳过重目录""不误报 `100%done`/`a%b`""深度上限"）；
  `tests/env.test.js` 新增回归用例锁死 `SystemDrive` 不得被移出白名单；全量 **168/168**；
  真实 `nomad doctor` 17 项全通过。
