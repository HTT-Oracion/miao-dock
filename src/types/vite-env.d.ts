/// <reference types="vite/client" />

// Vite 的 client 类型给出 `*.png` / `*.svg` / `*.css` 等资源导入的模块声明。
// 随仓图片已整体搬到 `public/assets/icons/`（公共资源，用绝对 URL 引，不经构建），
// 本仓库目前**没有任何图片 import**；这份引用留着是因为 `*.css` 等其它资源导入仍可能需要它，
// 且它是 Vite 项目的惯例入口（删掉不会立刻报错，只会让下一个 import 资源的人踩空）。
