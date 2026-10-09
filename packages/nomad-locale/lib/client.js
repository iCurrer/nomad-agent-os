// nomad-locale — 浏览器半（**手写，零构建**）
//
// 发布打磨：把 conversation hero（新建会话欢迎页）的上游品牌文案换成 Nomad 口径。
//
// ── 通道：上游 locale 服务的正规扩展点（零 Core 修改）──────────────────────────
// 侦察结论（2026-10-09，dsh-client-locale/lib/client.js 的 LocaleRuntime 实现逐行核过）：
//   · hero 文案不是硬编码，是 i18n 键：conversation 插件以
//     `ctx.locale.register("conversation", { zh, en })` 注册词典（NS = "conversation"）。
//   · `register(ns, dicts)` 类型化形态：同 (ns, locale) **重复注册抛错**（单一占用者）——
//     所以不能直接覆盖上游的 zh 词典。
//   · 但存在**非类型化单语言形态** `register(ns, locale, dict)`，文档原文：
//     "Single-locale untyped form **for language-pack contributions**" —— 语言包贡献专用。
//   · `addLanguage({ id, label, fallback })`：把一个新语言加进可选目录；
//     fallback 必须已注册、链必须终止于 en；未知 id 抛错、id 占用抛错。
//   · 查找顺序：活跃语言的 fallback 链（入口 ns）→ 共享 common ns → 键本身。
// ⇒ 方案：注册 `zh-nomad`（fallback = zh）+ 只覆盖要换的键，其余词条自然回落官方 zh。
//    这就是上游留的正门，零 hack。
//
// ── 为什么 active === "zh" 才 setLocale ───────────────────────────────────────
// `setLocale` 是唯一用户偏好写入口（持久化）。语言包注册**不会**自动切换已解析的
// 宿主偏好 ⇒ 必须显式切一次。但绝不能无条件切：用户若明确选了 en，切走等于劫持。
// 取「当前活跃是官方 zh」作为迁移条件——一次性迁移，之后用户在设置里可自由切换
// （「中文（Nomad）」会出现在语言列表里，与官方 zh 并存）。

window.__ModuleLoader__.load({
	id: "@nomad/dsh-client-locale",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** conversation 插件的词典命名空间（源码实证：`const NS = "conversation"`）。 */
		const NS = "conversation";

		/**
		 * Nomad 语言 id。BCP 47-style（上游校验正则：
		 * /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/，"zh-nomad" 实测通过）。
		 */
		const LOCALE_ID = "zh-nomad";

		/**
		 * 对外文案（发布面）。只列要换的键，其余词条走 fallback 链回落官方 zh。
		 * 改口径就改这里——单点、可测、随盘发布。
		 */
		const OVERRIDE = {
			"hero.headline": "便携智能体操作系统",
			"hero.preview": "开发预览",
		};

		/** 语言目录里的展示名（设置页语言选择器可见）。 */
		const LOCALE_LABEL = "中文（Nomad）";

		/** 需要的服务：`locale`（由 dsh-client-locale 包 provide 的 Cordis service）。 */
		const inject = ["locale"];

		/**
		 * 挂载：注册语言词典 + 语言目录 + 一次性迁移切换。
		 * 每一步都容错：语言包失败降级为「沿用上游官方文案」，绝不影响启动。
		 * @param ctx - 客户端根上下文（`ctx.locale` 由 `inject` 声明保证可用）。
		 */
		function apply(ctx) {
			const locale = ctx.locale;
			// ① 词典：非类型化单语言形态（语言包贡献专用）。("conversation", "zh-nomad")
			//    是全新键位，不与上游的 zh/en 占用冲突（重复注册会抛错，这里天然避开）。
			locale.register(NS, LOCALE_ID, { ...OVERRIDE });
			// ② 语言目录：注册可选语言，fallback 到官方 zh（链：zh-nomad → zh → en ✓）。
			//    disposer 挂到 ctx.effect，插件卸载时同步撤出语言目录。
			ctx.effect(
				() => locale.addLanguage({ id: LOCALE_ID, label: LOCALE_LABEL, fallback: "zh" }),
				"nomad-locale: language pack",
			);
			// ③ 一次性迁移：仅当活跃语言是官方 zh 时切换（绝不劫持 en 用户）。
			//    失败（如快照形状变化）只告警——词典与目录已就位，用户可手动切换。
			try {
				const snapshot = locale.getLocale();
				if (snapshot.active === "zh") locale.setLocale(LOCALE_ID);
			} catch (error) {
				console.warn("[nomad-locale] 迁移切换未完成（可在设置里手动选「中文（Nomad）」）：", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
