# service/src/music/  （占位）

音乐模块的服务端代码归属目录。当前为**空占位**：

- 音乐逻辑**全部在 Rust 侧** —— `app/src-tauri/src/music/`（四平台 `netease` / `kugou` / `qqmusic` / `migu`
  + 音频代理 + 加密 + 歌词 + 缓存；汽水平台延后）。
- box-service（`service/`）**暂无**音乐相关服务代码。

保留此目录，是为了让「漫画翻译 / 设置 / 音乐」三块服务代码各有一处明确归属
（见 `AGENTS.md` §1「服务端模块目录」· `docs/spec-notes.md` D-101）。
将来若有音乐服务端逻辑，落在这里，**不再平铺回 `service/src/` 根**。
