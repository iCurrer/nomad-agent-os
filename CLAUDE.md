# CLAUDE.md

本仓库的**唯一规则来源**是 [`AGENTS.md`](./AGENTS.md)。

开始任何工作前：

1. 完整阅读 `AGENTS.md`
2. 完整阅读 `docs/BOOTSTRAP_PROMPT.md` 并按其执行 Recon
3. 当前阶段：**Phase 2 — Nomad Web UI（V1 已交付）**；下一步 Phase 3 Agent OS（见 `docs/ROADMAP.md`）

优先级提醒：**当前仓库源码 > AGENTS.md > docs/ > 官方文档 > 模型已有知识**。

不要重写 DSH 的 Agent Loop / Session / Tool Runtime。
不要在未定位真实代码位置前修改任何文件。
不要自动 `git push`，不要自动升级 DSH master。
