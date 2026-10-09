// nomad-panel — 浏览器半（**手写，零构建**）
//
// 职责：在 DSH 侧栏**长出一个 Nomad 自己的入口**，并在主区渲染 Nomad 自己的面板。
// 这是 Phase 2 阶段 5-B（结构层）的产物；2026-10-09 依维护者反馈改版为**仪表盘形态**：
//   分区 = ① 品牌头 ② **Dashboard（状态数据卡片墙）** ③ 构建元信息 ④ About（折叠，默认收起）。
//   About（合规声明 + 产品介绍）与数据面板**分离** —— 数据归数据，合规归合规；
//   About 折叠但**始终在元素树里**（inline display:none），合规文案由测试守着，不因折叠而缺席。
//
// ── 为什么是「增量长一格」而不是「整块替换侧栏」────────────────────────────────
// `ui-layout/src/client/index.ts:58-67` 对 `sidebar` 槽的契约原文：
//   "The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which declares the
//    workspace and settings seats inside it — registering here replaces the navigation
//    column outright rather than adding to it, **and the seats it declares disappear
//    with it**."
// 即整块替换会**连带丢掉** `sidebar.workspaces`（会话列表）与 `sidebar.settings`（设置），
// 必须自己重新声明并重写（上游 SidebarRoot 316 行 + 折叠动画 + 滚动条管理）。
// 收益/风险比很差，故走增量。
//
// ── 为什么增量是**零冲突**的（两条槽的基数决定，非推测）────────────────────────
//   · `main`              — kind: **keyed** ⇒ 新 key 就是新格子，与既有 key 并列。
//                           AppFrame 用 `renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })`
//                           寻址，故只要本行 key 与侧栏行的 id 相同即可对上。
//   · `sidebar.panellist` — kind: **list**  ⇒ 新 id 就是新行。
//                           且侧栏的面板行**直接来自本槽的注册条目** ——
//                           `ui-sidebar/src/client/index.ts:50-54` 逐字：
//                             `ctx.slots.entriesOfSlot('sidebar.panellist').map(({ options }) => ({
//                                id: options.id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id
//                              })).sort((a, b) => a.order - b.order)`
//                           ⇒ **注册即出现在侧栏**，无需修改任何上游行、无需 disable 任何占用者。
//   · 两者由 `selectPanel(id)` 串联：`ui-layout/src/client/service.ts:72-78` 在选中前检查
//     `hasMainPanel(id)`（查 live main-slot registry）—— 我们两侧都注册，故必然通过。
//
// ── 槽契约 ─────────────────────────────────────────────────────────────────────
//   · `main`              owner props `{}`（为空；寻址靠 register 的 `key`）
//   · `sidebar.panellist` owner props `{ size: 16|18, active: boolean }`（SidebarPanelIconOwnerProps）
//
// ── 样式策略：不硬编码任何色值 ──────────────────────────────────────────────────
// 全部走上游 CSS 变量（`--dsw-*`；上游 dist 里共 **433** 个，侧栏样式亦然）。
// 理由：① 自动跟随亮/暗主题；② 主题样式由 `ui-theme` 在**运行时**以 `<style>` 注入
// （`ui-theme/src/client/styles.ts` 的 `installThemeStyles`），变量在 `:root` / `body` 上，
// 我们只消费不覆盖 —— 与上游换肤机制不冲突。
// 次要文字额外挂 `currentColor` 兜底 + opacity：万一将来变量名变动，也不会落到"看不见"。

window.__ModuleLoader__.load({
	id: "@nomad/dsh-client-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let jsx_runtime = require("react/jsx-runtime");
		let React = require("react");

		/** 侧栏入口与主面板共用的寻址 id（`MainPanelId` 运行期就是普通字符串）。 */
		const PANEL_ID = "nomad";

		// ── 设计令牌（全部引用上游变量，无一处硬编码色值）──────────────────────────
		// 兜底值刻意只用 `currentColor` / `transparent` —— **不得**写死任何色值（含中性灰）：
		// 写死的中性色会在明暗主题之一里失真，而 `currentColor` / `transparent` 永远安全。
		// 这条由 `tests/nomad-panel.test.js` 的「不含任何硬编码色值」用例守住。
		const T = {
			primary: "var(--dsw-alias-label-primary, currentColor)",
			secondary: "var(--dsw-alias-label-secondary, currentColor)",
			brand: "var(--dsw-alias-brand-primary, currentColor)",
			surface: "var(--dsw-alias-bg-layer-2, transparent)",
			card: "var(--dsw-alias-bg-layer-1, transparent)",
			border: "var(--dsw-alias-border-l2, transparent)",
			borderSoft: "var(--dsw-alias-border-l1, transparent)",
			radiusLg: "var(--dsw-radius-lg, 16px)",
			radiusMd: "var(--dsw-radius-md, 12px)",
			radiusSm: "var(--dsw-radius-sm, 8px)",
			mono: "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)",
			// 语义状态色（卡片状态点用）：全部来自上游真实 token（runtime dist 实证存在），
			// 兜底 currentColor —— 不硬编码任何色值，明暗主题自动跟随。
			ok: "var(--dsw-alias-state-success-primary, currentColor)",
			warn: "var(--dsw-alias-state-warn-primary, currentColor)",
			bad: "var(--dsw-alias-state-error-primary, currentColor)",
		};

		// ── 上游归属与许可（About 区块用；合规声明的最小事实集）──────────────────────
		// 为什么内联写死而不是读配置：本包是**零构建手写产物** —— 运行时既拿不到
		//   `config/nomad.yaml`，也不经过任何构建期变量替换（宿主半是空 `apply`）。
		// 防漂移：`version` 必须与 `config/nomad.yaml` 的 `runtime.dsh.pinned_version` 一致，
		//   由 `tests/nomad-panel.test.js` 的「★ 上游版本锚定」用例逐字比对两处 —— 改一处漏另一处即红。
		// 事实来源（均为上游原文，非推断）：
		//   · `vendor/deepseek-harness/LICENSE` 首行：MIT License / Copyright (c) 2026 DeepSeek；
		//   · `vendor/deepseek-harness/README.md` 与 `BRAND_GUIDELINES.zh.md`。
		const UPSTREAM = {
			/** 上游产品全名。BRAND_GUIDELINES 明确允许在**描述性文字**中使用全名。 */
			name: "DeepSeek Harness",
			/** 官方建议的生态缩写（用于简称处）。 */
			abbr: "DSH",
			/** 锁定的上游版本；与 config/nomad.yaml 的 pinned_version 对齐（有测试守）。 */
			version: "0.2.1-alpha.1",
			/** 上游许可标识。 */
			license: "MIT",
			/** 版权持有人。 */
			holder: "DeepSeek",
			/** 版权年份。 */
			holderYear: "2026",
		};

		// ── 状态端点（只读、低频轮询）──────────────────────────────────────────────
		// 数据从 Host（盘内）进面板的唯一桥接（见 docs/HOST_TO_CLIENT.md §4 路径 B）：
		// 面板是**零构建手写**产物，读不到运行时随机端口（DSH_CLIENT_* 是构建期内联），
		// 也读不到盘内 nomad.state.json，故端点用**固定端口**（config.status.port，缺省 3090）。
		// 面板直接 fetch 一个可预测地址；失败即降级为静态骨架，不因端点未就绪而崩。
		// 该地址与 config/nomad.yaml 的 status.port 对齐，由 tests/nomad-panel.test.js 守锚定。
		const STATUS_ENDPOINT = "http://127.0.0.1:3090/status";

		/**
		 * 低频轮询只读状态端点，返回 { data, error, stale }。
		 * 用 React 的 useState/useEffect（面板已 require react）；轮询间隔 5s。
		 * **失败不清空上次数据**（2026-10-09 真机反馈：U 盘慢时请求偶发超时，
		 * 清空会让面板在「骨架 ↔ 数据」之间来回翻页，用户感知为闪屏）——
		 * 只记录 error 供降级提示，数据保留上一次成功值（stale 标注陈旧）。
		 * @returns {{ data: object|null, error: string|null, stale: boolean }} 状态快照
		 */
		function useStatus() {
			const [snapshot, setSnapshot] = React.useState({ data: null, error: null, stale: false });
			React.useEffect(() => {
				let cancelled = false;
				let timer = null;
				const tick = async () => {
					try {
						const res = await fetch(STATUS_ENDPOINT, { cache: "no-store" });
						if (!res.ok) throw new Error("HTTP " + res.status);
						const data = await res.json();
						if (!cancelled) setSnapshot({ data: data, error: null, stale: false });
					} catch (error) {
						// 只在「还没有任何成功数据」时才塌到骨架；有数据就保留并标注陈旧。
						if (!cancelled) {
							setSnapshot(function (prev) {
								if (prev && prev.data !== null && prev.data !== undefined) {
									return { data: prev.data, error: error instanceof Error ? error.message : String(error), stale: true };
								}
								return { data: null, error: error instanceof Error ? error.message : String(error), stale: false };
							});
						}
					}
				};
				void tick();
				timer = setInterval(() => { void tick(); }, 5000);
				return () => { cancelled = true; if (timer !== null) clearInterval(timer); };
			}, []);
			return snapshot;
		}

		// ── 侧栏图标：北斗七星「点阵版」────────────────────────────────────────────
		// 与侧栏顶部品牌标识（`@nomad/dsh-client-brand` 的**连线版**七星）**同源不同形**：
		// 顶部是 24px 完整星图（含连线），这里是 16/18px 点阵 —— 小尺寸下点比线清晰，
		// 且避免与 logo 完全重复。点位与品牌包一致（斗柄 3 星 + 斗魁 4 星，索引 3 为枢纽「天权」）。
		const DIPPER = [
			[3.2, 17.2], [6, 16], [8.6, 14.2], [10.6, 12.2],
			[10.2, 7], [15, 5.6], [16.8, 10.2],
		];

		/**
		 * 侧栏行图标。
		 * @param props - 宿主槽位提供的几何与选中态。
		 * @param props.size - 请求的方形边长（像素）；上游传 16（宽栏）或 18（窄栏）。
		 * @param props.active - 本面板是否为主区当前选中项。
		 * @returns 七星座图标。
		 */
		function NomadPanelIcon(props) {
			const size = typeof props.size === "number" ? props.size : 18;
			const active = props.active === true;
			return jsx_runtime.jsx("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true",
				focusable: "false",
				children: jsx_runtime.jsx("g", {
					fill: "currentColor",
					// 未选中时整体略降透明度：与上游面板图标（线条类）的静息观感对齐。
					opacity: active ? 1 : 0.7,
					children: DIPPER.map((star, index) =>
						jsx_runtime.jsx("circle", {
							cx: star[0],
							cy: star[1],
							r: index === 3 ? 2.5 : 1.9,
						}, index)),
				}, "stars"),
			});
		}

		// ── 大号品牌标识（面板头部用）──────────────────────────────────────────────
		/**
		 * 渲染面板头部的大号七星（含连线，与侧栏 logo 同形以便识别同源）。
		 * @param props - 边长。
		 * @returns 七星标识。
		 */
		function NomadMark(props) {
			const size = typeof props.size === "number" ? props.size : 44;
			return jsx_runtime.jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true",
				focusable: "false",
				style: { display: "block" },
				children: [
					jsx_runtime.jsx("path", {
						d: "M3.2 17.2L6 16 8.6 14.2 10.6 12.2 10.2 7 15 5.6 16.8 10.2 10.6 12.2",
						stroke: "currentColor",
						strokeWidth: 1.1,
						strokeLinecap: "round",
						strokeLinejoin: "round",
						opacity: 0.55,
					}, "dipper"),
					jsx_runtime.jsx("g", {
						fill: "currentColor",
						children: DIPPER.map((star, index) =>
							jsx_runtime.jsx("circle", {
								cx: star[0],
								cy: star[1],
								r: index === 3 ? 2 : 1.5,
							}, index)),
					}, "stars"),
				],
			});
		}

		// ── 仪表盘卡片数据（3.6 面板整合 + 发布级打磨 2026-10-09）────────────────────
		/**
		 * 把实例 phase 翻译成对外措辞（上游 phase 是内部英文枚举，发布面不裸露）。
		 * @param {string|undefined} phase - 上游 phase 原值
		 * @returns {string} 对外显示文本
		 */
		function describePhase(phase) {
			if (phase === undefined || phase === null || phase === "") return "未运行";
			const map = { ready: "运行中", starting: "启动中", stopping: "停止中", stopped: "已退出", exited: "已退出" };
			return map[String(phase)] ?? String(phase);
		}

		/**
		 * 把状态快照折叠成仪表盘卡片数据（纯函数，测试可直接喂桩数据）。
		 * 每张卡 = { label, value, sub, tone? }；tone 是语义状态（'ok'|'warn'|'bad'），
		 * 渲染层据此画状态点（颜色走上游语义 token）。
		 * 端点未就绪时给一张「Status」卡说明原因；各数据段缺失时跳过对应卡 ——
		 * 段级容错契约：缺一段不塌整墙。
		 * @param {{ data: object|null, error: string|null, stale: boolean }} status - useStatus 快照
		 * @returns {{ label: string, value: string, sub: string, tone?: string }[]} 卡片数据
		 */
		function buildCards(status) {
			const data = status && status.data;
			if (data === null || data === undefined) {
				return [{
					label: "Status",
					value: "—",
					sub: status && status.error ? "端点不可达：" + status.error : "连接中…",
				}];
			}
			const id = data.identity || {};
			const st = data.state || {};
			const health = data.health || {};
			const cards = [];
			// 对外措辞：引擎版本不带内部缩写（上游全名与归属在 About 中给足）。
			cards.push({
				label: "Version",
				value: id.NOMAD_VERSION || "—",
				sub: "引擎 " + (id.DSH_VERSION || "—"),
			});
			cards.push({
				label: "Instance",
				value: describePhase(st.phase),
				sub: st.publicUrl !== undefined && st.publicUrl !== "" ? String(st.publicUrl) : "nomad start 后出现",
				tone: st.phase === "ready" ? "ok" : undefined,
			});
			const summary = health.summary || {};
			cards.push({
				label: "Health",
				value: `${summary.pass ?? 0} 通过`,
				sub: `警告 ${summary.warn ?? 0} · 失败 ${summary.fail ?? 0} · 跳过 ${summary.skip ?? 0}`,
				tone: (summary.fail ?? 0) > 0 ? "bad" : (summary.warn ?? 0) > 0 ? "warn" : "ok",
			});
			// Profiles 段（Phase 3.6）：默认 profile 置前；问题明细由 doctor 承担。
			if (data.profiles !== undefined && data.profiles !== null) {
				cards.push({
					label: "Profile",
					value: data.profiles.defaultName || "—",
					sub: `盘内共 ${data.profiles.count ?? 0} 个`,
				});
			}
			// Skills 段（Phase 3.2）：数量一目了然；修复指引由 doctor 的 skills 巡检项承担。
			if (data.skills !== undefined && data.skills !== null) {
				cards.push({
					label: "Skills",
					value: `有效 ${data.skills.valid ?? 0}`,
					sub: `已装 ${data.skills.total ?? 0} · 被忽略 ${data.skills.ignored ?? 0}`,
					tone: (data.skills.valid ?? 0) > 0 ? "ok" : undefined,
				});
			}
			// 数据面段（Phase 3.3）+ 备份提示（3.5）：面板只展示，动作入口在 CLI。
			if (data.data !== undefined && data.data !== null) {
				cards.push({
					label: "Storage",
					value: data.data.human ?? "—",
					sub: `可清理 ${data.data.tmpFiles ?? 0} 文件`,
				});
				const backup = data.data.lastBackup;
				if (backup !== undefined && backup !== null) {
					const stale = backup.ageDays === null || backup.ageDays === undefined || backup.ageDays > 30;
					cards.push({
						label: "Backup",
						value: backup.ageDays === null || backup.ageDays === undefined ? "从未备份" : `${backup.ageDays} 天前`,
						sub: stale ? "建议 nomad backup" : "nomad backup 可备份",
						tone: stale ? "warn" : "ok",
					});
				}
			}
			// 权限档位段（Phase 3.6）：一行档位摘要；正文与 never 自证由 doctor 第 21 项承担。
			if (data.permissions !== undefined && data.permissions !== null) {
				const pm = data.permissions;
				cards.push({
					label: "Permissions",
					value: pm.exists ? (pm.summary !== "" ? pm.summary : "模板异常") : "模板缺失",
					sub: `never ${pm.never ?? 0} 条${pm.problems > 0 ? ` · ${pm.problems} 个问题（见 doctor）` : ""}`,
					tone: !pm.exists ? "bad" : pm.problems > 0 ? "warn" : "ok",
				});
			}
			// 更新提示段（Phase 3.6）：只回读 CLI 显式检查的落盘留档，端点零网络。
			{
				const upd = data.update;
				let value = "从未检查";
				let sub = "nomad update --check";
				let tone;
				if (upd !== undefined && upd !== null) {
					if (upd.comparison === "up-to-date") { value = "已是最新"; sub = String(upd.current ?? "—"); tone = "ok"; }
					else if (upd.comparison === "current-newer") { value = "盘内更新"; sub = `${upd.current ?? "—"} > ${upd.latest ?? "—"}，不动作`; }
					else if (upd.comparison === "update-available") { value = "可更新"; sub = `${upd.current ?? "—"} → ${upd.latest ?? "—"}（nomad update --yes）`; tone = "warn"; }
					else { value = "查询失败"; sub = "重试 nomad update --check"; tone = "bad"; }
				}
				cards.push({ label: "Update", value: value, sub: sub, tone: tone });
			}
			return cards;
		}

		// ── 面板本体（仪表盘版）────────────────────────────────────────────────────
		/**
		 * 尽力读取构建标识；拿不到就返回 undefined（骨架不因缺信息而崩）。
		 * 上游 SidebarRoot 用 `process.env.DSH_CLIENT_VERSION`（构建期替换）；
		 * 我们的手写产物里 `process` 未必存在，故先判存在性，再回退到启动图。
		 * @returns 构建标识，或 undefined。
		 */
		function readBuildId() {
			try {
				if (typeof process !== "undefined" && process !== null && process.env
					&& typeof process.env.DSH_CLIENT_VERSION === "string") {
					return process.env.DSH_CLIENT_VERSION;
				}
			} catch (_) { /* 取不到就走回退 */ }
			try {
				const boot = window.__DSH_BOOT__;
				if (boot && typeof boot.rev === "string" && boot.rev !== "") return boot.rev;
			} catch (_) { /* 同上 */ }
			return undefined;
		}

		/**
		 * 渲染 Nomad 面板（仪表盘版）。
		 * 分区顺序：品牌头 → Dashboard 卡片墙 → 构建元信息 → About 开关（折叠）→ About 正文 → 回程。
		 * About 默认收起（inline display:none）但**始终在元素树里** —— 合规文案不缺席，
		 * 由 tests/nomad-panel.test.js 的 About 系列断言守住。
		 * @param props - 注册时 `inject` 提供的回调。
		 * @param props.back - 返回对话（`selectPanel(null)`；上游 AppFrame 把 null 视为对话）。
		 * @returns 面板元素树。
		 */
		function NomadPanel(props) {
			const back = props && props.back;
			const buildId = readBuildId();
			const status = useStatus();
			const aboutState = React.useState(false);
			const showAbout = aboutState[0];
			const toggleAbout = aboutState[1];

			/** 一行「标签 — 值」的元信息显示（About 归属行与构建元信息行共用）。 */
			const row = (label, value) => jsx_runtime.jsxs("div", {
				style: { display: "contents" },
				children: [
					jsx_runtime.jsx("div", {
						style: {
							color: T.secondary,
							fontSize: "11px",
							letterSpacing: "0.06em",
							textTransform: "uppercase",
							paddingTop: "3px",
							whiteSpace: "nowrap",
						},
						children: label,
					}, "l"),
					jsx_runtime.jsx("div", {
						style: { color: T.primary, fontSize: "13px", fontFamily: T.mono, wordBreak: "break-all" },
						children: value,
					}, "v"),
				],
			}, label);

			const cards = buildCards(status);
			const staleNote = status && status.stale ? `（数据陈旧：${status.error}）` : "";

			return jsx_runtime.jsx("div", {
				style: { height: "100%", overflowY: "auto", display: "flex", justifyContent: "center" },
				children: jsx_runtime.jsxs("div", {
					style: {
						width: "100%",
						maxWidth: "720px",
						padding: "48px 32px 72px",
						boxSizing: "border-box",
						display: "flex",
						flexDirection: "column",
						gap: "26px",
						color: T.primary,
					},
					children: [
						// ① 品牌头
						jsx_runtime.jsxs("header", {
							style: {
								display: "flex",
								flexDirection: "column",
								alignItems: "center",
								gap: "10px",
								textAlign: "center",
							},
							children: [
								jsx_runtime.jsx("span", { style: { color: T.brand }, children: jsx_runtime.jsx(NomadMark, { size: 44 }) }, "mark"),
								jsx_runtime.jsx("div", {
									style: { fontSize: "22px", fontWeight: 600, letterSpacing: "0.01em", lineHeight: "28px" },
									children: "Nomad",
								}, "name"),
								jsx_runtime.jsx("div", {
									style: { color: T.secondary, fontSize: "13px", lineHeight: "20px" },
									children: "Portable Agent OS",
								}, "tagline"),
							],
						}),
						// ② Dashboard —— 状态数据卡片墙（与 About 分离；每 5s 低频刷新）
						jsx_runtime.jsxs("section", {
							style: { display: "flex", flexDirection: "column", gap: "10px" },
							children: [
								jsx_runtime.jsx("div", {
									style: {
										color: T.secondary,
										fontSize: "11px",
										letterSpacing: "0.06em",
										textTransform: "uppercase",
									},
									children: "Dashboard",
								}, "t"),
								jsx_runtime.jsx("div", {
									style: {
										display: "grid",
										gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
										gap: "10px",
									},
									children: cards.map((card) => jsx_runtime.jsxs("div", {
										style: {
											background: T.card,
											border: `1px solid ${T.borderSoft}`,
											borderRadius: T.radiusMd,
											padding: "14px 16px",
											display: "flex",
											flexDirection: "column",
											gap: "6px",
											minWidth: 0,
										},
										children: [
											// 标签行：语义状态点（仅 tone 存在时渲染）+ 标签。
											// 状态点颜色走上游语义 token（success/warn/error），明暗主题自动跟随。
											jsx_runtime.jsxs("div", {
												style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
												children: [
													card.tone !== undefined ? jsx_runtime.jsx("span", {
														"aria-hidden": "true",
														style: {
															width: "7px",
															height: "7px",
															borderRadius: "50%",
															background: card.tone === "ok" ? T.ok : card.tone === "warn" ? T.warn : T.bad,
															flexShrink: 0,
														},
													}, "dot") : null,
													jsx_runtime.jsx("div", {
														style: {
															color: T.secondary,
															fontSize: "10px",
															letterSpacing: "0.08em",
															textTransform: "uppercase",
														},
														children: card.label,
													}, "l"),
												],
											}, "lt"),
											jsx_runtime.jsx("div", {
												style: {
													color: T.primary,
													fontSize: "15px",
													fontFamily: T.mono,
													lineHeight: "20px",
													wordBreak: "break-word",
												},
												children: card.value,
											}, "v"),
											jsx_runtime.jsx("div", {
												style: { color: T.secondary, fontSize: "11px", lineHeight: "16px", wordBreak: "break-word" },
												children: card.sub,
											}, "s"),
										],
									}, card.label)),
								}, "cards"),
							],
						}, "dashboard"),
						// ③ 构建元信息（小行，仪表盘的脚注）
						jsx_runtime.jsxs("div", {
							style: {
								background: T.surface,
								border: `1px solid ${T.borderSoft}`,
								borderRadius: T.radiusMd,
								padding: "12px 16px",
								display: "grid",
								gridTemplateColumns: "auto 1fr",
								rowGap: "7px",
								columnGap: "22px",
							},
							children: [
								// 对外措辞：不再裸露内部标签（原 Build/Panel 是开发期产物）——
								// 「上游构建」保留排障价值；「面板标识」是本面板的寻址 id（排障锚点，
								// 由 tests/nomad-panel.test.js 的身份用例守着）；「端点」如实标注只读。
								row("上游构建", (buildId === undefined ? "—" : buildId) + staleNote),
								row("面板标识", PANEL_ID),
								row("状态端点", STATUS_ENDPOINT.replace("http://", "") + "（只读）"),
							],
						}, "meta"),
						// ④ About 开关 —— 折叠切换。刻意用 div 而非 button：
						//    回程按钮必须保持全树唯一 <button>（tests/nomad-panel.test.js 断言），
						//    且开关属导航性点击，不承担表单语义。
						jsx_runtime.jsx("div", {
							onClick: () => { toggleAbout(function (prev) { return !prev; }); },
							style: {
								color: T.secondary,
								fontSize: "11px",
								letterSpacing: "0.06em",
								textTransform: "uppercase",
								cursor: "pointer",
								userSelect: "none",
								alignSelf: "flex-start",
							},
							children: (showAbout ? "▾ " : "▸ ") + "About Nomad · 许可与归属",
						}, "about-toggle"),
						// ⑤ About 正文 —— 合规声明 + 产品介绍，默认收起（display:none）。
						//    收起只是视觉折叠：元素树里始终在，合规文案由测试守住不缺席。
						// 措辞红线（改文案前必读，均为测试锚点）：
						//   · 说「构建在 X 之上」= 官方许可的描述性用法 ✅
						//   · 说「官方合作 / 推荐 / 认证」= 违反 BRAND_GUIDELINES ❌（不得暗示背书）
						//   · 依赖许可不指向 `THIRD_PARTY_NOTICES.md`：该聚合清单**当前不在运行时分发包里**，
						//     指向它会让用户去翻一个不存在的文件。上游各依赖包**自带** LICENSE，
						//     故如实写"见各依赖包内 LICENSE"（实测：非 scoped 顶层 164 个包中 155 个自带）。
						jsx_runtime.jsxs("section", {
							style: {
								display: showAbout ? "flex" : "none",
								flexDirection: "column",
								gap: "12px",
							},
							children: [
								jsx_runtime.jsx("p", {
									style: { margin: 0, fontSize: "14px", lineHeight: "22px", color: T.primary },
									children: "把 Agent 的家装进 U 盘，把浏览器变成它的屏幕。",
								}, "lead"),
								jsx_runtime.jsx("p", {
									style: { margin: 0, fontSize: "13px", lineHeight: "20px", color: T.secondary },
									children: `Nomad 是构建在 ${UPSTREAM.name}（${UPSTREAM.abbr}）之上的 Portable Agent OS：不重写 Agent 引擎，只做产品层与可移植层。`,
								}, "desc"),
								jsx_runtime.jsxs("div", {
									style: {
										background: T.surface,
										border: `1px solid ${T.borderSoft}`,
										borderRadius: T.radiusLg,
										padding: "16px 20px",
										display: "grid",
										gridTemplateColumns: "auto 1fr",
										rowGap: "9px",
										columnGap: "22px",
									},
									children: [
										row("构建于", `${UPSTREAM.name}（${UPSTREAM.abbr}）${UPSTREAM.version}`),
										row("上游许可", `${UPSTREAM.license} · Copyright (c) ${UPSTREAM.holderYear} ${UPSTREAM.holder}`),
										row("本项许可", UPSTREAM.license),
										row("依赖许可", "许可见各依赖包内 LICENSE"),
									],
								}, "credits"),
								jsx_runtime.jsx("p", {
									style: { margin: 0, fontSize: "12px", lineHeight: "18px", color: T.secondary },
									children: `${UPSTREAM.abbr} / ${UPSTREAM.name} 是深度求索公司的注册商标。Nomad 为独立项目，与 DeepSeek 无隶属、无赞助，亦无背书关系。`,
								}, "mark"),
								jsx_runtime.jsx("p", {
									style: { margin: 0, fontSize: "12px", lineHeight: "18px", color: T.secondary },
									children: `${UPSTREAM.abbr} 处于 developer preview，上游明示将有破坏性变更。Nomad 不追踪 master、不自动升级，一律走版本化运行时与可回滚流程。`,
								}, "notice"),
							],
						}, "about"),
						// ⑥ 回程
						jsx_runtime.jsxs("footer", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: "12px",
								paddingTop: "4px",
								borderTop: `1px solid ${T.borderSoft}`,
								marginTop: "2px",
							},
							children: [
								jsx_runtime.jsx("button", {
									type: "button",
									onClick: () => { if (typeof back === "function") back(); },
									style: {
										background: "transparent",
										color: T.primary,
										border: `1px solid ${T.border}`,
										borderRadius: T.radiusSm,
										padding: "7px 14px",
										fontSize: "13px",
										cursor: "pointer",
									},
									children: "Back to conversation",
								}, "back"),
								jsx_runtime.jsx("span", {
									style: { color: T.secondary, fontSize: "12px" },
									children: "点击左侧任意会话也会回到对话",
								}, "hint"),
							],
						}),
					],
				}),
			});
		}

		// ── 注册 ───────────────────────────────────────────────────────────────────
		/**
		 * 需要的服务。`slots` 是槽位注册表；
		 * `ctx.layout` 不在此列 —— 它由 `dsh.client.inject` 声明的包依赖保证可用
		 * （上游 `ui-plugin-manager` 同样做法：inject 里有 ui-layout 包，但 `exports.inject` 无 layout）。
		 */
		const inject = ["slots"];

		/**
		 * 挂载：① 主区面板 ② 侧栏入口。两者共用同一个 id 才能互相寻址。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			// ① 主区面板 —— `main` 是 keyed，新 key 即新格子，与 conversation 并列。
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				inject: () => ({
					/** 回对话：AppFrame 把 `null` 解为 `conversation`。 */
					back: () => {
						try {
							ctx.layout.selectPanel(null);
						} catch (_) { /* 服务未就绪时静默：面板照常可看，不因回程失败而崩 */ }
					},
				}),
			}, NomadPanel));

			// ② 侧栏入口 —— `sidebar.panellist` 是 list，新 id 即新行，侧栏自动出现。
			//    `order: 20` 排在上游插件面板（0）与日程（10）之后：Nomad 是外壳自身的入口，
			//    不抢上游位置的视觉优先级；后续若要前置，改这个数字即可。
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				label: () => "Nomad",
			}, NomadPanelIcon));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
