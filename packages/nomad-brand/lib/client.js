// nomad-brand — 浏览器半（**手写，零构建**）
//
// 为什么这个文件长这样（依据：盘内已构建产物 + 上游源码实测，非猜测）：
//   · 客户端插件的产物形态是 `window.__ModuleLoader__.load({ id, factory })` 的
//     **UMD 式信封 + CJS 式 require**，不是 ESM。参照物：
//     `@deepseek-ai/dsh-client-ui-brand-official/lib/client.js`（仅 1863 字节）。
//   · 加载器 `@deepseek-ai/dsh-client-modules` 用 `readFileSync(exports["./client"])`
//     **原样吐出、运行时不编译**，所以纯 JS 手写即可 —— 不需要 tsdown / TS / JSX。
//   · 因此这里不写 JSX，改用 `require("react/jsx-runtime")` 的 `jsx` / `jsxs`。
//
// 槽位契约（`ui-sidebar/src/client/contract/slots.ts`）：
//   · `sidebar.brand.mark` — kind: single / scope: root / props `{ size: number }`
//     兜底是 `<FishLogo size={24} />`（`SidebarRoot.tsx:189,225`）
//   · `sidebar.brand.name` — kind: single / scope: root / props `{}`（占位者自持宽度）
//     兜底是 `t('brand.localBuild')`（+ 版本号），`SidebarRoot.tsx:228`
// 两个槽都是 `single`：**先到者占住，后到者抛 `duplicate declaration` 被拒**
//   （依据 `ui-renderer/src/client/registry.ts:487`：undeclared target / duplicate / kind conflict
//    都在 core 层先抛）。
//   ⚠️ 2026-10-08 实测更正：上游 `ui-brand-official` 里的
//     `if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return` 是**真的**，
//     但**本构建的 profile 就是 `official`** —— 那句 if 被构建期死代码消除（全套产物里
//     该标识符只出现在 README）。⇒ 官方占用者**一直在注册**，本包会因后到被拒。
//     ⇒ 光挂本包**没用**（服务端一切正常、界面零变化）；必须在
//       `packages/nomad-web-app/cordis.patch.yml` 里用
//       `- id: ui-brand-official` + `disabled: true` 让它**先让出**，本包才接管。

window.__ModuleLoader__.load({
	id: "@nomad/dsh-client-brand",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let jsx_runtime = require("react/jsx-runtime");

		// ── 品牌标识：北斗七星 ────────────────────────────────────────────────────
		// 取意「以星导航的游牧者」，与产品名 Nomad 及本机助手「天枢」（北斗一）同源。
		// 七颗星 = 4 颗斗柄（天枢/天璇/天玑/天权）+ 3 颗斗魁，斗魁为四边形。
		// 24×24 viewBox，实心圆点 + 细连线，缩到 24px 仍清晰；`currentColor` 保证跟随主题。
		const MARK_VIEW_BOX = "0 0 24 24";
		/** 斗柄自左下向右上汇入斗魁，再沿斗魁四边闭合 —— 一笔连出七星的走向。 */
		const MARK_PATH = "M3.2 17.2L6 16 8.6 14.2 10.6 12.2 10.2 7 15 5.6 16.8 10.2 10.6 12.2";
		/** 七颗星的位置；索引 3 为「天权」（斗柄与斗魁的连接点），画得略大以示枢纽。 */
		const MARK_STARS = [
			[3.2, 17.2], [6, 16], [8.6, 14.2], [10.6, 12.2],
			[10.2, 7], [15, 5.6], [16.8, 10.2],
		];

		/**
		 * 渲染 Nomad 品牌标识。
		 * @param props - 宿主槽位提供的几何参数。
		 * @param props.size - 请求的方形边长（像素）；上游传 24。
		 * @returns 北斗七星标识。
		 */
		function NomadBrandMark(props) {
			const size = typeof props.size === "number" ? props.size : 24;
			return jsx_runtime.jsxs("svg", {
				width: size,
				height: size,
				viewBox: MARK_VIEW_BOX,
				fill: "none",
				"aria-hidden": "true",
				focusable: "false",
				children: [
					jsx_runtime.jsx("path", {
						d: MARK_PATH,
						stroke: "currentColor",
						strokeWidth: 1.3,
						strokeLinecap: "round",
						strokeLinejoin: "round",
						opacity: 0.7,
					}, "dipper"),
					jsx_runtime.jsx("g", {
						fill: "currentColor",
						children: MARK_STARS.map((star, index) =>
							jsx_runtime.jsx("circle", {
								cx: star[0],
								cy: star[1],
								r: index === 3 ? 1.7 : 1.3,
							}, index)),
					}, "stars"),
				],
			});
		}

		/**
		 * 渲染 Nomad 字标（不含标识本身 —— 标识由独立的 mark 槽承担）。
		 * 字号/行高对齐 Web UI 的 14px 基准；颜色 `inherit` 以跟随主题（不硬编码色值）。
		 * @returns 字标。
		 */
		function NomadBrandName() {
			return jsx_runtime.jsx("span", {
				style: {
					color: "inherit",
					fontSize: "14px",
					fontWeight: 600,
					lineHeight: "22px",
					letterSpacing: "0.01em",
					whiteSpace: "nowrap",
				},
				children: "Nomad",
			});
		}

		/** 需要的服务：UI 槽位注册表。 */
		const inject = ["slots"];

		/**
		 * 一次性占住侧栏两个品牌槽。
		 * 之所以嵌套 `inject`：`sidebar.brand.name` 由 `ui-sidebar` 声明，先等 mark 槽就绪
		 * 再等 name 槽，保证两处要么都属于 Nomad、要么都不属于（不留「半个品牌」）。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.brand.mark", () =>
				ctx.slots.inject("sidebar.brand.name", function* () {
					yield ctx.slots.register({ name: "sidebar.brand.mark" }, NomadBrandMark);
					yield ctx.slots.register({ name: "sidebar.brand.name" }, NomadBrandName);
				}));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
