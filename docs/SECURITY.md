# SECURITY.md — 安全与 Secret 管理

## 1. Secret 铁律

**禁止** API Key 进入：

- Git 仓库
- 日志
- Session 记录
- 截图 / 录屏
- config 仓库 / 示例文件

**禁止**出现的文件名与形式：

```
secrets.json
api_key.txt
provider_key.yaml
明文 token 写进 nomad.yaml
```

## 2. 存储策略

优先级：

1. **OS Credential Store**（Windows Credential Manager / Keychain / libsecret）—— 首选
2. 若必须「完全便携」（换机器即用）：**加密 Secret Store**
   - USB 上只保存**密文**
   - 主密钥不落盘在同介质明文位置
   - 加密方案需写入 `docs/DECISIONS.md`

## 3. Provider 配置规范

`config/providers.yaml` 只允许：

```yaml
providers:
  - id: <name>
    type: <openai-compatible|...>
    base_url: <url>
    credential_ref: <credential-store-key>   # 只存引用，不存值
```

**任何情况下不写 `api_key:` 字段。**

## 4. Agent 行为权限

| 级别 | 默认策略 |
| --- | --- |
| Read | 自动允许 |
| Write | workspace 内自动允许 |
| Execute | 普通命令自动允许 |
| Network | 按工具判断 |
| Sensitive | 必须询问 |
| External Upload | 必须询问 |
| Git Push | 必须询问 |
| Production Deploy | 必须询问 |

落点：`config/permissions.yaml`。

## 5. 供应链

- 禁止引入未经确认的第三方代码
- 禁止复制许可证不明的代码
- 新增依赖必须说明理由，并记录到 `docs/DECISIONS.md`

## 6. 提交前自检

- [ ] `git diff` 中无 Secret / token / 私钥
- [ ] 无硬编码 Host 路径
- [ ] 无调试用输出敏感信息
- [ ] `.gitignore` 覆盖 runtime / data / workspace / secrets
