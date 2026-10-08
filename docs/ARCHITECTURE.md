# ARCHITECTURE.md — Nomad 总体架构

> 本文件描述**目标架构**。凡与当前仓库源码不符处，以源码为准，并及时修正本文件。
> 状态：`draft`（Phase 0 结束后需按真实源码复核一遍）

## 1. 分层

```
                          NOMAD
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
      Web UI              CLI              Launcher
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                 Nomad Application Layer
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
     Projects            Memory              Skills
        │                   │                   │
     Profiles            Context          Permissions
                            │
                            ▼
              DeepSeek Harness Engine
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
    Agent Loop            Tools                MCP
        │                   │                   │
     Sessions             Models              Events
                            │
                            ▼
                   Portable Runtime
                            │
                            ▼
                           USB
```

Nomad = `UI` + `Application Layer` + `Portable Runtime` + `Persistent Data` + `DSH Engine`

## 2. 职责边界

### DSH 负责（Nomad 不重写）

Agent Loop ｜ Tool Calling ｜ Tool Runtime ｜ Session ｜ Model ｜ MCP ｜ Events ｜ Agent execution

### Nomad 负责

Portable Runtime ｜ Launcher ｜ Browser UI ｜ Project management ｜ Memory management ｜ Skills management ｜ Profiles ｜ Permissions ｜ Portable configuration ｜ Backup ｜ Runtime version management ｜ Upgrade / rollback ｜ USB persistence ｜ Host isolation

## 3. Web Client 数据方向（唯一正确路径）

```
Host / DSH State
      ↓
 Remote / API
      ↓
  Client Model
      ↓
  UI Adapter
      ↓
Conversation / Presentation
      ↓
    Slots
      ↓
   React UI
```

**禁止**：

- `React Component → 自己复制一套 Agent State`
- `DSH Session + Nomad Session` 两套事实源

**正确**：`DSH Session → Nomad Adapter → Nomad UI`

## 4. Client 模块盘点清单

修改 Web Client 前，必须先在实际源码中确认以下模块的位置与关系（不靠文件名猜测）：

Client ｜ Remote ｜ API ｜ Session ｜ Conversation ｜ Event ｜ Model ｜ Slots ｜ Layout ｜ Plugin ｜ Profile ｜ Settings

对每个模块回答 8 问：

1. 谁创建它？
2. 谁调用它？
3. 数据从哪里来？
4. 数据到哪里去？
5. 生命周期是什么？
6. 是否有事件？
7. 是否可以被替换？
8. 是否有 Plugin / Slot 扩展点？

> 盘点结果写入 `docs/DSH_SOURCE_MAP.md`。

## 5. 可移植层

| 关注点 | 设计 |
| --- | --- |
| 根路径 | 所有路径从 `NOMAD_ROOT` 派生，由 Launcher 注入 |
| Runtime | `runtime/dsh/<version>/`，`current` 指向当前版本 |
| Data | `data/`，跨 Runtime 版本长期存活 |
| 环境隔离 | 进程级 environment override（HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP/npm cache/Node cache/DSH writable state），不永久改系统变量 |
| 端口 | 不写死，默认被占用时自动寻找可用端口 |
| 宿主污染 | 以实测为准，见 `docs/PORTABILITY.md` 的检查表 |

## 6. 升级 / 回滚

```
Check → Download → Verify → Backup → Migrate → Smoke Test → Switch → Success
                                                                  └─ 失败 → Rollback
```

`config/compatibility.yaml` 记录：Nomad version、DSH version、schema version、migration version。

**禁止**：直接追踪 master、每次启动自动 `git pull`、自动覆盖当前 Runtime。

## 7. 构建与发布

```
开发机:  DSH Source → Nomad Patch → Nomad Plugins → Nomad Web → Build → Package → Portable Release
用户机:  Portable Runtime → USB（不需要源码 / pnpm / node_modules / 重新编译）
```

第一阶段平台优先级：**Windows x64** > Linux x64 > macOS。多平台统一通过抽象层（runtime / launcher / path / environment / browser / process management）。

## 8. 待源码验证清单（Phase 0）

- [ ] DSH 进程入口与启动参数
- [ ] Web Server 启动方式与端口协商机制
- [ ] Session 存储介质（文件 / DB / durable stream）
- [ ] Event 流协议与订阅方式
- [ ] Client 与 Host 的通信协议（HTTP / WS / RPC）
- [ ] Plugin / Profile / Slot 真实扩展点
- [ ] DSH 可写状态目录集合（决定 Host Isolation 变量清单）
- [ ] Build 产物结构与最小运行依赖
