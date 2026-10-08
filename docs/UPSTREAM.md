# UPSTREAM.md — DSH 上游修改台账

> **凡修改 DSH Core，必须在此登记。** 未登记的 Core 修改视为违规。
> 目标：随时能回答「我们相对上游改了哪些、为什么、升级时会不会炸」。

## 登记表

| # | 上游版本 | 修改 commit | 修改文件 | 修改原因 | 修改行为 | 兼容性风险 | 可否上游化 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | | |

字段说明：

- **上游版本**：修改基于的 DSH 版本（如 `0.2.1`）
- **修改 commit**：本仓库 commit hash
- **修改原因**：为什么现有扩展点（Configuration / Plugin / Profile / Adapter / Slot）无法满足
- **修改行为**：改了什么逻辑，行为差异是什么
- **兼容性风险**：升级到新版本时冲突概率与影响面
- **可否上游化**：能否提交回上游（能则优先上游化）

## 当前基线

| 项 | 值 |
| --- | --- |
| 跟踪的 DSH 版本 | `0.2.1-alpha.1` |
| 上游 commit | `5badb15009ae1756c3afe0ae0cef1faafc290ccc`（2026-10-03） |
| npm 已发布版 | `0.2.0-rc.2` |
| 本地源码路径 | `vendor/deepseek-harness/`（`--depth 1`，仅供阅读） |
| 最后同步日期 | 2026-10-08 |
| 累计 Core patch 数 | **0** |
| 许可证 | MIT |

## 同步与升级流程

```
Check 上游版本
   ↓
评估 breaking changes（对照 UPSTREAM 登记表逐条比对）
   ↓
Download → Verify → Backup → Migrate → Smoke Test → Switch
   ↓
失败 → Rollback（current 指回旧版本）
```

**严禁**：

- 直接追踪 `master`
- 每次启动自动 `git pull`
- 自动覆盖当前 Runtime
- 自动升级 DSH master

> 原因：DSH 仍属 developer preview，上游可能存在 breaking changes。

## 每次 DSH 升级后必须做

- [ ] 更新 `docs/DSH_SOURCE_MAP.md`
- [ ] 逐条复核本文件登记表的 patch 是否仍然必要 / 是否已被上游吸收
- [ ] 更新 `config/compatibility.yaml` 的 `dsh_version`
- [ ] 跑 Runtime Smoke Test + Portable Smoke Test
