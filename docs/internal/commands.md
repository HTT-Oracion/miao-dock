# 命令全表（唯一事实源）

> 本文件是**所有 `npm run` 命令**的唯一清单。`AGENTS.md` / `README.md` 只写"跑哪四条"，
> 不再各自维护一张表 —— 两张表必然漂移（2026-10 首次核对就抓到五处条数漂移）。
>
> ## 条数口径
>
> 表里每个 `check:*` 的「**N 条**」是**正向断言数**，由 `npm run task -- check:counts`
> **每次提交机器对账**：跑脚本取自报数，与本文件不一致就红。
>
> - **service / nightly 层**的数字是人工快照（它们起真进程、分钟级，塞进 static 门会把
>   闸门从 10s 变成 4 分钟 —— 那等于没有门）。改了那批断言请自己跑一遍更新数字。
> - **反证条数**同理未进门（各脚本汇总行格式不统一，且反证轮要把每个脚本再跑一遍）。
>
> ## 怎么读
>
> - 「条数」为空 = 该命令没有断言计数（构建 / 装配 / 派发类）。
> - 细节（为什么这么设计、踩过什么坑）**不在本文件** —— 查 `docs/internal/spec-notes*.md`
>   对应的 `D-xx` 条目。本文件只回答"跑什么、大概覆盖什么、几条"。

### 命令清单：check / selftest / 装配 / 开发辅助都住根 e2eScripts.json

| `npm run task` | 列清单（154 条 = 90 基条目 + 64 派生反证轮），退出码 2 |
| `npm run task -- <id>` | 派发一条，如 `npm run task -- check:units`（id 后参数原样透传） |

### 代码校验（本地由 husky 的 pre-commit 守着，CI 里是强制点）

| `npm run lint` | eslint |
| `npm run lint:fix` | eslint --fix |
| `npm run format` | prettier --write |
| `npm run format:check` | prettier --check |

### 自测聚合入口（分层 + 并行 + git 变更过滤；注册表在 e2e/_check-registry.mjs）

| `npm run check` | static 快闸门 20 项 |
| `npm run check:changed` | 只跑与 git 变更相关的 |
| `npm run check:full` | static + service 全量 |
| `npm run check:nightly` | 全量：含 nightly |

| `npm run task -- check:registry[:refute]` | 命令清单 ↔ 分层注册表 正向 15 条 · **15 条** |
| `npm run task -- check:counts[:refute]` | 条数对账：本节 static 层那批的「N 条」必须与脚本自报一致 2 条 · **2 条** |

| `npm run selftest` | A 组服务契约 159 条 + 引擎自测 23 条 · **159 条** |
| `npm run task -- selftest:app[:refute]` | B 组应用生命周期 16 条 · **16 条** |
| `npm run task -- selftest:app:e11[:refute]` | E11 三进程树回收 |
| `npm run task -- selftest:app:e11:real` | 同上但真进程 |
| `npm run task -- selftest:app:guide` | D-229 未装配时 ① 必须可用 |
| `npm run task -- check:launch-plan[:refute]` | S2/A3b 启动配方契约 25 条 · **25 条** |
| `npm run task -- check:child-watch[:refute]` | 外部二进制父死看守双靶取证 3 条 · **3 条** |
| `npm run task -- check:child-watch-kill[:refute]` | child-watch Windows killTree 无条件 /F 双靶源码钉 2 条  · **2 条** |
| `npm run task -- e2e` | D 组端到端 |
| `npm run task -- check:ia` | IA 结构 37 条 · **37 条** |
| `npm run task -- check:engine-download-entry[:refute]` | D-233 下载入口 7 条 · **7 条** |
| `npm run task -- check:tls` | TLS 依赖链 14 条 · **14 条** |
| `npm run task -- check:quit[:refute]` | 「退出喵坞」根因钉子 5 条 · **5 条** |
| `npm run task -- check:ui-scale[:refute]` | 字号分档 · **6 条** |
| `npm run task -- check:autostart[:refute]` | 翻译服务「自动启动 / 手动启停」根因钉子 21 条 · **21 条** |
| `npm run task -- check:engine-parity[:refute]` | 引擎耦合点纯函数 |
| `npm run task -- check:engine-http[:refute]` | 引擎 HTTP 运行期 |
| `npm run task -- check:retry[:refute]` | 队列「重试」任务身份：复用同一 taskId · **10 条** |
| `npm run task -- check:lib-manage[:refute]` | 漫画库管理取证：队列删除 · **23 条** |
| `npm run task -- check:retranslate[:refute]` | 单张漫画返工重译 + 全屏缩放快捷键：返工覆盖译文 · **12 条** |
| `npm run task -- check:models[:refute]` | S3 模型下载器 E7 双靶：38 条 × 2 靶 = 正向 76× 2 = · **38 条** |
| `npm run task -- check:engine-patches[:refute]` | 上游源码补丁表 · **7 条** |
| `npm run task -- check:extract-atomic[:refute]` | D3 原子解包 · **6 条** |
| `npm run task -- check:engine-bootstrap[:refute]` | G4/G5 零配置装配链门 23 条 · **23 条** |
| `npm run task -- check:engine-bootstrap-real[:refute]` | G4 夹具版真装配 · **11 条** |
| `npm run task -- check:pydensecrf-wheel[:refute]` | B4/G3 预编译 wheel 通道 20 条 · **20 条** |
| `npm run task -- check:pydensecrf-wheel-install` | B4 真装一次 · **5 条** |
| `npm run task -- check:offline-real` | C4 真引擎离线加载 |
| `npm run task -- check:uninstall-keep` | E3 真卸载一次 |
| `npm run task -- check:offline-fallback[:refute]` | C4 离线兜底 9 条 · **9 条** |
| `npm run task -- fetch:models` | S3 模型下载器 CLI Node 对照端 |
| `npm run task -- fetch:mpv` | 番剧内核轨的 mpv 二进制 |
| `npm run task -- check:profile[:refute]` | S4 档位映射 / 加速后端 / 降档 / 空闲卸载 · **42 条** |
| `npm run task -- check:e5e6[:refute]` | S4 端到端 E5/E6：真服务 + 真引擎 + 真 ③，16 条 / 逃生开关反证 3 条 · **16 条** |
| `npm run task -- check:contract[:refute]` | S5 契约增量：9 键 sidecar / 未就绪 vs 不可用 / 模型缺失 / /eng · **77 条** |
| `npm run task -- check:translate[:refute]` | ver2.2 在线翻译服务 · **54 条** |

### S7 真机端到端 E1–E11（逐项取证；总表见 docs/internal/engine-e2e-acceptance-report.md）

| `npm run task -- check:e3:real` | E3 真引擎全链路 31 张 · **8 条** |
| `npm run task -- check:e4[:refute]` | E4 档位切换：生效档位 vs 配置档位 / 未声明档位必须抛错 · **6 条** |
| `npm run task -- check:e7:real[:refute]` | E7 模型续传与校验 · **6 条** |
| `npm run task -- check:e8[:refute]` | E8 加速后端：真机走 MPS / 真回退报 degraded / 用户自选 CPU 不算故 · **6 条** |
| `npm run task -- check:e10[:refute]` | E10 安全：只监听回环 / 非图片字节不进引擎 / 无令牌 403 · **7 条** |
| `npm run task -- check:music[:refute]` | 音乐平台 / 播放模式五档 / 心动模式 / 播放列表入口与抽屉 / 桌面歌词 / 逐字歌词 · **251 条** |
| `npm run task -- check:anime-kernel:real[:refute]` | 番剧内核轨真机半边：真 mpv 跑 `animesvc --kernel-selftest` |
| `npm run task -- check:anime-module[:refute]` | 番剧模块接线：`@anime` 别名双同步 / `/anime` 路由与 IA · **54 条** |
| `npm run task -- check:settings[:refute]` | 设置页「播放 · **184 条** |
| `npm run task -- check:units[:refute]` | 前端分层 / hooks / 别名 / 状态 / 屏装配件分派 / 灵动岛 / 看图缩放 / · **59 条** |
| `npm run task -- check:bundle[:refute]` | 打包配置钉子 17 条 · **17 条** |
| `npm run task -- check:macos-compat[:refute]` | D7 macOS 兼容 11 条 · **11 条** |
| `npm run task -- check:macos-signing[:refute]` | E1 macOS 签名 + 公证 8 条 · **8 条** |
| `npm run task -- check:resources[:refute]` | 随包资源寻址 A1/A2 三环境取证 8 条 · **8 条** |
| `npm run task -- check:packaged[:refute]` | A4 打包后冒烟 · **13 条** |
| `npm run task -- check:runtime-probe[:refute]` | B2/B5 引擎运行时就绪检测 78 条 · **78 条** |
| `npm run task -- check:path-single-source[:refute]` | B3 检测与启动同源 5 条 · **5 条** |
| `npm run task -- check:launch-gate[:refute]` | D6 real 档启动前预检闸门 10 条 · **10 条** |
| `npm run task -- check:install-guide[:refute]` | D5 分平台安装引导与产品对拍 18 条 · **18 条** |
| `npm run task -- check:notready-state[:refute]` | D1「运行时未装配」独立成态 21 条 · **21 条** |
| `npm run task -- check:models-guide[:refute]` | D8 模型引导清单 · **14 条** |
| `npm run task -- check:size-guide[:refute]` | C1 体积与落点如实告知 16 条 · **16 条** |
| `npm run task -- check:platform-guide[:refute]` | C3 `llama-server` 按平台分化 12 条 · **12 条** |
| `npm run task -- check:progress-truth[:refute]` | D2 进度只来自真实来源 10 条 · **10 条** |
| `npm run task -- check:model-runner[:refute]` | C2 校验/建链执行体随包定位 12 条 · **12 条** |
| `npm run task -- check:resilience[:refute]` | manga-service 健壮性钉子 9 条 · **9 条** |
| `npm run task -- check:docs` | 文档 ↔ 实现一致性 · **18 条** |

### F 组「服务 Rust 化」的契约钉子（F0–F5 已全部 ☑，见 docs/internal/packaging-local-engine-dev-plan.md）

| `npm run task -- check:anime[:refute]` | D-242 动漫服务共存 + D-250 远程中继 + D-251 内核轨 + D-252  · **98 条** |
| `npm run task -- check:paths[:refute]` | F2 路径解析与 `config.mjs` 逐字节对拍 5 条 · **5 条** |
| `npm run task -- check:store[:refute]` | F3 任务库内核同源对拍 24 条 · **24 条** |
| `npm run task -- check:store-exec[:refute]` | F3-b 执行/队列同源对拍 74 条 / 反证 · **74 条** |
| `npm run task -- check:engine-parity[:refute]` | F4 引擎纯协议/配方层冻结 golden 25 条 / 反证 · **25 条** |
| `npm run task -- check:engine-http[:refute]` | F4-b1 引擎 HTTP 运行期冻结 golden 20 条 / 反证 · **20 条** |
| `npm run task -- check:llm-supervisor[:refute]` | F4-b2 ③ supervisor 冻结 golden 4 条 / 反证 · **4 条** |
| `npm run task -- check:harness[:refute]` | F0 服务靶子抽象 7 条 · **7 条** |
| `npm run task -- check:routes[:refute]` | F5 路由表 / 转发计数 9 条 · **9 条** |
| `npm run task -- check:docpaths[:refute]` | 现行文档引用的仓库路径必须真实存在 · **5 条** |
| `npm run task -- sign:preflight` | E1 macOS 打包前自检 |
| `npm run app:build:mac` | macOS 打包 = 自检 + tauri build |

---

## 未登记进 `e2eScripts.json` 的入口

`package.json` 只留三类入口（代码校验 / app 启停打包 / 测试入口），其余一律走
`npm run task -- <id>`。下面这些是 `package.json` 里的：

| 命令 | 用途 |
|---|---|
| `npm run app` | 起桌面端（Tauri dev），会自己拉起服务 / 引擎 / LLM 三个子进程 |
| `npm run app:build` | 出安装包：主应用 `tauri build` + `install:kit` |
| `npm run dev` | 只起 Vite 前端（不含 Tauri 壳） |
| `npm run tauri -- <args>` | 直通 Tauri CLI（如 `build`） |

> 完整清单与分组：`npm run task -- --list`（退出码 0）。
