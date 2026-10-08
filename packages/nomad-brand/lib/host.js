// nomad-brand — 宿主半（node 半）。
//
// 存在的唯一理由：loader 的行需要一个**宿主侧模块**去 import；而真正的界面在
// `exports["./client"]` 指向的浏览器半里。上游 `ui-brand-official` 的宿主半同样
// 是一个空 `apply`（`lib/index.js`，9 行）。
//
// 这里刻意**不做任何事**：不注册服务、不读配置、不碰文件系统。
// 「宿主半空、浏览器半有实质」是本包的既定形态 —— 品牌纯属浏览器展示。

/** 宿主侧插件体 —— 本包只贡献浏览器端的展示。 */
export function apply() {}
