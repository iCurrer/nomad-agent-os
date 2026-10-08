# @nomad/nomad-web-app

Nomad 的 **Web 表面补丁层** —— profile 的第三层，排在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后。

## 这是什么

DSH 的 profile 是一叠**有序补丁层**。一个 npm 包只要在自己的 `package.json` 里声明
`dsh.bundle.patch`，就成了一层 bundle：

```jsonc
{ "name": "@nomad/nomad-web-app",
  "dsh": { "bundle": { "patch": ["./cordis.patch.yml"] } } }
```

本包**没有一行 JS、不需要任何构建步骤** —— L4-a 姿态：重述 roster、复用官方前端 dist、
**不改 DSH 源码**（依据 `docs/UI_ARCHITECTURE.md` §8.5、ADR-0011）。

## 怎么被挂上

`$DSH_HOME/profiles/nomad/package.json` 的 `dsh.profile.bundles` 用**相对路径**指向本目录：

```jsonc
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "../../../../packages/nomad-web-app"   // ← 由 Launcher 按实际相对距离算出，勿手工维护
]
```

相对路径的好处：源留在 repo（单一事实源）、零复制零漂移、免疫 U 盘盘符变化。详见 **ADR-0020**。

**这份 `bundles` 不是手写的** —— 它由 `launcher/lib/profile.js` 的 `ensureNomadProfile()` 在
`nomad start` 时按实际相对距离算出并写入（幂等，ADR-0021）。因为相对深度取决于 `DSH_HOME` 位置，
手工维护会在盘内布局一变时**静默失效**。

手动查看 / 自举：

```bash
node launcher/nomad.js profile            # 只读：看当前 bundles 与自研层位置
node launcher/nomad.js profile --ensure   # 幂等自举到位（start 也会自动做）
```

## 改之前必读（五条硬规则，有测试兜底）

1. **`id:` 覆盖会替换目标行的整个 `config`** → 必须重述该行**所有**键，漏一个就**静默丢配置**。
   先去 `--dump-config` 里抄全键，别凭记忆。
2. **dump 里 YAML 折叠标量（`>-`）会折行** → 断言长文本前先归一化空白
   （`text.replace(/\s+/g, ' ')`），否则子串匹配会假失败。
3. **自研层必须留在 `bundles` 末位** —— 它的补丁要叠在上游 `dsh-web-app` 层之上。
   手工挪动位置会被 `nomad doctor` 标为 WARN，并被 `ensureNomadProfile()` 自动纠偏。
4. **`insert:` 的 group 行必须三个键齐全** —— `name: cordis:group` + `group: true` + `config`（空容器写 `[]`）。
   2026-10-08 两个坑都是这里踩的（`--dump-config` 全看不出来）：

   | 缺哪个键 | 运行期后果 |
   | --- | --- |
   | 缺 `name` | preflight 里 `manifestOf(ctx, row.name, …)` 抛错 → 整行**被静默禁用**：<br>`dsh: disabling profile plugin row "nomad": its declared peer dependencies cannot be validated: …startsWith` |
   | 缺 `config` | `Group.update(undefined)` 在第 82 行 `config.map(...)` 抛 `TypeError: Cannot read properties of undefined (reading 'map')`，栈里能看到 `profiles/<name>/#<row>` |

   上游 11 处 group 行三项全齐，照抄即可。
5. **`--dump-config` 不能代替真启动** —— 它只做组合，**不做 preflight、不初始化插件**，
   所以第 4 条那两类错误它一个都看不出来。改完必须跑下面这条：
   `node tests/smoke/real-runtime-smoke.js`（内含「**DSH 启动输出零告警**」断言，
   按字节偏移隔离本次启动的输出，不许出现 `failed to import` / `did not activate` /
   `disabling profile plugin row` / `*Error`）。

## 怎么验证

```bash
node --test tests/profile.test.js         # profile 自举的纯逻辑面
node tests/smoke/l4a-bundle-probe.js      # 8/8（组合树换层，dump 层）
node tests/smoke/nomad-profile-smoke.js   # 9/9（真实 DSH 加载自举 profile 并渲染 UI）
node tests/smoke/real-runtime-smoke.js    # 15/15（全链路；含零告警 + 前端资源全量可达）
```

想肉眼看组合树：

```bash
DSH_HOME=<某临时目录> node runtime/dsh/0.2.1-alpha.1/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile nomad --dump-config
```

## 现在挂了什么

| 补丁 | 动作 | 目的 |
| --- | --- | --- |
| `system-prompt` | `id:` 覆盖（全量重述） | 往 personaSuffix 注入 Nomad 身份：让 Agent 知道自己跑在可移动盘上 |
| `session-query-sqlite` | `id:` 覆盖（全量重述） | 把「会话检索索引不落盘」从上游默认值升级为 Nomad 自己的承诺 |
| `nomad` | `insert:`（`group: true`） | 为后续挂自研插件预留的可寻址容器，本阶段**有意不挂实现**（零运行期风险） |
