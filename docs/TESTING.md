# TESTING.md — 测试与 Quality Gate

> 原则：**测试不是最后补的，而是修改的一部分。**
> 不允许用「看起来能工作」代替架构正确。

## 1. 每次修改的最低要求

| 顺序 | 项目 | 何时必做 |
| --- | --- | --- |
| 1 | Typecheck | 每次 |
| 2 | Lint | 每次 |
| 3 | Unit Test | 每次 |
| 4 | Build | 涉及构建 |
| 5 | Web Build | 涉及 Web |
| 6 | Runtime Smoke Test | 涉及 Runtime |
| 7 | Portable Smoke Test | 涉及便携 / Launcher / 环境 |

收尾（强制）：

```bash
git diff
git status
```

确认：无无关修改 / 无 Secret / 无 Host path / 无测试删除 / 无临时文件。

## 2. 禁止的测试行为

- 删除测试
- 弱化测试（放宽断言、加 try-catch 吞错、跳过）
- 修改测试来「通过测试」
- `skip` / `only` 遗留进提交

## 3. 测试分层（目标形态）

| 层 | 范围 | 说明 |
| --- | --- | --- |
| Unit | Application Layer 逻辑 | Project / Memory / Skill / Profile / Permission |
| Integration | Adapter 与 DSH 边界 | Session 读写、Event 订阅、Remote / API |
| Smoke | Launcher 全链路 | 启动 → Web → Session → Tool → 退出 |
| Portable | 宿主污染 | 见下节 |
| UI | 组件与布局 | Tool Card 渲染、主题 token |

## 4. Portable Smoke Test（关键）

在**清洁环境**执行：

1. 无 Node / pnpm 的机器上插入 USB
2. 启动 `Nomad.exe`
3. 浏览器自动打开 Web UI
4. 创建 Session 并发送一条消息，Agent 正常回复
5. 触发一次 Tool 调用（Shell / File）
6. 创建 Project，重启后仍在
7. 修改配置，重启后生效
8. 干净退出（进程无残留）
9. 按 `docs/PORTABILITY.md` 第 4 节检查宿主污染

**全部通过才算 Phase 1 完成。**

## 5. Runtime Smoke Test

针对 `runtime/dsh/<version>/`：

- [ ] `current` 指向正确
- [ ] 启动成功且版本可查
- [ ] 升级到新版本后 `data/` 不受影响
- [ ] 模拟失败 → 回滚到旧版本成功

## 6. 报告格式

每次修改后，AI 必须输出：

```
改动文件：
  - path (原因)
验证命令与结果：
  - typecheck: pass
  - lint: pass
  - test: pass
  - build: pass / n/a
git diff 摘要：
风险与未覆盖项：
```
