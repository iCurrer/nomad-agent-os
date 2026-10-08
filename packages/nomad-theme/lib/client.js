// nomad-theme — 浏览器半（**手写，零构建**）
//
// 阶段 5-C：Nomad 自有外观（换肤）。
//
// ── 换肤通道：ctx.theme.overrideTokens() ───────────────────────────────────────
// DSH 的 `ui-theme` 包提供一个**官方明确的换肤扩展点**（`ThemeRuntime`，通过
// `ctx.provide('theme')` 暴露为 Cordis service）。README 原文：
//   "Third-party themes can register alias-token overrides through `ctx.theme`."
// 两条通道：
//   · `register(definition)`    注册一个完整主题 id（出现在「外观」设置里供切换，重）
//   · `overrideTokens(src, map)` 堆叠一层 token 覆盖（不注册主题，全局立即生效，轻）← 本包用它
//
// ── 为什么用 overrideTokens 而不是「注入 <style> 覆盖变量」─────────────────────
// 早期结论（ADR-0025 附带发现）曾说「注入后置 <style> 覆盖 --dsw-* 即可」，但那条
// 有一个隐患：`ThemePresenter.apply()` 会把 resolved 后的 `active.tokens` 用
// `body.style.setProperty()` 写成**内联样式**（`theme-presenter.ts:61-67`），而内联
// 样式优先级**高于** `<style>` 里的 `:root`/`body` 规则 ⇒ 主题切换时会被 presenter
// 覆盖掉。`overrideTokens` 则走官方 API，token 层被正确折进 `active.tokens`、由
// presenter 统一应用，和 DSH 的主题生命周期正确协同 —— 是唯一不会被打回原形的路。
//
// ── 覆盖范围（浅色换、暗色保持）──────────────────────────────────────────────
// 维护者拍板：**只把「浅色模式」换成暖米白大地色系，暗色保持 DSH 默认**。
// `overrideTokens` 强制每个 token 给 `{ light, dark }` 双值（README："both palette
// modes are mandatory"）⇒ dark 侧填 DSH 默认暗色的**解析后色值**（见下方注释），
// 用「刻意保持原值」的姿态满足强制双值约束，同时不改变暗色观感。
//
// ── 为什么除了 alias 还要覆盖 specific ─────────────────────────────────────────
// 直觉是「只盖 alias 层就能换肤」，但实测 DSH 0.2.1-alpha.1 的 surface 大量直接
// 绑定 **specific** token、不经过 alias 引用链。最典型：侧边栏背景
// `--dsw-specific-sidebar-fill`（浅色 = var(--dsw-static-neutral-bluish-50)，即白色），
// 它**直接**指向底层 static，而不是 --dsw-alias-bg-base。于是单列覆盖 alias 时，
// 主区等走 alias 的区域会变暖米白，**侧边栏纹丝不动**（这正是 2026-10-08 实测现象）。
// 因此本包在 alias 9 项之外，再叠加侧边栏 4 个 specific token
// （fill / nav-item-hover / nav-item-active / nav-item-active-accent）。
// 浅色给大地色系梯度，暗色**保持 DSH 默认**——这里刻意用 `var(--dsw-static-*)`
// 引用官方变量（而非写死解析值），以便将来 DSH 升级时暗色观感自动跟随。
//
// ── 样式铁律 ──────────────────────────────────────────────────────────────────
// 本包**唯一例外**地写死了色值 —— 因为换肤的本质就是「注入具体色值」。但为守住
// 「不写死会漂移的色」这条纪律，dark 侧的值全部标注了 `--dsw-static-*` 来源，且
// 由 `tests/nomad-theme.test.js` 的「token 键名 = 官方 alias 清单」用例守锚定。

window.__ModuleLoader__.load({
	id: "@nomad/dsh-client-theme",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * Nomad 浅色（暖米白大地色系）—— 维护者 2026-10-08 定的配色。
		 * 角色映射（维护者原话 → alias token）：
		 *   主背景 #F5EEE8 → --dsw-alias-bg-base
		 *   次背景 #EDE2D9 → --dsw-alias-bg-layer-1（-layer-2 用主背景同值更协调）
		 *   主色   #C99F8A → --dsw-alias-brand-primary（裸肤棕）
		 *   强调色 #A87560 → --dsw-alias-brand-primary 的 hover/active（陶土棕，暂以
		 *                     button-primary-hover 承载，见下）
		 *   文字   #332B27 → --dsw-alias-label-primary（深咖）
		 *   次文字 #81746D → --dsw-alias-label-secondary（灰棕）
		 *   边框   #DED1C7 → --dsw-alias-border-l1（-l2 用深一档的 #D0BFAF）
		 */
		const NOMAD_LIGHT = {
			// 主背景 · 暖米白
			"--dsw-alias-bg-base": "#F5EEE8",
			// 次背景 · 浅裸色（layer-1 与 layer-2 拉开一档层次）
			"--dsw-alias-bg-layer-1": "#EDE2D9",
			"--dsw-alias-bg-layer-2": "#F0E7DF",
			// 主色 · 裸肤棕（品牌主色，按钮/链接/选中态的主视觉）
			"--dsw-alias-brand-primary": "#C99F8A",
			// 强调色 · 陶土棕（按钮 hover/active 与主色的按压态）
			"--dsw-alias-button-primary-hover": "#A87560",
			// 文字 · 深咖
			"--dsw-alias-label-primary": "#332B27",
			// 次文字 · 灰棕
			"--dsw-alias-label-secondary": "#81746D",
			// 边框 · 浅裸（l2 深一档，用于卡片描边与分割线）
		"--dsw-alias-border-l1": "#DED1C7",
		"--dsw-alias-border-l2": "#D0BFAF",
		// 侧边栏（走 specific token，不走 alias —— 见文件头注释「为什么还要覆盖 specific」）
		"--dsw-specific-sidebar-fill": "#EDE2D9",
		"--dsw-specific-sidebar-nav-item-hover": "#E5D8CD",
		"--dsw-specific-sidebar-nav-item-active": "#E0CFC0",
		"--dsw-specific-sidebar-nav-item-active-accent": "#C99F8A",
	};

		/**
		 * DSH 默认暗色 —— 刻意保持原值（不换肤）。
		 * 值 = `design-platform.css` 里 `body[data-ds-dark-theme]` 段的解析结果，
		 * 来源逐条标注，供将来 DSH 升级时对照。
		 */
		const DSH_DARK = {
			// = var(--dsw-static-neutral-bluish-950)
			"--dsw-alias-bg-base": "rgb(21, 21, 23)",
			// = var(--dsw-static-neutral-bluish-875)
			"--dsw-alias-bg-layer-1": "rgb(35, 35, 36)",
			// = var(--dsw-static-neutral-bluish-850)
			"--dsw-alias-bg-layer-2": "rgb(44, 44, 46)",
			// = var(--dsw-static-neutral-bluish-50)
			"--dsw-alias-brand-primary": "rgb(249, 250, 251)",
			// = var(--dsw-static-neutral-bluish-100)（button-primary-hover 暗色默认）
			"--dsw-alias-button-primary-hover": "rgb(226, 229, 232)",
			// = var(--dsw-static-neutral-bluish-50)
			"--dsw-alias-label-primary": "rgb(249, 250, 251)",
			// = var(--dsw-static-neutral-bluish-300)
			"--dsw-alias-label-secondary": "rgb(207, 211, 214)",
			// = rgba(255,255,255,0.06)
			"--dsw-alias-border-l1": "rgba(255, 255, 255, 0.06)",
			// = rgba(255,255,255,0.12)
		"--dsw-alias-border-l2": "rgba(255, 255, 255, 0.12)",
		// 侧边栏 specific 暗色：保持 DSH 默认，引用官方 static 变量（不写死解析值）
		"--dsw-specific-sidebar-fill": "var(--dsw-static-neutral-bluish-900)",
		"--dsw-specific-sidebar-nav-item-hover": "var(--dsw-static-neutral-bluish-75)",
		"--dsw-specific-sidebar-nav-item-active": "var(--dsw-static-neutral-bluish-100)",
		"--dsw-specific-sidebar-nav-item-active-accent": "var(--dsw-static-deepseek-100)",
	};

		/**
		 * 折叠成 overrideTokens 要求的 `{ token: { light, dark } }` 形态。
		 * 键集 = NOMAD_LIGHT 的键集（两者必须一一对应，由测试守住）。
		 */
		const TOKENS = {};
		for (const name of Object.keys(NOMAD_LIGHT)) {
			TOKENS[name] = { light: NOMAD_LIGHT[name], dark: DSH_DARK[name] };
		}

		/** 需要的服务：`theme`（由 ui-theme 包 provide 的 Cordis service）。 */
		const inject = ["theme"];

		/**
		 * 挂载：堆叠一层 Nomad 换肤覆盖。
		 * @param ctx - 客户端根上下文（`ctx.theme` 由 `inject` 声明保证可用）。
		 */
		function apply(ctx) {
			// 覆盖源 = 本包 id（README：动态包传自己的包 id，兼作 inspection 的 origin）。
			ctx.theme.overrideTokens("@nomad/dsh-client-theme", TOKENS);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
