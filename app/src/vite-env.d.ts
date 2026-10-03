/// <reference types="vite/client" />

// Vite 的 client 类型给出 `*.svg` / `*.css` 等资源导入的模块声明，
// 少了这个文件，`import logo from '../assets/brand/miao-logo.svg'` 会在 tsc 下报找不到模块。
