# 番剧模块验收报告（R0–R7 汇总）

> 对应 `plan-anime-remaining.md`。**本报告只写"跑过什么、哪条命令能复现"**，不写主观结论。
> 真机部分（GUI 点击 / 真实播放器）单独列在 §5，未跑就是未跑。

---

## 1. 门禁总表（本机可复现）

| 门 | 命令 | 最近结果 |
|---|---|---|
| 静态快闸门 | `npm run check` | **19 / 19** |
| 番剧模块接线 | `npm run task -- check:anime-module` | **52 / 52** |
| 同上反证轮 | `npm run task -- check:anime-module:refute` | **47 / 47** 按预期变红 |
| 番剧服务 e2e | `npm run task -- check:anime` | **98 / 98**（A1–A22） |
| 番剧单元测试 | `cargo test --lib animesvc` | **99 / 99**（连跑 5 次稳定） |
| 应用侧桥接单测 | `cargo test --bin miao-dock anime` | **11 / 11** |
| 子窗口几何单测 | `cargo test --bin miao-dock embed` | **4 / 4** |
| 应用侧编译 | `cargo check --bin miao-dock` | **0 错 0 warning** |
| 条数对账 | `npm run task -- check:counts` | **2 / 2** |
| 文档一致性 | `npm run task -- check:docs` | **21 / 21** |
| 文档路径 | `npm run task -- check:docpaths` | **5 / 5** |
| 设置页 | `npm run task -- check:settings` | **186 / 186** |
| 前端类型 | `npx tsc --noEmit` | **0 错** |
| 前端风格 | `npx eslint src/modules/anime src/screens/anime src/hooks` | **0 error** |
| 格式化 | `npx prettier --check …` | 全绿 |
| 构建 | `npx vite build --no-emptyOutDir` | 通过 |

> 🔴 改 `src-tauri/src/anime/**` 或 `commands/**` 后**必须**额外跑 `cargo check --bin miao-dock`：
> 这些文件只在 bin 里编，`cargo check --lib` 看不见（D-268 的教训）。

---

## 2. 里程碑与落点

| 里程碑 | 状态 | 关键落点 | 台账 |
|---|---|---|---|
| R0 基础 | ✅ | 番剧域模块 / 路由 / IA / 十屏分派 | D-239 … D-249 |
| R1 内核轨 | 🟡 B 方案已实现，A 方案未做 | `animesvc/kernel/`（mpv + JSON IPC）、`anime/embed.rs`（视频子窗口 + `--wid`） | D-251 · D-269 · D-270 |
| R2 在线源 / 自定义源 / 元数据 | ✅ | `datasource/web.rs`、`metadata.rs`、订阅导入、记忆回放、点选元素 | D-250 · D-252–D-260 · D-268 |
| R3 缓存与下载 | ✅ | `animesvc/cache.rs`（状态机 / Range 续传 / LRU） | D-261 |
| R4 账号与同步 | ✅ | `animesvc/account.rs`（中继契约 + 本地桩 / 队列 / 逐条挑边） | D-262 · D-266 |
| R5 BT | ✅（PikPak 只留接口） | `animesvc/bt/`（librqbit 会话 / 边下边播 / 限速与做种 / peer 过滤） | D-263 · D-264 · D-265 |
| R6 真机验收 | ⏳ 待执行 | 清单：`docs/internal/anime-r6-checklist.md` | — |
| R7 门禁与文档 | ✅ | 每轮 `npm run check` + 相关 e2e + 台账 | D-250–D-270 |

---

## 3. e2e 覆盖到的行为（`check:anime` 的 A 组）

| 组 | 覆盖 |
|---|---|
| A1–A4 | 服务起停 / 令牌 / 库扫描 / 收藏与进度落盘 |
| A5–A8 | 进程互不干扰 / manifest 端点 / 播放契约 / 源列表 |
| A9–A14 | 探索页在线数据 / 通用网页源 / 详情补充 / 验证码门 / 订阅导入 / 筛选 |
| A15 | 优先分辨率（精确命中 + 缺档降级） |
| A16 | 订阅导入（草稿 / 坏 JSON 的措辞） |
| A17 | 缓存任务（真下载 → done → 删除） |
| A18 | 账号（登录 / 401 / 状态 / 同步 / 冲突 / 退出） |
| A19 | BT（空表 / `running:false` / 非法地址 400） |
| A20 | BT 边下边播签名 / 伪造 403 / PikPak 接口如实 |
| A21 | BT 限速（读 / 改 / 再读 / 负数 422） |
| A22 | 冲突逐条挑边（保留本地 / 采纳云端 / 非法 side） |

## 4. 单元测试覆盖到的判定层

- 播放契约 `PlaybackCore`（`--playback-selftest`）
- 缓存：`.part` 路径 / 状态 camelCase / 盘上字节优先 / **真 Range 续传** / LRU
- 账号：冲突策略表 / 中继契约（登录 + 刷新 + 推送幂等 + 冲突 + 拉取）/ 设备码 pending→ok
- BT：任务映射 / `--wid` 参数构造 / 限速 NaN 拒绝 / 视频文件选择 / 视频子窗口 DPI 换算
- 元数据：搜索 / 详情 / 日历 / 热度 / 角色 / 关联 / 图片 / 导入
- 网页源：列表解析 / 相对地址 / GBK 编码 / 直链多清晰度 / 订阅校验

---

## 5. 未验证（真机）与未做（如实）

| 项 | 状态 | 说明 |
|---|---|---|
| R6 十屏点一遍 | ⏳ | 清单 `anime-r6-checklist.md`；需 GUI，本环境只有无头门禁 |
| 真播矩阵（mp4 / mkv+ass / 多轨 / HLS / 截图 / 续看） | ⏳ | 需真 mpv 二进制 + 真实媒体；`check:anime-kernel:real` 覆盖内核自检 17 例，但"画面"要人看 |
| 嵌入子窗口的画面（DPI / 圆角 / 全屏 / z-order） | ⏳ | 代码链路已通（D-270），画面必须真机确认 |
| A 方案（libmpv FFI + render callback） | ❌ 未做 | WebView 不暴露 surface；用户口径：标未做（D-267） |
| macOS 嵌入（`NSView` 层级） | ❌ 未做 | 非 Windows 的 `main_hwnd()` 恒 `None`；平台分叉另做 |
| PikPak 真客户端 | ❌ 按口径不做 | 只留接口，`implemented` 恒 false（D-264） |
| BT 边下边播的"分片优先级调度" | ❌ 未做 | 现为**文件级**：按 Range 等字节就位再发（D-264） |
| peer 过滤"清空可回滚" | ❌ 未做 | 订阅地址交给会话后只能重启换掉（D-265） |

---

## 6. 复现全部门禁

```bash
npm run check
npm run task -- check:anime
npm run task -- check:anime-module
npm run task -- check:anime-module:refute
npm run task -- check:counts
npm run task -- check:docs
npm run task -- check:settings
npx tsc --noEmit
npx eslint src/modules/anime src/screens/anime src/hooks
npx vite build --no-emptyOutDir
cd src-tauri
cargo test --lib animesvc
cargo test --bin miao-dock anime
cargo check --bin miao-dock
```
