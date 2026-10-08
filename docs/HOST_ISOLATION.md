# HOST_ISOLATION.md — 宿主零污染（源码级证据）

> 本文是「**U 盘生成的记录必须落在 U 盘，不污染宿主机**」这条硬需求的**唯一权威依据**。
> 证据等级：**源码级**（附 `文件:行`）。上游 commit：`5badb15009ae1756c3afe0ae0cef1faafc290ccc`（`0.2.1-alpha.1`，2026-10-03）。
> 与源码冲突时以源码为准，并立即修正本文。

---

## 1. 结论先行

**能成立，而且不需要改 DSH 一行代码。** 三个机制直接支撑：

1. **单一数据根**：DSH 所有用户数据都从 `DSH_HOME` 派生。默认 `~/.dsh`，可用环境变量覆盖。
2. **官方先例**：上游自己的 Desktop 测试脚本就是用「环境白名单 + 覆盖 HOME/TEMP」做隔离的。
3. **临时文件受 TEMP 控制**：全部临时目录走 `os.tmpdir()`，覆盖 `TEMP/TMP/TMPDIR` 即可搬到 U 盘。

---

## 2. 数据根解析链（第一机制）

`packages/util/home-paths/src/index.ts:87` — `resolveDshHome()`

```
优先级：显式配置 path  >  $DSH_HOME  >  ~/.dsh
```

- 空白/纯空格的 `$DSH_HOME` 视为未设置（不会退化到 cwd）
- 结果经过 `~` 展开与绝对化
- 子路径派生：`dshHomePath(...segments)`、`dshCachePath(...segments)` → `<home>/cache/<segments>`

**上游明确为启动器留了口子**：
`apps/cli/src/profile-boot.ts:70`
> `$DSH_HOME` may be set by the test or **launcher** after import.

→ Nomad Launcher 就是那个 launcher。

---

## 3. `DSH_HOME` 之下的实际写入点（源码逐条）

| 写入位置 | 源码位置 | 说明 |
| --- | --- | --- |
| `$DSH_HOME/sessions` | `packages/bundle/base/cordis.patch.yml:133` | **会话记录**：`root: !!js dshHomePath('sessions')`（append-only 事件日志） |
| `$DSH_HOME/profiles/<name>/` | `packages/boot/app-boot/src/profile.ts:169` | profile 目录（`package.json` + `cordis.patch.yml` + 插件 `node_modules`） |
| `$DSH_HOME/cordis.patch.yml` | `apps/cli/src/profile-boot.ts:73-74` | home 级用户补丁层（机器级偏好） |
| `$DSH_HOME/logs/` | `apps/cli/src/startup-diagnostics.ts:27` | 启动诊断报告（私有、唯一命名） |
| `$DSH_HOME/attachments/v1` | `packages/attachment/attachment-local/src/file-store.ts:70` | 附件持久存储 |
| `$DSH_HOME/cache/attachments` | `packages/attachment/attachment-local/src/index.ts:175-177` | 附件缓存 |
| `$DSH_HOME/.credentials.yaml` ⚠️ | `packages/credentials/credentials-local/src/index.ts:7,512` | **凭据：明文 YAML**（见 §6 风险） |
| `$DSH_HOME/.env` | `packages/credentials/credentials-local/src/index.ts:9` | 只读回退层 |
| `$DSH_HOME/AGENTS.md` | `packages/context/agent-instructions/src/render.ts:93-94` | 用户全局指令文件 |
| `$DSH_HOME/llm-deepseek/files-v3.json` | `packages/llm/llm-deepseek/src/upload-index.ts:119` | 上传索引 |
| `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` | `apps/desktop-host/src/index.ts:98` | Desktop 载体运行时（本阶段不用） |
| `$DSH_HOME/settings` | `packages/util/home-paths/README.md:35` | 设置域 |

**结论**：把 `DSH_HOME` 指向 `<NOMAD_ROOT>/data/dsh-home`，上表**全部**落到 U 盘，其中就包含最关键的**会话记录**。

---

## 4. 官方隔离配方（第二机制，直接可抄）

`apps/desktop/scripts/test-host-updates.ts:34-39` — 上游自己的写法：

```js
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(?:path|systemroot|windir|comspec|pathext)$/iu.test(name)))
const child = spawn(process.execPath, [script, root], {
  cwd: root,
  env: {
    ...environment,
    DSH_HOME: join(root, 'home'),
    USERPROFILE: root,
    HOME: root,
    TEMP: root, TMP: root, TMPDIR: root,
  },
  stdio: 'inherit', windowsHide: true,
})
```

要点（Nomad 直接照抄）：

1. **白名单而非黑名单**：只保留 `path / systemroot / windir / comspec / pathext / systemdrive` 六个变量（末位为本项目**增补**，理由见 §4.1），**其余全部不继承**。比逐个排除更彻底。
2. 显式覆盖 `DSH_HOME`、`USERPROFILE`、`HOME`、`TEMP`、`TMP`、`TMPDIR`。
3. **`cwd` 也设为私有根** —— 因为「调用目录」是默认 workspace root。
4. 未设置 `APPDATA` / `LOCALAPPDATA`：源码中这两个变量**只被读、不被写**（仅 `packages/host/open-in-app/src/catalog.ts` 用于探测宿主编辑器），所以不需要搬走。
5. 源码级隔离手段，本项目在 `runtime/launcher/` 中实现为**进程级**，绝不写系统环境变量。

### 4.1 白名单的真实边界（2026-10-08 实测，**推翻了此前的想当然**）

实测方法：用隔离配置构造子进程环境，再在子进程里**直接读 `process.env`**
（注意：`cmd /c echo %VAR%` 是**无效测法** —— cmd 的展开有自己的解析路径，不反映进程环境真相）。

| 传给子进程的 env | 子进程实际可见 |
| --- | --- |
| `{}`（**完全空**） | `SystemDrive="C:"`、`SystemRoot="C:\WINDOWS"`、`USERPROFILE="C:\Users\<user>"`、`TEMP=…\Temp` |
| `{Path}` 等部分变量 | 同上 —— 缺的那些被补上了 |
| `{SystemDrive:"ZZ:"}` | `"ZZ:"`（**传入值被尊重**，不被覆盖） |

**两条结论**：

1. **Windows 在创建进程时会自动补全/注入系统关键变量**，白名单**拦不住**这一类。
   所以「环境里没有 `SystemDrive`」这种状态**不会出现** —— 依赖它做的推断都是错的。
2. **但真正要防的敏感变量确实被防住了** ✅：
   宿主有 `DEEPSEEK_API_KEY`（len=35），而**子进程里为 `null`**。
   → §1 的核心结论（`HOST_ISOLATION.md` 的隔离有效性）**依然成立**；
   白名单只放行了被 override 的项，系统变量被补全属既定行为，**不是泄漏**。

**`systemdrive` 为何仍加入白名单**：这是**声明性对齐**，不是安全修复 ——
上游 `@modelcontextprotocol/client` 的 `DEFAULT_INHERITED_ENV_VARS`（win32 分支）**明确列出**
`SYSTEMDRIVE`，即生态本就期望该变量在场。显式列出便于阅读，且与上游期望一致。

### 4.2 已知缺陷：字面量目录「`%VAR%`」被写入盘内

**现象**：`workspace/%SystemDrive%/ProgramData/Microsoft/Windows/Caches/`
下出现 4 个文件（≈966 KB），正是 Windows 兼容性/字体缓存库
（`cversions.2.db` 等；文件名与系统侧 `C:\ProgramData\Microsoft\Windows\Caches\` 一一对应，
但版本号是初始值 → 是**重建**而非复制）。

**成因（已确认为"路径未展开"）**：某进程把 `%SystemDrive%\…` 当**字面量**拼进路径，
未做展开，于是以该进程 cwd（= Agent 工作区 `workspace/`）为基准落了盘。

**真凶（已逐一排除，未最终定位）**：
- 全量搜字面量 `%SystemDrive%`：`runtime/` 与 Nomad 侧（launcher/tests/tools）**均 0 命中**；
- `@deepseek-ai/libreoffice-kit-win32-x64` 曾疑似（`grep ProgramData` 命中），
  实为 C++ 符号名 `GrGLSLProgramDataManager`，**不是路径**；
- `@modelcontextprotocol/client`：只是**声明要继承**该变量（见 §4.1），不产生字面量；
- `node-gyp`：`process.env.SystemDrive || 'C:'`，**有兜底**。

→ 结论：创建者**不在 Nomad 与已打包运行时之内**（很可能是 Windows 侧组件在不完整环境块下
`ExpandEnvironmentStrings` 保留未展开字面量所致）。**不臆断，不编造来源。**

**防线（可观测，不依赖定位真凶）**：`nomad doctor` 新增
**「盘内字面量目录巡检」**（`launcher/lib/doctor.js#scanLiteralDirs`）——
扫描 `workspace/ data/ profiles/ skills/ mcp/` 下形如 `%VAR%` / `${VAR}` 的目录名并告警
（命中即不再深入；跳过 `node_modules/runtime/vendor/.cache-dev/.git/tmp`；深度上限 4）。

**处置**：已把该子树隔离到 `data/tmp/quarantine/wrongly-written-systemdrive-2026-10-08/`
（保留可恢复性）。清理由维护者确认；`workspace/` 已恢复为空。

---

## 5. 临时文件（第三机制）

全部临时目录走 `os.tmpdir()`，共 20+ 处，典型：

| 位置 | 源码位置 |
| --- | --- |
| spill（溢出的大输出落盘） | `packages/spill/spill-local/src/store.ts:37`、`src/index.ts:146` |
| sandbox 临时根 | `packages/sandbox/sandbox-local/src/index.ts:426`、`packages/sandbox/sandbox/src/roots.ts:54` |
| subprocess 启动目录 | `packages/subprocess/subprocess-local/src/runner-protocol.ts:104`、`src/output.ts:43` |
| shell 活动目录 | `packages/subprocess/subprocess-local/src/shell-activity.ts:66` |
| Chrome 用户数据目录（browser-use） | `packages/experimental/browser-use-stagehand-native/src/launch.ts:28` |
| Office→PDF 转换 | `packages/document/office-to-pdf/src/index.ts:248` |
| 编辑器图标渲染 | `packages/host/open-in-app/src/icons.ts:67,105` |
| Windows ACL 沙箱 | `packages/sandbox/sandbox-windows-acl/src/acl-skill.ts:47` |

> `os.tmpdir()` 在 Windows 下读 `TEMP`/`TMP`，POSIX 下读 `TMPDIR`。
> **覆盖这三个变量 = 全部临时产物搬进 U 盘**（建议 `<NOMAD_ROOT>/data/tmp`）。
> 另注：`packages/experimental/webworker-runtime/src/storage/paths.ts:23` 的 `DSH_TMP` 是**虚拟文件系统常量**，不是环境变量，别误用。

---

## 6. ⚠️ 必须处理的两个风险

### 6.1 凭据是明文 YAML

`packages/credentials/credentials-local/src/index.ts:7`：
> `> $DSH_HOME/.credentials.yaml      (provider-managed, writable)`

**U 盘丢失 = API Key 明文泄露。** ~~Nomad 的处置（对应 `docs/SECURITY.md`）：~~

> ### ✅ 已定案（2026-10-08）→ **ADR-0019**
>
> **维护者拍板的最高判据：「不能污染宿主机」。** 据此：
>
> | 原选项 | 处置 | 理由 |
> | --- | --- | --- |
> | ~~B 宿主 OS Credential Store~~ | ❌ **永久排除** | 会往宿主 Windows 凭据管理器写数据，拔盘后仍留在宿主机 —— **违反「不污染宿主机」** |
> | ~~A+B 混合~~ | ❌ **排除** | B 那半同样污染宿主 |
> | ~~C 裸告警（只提示不控制）~~ | ❌ **排除** | 仍允许明文落进可丢失介质，且挡不住用户在 DSH 自带 UI 里录入落盘 |
> | **A 盘内加密 Secret Store** | ✅ **采纳，排期 Phase 3** | AES-GCM + 主密码派生（scrypt/Argon2），Launcher 启动时解密注入进程环境。加密库在**盘内**，不碰宿主 |
>
> **过渡期规则（立即生效，Phase 2 不受阻）**
> 1. **唯一合法凭据入口 = Launcher 以进程环境变量注入**（与 `DSH_HOME` 同一条通道）。
> 2. 盘内 `$DSH_HOME/.credentials.yaml` 必须维持**空模板**，不得承载真 key。
> 3. 需要真实对话轮时，由维护者**当次**启动前临时提供（临时环境变量 / 交互输入），`nomad stop` 后不保留。
> 4. Phase 2（Web UI 定制）**不需要模型凭据**，因此**不被本项阻塞**。

- **禁止**把 `.credentials.yaml` 提交进 Git（已由 `.gitignore` 的 `data/` 覆盖）

**实测确认（2026-10-08）**：真实 DSH（`0.2.1-alpha.1`）首次启动即在**盘内** `$DSH_HOME` 创建了该文件
（`data/dsh-home/.credentials.yaml`，161 字节模板）。**这不是理论风险，而是必然发生的写入点** ——
所以本项**不能**靠"用户不去配置"来规避，必须由 Launcher 掌控唯一注入通道。


### 6.2 `.env` 不能设置 bootstrap 变量

`packages/boot/app-boot/src/index.ts:133-157`：
- `BOOTSTRAP_NAMES` 含 `PATH` `HOME` `USERPROFILE` `SHELL` `NODE_OPTIONS` `NODE_PATH` `GIT_*` `HTTP_PROXY` 等
- `BOOTSTRAP_PREFIXES = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']`

任何 `.env` 文件尝试设置这些名字会**直接报错退出**。
→ **`DSH_HOME` 必须由 Launcher 以进程环境变量注入**，写进 `.env` 会被拒绝。

配套事实（`packages/util/launch-environment/README.md`）：
`.env` 分层信任顺序为「继承的进程环境 > `<调用目录>/.env` > `$DSH_HOME/.env`」。

### 6.3 宿主交互是有意设计，不是污染

`packages/host/open-in-app/src/catalog.ts` 会探测并**启动**宿主的 Cursor / VS Code / Windsurf / GitHub Desktop 等。
这是产品功能。在 Nomad 权限模型中归类为 **External（必须询问）**，见 `config/permissions.yaml`。

---

## 7. 宿主机侧可能残留的白名单（预期，需实测确认）

| 位置 | 预期原因 | 可控性 |
| --- | --- | --- |
| `%TEMP%` 下 OS/浏览器自身临时文件 | 系统行为 | 高（DSH 自身的已搬走） |
| 浏览器缓存（用户自己的浏览器配置） | 打开 `127.0.0.1:3080` 是宿主浏览器行为 | 中（属用户自己的浏览器，不算 Nomad 写入） |
| 无 | `AppData` / `LocalAppData` / 注册表 | **源码中无写点** |

> 「打开浏览器」这一点需要注意：**浏览器本身是宿主的**，它的历史记录/缓存属于宿主浏览器自己的行为，Nomad 不可能也不应该接管（除非改用 Electron 载体，即官方 Desktop 形态）。

---

## 8. 验收测试流程（对应 `docs/TESTING.md`）

1. 清洁 Windows 机器（**不装 Node / pnpm**）
2. 记录基线的 `%APPDATA%`、`%LOCALAPPDATA%`、`%USERPROFILE%`、`%TEMP%` 快照
3. 插入 U 盘，启动 `Nomad.exe`
4. 浏览器打开 → 建会话 → 发消息 → 触发一次 Tool（Shell / 文件写）
5. 创建 Project、上传一个附件、改一次配置
6. 退出
7. 比对快照，逐项填入下表

| 残留路径 | 产生原因 | 是否必需 | 可否收敛 | 处置 |
| --- | --- | --- | --- | --- |
| （待实测填入） | | | | |

8. 反向验证：确认 `$NOMAD_ROOT/data/dsh-home/sessions/` 下**确实新增了会话文件**

### 8.1 实测结果（**真实引擎**，2026-10-08）

用真实 `@deepseek-ai/dsh@0.2.1-alpha.1`（**不是替身**）经 Nomad 启动一次并观测：

| 观测项 | 结果 |
| --- | --- |
| 宿主 `C:\Users\<user>\.dsh` | **全程未出现** —— 该目录事先已清空并作为标尺，这是最强的单条判据 |
| 盘内 `$DSH_HOME` 新增 | `.anonymous-user-id`、`.credentials.yaml`、`profiles/`、`sessions/`、`storages/` |
| 宿主临时目录 | **未被写**（`TEMP` / `TMP` / `TMPDIR` 已重定向到盘内 `data/tmp`） |
| 宿主 `%APPDATA%` / `%LOCALAPPDATA%` | 未新增 dsh 相关目录（与源码结论一致：二者只被读、不被写） |
| 进程 | `nomad stop` 后**无残留进程**；状态文件被清理 |
| 复现脚本 | `tests/smoke/real-runtime-smoke.js`（11 步，其中两条是宿主标尺断言） |

> ⚠️ **仍未实测的项**：会话内附件、Office→PDF 转换、browser-use 的 Chrome 用户目录。
> 这些路径在 Phase 0 源码盘点里已确认**都走 `tmpdir()`**，但要触发它们必须跑一次**真实对话轮**，
> 而这需要盘上有可用的模型凭据 —— 于是它和 §6.1 的凭据方案选择绑在一起。

---

## 9. 待办

- [x] 真实引擎零污染实测（标尺：宿主 `~/.dsh` 必须始终不出现；见 §8.1）
- [x] §7 残留白名单实测（`%APPDATA%` / `%LOCALAPPDATA%` / 桌面快捷方式 / npm 全局 —— **均无 DSH 残留**）
- [x] **§6.1 凭据处置定案** → **ADR-0019**：宿主凭据库永久排除（违「不污染宿主机」铁律）；唯一入口 = Launcher 注入；
      盘内不落真 key；加密库排期 Phase 3。**Phase 2 不再被阻塞**
- [ ] 跑一次真实对话轮，覆盖会话内附件 / Office→PDF / browser-use 的 Chrome 用户目录
      （仍需维护者当次临时提供模型凭据；跑完须断言宿主 `~/.dsh` 未出现）
- [x] 用 `dsh --dump-config` 导出 web profile 组合树，逐行核对是否仍有非 `DSH_HOME` 派生的绝对路径
      → **结论：没有。** 全树 1312 行仅 2 处盘符字样，均无害（OTel URL + prompt 字面示例）。
      证据：`tests/smoke/l4a-patch-probe.js` 第 7 步（回归断言）
- [x] 确认 `settings` 域与 `session-query-sqlite` 的实际落点
      → `session-query-sqlite` = `path: ':memory:'` + `openAt: never`，**无盘上落点**；
      `sessions` / `storages` 的 `root` 均为 `!!js dshHomePath(...)`（盘内派生）；`settings` 行无 path 配置
- [ ] 确认 DSH 是否提供「禁用自带凭据录入」开关；若无，则需在启动横幅 + `doctor` 标注盘内凭据文件状态


