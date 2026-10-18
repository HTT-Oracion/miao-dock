# 新人上手 · dev-setup

> 目标：**半小时内把项目跑起来 + 把检查跑绿**。本机特有的坑（MSVC / 沙箱 / PATH）集中在
> `AGENTS.md` §5，这里只写通用流程，遇到现象再去查那一节。

## 0. 这是什么

喵坞 MiaoDock —— Tauri 桌面端「漫画翻译 + 音乐播放」。四层，改哪层跑哪层的检查：

| 目录 | 职责 | 语言 |
|---|---|---|
| `src/` | 前端 UI + 状态（根目录只留 `main.tsx` / `App.tsx`，其余按职责分目录） | React + TS + zustand + Vite |
| `src-tauri/` | Tauri 壳：窗口 / 系统能力 / Rust 侧音乐逻辑 | Rust |
| `src-tauri/src/mangasvc/` | manga-service：HTTP API + 任务队列 + 落盘（原 `service/` 的 Node 实现已删，D-209） | Rust |
| `engine/` | 推理引擎侧装配（mock 可跑，真权重需另装） | Node + Python |

## 1. 环境要求

| 工具 | 版本 / 说明 | 什么时候需要 |
|---|---|---|
| Node | ≥ 22（本仓用 managed 22.22.2） | 一直 |
| npm | 随 Node | 一直 |
| Rust + cargo | stable | 编 `src-tauri` 才需要 |
| Python | 3.13 | 引擎侧装配 / 脚本才需要 |

Windows 上编 Rust **必须**在 MSVC 环境里（`ring` 要现场编译 C）—— 见 `AGENTS.md` §5，那里的
`fatal error C1034: stddef.h` 就是缺 `INCLUDE` 的症状。

## 2. 第一次上手

```bash
npm ci                 # ① 装前端依赖
npm run task -- check:docs                  # ② 秒级：先确认基线是绿的
npm run app                         # ③ 起 dev（tauri dev）
```

⚠️ **第 ② 步不能跳**。基线不绿时你分不清哪条红是自己引入的——本仓的检查条数是写死的
（`AGENTS.md` §3 有清单），对不上就说明基线已经被动过。

> **真引擎不在仓库里**：`npm run app` 默认走 `MIAO_ENGINE_PROTOCOL=real`，要的是
> `<appData>/runtimes/manga-translator/`（macOS `~/Library/Application Support/`、Windows `%LOCALAPPDATA%\`、
> Linux `~/.local/share/`）下的 Python venv + 依赖 + 模型权重 —— **与装到哪个盘无关**（B1）。
> 装配：`npm run task -- setup:engine && npm run task -- deps:engine && npm run task -- fetch:models && npm run task -- extract:models`
> （README §二）。不想碰引擎就用 `MIAO_ENGINE_PROTOCOL=mock npm run app` 跑替身快回路。
> 装没装齐、缺哪一项：`GET /api/v1/engine/runtime`（B2）。
> 分平台逐步引导（含体积、自检、平台专属坑）：`docs/install-guide-windows.md` · `docs/install-guide-macos.md`（D5）。

## 3. 常用命令（按耗时排）

**秒级 · 源码级（只读源码/配置，不起进程）** —— 改完必跑：

```
check:docs  check:docpaths  check:units  check:ia  check:music  check:settings
check:bundle  check:resilience  check:quit  check:autostart
```

**十秒级 · 判定层（真服务 + 假引擎）** —— 改了 service/engine 契约必跑：

```
selftest  check:contract  check:e10  check:e4  check:e8
check:paths  check:runtime-probe  check:path-single-source   # B1/B2/B3：落点 · 就绪检测 · 同源
check:launch-gate  check:install-guide                      # D6/D5：启动前闸门 · 安装引导与产品对拍
check:notready-state  check:models-guide                    # D1/D8：未装配独立成态 · 模型引导清单（渲染）
check:size-guide  check:model-runner                        # C1/C2：体积与落点如实告知 · 执行体随包定位（含跨卷）
```

**分钟级 · 反证轮** —— 只有**改了断言本身**才跑（证明断言咬的是机制，不是碰巧绿）：

```
任意 check 加 :refute，如 npm run task -- check:music:refute
```

**nightly · 打包后冒烟** —— 只有 `npm run app:build` 产出真实安装包后才跑（A4）：

```
check:packaged          # 静默安装 → 资产自检 → 起服务打 /health + mock 替身 + 启动配方
```

**前端**：`cd app && npx tsc --noEmit && npx vite build`

## 4. 五条最容易踩的坑

1. **行尾（EOL）**：本仓工作区是 **CRLF**（`core.autocrlf=true`、无 `.gitattributes`）。
   `Write` 建文件、`sed -i` 原地改都会把整文件写成 **LF** —— 后果**不是报错，是断言静默翻转**
   （多行锚点突然命中/失效）。改完用 Node 数 `text.split('\n').filter(l => l.endsWith('\r')).length`，
   **别用 `grep -c $'\r'`**（Git Bash 下该转义可能不展开，输出"CR 数=行数"的假信号）。
2. **反证轮必须整轮跑完**：`--refute` 原地改写真实源文件、靠 `try/finally` 还原；
   进程被中断 ⇒ 变异残留在工作区。跑完**必查 `git status`**；中断后先清残留再下结论。
3. **别用 shell `grep` 判"有没有"**：`\|`、`--include=*.tsx` 这类写法会**静默失配**
   （曾把"确实有"判成 0 命中，白排查一轮）。用专用搜索工具。
4. **`vite build` 前先把 `dist/` 挪走**：沙箱的 safe-delete 守卫会拦"批量删 > 50 文件"。
5. **动手前先 `git status`**：本仓库可能有并发会话在同一工作区改动。提交**路径限定 `git add`**，别 `-A`。

## 5. 代码地图（改之前先看这里）

| 位置 | 放什么 |
|---|---|
| `src-tauri/src/mangasvc/store/` | 队列落盘：`exec`（执行体）· `view`（视图）· `pure`（纯函数）· `atomic`（原子写） |
| `src-tauri/src/mangasvc/` 根 | 服务外壳与域模块：`mangasvc.rs`（鉴权/装配）· `routes.rs`（44 条路由）· `handlers.rs`（端点）· `library.rs` · `translate/` · `engine/` |
| `src/screens/` | 屏层；一个应用一组屏（屏入口 + 屏内件同目录，如 `screens/manga/`） |
| `src/components/units/` | 跨屏通用 UI（`Btn`/`Notice`/`MenuButton`/`Modal`…），新通用件必须落这里 |
| `src/components/` | 业务组件（非通用） |
| `src/hooks/` | **所有 `use*` 文件必须住这里**（`check:units` 硬断言，无豁免） |
| `src/tools/` | 跨屏复用的**纯函数**（不 import 业务层） |
| `src/music/` | 音乐：`store.ts`（装配）· `actions/*.ts`（12 段切片）· `convert.ts` · `prefs.ts` · `persist.ts` · `slice.ts` |
| `e2e/` | 全部验收断言（`*-check.mjs`）；`e2e/service/` 是起真服务的判定层 |

## 6. 规范与台账在哪

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | **工程纪律 + 验收命令清单 + 本机环境陷阱**（动手前必读） |
| `.trae/rules/project_rules.md` | 代码约束细则（三条禁项 / 命名 / 注释） |
| `docs/internal/spec-notes.md` | 偏离与裁定台账 **D-01 ~ D-136**（已封卷，历史痕迹不改） |
| `docs/internal/spec-notes-1.md` | 台账续篇 **D-137 起**（新决策写这里，编号全局接续） |
| `../code-audit-report.md` | 结构审计报告与改造执行记录（**在仓库外**的 `manga/` 目录） |

> 提交信息格式：`类型(模块): 功能简述 + 关键点简述`（类型 = feat/chore/fix/style/test/docs；
> 模块 = music/settings/manga · 层 service/engine/e2e · docs）。
