# 第三方组件与许可声明

Nomad 自身代码以 **MIT** 许可发布（见根目录 [`LICENSE`](LICENSE)）。本文件汇总 Nomad 所依赖的
第三方组件及其许可，以履行 MIT 及各依赖许可所要求的「保留版权声明与许可声明」义务。

> **本文件是聚合声明，不复制上游许可全文。** 完整许可原文随运行时包分发
> （每个依赖目录下均附有自己的 `LICENSE`）。运行时按版本独立管理、**不随源码仓库分发**，
> 因此聚合清单是源码侧的合规载体。

---

## 1. 上游 Agent 引擎

| 组件 | 版本 | 许可 | 版权 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh` | 0.2.1-alpha.1 | **MIT** | Copyright (c) 2026 DeepSeek |

- 上游仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 上游许可全文：`runtime/dsh/<version>/node_modules/@deepseek-ai/dsh/LICENSE`
- 上游品牌规范：`BRAND_GUIDELINES.zh.md` —— Nomad 的遵守情况见 README「归属与许可」。
- 计费与商标提示：DSH / DeepSeek Harness 是深度求索公司的注册商标；Nomad 与 DeepSeek
  **无隶属、无赞助、无背书关系**，「基于 DeepSeek Harness 构建」属上游明确许可的描述性用法。

---

## 2. 运行时传递依赖（aggregate）

Nomad 便携运行时（`runtime/dsh/<version>/node_modules`，**不随本仓库分发**）的顶层
`node_modules`（含 scoped 目录）共 **561** 个包，许可分布：

| 许可 | 包数 |
| --- | ---: |
| MIT | 471 |
| Apache-2.0 | 51 |
| ISC | 15 |
| BSD-3-Clause | 14 |
| MPL-2.0 | 2 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 2 |
| BSD-2-Clause | 2 |
| Python-2.0 | 1 |
| Unlicense | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |

**结论：无 GPL / AGPL 等强 copyleft 依赖** —— Nomad 以 MIT 发布**不产生许可传染**。
弱 copyleft 组件（MPL-2.0 / LGPL-3.0）均以**未修改的依赖形式**使用，符合各自许可要求。

### 需特别列名的弱 copyleft / 非常见许可组件

| 包 | 版本 | 许可 |
| --- | --- | --- |
| `@deepseek-ai/libreoffice-kit` | 0.1.5 | MPL-2.0 |
| `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT |
| `argparse` | 2.0.1 | Python-2.0 |
| `fast-sha256` | 1.3.0 | Unlicense |
| `tslib` | 2.8.1 | 0BSD |
| `type-fest` | 4.41.0 | (MIT OR CC0-1.0) |

### 自行复核方法

```bash
# 在已打包运行时的机器上，逐包打印 name / version / license
node -e "
const fs=require('fs'),path=require('path');
const base='runtime/dsh/0.2.1-alpha.1/node_modules';
for (const e of fs.readdirSync(base)) {
  const dirs = e.startsWith('@') ? fs.readdirSync(path.join(base,e)).map(s=>path.join(e,s)) : [e];
  for (const d of dirs) {
    const p=path.join(base,d,'package.json');
    if(!fs.existsSync(p)) continue;
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    console.log(j.name, j.version, j.license||'(none)');
  }
}"
```

---

## 3. Nomad 自身各组件的许可

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| `launcher/` | MIT | 零依赖 Node CLI + 运行时监督进程 |
| `packages/nomad-web-app` | MIT | L4-a 补丁层（`cordis.patch.yml`） |
| `packages/nomad-brand` | MIT | 侧栏品牌槽客户端插件 |
| `packages/nomad-panel` | MIT | Nomad 自有面板插件 |
| `packages/nomad-theme` | MIT | 主题语义 token 覆盖插件 |
| `tools/` `tests/` `docs/` | MIT | 工具 / 测试 / 文档 |

各包 `package.json` 均已声明 `"license": "MIT"`。

---

## 4. 未修改上游源码

对照上游 `docs/cookbook/extension-cookbook.zh.md`：「每个产品功能都映射到一个**文档化扩展点**
上的监听器……**没有任何一行修改循环本身**」。Nomad：

- **Core Patch 数 = 0** —— 未对任何 `@deepseek-ai/*` 包做源码级修改；
- 全部定制通过**官方扩展点**完成：Cordis 插件 / `cordis.patch.yml` 行补丁 /
  客户端插件槽位 / 主题 token 覆盖（`ctx.theme.overrideTokens()`）；
- 因此不存在「上游 MIT 代码被修改后需额外声明」的情形。

详见 [`docs/DECISIONS.md`](docs/DECISIONS.md) **ADR-0026**（合规审计）与
[`docs/UPSTREAM.md`](docs/UPSTREAM.md)。
