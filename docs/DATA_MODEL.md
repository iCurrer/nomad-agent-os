# DATA_MODEL.md — Nomad 数据模型

> **警告**：以下为**设计草案**，字段必须根据 DSH 与 Nomad 实际实现调整。
> **禁止在未验证的情况下固化 Schema**。任何结构变更必须先定位源码、写 ADR，再改本文件。

## 1. 事实源原则

| 数据 | 事实源 | Nomad 的角色 |
| --- | --- | --- |
| Session（消息、事件、执行状态） | **DSH** | 只读 + 附加 metadata |
| Event / durable stream | **DSH** | 订阅转发，不另存副本 |
| Project / Memory / Skill / Profile / Permission / Runtime | **Nomad** | 完全拥有 |
| UI state / Theme | **Nomad** | 完全拥有 |

**禁止**：Nomad 复制 DSH 的 Session 状态并让 UI 认为那是真实来源。

## 2. 实体草案

### Session（Nomad 侧 metadata）

```
id
created_at
updated_at
project_id
profile_id
dsh_session_id      # 指向 DSH 事实源
title
tags[]
notes
ui_state            # 可丢弃
```

### Project

```
id
name
path                # 相对 NOMAD_ROOT
profile
skills[]            # 引用
memory_refs[]       # 引用
instructions        # 项目级追加指令
git_metadata
created_at
updated_at
```

### Memory

```
id
type                # user | project | preference | decision | knowledge
content
source
project_id
created_at
updated_at
```

用户必须能够：查看 / 编辑 / 删除 / 导入 / 导出 / 搜索。
**Memory 不得变成 AI 黑盒数据库。**

### Skill

```
id
name
version
path
enabled
```

目录约定：`skills/<name>/`，内含 `skill.md` + instructions / examples / references / scripts。
Skill 不得直接侵入 DSH Core。

### Profile

```
id
name                # coding | research | writing | devops | personal
model
tools[]
skills[]
permissions{}
mcp[]
ui_behavior
```

示例（Coding Profile）：tools = `shell / git / filesystem / browser`；permissions = 可读写 workspace、**禁止 production deploy**。

## 3. 存储布局

```
data/
├── sessions/     # Nomad 侧 Session metadata
├── events/       # 索引 / 指针（不是 DSH Event 的替代副本）
├── memory/
├── projects/
├── logs/
├── cache/        # 可随时删除
└── backups/
```

`cache/` 与 `logs/` 视为可丢弃；`sessions/ memory/ projects/ backups/` 视为不可丢失。

## 4. 兼容与迁移

- `config/compatibility.yaml` 记录 `nomad_version / dsh_version / schema_version / migration_version`
- 任何 schema 变更 → 递增 `schema_version` + 提供 migration + 提供 rollback
- 迁移前必须 Backup（写入 `data/backups/`）

## 5. 待验证项

- [ ] DSH Session 实际字段与存储格式
- [ ] 是否已有 Event 持久化机制可复用
- [ ] DSH 是否已有 Profile / Plugin 的数据结构可直接继承
- [ ] Nomad metadata 应挂在 DSH Session 的哪一层（sidecar vs 独立索引）
