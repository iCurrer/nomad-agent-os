---
name: hello-nomad
description: Nomad 内置示例 skill —— 验证 skill 安装链路的最小样例，并向用户问好
whenToUse: 用户想验证 skill 系统是否工作时
---

# Hello Nomad

这是 Nomad 的内置示例 skill（随盘样例 `docs/examples/skills/hello-nomad/`，用
`nomad skill add docs/examples/skills/hello-nomad` 安装到 `data/dsh-home/skills/` 后才会被 DSH 加载）。

## 你要做的

1. 用一句话向用户问好，并报出当前 Nomad 的 Stage（如果知道的话）。
2. 说明：这段行为由 skill 文件驱动，文件位于盘内 `data/dsh-home/skills/hello-nomad/SKILL.md`。
3. 提醒：可以用 `nomad skill remove hello-nomad` 卸载本示例。

## 边界

- 不执行任何写操作，只输出一段话。
