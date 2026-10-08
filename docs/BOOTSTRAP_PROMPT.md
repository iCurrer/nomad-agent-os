# BOOTSTRAP_PROMPT — 新会话启动提示词（直接粘贴给 AI）

> 每个新的 AI 会话（Claude Code / Cursor / Codex / 其他）的**第一条消息**，直接粘贴下面整段。
> 作用：让 AI 先进入 Phase 0 认知状态，而不是立刻乱改代码。

---

```text
你现在正在开发 Nomad。

Nomad 是建立在 DeepSeek Harness 之上的 Portable Agent OS。

不要把 Nomad 当成一个从零开发的 Agent。
不要重写 DSH Agent Loop。
不要重写 DSH Session。
不要创建第二套 Agent Runtime。

你的第一任务不是写代码。
你的第一任务是理解当前仓库。

执行：

1. git status
2. 查找 AGENTS.md
3. 阅读 README
4. 阅读 docs
5. 阅读 package.json
6. 建立 docs/DSH_SOURCE_MAP.md
7. 找到 DSH Web Entry
8. 找到 Client
9. 找到 Remote/API
10. 找到 Session
11. 找到 Event
12. 找到 Tool
13. 找到 MCP
14. 找到 Plugin
15. 找到 Profile
16. 找到 Build
17. 找到 Runtime

然后输出：

    当前架构
    关键调用链
    数据流
    UI 数据流
    Session 数据流
    Agent 执行流
    Build 流程
    Portable 启动流程

只有完成源码理解后，才能开始修改。

硬约束：

- Runtime 与 Data 分离
- USB 路径由 Launcher 管理
- 不硬编码 Host path
- 不保存 Secret 到 Git
- 不自动 git push
- 不自动升级 DSH master
- 不删除测试
- 不弱化测试
- 不大规模无关重构
- 优先 Plugin/Profile/Adapter/Slot
- Core 修改必须记录
- 修改后必须测试
- 修改后必须检查 git diff
```

---

## 使用说明

1. 仓库根放好 `AGENTS.md`（已就位）。
2. 新会话把上面代码块内容整段粘贴，AI 会自动进入 Phase 0 Recon。
3. Read 到 `AGENTS.md` 后，AI 会被强制遵守第 2 节 Recon Gate 与第 11 节 Quality Gate。
4. Phase 0 完成后，把 `docs/DSH_SOURCE_MAP.md` 固化，并让 AI 输出「发送一条消息后 DSH 内部发生了什么」作为验收。

## 常见偏差（出现即纠正）

| 偏差 | 纠正 |
| --- | --- |
| AI 直接开始写代码 | 打回：先输出 Recon 报告 |
| AI 凭记忆描述 DSH 内部实现 | 要求给出 `文件:行` 证据 |
| AI 提出 fork Core | 要求先穷尽 Configuration / Plugin / Profile / Adapter / Slot |
| AI 建了第二套 Session | 立即停止，回到 Adapter 方案 |
| AI 说「测试先跳过」 | 违反 `AGENTS.md` 第 9 节第 2/3/4 条 |
