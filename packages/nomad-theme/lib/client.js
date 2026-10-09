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
		// ── 选中/激活面家族（2026-10-09 发布打磨：修「选中后纯白」与米白主题打架）──
		// 上游浅色默认：layer-3 / code-segment-selected = 纯白 #fff，multi-select /
		// selector / tip = #f5f6f7 近白，ghost-active-fill = #ebeef2 —— 在米白底上
		// 全部呈「死白块」。统一换成暖色梯度（与 layer-2 / nav-item-active 同族）。
		"--dsw-alias-bg-layer-3": "#F0E7DF",
		"--dsw-alias-bg-multi-select": "#EAE0D6",
		"--dsw-alias-markdown-code-segment-selected": "#F0E7DF",
		"--dsw-specific-selector": "#EAE0D6",
		"--dsw-specific-tip": "#EAE0D6",
		"--dsw-alias-button-ghost-active-fill": "#E0CFC0",
		// 文档多选高亮：上游是蓝 40% 混透明（DeepSeek 蓝），换成品牌裸肤棕同强度。
		"--dsw-alias-bg-document-selection": "color-mix(in srgb, #C99F8A 40%, transparent)",
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
		// 选中/激活面家族暗色：同样刻意保持 DSH 默认（来源 = 上游暗色段的解析引用）。
		"--dsw-alias-bg-layer-3": "var(--dsw-static-neutral-bluish-800)",
		"--dsw-alias-bg-multi-select": "var(--dsw-static-neutral-850)",
		"--dsw-alias-markdown-code-segment-selected": "var(--dsw-static-neutral-bluish-800)",
		"--dsw-specific-selector": "var(--dsw-static-neutral-bluish-800)",
		"--dsw-specific-tip": "var(--dsw-static-neutral-bluish-800)",
		"--dsw-alias-button-ghost-active-fill": "var(--dsw-static-neutral-bluish-750)",
		"--dsw-alias-bg-document-selection": "color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent)",
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
		 * 隐藏 conversation hero 的上游鲸鱼（DeepSeek 吉祥物）。
		 *
		 * 为什么走 CSS 而不是 token：这是「隐藏一个具体元素」，不是颜色 token，
		 * overrideTokens 通道管不到 display。这是 ADR-0031「禁注 <style>」的**已登记例外**：
		 * 该结论针对 token 变量（会被 ThemePresenter 内联样式打回），对普通选择器规则无效。
		 *
		 * class 来源：`dsh-client-ui-conversation` dist 内 CSS Modules 编译产物
		 * （HeroShell_module_css_default.fish / .fishHitbox = "pXSMma_*"，2026-10-09 实证）。
		 * ⚠️ DSH 升级若重编译，hash 可能变化 → 本规则静默失效（退化为"鲸鱼重新出现"，
		 * 不影响功能）。用 `[class*="_fish"]` 子串匹配做 resilience：同时命中 fish 与
		 * fishHitbox，且 hash 变了也能跟上（`_fish` 后缀来自源码属性名，比 hash 稳定）。
		 */
		const HIDE_UPSTREAM_FISH_CSS = '[class*="_fish"],[class*="_fishHitbox"]{display:none!important}';

		// ── 浏览器标签标题守卫（2026-10-09 发布打磨）────────────────────────────────
		// 上游 `dsh-client-ui-layout` 的 AppFrame 里 `const productTitle = "DeepSeek Harness"`
		// 是**硬编码常量**（不走 i18n，locale 通道够不着），其 DocumentTitle 组件在每次
		// 会话切换/卸载时都会主动重写 document.title（`title — DeepSeek Harness` / 清理函数
		// 直接写回 productTitle）⇒ 一次性改写必被打回。唯一不碰 Core 的正规做法：装一个
		// **持续守卫** —— MutationObserver 监听标题变化，凡含上游产品名就地替换为 Nomad，
		// 保留会话名前缀（`会话X — DeepSeek Harness` → `会话X — Nomad`）。
		// 防死循环：守卫自己的改写结果不再含目标串，观察者回调二次触发即空转。
		const UPSTREAM_PRODUCT_TITLE = "DeepSeek Harness";
		const NOMAD_PRODUCT_TITLE = "Nomad";

		/** 就地改写：把上游产品名整体替换为 Nomad（其余内容原样保留）。 */
		function rewriteDocumentTitle(raw) {
			return raw.split(UPSTREAM_PRODUCT_TITLE).join(NOMAD_PRODUCT_TITLE);
		}

		/**
		 * 安装标题守卫（幂等：window 旗标，重复 apply 不叠加观察者）。
		 * 监听 document.head 的子树/文本变化 —— React 对 document.title 的写入
		 * 最终都落在 <title> 元素的文本上，head 级监听对「title 元素被整体替换」也免疫。
		 */
		function installTitleGuard() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
			if (typeof window !== "undefined") {
				if (window.__nomadTitleGuardInstalled === true) return;
				window.__nomadTitleGuardInstalled = true;
			}
			const fix = () => {
				if (typeof document.title === "string" && document.title.indexOf(UPSTREAM_PRODUCT_TITLE) !== -1) {
					document.title = rewriteDocumentTitle(document.title);
				}
			};
			// 应用即修一次：React 挂载前的初始标题（若上游将来加了静态 <title>）也覆盖。
			fix();
			const observer = new MutationObserver(fix);
			if (document.head) {
				observer.observe(document.head, { childList: true, subtree: true, characterData: true });
			}
		}

		/**
		 * 挂载：堆叠一层 Nomad 换肤覆盖 + 注入上游吉祥物隐藏规则 + 标题守卫。
		 * @param ctx - 客户端根上下文（`ctx.theme` 由 `inject` 声明保证可用）。
		 */
		function apply(ctx) {
			// 覆盖源 = 本包 id（README：动态包传自己的包 id，兼作 inspection 的 origin）。
			ctx.theme.overrideTokens("@nomad/dsh-client-theme", TOKENS);
			// 鲸鱼隐藏（幂等：以 style id 为锚，重复 apply 不会叠多条）。
			if (typeof document !== "undefined" && document.getElementById("nomad-theme-hide-fish") === null) {
				const style = document.createElement("style");
				style.id = "nomad-theme-hide-fish";
				style.textContent = HIDE_UPSTREAM_FISH_CSS;
				document.head.appendChild(style);
			}
			// 标签标题守卫（幂等：window 旗标）。
			installTitleGuard();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
