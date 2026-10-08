# DSH_SOURCE_MAP.md — DeepSeek Harness 源码地图

> **本文件是 Coding AI 最重要的文档。**
> 状态：`PHASE 0 CORE COMPLETE — 24/24 组件已定位 + UI/客户端分层已建 + 四条调用链已填（含 Phase 0 验收项 A）`
> 规则：每一项都必须来自**实际源码阅读**，附 `文件路径:行号`。禁止凭模型记忆填写。
> 每次 DSH 升级后**必须**更新本文件。

---

## A. 上游事实

> **证据等级已升级**：Phase 0 已 clone 源码（commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc` / `0.2.1-alpha.1`）
> 并完成逐条复核。下表**标 ✅ 的条目已由源码证据确认**，标 ⚠️ 的仍是文档级、待复核。

| 项 | 事实 | 等级 |
| --- | --- | --- |
| 包名 / 版本 | `@deepseek-ai/dsh`，npm 最新 `0.2.0-rc.2`；仓库 tag 已到 `0.2.1-alpha.1` | ⚠️ |
| 许可证 / 阶段 | MIT，Developer Preview | ⚠️ |
| 启动（npm） | `npx @deepseek-ai/dsh web` → 默认 `http://127.0.0.1:3080`，自动打开浏览器；`--no-open` 关闭 | ✅ `bundle/web-app/cordis.patch.yml`（`port ?? 3080`） |
| 启动（源码） | `pnpm install` → `pnpm run build` → `pnpm dsh web` | ⚠️ |
| 跑既有产物 | `pnpm start:web`（不重新 build）；开发用 `dev:web` | ⚠️ |
| 状态根 | **`DSH_HOME`**；优先级「显式配置 > `$DSH_HOME` > `~/.dsh`」 | ✅ `util/home-paths/src/index.ts:87` |
| profile 目录 | `$DSH_HOME/profiles/<name>` | ✅ `boot/app-boot/src/profile.ts:169` |
| 内核 | Cordis 插件系统：内核只管加载/卸载/依赖；模型、工具、技能、会话、沙箱、存储、循环、**UI** 全为插件 | ✅ `docs/capability-seams.md` |
| 内置 bundle | `dsh-base` / `-web-app` / `-headless` / `-sdk-app` / `-sdk-minimal` / `-acp-app` | ✅ `packages/bundle/` |
| profile 结构 | `package.json`（`dsh.profile` 清单 + 有序 `bundles`）+ `cordis.patch.yml` | ✅ `util/package-manifest/src/types.ts:75` |
| 组合顺序 | bundles 按序 → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` | ✅ `bundle/web-app/cordis.patch.yml` 文件头 |
| patch 语义 | **按 id 覆盖整行 `config`**；`insert:` 新增行 | ✅ 同上（注释明写） |
| 自省命令 | `--dump-default-config` / `--dump-config` / `--dump-config-schema` | ⚠️ |
| 运行时自省 | `cordis_inspect what:"client"` 查实时槽位树与单槽契约（含**替换风险**） | ✅ `docs/subsystems/slots.md` |
| 插件管理 | `dsh plugin --profile <name> <pnpm args>`；⚠️ **npm 版 CLI 拒绝插件管理请求**，仅 Desktop 安装版可用 | ⚠️ |
| 插件管理服务 | `ctx.pluginManager` = *Current-profile plugin and bundle management* | ✅ `docs/capability-seams.md` |
| 会话 | append-only 事件日志；恢复/分叉/检索/回放共享同一事件流 | 🟡 |
| 主题持久化 | 主题设置写入 `$DSH_HOME/cordis.patch.yml`；别名令牌经 `ctx.theme` 注册 | ✅ `client/ui-theme/README.md` |
| 运行模式 | 标准 / PTC / 极简 / 创造（`DSH_TOOLS_MODE` 临时环境缝） | ✅ `bundle/web-app/cordis.patch.yml` |
| 其他载体 | Electron Desktop（`apps/desktop`，`desktop` 保留 profile） | ✅ `apps/desktop/` |
| CLI 入口 | `dsh <name>` / `--profile <name>` / `acp` / `headless` / `sdk` / `sdk-minimal` / `web` | ✅ `apps/cli/` |

### 由上述事实直接导出的两个结论

1. **Core patch 应趋近 0**：官方明示「无需改动源码即可在配置层组合扩展」，`AGENTS.md` 第 3 节优先级阶梯中的「Configuration / Plugin」几乎就是唯一手段。
2. **`npx` 是便携性地雷**：它依赖 npm Registry，无网机器会直接失败 → 必须离线预置（见 `docs/PORTABILITY.md` §8）。

---

## 填写格式

每个组件按 6 字段记录：

```
Component        : 组件名
Source Path      : 源码路径（含行号）
Responsibility   : 职责一句话
Entry Point      : 入口（函数 / 类 / 导出）
Dependencies     : 依赖（上游 / 下游）
Extension Point  : 扩展点（Plugin / Slot / Hook），无则写 none
```

## 待填组件清单

> 上游 commit：`5badb15009ae1756c3afe0ae0cef1faafc290ccc`（`0.2.1-alpha.1`，2026-10-03）
> 本地路径：`vendor/deepseek-harness/`

| # | 组件 | Source Path（源码级证据） | 状态 |
| --- | --- | --- | --- |
| 1 | Repository / Monorepo | `pnpm-workspace.yaml`；`apps/`(cli/desktop/desktop-host/web)；`packages/`(60+ 包，见 §B) | ✅ |
| 2 | Package 划分 | `packages/*/` 按能力域切分：boot / session / storage / host / client / bundle / sandbox / spill / credentials / util … | ✅ |
| 3 | Entry（CLI 进程入口） | `apps/cli/src/bin.ts`；参数语法 `apps/cli/src/args.ts` | ✅ |
| 4 | Core | 内核为 Cordis 插件系统（第三方 `@deepseek-ai/cordis`），本身不承载 Agent 能力 | ✅ |
| 5 | Agent（Loop / 状态机） | `packages/core/`：`agent` / `agent-loop` / `agent-default-model` / `agent-tool-presentation` / `tools` / `system-prompt` / `scope`；指令注入 `packages/context/agent-instructions`；预设 `packages/preset/agent-preset{,-registry}` | ✅ |
| 6 | Session | 持久化 `packages/session/session-persistence-jsonl/`（`src/index.ts:279-280` `this.root = resolve(config.root)`；根由 `packages/bundle/base/cordis.patch.yml:133` 设为 `dshHomePath('sessions')`）；投影缓存 `packages/session/session-projection-cache/`；查询 `packages/session/session-query-sqlite/` | ✅ |
| 7 | Event（durable stream） | Session 为 **append-only** 事件日志（官方描述），实现同上 jsonl 持久化；`docs/subsystems/session-projection.md` 定义投影 | 🟡 部分 |
| 8 | Tool / Tool Runtime | `packages/shell/`、`packages/fs/`、`packages/subprocess/`、`packages/skill/`、`packages/lsp/`、`packages/browser-use/`、`packages/computer-use/`、`packages/terminal/`、`packages/team`… 工具目录见 `docs/tool-catalog.md` | ✅ |
| 9 | MCP | `packages/mcp/mcp-client/`（客户端）+ `packages/mcp/mcp-resources/`（作用域资源访问，服务 `ctx.mcpResources`）；子系统文档 `docs/subsystems/mcp.md` | ✅ |
| 10 | Client（Web Client） | `packages/client/`（60+ 个 `ui-*` / `connection` / `store` / `modules` / `resources` 包，见 §C） | ✅ |
| 11 | Web（Server / Entry） | 传输层 `packages/host/webserver/`（`host`/`port`/压缩/index 注入表）；SPA 静态 `packages/host/frontend-static/`；bundle 粘合 `packages/bundle/web-app/src/`（`index.ts` / `startup.ts` / `public-url.ts`） | ✅ |
| 12 | API / Remote / Service | `packages/api/`：`gateway`（Remote 分发/取消/逻辑流）+ `remotes`（生成式方法装配）+ `session-controller` / `workspace-controller` / `workspace-files` / `terminal-controller` / `job-controller` / `settings-controller` / `account-controller`。文档 `docs/api-gateway.md` | ✅ |
| 13 | Plugin | 内核 Cordis；profile 即「插件补丁层有序堆栈」：`apps/cli/src/profile-boot.ts`；`cordis.patch.yml` 逐层叠加；插件管理器 `packages/boot/plugin-manager/` | ✅ |
| 14 | Profile | `packages/boot/app-boot/src/profile.ts`（`resolveProfileDir(name, home)` → `$DSH_HOME/profiles/<name>`，:169）；清单类型 `util/package-manifest/src/types.ts:75` | ✅ |
| 15 | Build | 根 `package.json` scripts：`build` / `build:lib:host` / `build:lib:client` / `build:web`；`tsdown.config.ts`；`Makefile`；`start:web` 跑既有产物 | ✅ |
| 16 | Desktop | `apps/desktop/`（Electron 载体）+ `apps/desktop-host/`（`:98` 运行时根 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime`） | ✅ |
| 17 | Model Provider | `packages/llm/`：`llm`（适配器注册表 `ctx.llm`）+ `llm-deepseek` / `llm-deepseek-account` / `llm-deepseek-api-key` / `llm-pi-ai`（第三方）+ `llm-retry` + `token-meter` | ✅ |
| 18 | 可写状态目录集合 | **已完整盘点** → `docs/HOST_ISOLATION.md` §3 与 §5 | ✅ |
| **19** | **Client Modules（客户端插件系统）** | `packages/client/modules/src/index.ts`（宿主半：扫描 Loader 条目→组 `__DSH_BOOT__` 图→`/plugins` 路由）+ `src/client/manifest.ts`（契约）。**bundle 请求时 `readFileSync` 现场读取**，带 `rev` 版本缓存 | ✅ |
| **20** | **Slots（UI 组合系统）** | `packages/client/ui-slots/`（`index.ts` 注册表 / `renderer.ts` / `store.ts`）；渲染器 `packages/client/ui-renderer/`（唯一绑定 bare observable 的包）。层级树见 `docs/subsystems/slots.md` | ✅ |
| **21** | **Layout / Theme** | `packages/client/ui-layout/`（三列 `AppFrame` + `ctx.layout` + 主题呈现器）+ `packages/client/ui-theme/`（深浅/系统 + 字号 + `--dsw-*` 令牌 + `ctx.theme`） | ✅ |
| **22** | **Bundle 组合层** | `packages/bundle/{base,web-app,headless,sdk-app,sdk-minimal,acp-app}/`（各含 `cordis.patch.yml` + `presets/*.patch.yml` + `src/index.ts`） | ✅ |
| **23** | **Manifest 契约** | `packages/util/package-manifest/src/types.ts`：`DshProfileManifest`（`:75`）/ `DshClientManifest`（`:81`）/ patch 声明 | ✅ |
| **24** | **凭据存储** | `packages/credentials/credentials-local/`（`src/index.ts:7` `.credentials.yaml` **明文**）；文档 `docs/subsystems/credentials.md` | ✅ |

## B. 目录结构快照（Phase 0 侦察结果）

```
apps/     cli  desktop  desktop-host  web
packages/（60+ 能力域包）
  boot/        app-boot  cmdline  config-editor  hmr  plugin-manager
  session/     session-persistence-jsonl  session-projection  session-projection-cache
               session-query-sqlite  session-title  session-log-*  session-telemetry-otel
  storage/     storage  storage-domain  storage-json  storage-sqlite
  host/        webserver  frontend-static  open-in-app  directory-picker*  plugin-inventory
  client/      connection  store  modules  resources  locale  shortcuts
               ui-layout  ui-chat  ui-conversation  ui-dockkit  ui-commands  ui-agent-preset …
  bundle/      base  web-app  headless  sdk-app  sdk-minimal  acp-app
  sandbox/     sandbox  sandbox-local  sandbox-windows-acl
  spill/       spill-local
  util/        home-paths  launch-environment  workspace-path  atomic-write  crypto …
  credentials/ credentials-local        identity/ anonymous-user-id
  llm/  api/  fs/  shell/  lsp/  mcp/  skill/  subprocess/  terminal/  workflow/  workspace/ …
native/  python/  scripts/  docs/  website/  benchmarks/  snapshots/  patches/  vendor/
```

构建与工具链（根 `package.json`）：`engines.node = ^22.19.0 || >=24.0.0`，`packageManager = pnpm@11.7.0`。
> ⚠️ 版本要求以实际 clone 为准，不要长期硬编码（见 `docs/DEVELOPMENT.md` §1）。

## C. Client / Web UI 分层（Phase 0 专项侦察）

> 来源：`docs/subsystems/web-client.md`（官方架构文档）+ 源码核对。**这是 Nomad UI 改造的权威坐标。**

### C.1 六层所有权表

| 层 | 主要属主 | 职责 |
| --- | --- | --- |
| Host application | 业务服务 + `packages/api/*-controller` 的 Host 半 | **权威状态**、持久化、变更定序、访问策略、流生产 |
| Transport & API assembly | `client/connection`、`api/gateway`、`api/remotes` | 建立 Client generation、暴露生成式 `ctx.remote.*`、转发选定事件、承载取消与结果 |
| Client models | `api/session-controller/client`、`api/workspace-controller/client` | **React-free** 的 Host 状态镜像、流/一元竞态消解、对象身份与订阅 |
| UI adapters | `client/ui-session`、`client/ui-workspace` | 把 model observable 转成 root / Provider 绑定的 Session Slot 源 |
| Conversation data | `client/ui-conversation` + 目标包（`ui-chat` / `ui-trajectory`） | 组装标准事件为独立目标快照，拥有共享对话壳与输入流 |
| Composition & rendering | `client/ui-slots`、`ui-renderer`、`ui-layout`、feature UI 包 | 声明扩展位、派生 props、绑定 observable 到 hooks、挂载最终树 |

**依赖方向（单向，不可逆）**：
```
Host state → Remote transport → Client model → UI adapter
          → Conversation/Presentation → Slots → React
```

### C.2 浏览器启动链（源码级）

```
Host 组合出 WebBootGraph
   ↓ 写入 window.__DSH_BOOT__ + 安装模块加载门面（在 parser 预载脚本执行前）
浏览器内核：建模块系统 → 预取 immediately 条目 → 挂载 vendored Cordis Loader → 创建每个图条目
   ↓ Cordis 服务注入决定激活；模块图顺序只决定同步 import 能否物化
roster 全部 settled → ui-renderer 水合 framework-free 的 boot DOM
   ↓ 调用唯一的上下文级 renderSlot('root')
最终树挂载
```

模块系统是**惰性 CommonJS 表**：加载 bundle 只注册 factory；物化条目才以同步 `require` 跑 factory。
→ **推论**：插件包体积对启动耗时**近乎无影响**（未用到就不执行）。

### C.3 关键架构红线（改 UI 时必须遵守）

1. **Client model 不是第二事实源**：Host controller 决定持久状态与变更结果；Client model 只保存「最新可用本地投影」并编码延迟响应/替换基线的合并规则。
2. **表现组件永远收不到** Cordis `ctx`、transport 对象、或另一 feature 插件的实现。
3. **只有 `ui-renderer` 允许** `useSyncExternalStore` 与 React context；业务组件**零 context**。
4. **表现组件「预期被整体重写」**（官方原话 `expected to be rewritten wholesale`）→ Nomad 大改 UI 是**合规动作**，不是 hack。

## D. 必须回答的关键问题（Phase 0 状态）

1. **用户发送一条消息之后，DSH 内部发生了什么？** → ✅ **已完成**，见「调用链 A」（含 10 段、逐段 `文件:行`）
2. Web Client 与 Host 的通信协议是什么？边界在哪？ → ✅ 见 §C.1「Transport & API assembly」+ `docs/api-gateway.md`；Remote 用 `@Remote` / `@Remote('name')` / `@Remote({mode:'stream'})` 三种装饰器
3. Session 的事实源存储在哪？格式是什么？ → ✅ **内存事件日志为权威源**（`core/session/src/index.ts:757`），JSONL 为持久化观察者（`session-persistence-jsonl/src/storage.ts:187`），磁盘路径见调用链 A 第 ⑨ 段
4. Event 流是可重放的 durable stream 还是内存事件？ → ✅ **两者都是**：`Session.append()` 先推进内存日志并**同步**派发 `session/event`，持久化/投影/遥测均为观察者；客户端经 `follow()` Remote 流拿到首帧完整基线 + 后续按 seq 追加 → **可重放**
5. 现有扩展点分别能覆盖哪些定制需求？ → ✅ **见 `UI_ARCHITECTURE.md` §8.0 五级梯度**（L1 Token → L5 Fork）
6. DSH 运行期会写哪些目录？ → ✅ `docs/HOST_ISOLATION.md` §3/§5（含逐条 `文件:行`）

## F. Nomad 的接入面（由调用链 A 反推）

走完心跳后可以确认：**Nomad 要接的是观察者口子与配置层，不是 Agent Loop。**

| 接入点 | 机制 | 对应级别 |
| --- | --- | --- |
| `session/event` 全局观察者 | `ctx.on('session/event', …)`（持久化、投影缓存、遥测、标题都这么接） | Nomad 自有数据层 |
| `agent/pre-step` 瀑布 | 可改写/拒绝即将进入模型的消息（`agent.ts:276`） | 上下文/权限策略 |
| `agent/request-error` 瀑布 | 重试/降级策略（`agent.ts:494`） | 可靠性策略 |
| `agent/turn-stopping` 串行事件 | 轮结束钩子（`agent.ts:360`） | 轮级副作用 |
| `session.append()` 消费者 | 但**不得**成为第二事实源 | ⚠️ 只读 |
| `/plugins` 路由 + `dsh.client` | 客户端插件现场服务 | L2 / L3 |
| `bundles` 列表 + `cordis.patch.yml` | roster 重述 | L4 |
| `@deepseek-ai/dsh-web-frontend` 替换 | 前端 dist 与 bundle 解耦 | L4 备选通道 |

**禁止**（承 `AGENTS.md` 第 4 节）：
- 自建第二套 Session / 第二套 Agent Loop / 第二套 Tool Runtime
- 绕过 `Session.append()` 直接写 `messages.json` 并当成真实状态

## E. 官方扩展文档索引（改造时先读这些，不要自创）

| 文档 | 用途 |
| --- | --- |
| `docs/subsystems/web-client.md` | Web Client 总架构 + 层所有权 |
| `docs/subsystems/slots.md` | **槽位契约与完整层级树** |
| `docs/subsystems/conversation.md` | 会话渲染管线（自定义视图/节点） |
| `docs/subsystems/client-modules.md` | 客户端插件打包与加载 |
| `docs/cookbook/adding-a-package.md` | 新增包（自研 bundle/插件的标准流程） |
| `docs/cookbook/extension-cookbook.md` | 扩展总入口 |
| `docs/cookbook/adding-a-tool.md` | 新增工具 |
| `docs/cookbook/adding-a-settings-card.md` | 新增设置卡 |
| `docs/cookbook/adding-a-remote-api.md` | 新增 Remote API |
| `docs/config-catalog.md` | **全量配置项目录（生成式）** |
| `docs/capability-seams.md` | 服务接缝图（哪个能力可替换、谁在消费） |
| `docs/persistence-catalog.md` | 持久化目录总账 |
| `packages/client/AGENTS.md` | 客户端代码硬纪律（槽位/props/导出/分层红线） |

> 另有中文版：同名 `.zh.md`。

## 调用链 / 数据流记录区（Phase 0 已填）

### 调用链 A：消息发送 ← **Phase 0 核心验收项**

> 问题：「用户发送一条消息之后，DSH 内部发生了什么？」

```
① UI 提交（浏览器）
   Session.prompt()                         api/session-controller/src/client/sessions/session.ts:254
   → remote.session.prompt({requestId, sessionId, mode, content, clientTimeZone})

② Remote 入口（Host）
   @Remote('prompt')                        api/session-controller/src/index.ts:432
   → this.commands.prompt(request)          index.ts:435

③ 校验与准入
   Commands.prompt()                        api/session-controller/src/commands.ts:311
   ├ 拒空白内容（须有非空白文本或附件）        :312
   ├ 校验 clientTimeZone（UTC 或 IANA）      :320
   ├ resolveAgent(sessionId)                :329
   ├ 幂等：同 requestId 已存在 → 直接 accepted :330
   ├ 若含图片：查模型 inputModalities 是否支持 :341
   ├ 附件准入 admitPromptContent()           :355
   ├ createUserMessage({content, source})    :357
   └ 投递：mode==='steer' ? agent.steer() : agent.followup(message)   :367-368

④ Agent 收件箱（唤醒）
   ReactLoopAgent.followup()                core/agent-loop/src/agent.ts:163
   → send(input, 'next-turn', true)          :164
   → inbox.splice('next-turn', ∞, 0, [msg])  :159
   → wakeDriver()                            :160

⑤ 驱动器循环
   kick()                                   core/agent-loop/src/agent.ts:252
   → while (await this.turn()) {}            :254   ← 多轮直到无唤醒输入

⑥ 一轮 = 多次 step
   turn()                                   agent.ts:296
   ├ session.append('turn/start', {turn})    :305   ← 持久化边界标记
   └ while(true):
       ├ preStep(target, {turn, step})       :316
       │  ├ inbox.claim(target, turn)        :271
       │  ├ systemPrompt.assemble()          :272   ← 系统提示词组装
       │  ├ renderContextSections + project  :274-275 ← 上下文注入（runtimeContext）
       │  └ dispatch.waterfall('agent/pre-step', …, → {kind:'enter', messages})  :276-282
       │     ★ 扩展点：'agent/pre-step' 瀑布可改写/拒绝消息
       ├ session.append('step/start')        :329
       └ step(decision)                      :338 → :398

⑦ 单步：模型请求 → 流式 → 工具
   step()                                   agent.ts:398
   ├ prepareRequest(turn, step, signal)      :408 → :547  ← 解析模型路由/适配器
   ├ session.append('system/message', …)     :417   ← 提示词投影（含 in-history 决策）
   ├ 首次尝试：逐条 append('user/message')    :420-422  ★ 用户消息在此入日志
   ├ buildRequest(...)                       :425
   ├ new AssistantStreamAttempt(...)         :426   ← 流式记录器
   ├ live.start(); llm.stream(request)       :436-438
   │   ★ 扩展点：preparedCall?.stream() 优先于 loopCtx.llm.stream()
   ├ for await (chunk of stream) live.push() :440-443  ← 逐块推送
   ├ live.finish → 
   │   ├ error/aborted → append('assistant/attempt')  :492
   │   │   └ dispatch.waterfall('agent/request-error', …, → {kind:'retry'})  :494-504
   │   │      ★ 扩展点：重试策略
   │   └ 正常 → append('assistant/message', {message, usage, stream})  :522
   ├ finish.kind==='max-tokens' → return     :530
   ├ const toolCalls = message.content.filter(b => b.type==='tool-call')  :532
   ├ toolCalls.length===0 → return {completed}  :533   ← 无工具调用 → 本轮结束
   └ executeToolCalls(...)                   :534 → core/agent-loop/src/tool-calls.ts:60
   └ finally: session.append('step/end')     :356
       （收尾）dispatch.serial('agent/turn-stopping')  :360

⑧ 事件落盘（关键架构事实）
   Session.append(type, data, opts)          core/session/src/index.ts:718
   ├ snapshotJsonValue(data) 校验可序列化     :728-735  ← 非 JSON 直接 throw
   ├ 禁止重入（another append publishing）     :737
   ├ deepFreeze({type, seq: SessionSeq(log.length), time: Date.now(), data, …})  :740-746
   ├ validateSessionEventData(event, …)      :747  ← schema 校验
   ├ surfaceManager.validateNext(event)      :748  ← 表层 operation 序列校验
   ├ this.log.push(event)                    :757  ← **内存日志 = 权威事实源**
   └ invokeContainedSessionObservers('session/event', …)  :760  ← 同步通知所有观察者
       ★ 持久化只是观察者之一，不是写路径

⑨ 持久化（观察者）
   ctx.on('session/event', …)                session/session-persistence-jsonl/src/storage.ts:535
   → storage.append(events, opts)            同文件 :187
   → 磁盘：root/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.<v>.jsonl[.zstd]
                                            session/session-persistence-jsonl/src/format.ts:268-287

⑩ 回浏览器
   @Remote({mode:'stream'}) follow()         api/session-controller/src/index.ts:486-488
   → history.follow(request, signal)         api/session-controller/src/history.ts:120
   → SessionFollowFrame{header, tail page, cursor, projection baseline}
   → 客户端 Session 事件窗口                  api/session-controller/src/client/sessions/session.ts
   → ui-conversation 事件注册表 → 目标快照(chat/trajectory) → Slot → React
```

**结论（这就是 Phase 0 要的答案）**：
DSH 的心跳是 **「收件箱 → 驱动器 → 轮 → 步 → (模型流 | 工具执行) → 事件追加」** 六段式。
**唯一事实源是 `Session.append()` 推进的内存事件日志**；持久化（JSONL）、投影缓存、Telemetry、标题生成、`session/event` 的全部消费者**都是观察者**。
→ 对 Nomad 的意义：**我们要接的是 `session/event` 这一个观察者口子 + `/plugins` + Slot，不是 Agent Loop。**

### 调用链 B：工具调用

```
executeToolCalls(ctx, turn, step, toolCalls, signal, spliceNextStep)   tool-calls.ts:60
├ 规划：tool-calls.ts:1 头部注释「parallel calls use a bounded rolling pool and are reclassified before start」
├ mode==='parallel' → 有界滚动池批量；否则每次一个（exclusive barrier）  :90 / :205
├ 每个调用按 exec 的 executionMode 决定并行/独占            :204-205
│   上限：ctx 的 maxParallelToolCalls（见 agent-loop README）
├ 结果经观察者写回：session.append('tool/result', …)       agent.ts:345
└ concluded（concludesTurn===true）→ 决定本轮是否终止      tool-calls.ts:158 / agent.ts:538
```

### 调用链 C：会话加载 / 恢复

```
Web 启动后：Host 侧 catalog 扫描 root/<projectKey>/* 目录          session-persistence-jsonl/src/index.ts:1587
├ .jsonl / .jsonl.zstd 两种代际                                  :1601
├ 旧布局检测（legacy layout）→ 拒绝并提示迁移                       :1602
├ 读取：page(older history / gap repair)   history.ts:77
└ 跟随：follow() 首帧 = 当前 header + tail page + cursor + 完整 projection baseline   history.ts:120
客户端：ClientSessions → SessionManager → Session（惰性实例化）
       每个物理 generation 用快照**原子替换**保留窗口，随后按 seq 追加标准事件
```

### 调用链 D：Web 启动

```
① CLI 解析 flag 家族（--host / --port / --public-url / --trusted-host / --no-open）
   web-startup 插件                          bundle/web-app/src/startup.ts:1-40
   → 提供 webStartup 服务（inject: ['cmdlineArgs']）

② webserver 行（host/port 来自 webStartup，带回退）
   config: host = ctx.webStartup.host ?? '127.0.0.1'
           port = ctx.webStartup.port ?? 3080
           compression: gzip（threshold 1024B）   bundle/web-app/cordis.patch.yml
   ★ Nomad 端口策略：这里传 0 走系统自动分配（配合 Leuncher 探测真实端口）

③ web-runtime 行（@deepseek-ai/dsh-web-app）  bundle/web-app/src/index.ts
   ├ 解析前端 dist：require.resolve('@deepseek-ai/dsh-web-frontend/package.json') → dist/index.html   :181
   │   ⚠️ 找不到该包会直接 throw                              :184
   ├ 挂载 host-frontend-static 作 fallback owner
   ├ 注册 web 表层 prompt section + bash runtime 变量
   ├ 打印 URL 行
   └ 等**完整 Loader 树 settled + required-entry 审计通过**后 openBrowser(url)   :201/:232
      → appRootUrl：publicUrl 优先，否则 loopback                  :166-167

④ LAN 信任采样（bind 后一次）：resolveLanTrust(host, trustedHosts)  :242
   trustedHosts = [...lanAddresses, ...extra(--trusted-host)]     :142
   → 释放依赖行（/api 信任围栏）

⑤ 浏览器侧启动链 → 见 §C.2
```

**★ Nomad 落地事实（Phase 1 实测，逐条带证据）**：

| 事实 | 证据 | Nomad 的用法 |
| --- | --- | --- |
| web 参数族**只有五个**：`--host/--no-open/--port/--public-url/--trusted-host` | `bundle/web-app/src/startup.ts:59-63` | 启动器只生成 `--host/--port/--no-open`，其余留给用户配置 |
| `--port <port>` 支持 `0` = 让 OS 挑一个空闲端口 | `startup.ts:61` | `web.port: 0` → 传 `--port 0`，端口从 URL 行回读（无竞态） |
| `--host 0.0.0.0` 被**主动拒绝** | `startup.ts:85-87` | 配置层只允许 `127.0.0.1`，越界直接报错 |
| launcher 级 flag 必须排在 app flag 之前（首个不认识的 token 之后全归 app） | `apps/cli/src/args.ts:159-166` | argv 顺序固定为 `--profile <name>` → `launcher_args` → app flags |
| 就绪行格式 `dsh web: <url>[ (LAN: <url>)]` | `bundle/web-app/src/index.ts:290` | Runtime Host 以 `^dsh web:` 解析就绪信号（`launcher/lib/dsh-url.js`） |
| 该 URL 携带本次 launch token（query 参数） | `client/connection/src/browser-auth.ts:223-227` | 交给浏览器时必须用**带 token 的** URL；日志只打脱敏地址 |
| 根路径带合法 token 的 GET → 铸 cookie 并重定向到干净 `./` | `browser-auth.ts:238-245` | 所以裸 loopback 地址会 401，不能代替 |
| `web` 是**内置 profile 名**，不可作为自建 profile 目标 | `apps/cli/src/profile-boot.ts:116-131`、`boot/app-boot/src/profile.ts:179-195` | Nomad 自己的 profile 需 `--from-default-profile web` 另起名（如 `nomad`） |
| 上游桌面载体亦使用 `['--no-open','--port','0']` | `apps/desktop-host/src/index.ts:30` | 印证端口与浏览器策略与官方一致 |

**★ 关键发现（新增，直接服务 L4）**：
前端 dist 是一个**独立 npm 包 `@deepseek-ai/dsh-web-frontend`**（`apps/web/package.json`，`0.2.1-alpha.1`，
`exports: { "./dist/*": "./dist/*" }`，`files: ["dist"]`），`bundle/web-app` 仅以 `workspace:*` 依赖它，
并在运行时 `require.resolve` 取 `dist/index.html`（`bundle/web-app/src/index.ts:181`）。
→ **前端产物与 bundle 解耦**，这给 Nomad 多开了一扇 L4 的门（详见 `UI_ARCHITECTURE.md` §8.5）。

## Skill 契约（Phase 3.0-A 勘探，2026-10-09，源码级）

> 来源：`vendor/deepseek-harness/packages/skill/`（`dsh-skill` 注册表 + `dsh-skill-filesystem` provider）。
> npm 发布包只含 `lib/`，本节全部结论以 vendor 源码为准。

| 契约 | 内容 | 证据 |
| --- | --- | --- |
| 架构 | `ctx.skills` 是**服务注册表**：`dsh-skill` 只合并目录、按名字解析胜者；具体来源由 provider 决定 | `packages/skill/skill/src/index.ts:1-10` |
| 4 个文件根 | ① `<projectRoot>/.dsh/skills`（rank 100）② `<projectRoot>/.agents/skills`（rank 200）③ `$DSH_HOME/skills`（rank 400，**`.system/` 子目录保留被忽略**）④ `$DSH_AGENTS_HOME/skills`（rank 500，缺省 `homedir()/.agents/skills`） | `skill-filesystem/src/index.ts:250-258`、`:36-40` |
| 两种合法格式 | **目录束** `<root>/<name>/SKILL.md`（深度恰好 2）或**扁平文件** `<root>/<name>.md`（深度 1） | `:676-687`（`isPotentialSkillPath`） |
| frontmatter | YAML：`name` + `description` 必填，`whenToUse` 可选；name 必须_kebab-case_ `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` | `dsh-skill/src/index.ts:23`、`skill-filesystem:111-117` |
| 优先级 | rank 数值**越小越优先**：project-dsh 100 < project-agents 200 < runtime 250 < custom 300 < user-dsh 400 < user-agents 500 < bundled 600（同名 skill 由注册表解析唯一胜者） | `skill-filesystem:36-40`、`dsh-skill:31-32` |
| 热更新 | 文件系统 watch，`skills/change` 事件广播 | `dsh-skill/src/index.ts:296`、`skill-filesystem:653-657` |
| **Nomad 映射** | `DSH_HOME=data/dsh-home` → user-dsh 根 = **`data/dsh-home/skills/`**（当前不存在，需 3.2 创建基线）；**盘根 `skills/` 目录 DSH 根本不读**。user-agents 根 = `<私有 USERPROFILE>/.agents/skills`（env.js 已重定向 homedir → 盘内，无宿主泄漏） | `launcher/lib/env.js:11` |
| **3.2 推论** | `nomad skill` 管理目标目录 = `data/dsh-home/skills/`（rank 400 档）；项目级 skill 由 Agent 工作区 `.dsh/skills` 承载，Nomad 不代管 | 本表 |

## DSH 版本

| DSH Version | 读取日期 | 证据等级 | 说明 |
| --- | --- | --- | --- |
| `0.2.0-rc.2` | 2026-10-08 | ⚠️ 文档级 | npm 最新发布版（**未读源码**） |
| `0.2.1-alpha.1` @ `5badb15` | 2026-10-08 | ✅ **源码级** | **本地 clone 基线**（`vendor/deepseek-harness/`，14208 文件 / 4704 `.ts`） |

> 升级 DSH 后：更新本表 → 重跑 §C/D 相关核对 → 按 `docs/UPSTREAM.md` 登记差异。
