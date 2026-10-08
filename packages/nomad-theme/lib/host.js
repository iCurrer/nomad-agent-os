// nomad-theme — 宿主半（node 半）。
//
// 与 nomad-brand / nomad-panel 同一形态：loader 的行需要一个**宿主侧模块**去 import，
// 而真正的换肤逻辑在 `exports["./client"]` 指向的浏览器半里（`ctx.theme` 是客户端
// Cordis service，宿主侧拿不到）。
//
// 这里刻意**不做任何事**：不注册服务、不读配置、不碰文件系统。
// 换肤是纯浏览器展示物，宿主侧无话可说。

/** 宿主侧插件体 —— 本包只贡献浏览器端的换肤。 */
export function apply() {}
