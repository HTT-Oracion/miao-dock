# 翻译服务（真实引擎）接入 · 开发计划

> 目的：把《09-技术方案》§6 +《04-翻译引擎接入规格》从**纸面规格**变成可执行计划。  
> 依据：《09》§6/§9、《03》全篇、《04》全篇、《01》§4、《02》§2.1；以及 **2026-10-05 在 `miao-dock` 仓库逐文件核实**的事实。  
> 纪律：本文中每条"现状"都带文件证据；每个"待实测"都写清测法。**未实测的数字一律给区间，不给精确值。**
>
> **分工 / 里程碑 / 交付物 / 验收流程** 见配套文件 `docs/engine-integration-delivery-plan.md`（本文只管技术方案与阶段划分）。



---

## 0. 结论（先给判断）

| 问题                   | 判定                                                                                                                                                                          | 依据            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 方案是否可行？              | **架构可行，但有前置闸门**。方案本身自洽（三层进程、单点适配层、契约增量而非重构），真正的不确定性全在"引擎能不能在这台机器上装通并跑起来"，而不是设计。                                                                                             | §4 测试 + §2 取证 |
| 是否满足跨端要求？            | **服务层已满足；引擎层不满足（目前是纸面）**。`box-service` 与 `engine-client` 是纯 Node，路径/进程/监听均已按 darwin/win32 分叉；但 Python 运行时 + PyTorch 轮子 + `llama-server` 二进制、以及 Windows 的**进程树回收**，代码里一行都没有。 | §2 逐条         |
| 现在能不能做"真实翻译"的测试？     | **不能**。缺三件：引擎源码、Python 运行时、模型权重。今天能做的是**服务层**的真实测试（已做，14/14）。                                                                                                               | §4.1          |
| 实施顺序是否采纳"先 box 后插件"？ | **采纳，且这条建议本身就是对的**——插件对引擎**零感知**（《04》§2 铁律），所以引擎链路可以完全在 box 侧闭环验收，插件串联是纯粹的最后一公里。                                                                                            | §3.3          |

**一句话**：眼下最该做的不是写 `engine-client`，而是**阶段 0 的环境闸门**——先把引擎在一台机器上装通、出 OpenAPI 快照、实测内存/磁盘/耗时。这一步不过，后面所有阶段的估时都是猜。

---

## 1. 现状取证：文档说的 vs 仓库里有的

| 项                   | 规格要求（《09》/《04》）                                             | 仓库现状（证据）                                                                                                                                         | 差距                                                                |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 进程数                 | **3**：box-service + 引擎② + LLM③                              | **2**：`ServiceManager.children{service, engine}`（`app/src-tauri/src/service.rs:46-49`），两个都用 `spawn_node` 拉 `node <entry>`                        | 缺 ③，且**只能用 Node 拉起**（`service.rs:287` 硬编码 `Command::new("node")`） |
| 引擎实现                | `manga-image-translator`（Python FastAPI）                    | `engine/src/server.mjs` 模拟引擎：`sleep(300ms)` + `renderTranslatedPage()` 渲染**版式化占位图**（`engine/src/server.mjs:99-110`）                              | 整条真实链路缺失（D-09）                                                    |
| 内部协议                | 以 `GET /docs` 的 OpenAPI 快照为准（《04》§4.4）                      | 自造协议：`POST /translate`（裸字节 + `X-Miao-{Seq,From,To}` 头）+ `GET /ready`（`service/src/engine-client.mjs:66,102`）                                     | 协议形状与真实引擎**未对齐**，且无快照                                             |
| 状态机                 | 五态 + `starting` 细分 **L1–L4**（《09》§6.1）                      | 四态 `Stopped/Starting/Running/Error`（`service.rs:23-30`），无阶段细分；`sidecar.state` 只有 3 值 `stopped/starting/running`（`engine-client.mjs:100,103,107`） | 缺 `downloading/prewarming/unloading/degraded/error` 五值            |
| `/health` 的 sidecar | 8 字段（`engineVersion/tier/model/accel/warmed/llm`…，《03》§5.1） | 3 字段 `{state, port, engine}`（`engine-client.mjs:100-108`）                                                                                        | 缺 5 字段                                                            |
| `/engine/status`    | 新增端点（《03》§5.2）                                              | **零命中**（全仓 grep `engine/status` 无结果）                                                                                                             | 未实现                                                               |
| 新错误码 ×2             | `ENGINE_NOT_READY` / `MODEL_DOWNLOAD_FAILED`（《03》§2.3）      | **零命中**（`service/src`、插件仓 `extension/src` 均无）                                                                                                    | 两端都未实现                                                            |
| 模型管理                | 下载/续传/SHA256/`.ready` 幂等（《04》§6.4）                          | 无任何下载器                                                                                                                                           | 未实现                                                               |
| 硬件探测/档位             | `HardwareProfile` + 映射表（《04》§7.2）                           | 无                                                                                                                                                | 未实现                                                               |
| 降档重试 / 空闲卸载         | 《04》§8/§9                                                   | 无                                                                                                                                                | 未实现                                                               |
| 跨端路径                | darwin/win32 分叉                                             | ✅ 已做（`service/src/config.mjs:63-80`）                                                                                                             | —                                                                 |
| 跨端进程树回收             | macOS 信号传播 / Windows Job Object（《04》§2.4）                   | ❌ 只有 `child.kill(); child.wait()`（`service.rs:220-223`）；Node 子进程自带 `parent-watch.mjs`，**Python/llama-server 没有等价物**                              | Windows 会留孤儿                                                      |
| `node` 依赖           | 打包后不依赖系统 PATH                                               | `Command::new("node")` + `resolve_entry()` 向上找 6 级（`service.rs:287,244-275`）                                                                     | **仅开发态可用**（沿 G-13 挂起）                                             |

---

## 2. 跨端核对（本轮的"重点确认"）

按**每一层各自的跨端难度**分开判，别把"Node 层是跨端的"当成"整条链路是跨端的"。

### 2.1 逐层判定

| 层                                   | 跨端现状                                                      | 结论         | 佐证                                                                                         |
| ----------------------------------- | --------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| **① box-service（Node）**             | 已跨端：路径分叉、`127.0.0.1` 监听、无平台特有 API                         | ✅ **满足**   | `config.mjs:63-80`；今日 macOS 实测 14/14（§4.1）                                                 |
| **② 引擎（Python + PyTorch）**          | 未落实：无 venv 引导、无按平台的 wheel 解析、无 Python 版本矩阵                | ❌ **纸面**   | 全仓无 `requirements.lock` / `runtimes/`                                                      |
| **③ LLM（llama.cpp `llama-server`）** | 未落实：无按平台的二进制获取（macOS arm64 Metal / Windows CUDA / CPU 三套） | ❌ **纸面**   | `command -v llama-server` → 未安装                                                            |
| **生命周期拉起**                          | 只能用 `node` 拉起（`service.rs:287`）                           | ❌ **需改造**  | 要按进程类型分派 spawn                                                                             |
| **就绪握手**                            | 依赖子进程 stdout 打一行 JSON 就绪行（`service.rs:304-308`）           | ❌ **形状不同** | FastAPI / llama-server **不会**打这种行 → 必须改为**主动轮询**（`GET /docs` / `/health`），即《04》§12 的"三重判定" |
| **进程树回收**                           | macOS 靠信号传播；Windows 需 Job Object / `taskkill /T /F`       | ❌ **缺口**   | `service.rs:220-223`；子进程侧只有 Node 的 `parent-watch.mjs`                                      |
| **落盘/安全/契约**                        | 与平台无关                                                     | ✅ **满足**   | `config.mjs` 黑名单 + 三次校验                                                                    |

### 2.2 三个必须写进计划的跨端硬骨头

1. **Python 运行时与 PyTorch 轮子的按平台解析**  
   `manga-image-translator` 官方要求 Python 3.10+。**PyTorch 轮子不是同一个包**：macOS arm64 走 MPS、Windows x64 要区分 CUDA 版本与 CPU 版。这意味着"venv 目录"必须带平台指纹，`requirements.lock` 要按平台分支——**一份 lock 走两端的做法在这里不成立**。
2. **`llama-server` 二进制的按平台获取**  
   llama.cpp 的 release 产物按 `{os}-{arch}-{backend}` 出（Metal / CUDA / CPU）。这不是"下载一个可执行文件"，而是"按探测结果选一个"。并且 Windows 上 `llama-server.exe` 正是《04》§2.4 点名的**孤儿风险**来源。
3. **Windows 进程树回收**  
   `Child::kill()` 在 Windows 上只结束直接子进程。Python 进程会派生子进程（数据加载 / 多进程推理），llama-server 是独立进程 ⇒ 必须给每个子进程建 **Job Object**（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），或统一走 `taskkill /PID /T /F`。**这条不能靠"子进程自己看守"替代**——`parent-watch.mjs` 是 Node 实现，Python 侧没有等价物。

### 2.3 ⚠️ 一处文档内部矛盾（建议修正）

《09》§1.3 / 《04》沿用 PD-3 写「**首个验证平台是 Windows 而非 macOS**」，理由是「上游参考实现是 Windows-only 项目」。

**但这条理由的适用对象是音乐模块的移植（上游参考实现的代码），不是翻译引擎。** 翻译引擎的：

- 内存基线（9.4/12.8/17.6 GB）是在 **MacBook Pro M4 / 16GB** 上估的（《04》§11.1）；
- 加速后端首选是 **MPS**（《04》§7.3）；
- 而本机（MacBook Pro M4 / 16GB）是**唯一可实测环境**。

**建议**：引擎链路（E 组验收）的**首发验证平台改为 macOS**，Windows 作为第二平台纳入 M5 一并覆盖。否则会出现"为了守一条为音乐写的规则，把唯一能验的环境排到最后"。  
**→ 已拍板（2026-10-05）：改 macOS 首发。** 见 §7-①。

---

## 3. 接口 / 数据流 / 依赖关系

### 3.1 外部契约（插件 + Box 共用，`http://127.0.0.1:5180/api/v1`）

| 端点                            | 鉴权                         | 谁用                                            | 本轮增量                         |
| ----------------------------- | -------------------------- | --------------------------------------------- | ---------------------------- |
| `GET /health`                 | **免鉴权**（唯一例外）              | 插件端口探测（命中条件 `service === "box-service"`）+ Box | `sidecar` 对象 3 → 8 字段        |
| `POST /tasks`                 | `X-Box-Token`              | 插件                                            | 新增 `503 ENGINE_NOT_READY` 语义 |
| `POST /tasks/{id}/batches`    | 同上                         | 插件                                            | 不变（≤20 张/请求）                 |
| `GET /tasks/{id}`             | 同上                         | 插件                                            | 不变                           |
| `GET /tasks/{id}/events`（SSE） | 同上（**故不能用 `EventSource`**） | 插件                                            | 不变                           |
| `POST /tasks/{id}/cancel`     | 同上                         | 插件                                            | 不变                           |
| `GET /queue`                  | 同上                         | 插件                                            | **数据来源变**：eta 改用真实逐张耗时       |
| `GET /library/**`             | 同上                         | 插件                                            | 不变                           |
| `GET /engine/status`          | 同上                         | **仅 Box**（插件不用）                               | **新增**                       |

**Origin 校验**：含 `Origin` 时必须匹配 `chrome-extension://*` 或 `null`，否则 403；CORS 回 `chrome-extension://<id>`，**不放 `*`**（`service/src/server.mjs:631` 附近）。

### 3.2 内部边界（**对客户端永久不可见**，《03》§1 铁律）

```
box-service ──POST /translate(真实形状以 /docs 快照为准)──▶ 引擎②(5003)
引擎②     ──POST 127.0.0.1:8080/v1/chat/completions────▶ 引擎③ Sakura(llama-server)
```

- **唯一耦合点**：`service/src/engine-client.mjs`。换引擎版本**只允许改这一个文件 + `VERSIONS.lock`**（《04》§3.3）。越过它泄漏引擎细节 = 缺陷。
- 适配层对外签名**保持**：`translateImage(bytes, {seq,from,to,mime}) → {bytes,ext,mime}`、`probeEngine() → ProbeResult`（**形状扩展**）。
- 单图调用**不逐图传参**：语言对/档位在引擎**启动期**用 `--config-file` 固定，调用只传字节 + seq（《04》§4.2）。

### 3.3 端到端数据流（含新增分支）

```
① 插件悬浮球 → ② 面板（选图 / 漫画名 / 14 项校验）
   ↓ POST /tasks   multipart: payload{comicName,idempotencyKey} + images[] + imageOrder[]
   ↓ box-service：NFKC 漫画名规范化 → 校验 → 分配序号 → 存 pending 暂存区 → 入**串行**队列
   ↓ 轮到本任务 → 【ver2.0 新增分支】引擎未就绪？
        是 → 503 ENGINE_NOT_READY（**不建单、不分配序号、不排队**）→ 面板切「准备中」
        否 → 建目录 → 逐张调引擎：
              detect → OCR → inpaint → translate(③ LLM，唯一跨进程阶段) → render
   ↓ 落盘  {root}/{漫画名}/NNN.<原嗅探扩展名>  +  NNN_translated.<嗅探扩展名>
   ↓ SSE: task.status / batch.status / item.status / heartbeat(15s)
③ 插件状态机 8 态（idle/submitting/queued/running/done/partial_failed/canceled/failed）
④ 插件回写网页 <img>
⑤ 面板：排队位次 / 逐张进度 / 结果回执
```

### 3.4 依赖关系（三条链）

| #  | 依赖                | 方向        | 性质                                                           |
| -- | ----------------- | --------- | ------------------------------------------------------------ |
| D1 | 插件 → box-service  | **强、无旁路** | 插件**只能**经 `5180–5190` 说话；引擎对插件零可见。box 未运行 ⇒ 插件只能进「服务未就绪」态    |
| D2 | box-service → 引擎② | 强、单点      | 全部经 `engine-client.mjs`                                      |
| D3 | 引擎② → 引擎③         | **软**     | ③ 挂了：翻译阶段失败、`item=failed`，但**视觉流水线仍可跑**（《04》§10.2）⇒ 错误分级必须区分 |

### 3.5 插件侧待改清单（最后一公里，共 4 处）

⚠️ 《01》§6 写的落点是 `src/panel/components/ServiceNotReady.tsx`，**该文件不存在**（ver1.0 文档写于实现之前）。以下是**实测的真实位置**：

| #   | 真实位置（已核实）                                                                                            | 改动                                                                                                                          | 现状                                                           |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P-1 | `extension/src/adapters/boxServiceClient.ts` + `src/types/contract.ts:310`                           | 解析 2 个新错误码。⚠️ `contract.ts` 的 `meansServiceNotReady` 门控**不得**把 `ENGINE_NOT_READY` 归进去 —— 它是「准备中」（进程在），与「服务未就绪」（进程不在）是两句不同的话 | 未做（`ENGINE_NOT_READY` / `MODEL_DOWNLOAD_FAILED` 在插件仓**零命中**） |
| P-2 | `extension/src/panel/Panel.tsx:366`（浮层）+ `src/domain/clientState.ts:390-401`（`SERVICE_NOT_READY` 常量） | 扩为「未就绪 / 准备中」两态                                                                                                             | 单态（`title: '本地翻译服务未运行'` / `primary: '启动 Box'`）               |
| P-3 | 同上两处 + 面板提示行                                                                                         | 文案×2：「正在准备翻译引擎…」/「首张稍慢，后续加快」                                                                                                | 未做                                                           |
| P-4 | `extension/src/domain/demoMode.ts:22`                                                                | **删除** `DEMO_BYPASS_SERVICE_READY = true`（被 `panel/controller.ts:163,651,663` 三处引用）                                         | 仍为 `true`（README 自述"后端就绪后移除"）                                |

> ⚠️ P-4 是"串联"的**真正开关**：它现在让插件在探测不到服务时也放行渲染。box 就绪后必须删，否则"服务未就绪"这条最重要的路径**永远测不到**。  
> ✅ **好消息**：P-1…P-4 全在**插件侧 4 个小文件**里，box 的实现方式（真引擎还是模拟引擎）对它们**完全透明**——这正是「先 box 后插件」这条路径成立的原因（《04》§2 铁律的结构性收益）。

---

## 4. 测试：用真实漫画原图跑

### 4.1 已完成的测试（服务层，真实进程 + 真实落盘）

**素材**：`test-manga/test_0.webp` —— 真实日文漫画单页，**1125×1600**，291,828 字节（`file` 判定 RIFF/WebP/VP8 lossy；页面本身含多处日文对白气泡，可肉眼确认是真实漫画页而非合成图）。

**做法**（探针脚本 `tmp-engine-test/probe.mjs`，`tmp-*/` 已被 `.gitignore` 覆盖）：  
起**真实的** `engine` + `service` 两个进程（与 Rust `ServiceManager` 同样的方式：先引擎后服务），`MIAO_ROOT` / `MIAO_STATE_DIR` 指向仓库内临时目录（**不写用户真实图片目录**），端口探测 → 读令牌 → 提交真实 webp → 轮询至终态 → 逐字节校验落盘产物。

**结果：14/14 全绿**（`合计 14/14`，脚本退出码 0）

| #  | 断言                                 | 结果                                                   |
| -- | ---------------------------------- | ---------------------------------------------------- |
| 1  | 模拟引擎启动并就绪                          | ✅ port=5003                                          |
| 2  | box-service 启动并打出就绪行               | ✅ port=5180（该行正是 Rust 侧握手依据）                         |
| 3  | 端口探测命中 `service === "box-service"` | ✅                                                    |
| 4  | `/health` 带回 `sidecar`             | ✅ `{state:"running",port:5003,engine:"sakura-mock"}` |
| 5  | 令牌为 64 位 hex                       | ✅                                                    |
| 6  | 读到测试原图                             | ✅ 291,828 字节                                         |
| 7  | `POST /tasks` 建单                   | ✅ HTTP 201                                           |
| 8  | 任务到达终态                             | ✅ `status=done`，**575 ms**                           |
| 9  | item 逐张状态                          | ✅ `#1:success`                                       |
| 10 | 原图 + 译文成对落盘                        | ✅ `001.webp` | `001_translated.png`                  |
| 11 | 译文是可解析 PNG                         | ✅ 13,122 字节                                          |
| 12 | **原图 webp 被服务端正确嗅探**               | ✅ 落盘为 `.webp`（扩展名取自字节而非 filename）                    |
| 13 | **译文尺寸 == 1125×1600**              | ✅（证明 WebP 头解析真的生效，未回退默认 400×600）                     |
| 14 | `GET /queue` 可读                    | ✅ HTTP 200                                           |

**这个测试证明了什么**：服务层（多部件解析 → 漫画名规范化 → 编号 → 暂存 → 串行队列 → 落盘 → 扩展名嗅探 → 逐张状态）在**真实图片、真实进程、真实磁盘**下是通的；且图片嗅探/尺寸解析对真实 WebP 正确（WebP 的 `VP8 ` 分支读偏移 26/28，`engine/src/image.mjs:78-83`）。

**这个测试没有证明什么** —— 我把它单独拿出来看：落盘的 `001_translated.png` 打开后是**若干灰条 + 两个空白方框**，即 `renderTranslatedPage()` 渲染的**版式占位图**。**一步真实翻译都没有发生。** 任何把"管路通"读成"翻译通"的结论都是错的。

### 4.2 真翻译测试做不了，缺什么

> **2026-10-05 更新（S0 完成）**：下表中**每一件都已补齐** —— 引擎源码（锁 commit）、Python（纠正为 3.11.17）、
> 引擎依赖（含 `pydensecrf`）、视觉模型（镜像预置 + sha256 校验）、Sakura GGUF + `llama-server`。
> **真翻译已于同日跑通（G1 通过）**：`out-first/test_0.webp`，1125×1600，1.6 分钟，逐像素 **4.94% 有实质差异**。详见 §4.7。

| 缺件                           | 现状                                          | 补齐代价                                      |
| ---------------------------- | ------------------------------------------- | ----------------------------------------- |
| `manga-image-translator` 源码  | ✅ **已解决**：锁定 commit `441d07c5`（97 MB，`runtimes/manga-translator/src/`）  | 已完成（走 `codeload` 归档；`git clone` 被本机代理拒，见 §4.6）                      |
| ~~**Python 3.10–3.12**~~      | ✅ **已解决但版本选错过**：现为 **3.11.17**（`runtimes/manga-translator/python-3.11/`）；3.12.15 保留改名 `python-3.12-probe/` 仅作探针 | 已完成（上游 `requires-python = ">=3.10, <3.12"`，**3.12 不在支持范围**，见 §4.6）          |
| ~~PyTorch + 视觉依赖~~           | ✅ **已装成并自洽**：torch 2.14.1 · torchvision 0.29.1 · numpy 1.26.4 · opencv 4.11.0 · transformers 5.18.0 · onnxruntime 1.30.0 · **`pip check` 无破损**；**MPS 已在引擎 venv 复测通过**（conv2d ≈15×） | 已完成（47m47s；`pydensecrf` 走镜像编译，见 §4.7）    |
| 视觉模型（检测/OCR/`lama_large`）    | ✅ **已镜像预置 + sha256 校验通过**：`detect-20241225.ckpt` · `lama_large_512px.ckpt` · `ocr_ar_48px.ckpt` + `alphabet-all-v7.txt` | 已完成（`ghfast.top` / `hf-mirror`；引擎**不做镜像回退**，故必须预置）          |
| Sakura GGUF + `llama-server` | ✅ **已就位**：llama.cpp **b11417**（macOS arm64，12 MB）+ Sakura **1.5B fp16 3.3 GB** | 已完成（`latest` 端点返回错 tag，改为写死 `b11417`，见 §4.7）                   |
| 磁盘余量                         | **数据卷实测 89 GB 可用**                            | 首次安装估算需 5–8 GB，**余量充足**                 |
| 网络可达性（2026-10-05 实测）        | `pypi` ✅ / `pypi.tuna` ✅ / `github.com` 根路径 ✅ **但 release 资产下载 ❌（502）** / **`huggingface.co` ❌** / `hf-mirror.com` ✅ / `modelscope.cn` ✅ / **`mirror.nju.edu.cn`（含 python-build-standalone 全量）✅** / `registry.npmmirror.com` ✅ | 二进制与模型权重**一律走镜像**；判"某站可达"必须**测到真实资产**，不能只看站点根路径（见 R9/R10）              |

### 4.5 S0 开工首轮实测结果（2026-10-05）

**动作**：装 Python（项目内）→ 建 venv → 装 torch → 跑 MPS 能力探针。
**探针**：`tmp-engine-test/mps-probe.py`（可复现；`tmp-*/` 已 gitignore）  
**版本锁**：`engine/VERSIONS.lock`（仓库内、可版本控制）

| 项 | 实测结果 |
|---|---|
| Python | **3.12.15**（python-build-standalone `20261003`，arm64，24 MB，16.7 MB/s） |
| torch | **2.14.1**（`cp312`/`macosx_14_0_arm64`，127 MB wheel）· numpy 2.5.3 |
| `mps.is_built()` / `is_available()` | **True / True** |
| 张量真在 MPS 上算 | ✅ `device.type == 'mps'`，且与 CPU 结果**逐位一致（偏差 0.000e+00）** |
| conv2d 1024×1024×32ch | MPS **≈ 10.1 ms** vs CPU **≈ 342 ms**（**≈ 34×**） |
| MPS 内存 | 已分配 386 MB · driver 已分配 1032 MB |

**判定**：**G1 ① 通过**（torch 可用 + MPS 真的可用且算得对）。
⇒ 风险 **R1（MPS 算子覆盖不全）由「高」降为「低」**，但**不归零**：
这里只测了 `matmul` 与 `conv2d`，**引擎实际用的算子集（检测/OCR/inpainting）仍可能踩到 CPU 回退** ——
那要等引擎本体跑起来才能逐算子确认。

**过程中发现的两个真问题**（都已处置）：
1. **`numpy` 缺失**：torch 装完并不带 numpy，torch 会打 `Failed to initialize NumPy` 警告。
   引擎必需 ⇒ 已装。**教训：torch 的依赖不等于引擎的依赖**，别把"torch 装上了"当成"环境齐了"。
2. **`brew install` 在本机沙箱内不可用**（`sandbox-exec: sandbox_apply: Operation not permitted`）；
   改用项目内 python-build-standalone ⇒ 顺带满足"运行时独立于 `app/`"与后续打包。

**另一处"写死的模拟引擎口径"（D-0.8 的第二处）**：
`scripts/e2e.mjs` 除了 D4a 写死 30s，`waitTask` 还写死了 **60s 单任务超时**。
慢引擎下它会先抛"未在 60000ms 内到终态"，**看起来像流程坏了，其实只是引擎慢**。
两处已一并改为**随单张耗时基准缩放**（基准可经 `MIAO_E2E_ITEM_MS` 覆盖）。
验收：正向 **23/23**；反证（引擎 900ms/张、基准不动）**22/23 —— 只 D4a 一条红**，明细自解释。

### 4.6 S0 第二轮实测：引擎本体就位 + **一处版本纠正** + 引擎的真实形状（2026-10-05）

#### ① 版本纠正：Python 3.12 **不是**引擎支持的版本 🔴

上游 `pyproject.toml` 写着 `requires-python = ">=3.10, <3.12"` —— **上界是 3.11**。

第一轮 S0 装的 **3.12.15 落在支持区间之外**。错因值得记下来：计划里把 README 的
"Python 3.10+" 当成了唯一约束，**只读了"3.10 以上"，没读到"3.12 以下"**。

| 处置 | 内容 |
|---|---|
| 引擎运行时 | 改装 **3.11.17**（支持区间内的最高版）→ `runtimes/manga-translator/python-3.11/` |
| 旧的 3.12.15 | **不删**，改名 `runtimes/manga-translator/python-3.12-probe/`，**名字自证其角色**（仅 MPS 探针用）；配套 venv 改名 `venv-3.12-probe/` |
| 为什么改名而不是留着 | 两个 Python 并存时，`venv` 建在哪个解释器上是**看不出来的** —— 这类"拿错解释器"的错会在很晚才以奇怪的方式爆出来。版本号写进目录名是**最便宜的自证** |

⚠️ 连带一条纪律：**"探针那一套"不等于"引擎那一套"**。§4.5 的 MPS 结论是在 3.12 + torch 2.14.1 上测的，
它证明的是"这台机器的 MPS 能用"，**不是**"引擎的 torch 也能用 MPS"。3.11 的引擎 venv 建好后要在**它自己里面**重测一次。

#### ② 引擎源码就位（`git clone` 走不通，走 codeload）

| 项 | 值 |
|---|---|
| 仓库 | `zyddnys/manga-image-translator`（10.5k star，GPL-3.0，上游仍在维护） |
| 锁定 | **commit `441d07c59a735c7db3db2e7bb8b07920afd8a9cc`**（main @ 2026-09-25） |
| 获取通道 | `git clone https://...` → **`CONNECT tunnel failed, response 502`**（本机代理拒）<br>`https://codeload.github.com/<repo>/tar.gz/<commit>` → **200 / 56 MB** ✅ |
| 落点 | `runtimes/manga-translator/src/`（97 MB，仓库外） |

**两条结论改了计划里的写法**：
1. **"锁 tag"不成立** —— 上游最新 release 是 **2022-04-23 的 `beta-0.3`**，之后不再发 release，tag 里没有可用版本 ⇒ 只能**锁 commit**。归档解包**不带 `.git`**，所以版本只认 `engine/VERSIONS.lock` 里的那一行，`git describe` 用不了。
2. **二进制/源码一律用"URL 直下 + 镜像"**，不要指望 `git clone`。这条把 R9/R10 从"风险提示"变成了"操作规范"。

#### ③ 引擎的真实形状（读源码实测）—— 计划里假设错的两处

| 计划里写的 | 实测 | 影响 |
|---|---|---|
| 引擎是"一个进程、一个端口" | **`server.main` 自己会再拉起一个执行器子进程**（`server/main.py:244`，且 `__main__` 里 `args.start_instance = True` 是**强制的**）⇒ 端口**成对**：`8000`(web) + `8001`(executor) | **S2 重估** |
| README 对端口有 8000/8001/5003 "四种说法"、"疑似漂移" | **不是漂移，是四个不同入口**：web=8000、`shared`(执行器)=5003、`ws`=5003、`local`=CLI。四种说法全部对上 | R4 的"漂移"部分**解除**，但**接口形状仍要锁 OpenAPI 快照** |
| 进程树是"服务 → 引擎"两层 | 实际是 **`box-service → server.main(uvicorn) → manga_translator shared(执行器) → [llama-server]`**；而 `main.py:272` 的 `handle_exit_signals` 只 `terminate()` **一层** | **孤儿回收风险比计划里高**，S2 必须按四层设计，不能按两层 |
| 就绪靠"读 stdout 打的行" | 它**不打就绪行**（只先打 `Nonce: <hex>`，然后 uvicorn 自己的日志） | 「三重判定（进程存活 + 端口 + HTTP 应答）」是**必需的**，不是过度设计 |

另外两处细节：执行器与 web 之间用 **`--nonce`（`X-Nonce` 头）**鉴权，默认随机生成 ⇒ 本项目要**自己掌握**它；
`--models-ttl` 默认 **0 = 永不卸载** ⇒ 计划里 Tier2 的 30 分钟卸载必须**显式传参**才成立。

**做法上顺带记一条**：`local` 子命令（`python -m manga_translator local -i <img>`）能**不起 web、不起执行器、没有 nonce** 地跑单图
⇒ **S0 要的"跑一张真翻译"用这条最省事**，把"环境闸门"和"进程编排"两件事解耦开验。

#### ④ 许可（⚠️ 新增待确认项）

引擎是 **GPL-3.0-only**。本项目已有先例（`vendor/music-reference/README.md`：参考实现 GPL-3.0，"个人自用不触发分发义务"），
**但引擎这一件不能照抄那个结论**：① 引擎依赖清单里的传染面更大；② 有利的一面是它**只经 HTTP 说话、是独立进程**，
不构成衍生作品；③ 而计划里的"首次安装 5–8 GB / 自动下载引擎与模型"若面向**对外分发**，义务边界要重新算。
⇒ **列待确认项**（本轮不定论），对外分发前必须先有结论。

**这一轮的判定**：引擎**源码与运行时**就位，**依赖正在装**；G1 仍**未过**（还差"第一张真译文"）。

> 因此"基于原图完成翻译服务的实际测试"这句话，今天仍只能到 §4.1 这一步 ——
> 但阻塞项已经从"什么都缺"收窄到**"装通依赖 + 跑出第一张真译文"**。

### 4.3 潜在风险

| # | 风险 | 级别 | 证据 / 说明 | 应对 |
|---|---|---|---|---|
| R1 | 引擎在本机装不通（PyTorch 轮子 / 算子 MPS 支持度） | ~~高~~ → **中** | **已部分消除**（2026-10-05）：torch 2.14.1 装上、MPS 可用且结果与 CPU 逐位一致（§4.5）。**残留**：引擎实际算子集（检测/OCR/inpainting）是否全走 MPS 未验 | **阶段 0 闸门**：仍守着 —— 引擎本体跑起来后逐算子确认，出现 CPU 回退要量化代价 |
| R2 | 16GB Mac 内存余量薄 | 中 | 官方估算 Tiny 峰值 ≈ 9.4 GB（余 6.6 GB），而权重是 **wired memory**（不可回收/不可换出），超限即 swap，单张 2s 可拖到 20s+ | 强制 Tiny；UI 不出 Medium（`Metal unified < 24 ⇒ Tiny`） |
| R3 | **磁盘余量（实测 89 GB 可用）** | **低** | 数据卷 `df -h /System/Volumes/Data` 实测：460Gi 总 / 354Gi 已用 / 89Gi 可用。**⚠️ 初版误读 `df -h /` 得"33 GB"** —— `/` 是 APFS 密封系统卷，读数受容器共享空间误导，**不能用它判余量** | 仍做"安装前提示预留"；模型目录与代码分离（换版本不重下） |
| R4 | 引擎 API 跨版本漂移 | 中 | 官方 README 自身对端口有 8000/8001/5003 四种说法（《04》§3.1） | 锁 tag + `openapi.snapshot.json` + 单点适配层 + 升级走评审 |
| R5 | Windows 孤儿 `llama-server.exe` | 中 | `Child::kill()` 在 Windows 只杀直接子进程 | Job Object（§2.2-3）；**本机无法验证** |
| R6 | 现有验收会被"真实引擎"打破 | ~~确定发生~~ → **已处置**（2026-10-05） | `scripts/e2e.mjs:492` 断言「20 张在 30 秒内完成」（`elapsed < 30`）；真实单张是**秒级**，该断言必红 | ✅ 已改为**随单张耗时基准缩放**（`MIAO_E2E_ITEM_MS` 可覆盖）；`waitTask` 写死的 60s 一并改（见 §4.5 末）。反证：慢引擎下 22/23，只 D4a 红 |
| R7 | 端口探测从"读就绪行"改"主动轮询"引入新竞态 | 中 | 现有 `wait_ready` 依赖 stdout `{...}` 行（`service.rs:324-341`），Python/llama-server 不打这种行 | 三重判定（进程存活 + 端口监听 + HTTP 应答），各自独立超时 |
| R8 | 「先 box 后插件」被误解为"插件不用动" | 低 | 插件确有 4 处必改（§3.5） | 把 P-1…P-4 写进计划尾部，别漏 |
| R9 | **模型权重源不可达** | 中 | 实测：`huggingface.co` **不通**（CONNECT tunnel failed / IPv4 超时）；而 `hf-mirror.com` 200 ✅、`modelscope.cn` 302 ✅、`pypi` 200 ✅ | 下载器**必须支持自定义 endpoint**（`HF_ENDPOINT` / ModelScope），并在失败时给出可操作的提示而非静默卡住 |
| R10 | **"站点可达"≠"资产可达"** | **高**（已实际踩到） | `github.com` 根路径返回 200，但 **release 资产下载 502**（同一域名，路径被拦）。**只看根路径会把"不可用"误判为"可用"** | 判可达性**必须请求真实资产**（`-r 0-1023` 取前 1KB）；二进制/权重一律优先镜像：`mirror.nju.edu.cn`（python-build-standalone 全量）、`registry.npmmirror.com` |
| R11 | Homebrew 在本机沙箱内不可用 | 中 | `brew install` 在下载校验阶段失败：`sandbox-exec: sandbox_apply: Operation not permitted`（**不是网络问题**） | 运行时改用**项目内** python-build-standalone（`runtimes/`），顺带满足"模型/运行时独立于 app/"与后续打包 |
| R12 | 服务侧还有一处超时默认值待按真引擎重估 | 中 | `service/src/config.mjs` 的 `engineTimeoutMs: envInt('MIAO_ENGINE_TIMEOUT_MS', 60_000)` —— 单张请求 60s 上限。真引擎单张若接近或超过该值，会以**超时错误**的形式失败（且看起来像引擎坏了） | S2 一并处理：按档位/实测单张耗时重估默认值，并在超时时区分"引擎慢"与"引擎挂" |

### 4.4 估时（**估算，阶段 0 后必须回填**）

M4 Metal / Sakura-1.5B 官方速度基线 40–60 tok/s（《04》§11.3）。一页漫画约 10 个气泡、每气泡译文数十 token ⇒ LLM 阶段约数秒；叠加 detect/OCR/inpaint/render 后，**单页量级在 10 s 上下**，20 页约 3–6 分钟。

> ⚠️ 这是**推算**，不是实测。它的作用是提前说明 R6（"20 张 30 秒"必然不成立），**不要**写进任何用户可见文案 —— 《04》§11.4 明令"未实测前不得给出精确秒数"。

### 4.7 S0 收口：**第一张真译文产出（G1 通过）**（2026-10-05）

| 项 | 实测 |
|---|---|
| 产物 | `runtimes/manga-translator/out-first/test_0.webp`（1125×1600，322 KB） |
| 耗时 | **1.6 分钟**（CPU，含模型加载；20 页量级可据此往回推，但仍需系统实测） |
| 完整流水线 | 检测(DefaultDetector 1536×2048) → OCR(Model48pxOCR，**21 个文本框**) → 翻译(Sakura 0.9→简体) → 掩码细化 → 擦除(LamaLarge 1128×1600) → 上字 → 落盘 |
| 像素取证 | 与原图逐像素：**4.94% 像素有实质差异**（最大通道差 255）⇒ 真改图 |
| 一键脚本 | `tmp-engine-test/s0-fetch-and-run.sh`（幂等 · 续传 · sha256 校验） |
| OpenAPI 快照 | `runtimes/manga-translator/openapi.engine.json`（S1 的依据；含 `/translate/image` `/translate/with-form/image` `/queue-size` 等） |

**两个必须带到 S1 的观察：**
1. **行数不匹配的重试路径会打 `404 File Not Found`**：11 行原文→10 行译文触发重译，重译那次 404，
   靠**降级为逐行翻译**才成功。⇒ 成因未定位；接真引擎后这条路径会常见，S1 要单独盯（会拉长耗时）。
2. **1.5B 档译文质量一般**（`いらっしゃい`→"真让人不爽"、`野バト`(野鸽)→"野兔"）⇒ **产品选型问题，非管线问题**。
   要"可用"得上 8B/14B 档，**下载量与单张耗时要重估**（§4.4 的估算按 1.5B 写的）。

### 4.8 一条被反证掉的错误归因（方法论，值得单列）

我一度判定"本机 Python 文件中介让 `import torch`/`pip check` 慢到分钟级"。
**四臂对照**（`tmp-engine-test/broker-ab.sh`，只改一个变量）把它推翻了：broker 开/关四臂**全部 1–2 秒**。
真因是**当时有并发重活压满机器**（pip 装机 + 一条 850s 的挂起连接同时在场）。

> 记它是因为**症状与"听起来很对的机制解释"同时出现**，是最容易写成结论的一对。
> 附带更正：该脚本第一版用了 GNU `timeout` —— macOS 没有（四臂全 rc=127 假绿）。改用 `perl alarm`。
> **"四臂都有输出"不等于"四臂都测到了"。**

---

## 5. 开发计划

### 阶段总览

| 阶段 | 名称 | 依赖 | 闸门 |
|---|---|---|---|
| **S0** | **环境闸门**：引擎装通 + 取证 | — | ✅ **通过（G1）** |
| **S1** | 适配层对齐（`engine-client` 换真实协议） | S0 | ✅ **通过**：单图真翻译可跑通（当时断言 32 + 反证 5/5，D-62；S5 扩到 **42 + 反证 8/8**） |
| S2 | 三进程生命周期 + 就绪探测 | S1 | ✅ **通过**：D-64…D-70（macOS 侧）；E11 的端口回收在 S7 真机复跑 `14/14` |
| S3 | 模型管理（下载/续传/SHA256） | S0 | ✅ **通过**：夹具 32/0 + 反证 5/5；真机半边 6/0 + 反证 3/3（D-72 / D-76） |
| S4 | 档位 / 加速后端 / 降档重试 / 空闲卸载 | S2 | ✅ **通过**：E5/E6 可验（判定层 42 + 反证 13/13 · 端到端 16 + 反证 3/3，D-73）；真机项 E4/E8 归 S7 |
| S5 | 契约增量（2 错误码 + `/health` 扩展 + `/engine/status`） | S2 | ✅ **通过**：契约断言 77/0 + 反证 4/4（D-74） |
| S6 | Box UI（设置② 10 项 + 引擎诊断 + 准备中/首张稍慢） | S5 | ✅ **通过**：设置页 **135/0** + 反证 **63/63** · 契约 77/0 · 服务端设置 61/0（D-75；收尾修 StrictMode 守卫，见 D-76 决策 1-6） |
| S7 | 真机端到端 E1–E11 | S2–S6 | ✅ **通过（本机可验部分）**：E1–E11 逐条取证 → `docs/engine-e2e-acceptance-report.md`；11 条里 4 条 ✅、7 条 ✅⚠️（未验半边**逐条登记、不计入已完成**）。6 个真缺陷修实现不放宽断言（D-76） |
| S8 | 插件串联（P-1…P-4） | S7 | ✅ **通过**：单测 201 · verify 27/27 · noservice 探针 10/10 · 反证 3 条 + 4 项 FAIL；**真引擎下复跑 E9 = 19/0**（D-77） |

### S0 · 环境闸门（**先做这个，不写业务代码**）

**为什么把它单列成一个阶段**：方案里所有未实测项（端口/内存/磁盘/耗时/Python 版本）都收敛在这里。它不产出功能，但**决定后面所有估时是否成立**。

| 动作 | 产出 |
|---|---|
| **磁盘预检**：安装前检查可用空间，不足时**显式提示预留 5–8 GB**（数据卷实测 89 GB 可用，余量充足） | 预检逻辑 + 提示文案（§7-②） |
| 装一个受支持的 Python（3.11 或 3.12）到 `runtimes/manga-translator/python/` | 版本结论 + 记录 |
| checkout `manga-image-translator` 并**锁 tag/commit** | `engine/VERSIONS.lock`（引擎 + PyTorch + llama.cpp 三行） |
| 建 venv、装依赖，确认 **torch 在 macOS arm64 上可 import 且 MPS 可用** | `requirements.lock`（按平台分支） |
| 拉起引擎，**`GET /docs` 存 OpenAPI 快照** | `engine/openapi.snapshot.json` ← **S1 的唯一依据** |
| 拉 Sakura Tiny GGUF + `llama-server`（macOS arm64 Metal） | 可跑的 ③ |
| **用 `test-manga/test_0.webp` 跑一张真翻译** | 肉眼可见中文译文 + 单张耗时 + 内存峰值（`footprint`）+ 磁盘占用（`du`） |

**S0 验收**：
- [ ] 一张真实日文漫画图 → 落盘译文，**肉眼可见中文**（对应 E2）
- [ ] **反证**：`translator=none` 时译文 ≈ 原文（证明翻译阶段真的在起作用，不是渲染假象）
- [ ] `/docs` 快照入库；端口实测值写入文档（终结 README 的端口自相矛盾）
- [ ] 单张耗时 / 峰值内存 / 首次安装磁盘占用 → 回填《04》§11.4
- [ ] MPS 是否全算子支持（有无 CPU 回退）→ 结论写进文档

### S1 · 适配层对齐 —— ✅ **已完成（见 D-62）**

- 重写 `service/src/engine-client.mjs`：`translateImage` 签名**不变**，内部按快照对真实端点/字段映射；错误归一为 `EngineError{code}`；输出仍走 magic number 嗅探。
- `probeEngine()` **形状扩展**为 **9 字段**（`state/port/engine/engineVersion/tier/accel/warmed/llm/model`，S1 阶段后 6 个恒 `null` = "位置占好"，非"已实现"）。
- 启动参数拼装 —— ⚠️ **本节初稿的两处说法已被实测推翻**：
  ① 服务端**没有** `--config-file` / `--model-dir` 这两个参数（`shared` 生产模式的 config **按请求**传，见 D-61/D-62）；
  ② 启动形式是 **`python main.py` 且 cwd = `<engineDir>/server`**，**不是** `-m server.main`；执行器的 cwd 才是 `src/`。
  实际拼装 = `python main.py --host --port [--use-gpu] [--models-ttl N] [--nonce None]` + `SAKURA_API_BASE` 环境变量。

**验收（原文不变）**：`translateImage()` 对真实引擎返回真译文；`probeEngine()` 在引擎未启动/启动中/就绪三态下分别返回 `stopped` / `starting` / `running`（**三条都要有反证**）。
**实测结果**：`npm run check:engine-client` **32/0** · `--refute` **5/5 变红** ·
真引擎 `engine/scripts/s1-real-engine-check.mjs` 出真译文（12.4 s / 11 区域 / 三态时间线 `stopped(1 ms)→starting(4.5 s)→running(7.9 s)`）。

### S2 · 三进程生命周期 —— ✅ **已完成（macOS 侧；见 D-64…D-70）**

- ✅ `ServiceManager`：`Children{service, engine, llm}`；按进程类型分派 spawn（Node / Python 可执行 / llama-server）。
  ⚠️ **启动配方不在 Rust 里拼**：Rust 启动时问 `service/scripts/print-launch-plan.mjs` 要 JSON
  （`cmd/cwd/env/probes/watch/探针预算`）—— 引擎侧细节必须留在唯一耦合点（D-65）。
- ✅ 就绪探测 **三重判定**（进程存活 + 端口监听 + HTTP 应答），各自独立超时。
  **stdout 就绪行保留，但降级为"数据通道"**（拿动态端口与令牌），**不再是就绪判据**（D-64）。
- ✅ 五态机 `stopped → starting(L1/L2/L3) → running → stopping → stopped`。
  ⚠️ **`L4 首图惰性初始化` 不属启动期**（对本文初稿的**有意偏离**）：它发生在首次翻译请求时、
  由引擎侧表达；《03》§4.5 已定「引擎的准备/卸载/降档都不新增客户端状态机节点」⇒ 见 D-64。
- ✅ **跨端进程树回收**：unix 每个子进程进自己的**进程组**，退出时 SIGTERM 整组 → 3s → SIGKILL 整组；
  Windows `taskkill /T /F` + `CREATE_NEW_PROCESS_GROUP`。**已拍板（§7-⑤）：Windows 分支已写**，
  用 `#[cfg(windows)]` 隔离，**标记 `unverified`** —— 本机验不了，不得算作"已验"（G2 ④）。
- ✅ 崩溃影响分级：② 挂 ⇒ 任务失败 + `degraded`；③ 挂 ⇒ 仅翻译阶段失败。① 挂 ⇒ 整体 `error`。
  （后台看护线程每 1s 巡一次；**不静默**，两条路都写日志。）
- ✅ **E11 的手段**：父死看门狗**分两层** —— 我们自己的 Node 子进程在进程内装看管；
  外部二进制（python / llama-server）由 `engine/scripts/child-watch.mjs` 包一层。
  先排除的三个"看起来能用"的机制（stdin EOF / 进程组 / SIGTERM）见 D-66。

**验收（原文不变）**：E1（可拉起 + 日志打印生效参数快照）、E11（主进程 SIGKILL 后 ②③ 自行退出、
端口释放；Windows 无孤儿 —— **本机只能验 macOS 一半**）。

**实测结果**：
- `npm run selftest:app` —— **16/16**（含 `S2a` 轨迹 `starting→L1→L2→L3→running`、`S2b` 生效参数快照、
  `S2c` 三子进程 pid 齐备、`S2d` 外部杀掉 ③ 后 `state=running degraded=true`、`B4` 端口全释放）；
- `npm run selftest:app:e11` —— mock 三进程，SIGKILL 主进程后 **13 个端口**（5180–5190/5003/8080）全释放；
- `npm run selftest:app:e11:real` —— **真进程**：服务 + `python main.py`(8000) + 执行器(8001) + `llama-server`(8080)，
  SIGKILL 后 **14 个端口**全部释放、无孤儿；同一轮从应用 stdout 读回 E1 生效参数快照（真命令）。
- 反证：`selftest:app:e11:refute`（`MIAO_NO_PARENT_WATCH=1`）⇒ 三进程全成孤儿（断言变红）；
  `MIAO_NO_CRASH_MONITOR=1` ⇒ `S2d` 变红；`check:child-watch` / `:refute` 秒级双向钉死看守机制。

**未验（明确登记）**：Windows 三项（Job Object / `taskkill /T /F` / 无孤儿 `llama-server.exe`）——
本机无 Windows，标记 `unverified`。`MIAO_NO_TREE_KILL=1` 这条反证在 mock 下**咬不到东西**
（mock 没有孙进程），只有真模式才有效。

### S3 · 模型管理 —— ✅ **已完成（见 D-72）**

下载器（HTTPS 官方源 + 断点续传 + **逐文件 SHA256** + 失败单文件重下 + `.ready` 幂等标记 + 逐文件进度 + 可暂停/恢复）。**模型目录独立于 `app/`**，引擎换版本不触发模型重下。

**验收**：E7（下载中断后续传成功；篡改一字节 → SHA256 失败 → 自动重下）。

**落地**：
- 清单 `engine/models.manifest.json`（**版本控制**，取代此前散在 `tmp-engine-test/`（被 `.gitignore` 忽略）的取物脚本）：
  6 条资产 = 4 视觉模型 + Sakura 权重 + llama.cpp 归档，逐条带 `url` / `sources` / `sha256` / `sizeBytes`。
- 内核 `engine/model-store.mjs`（`ensureModels` / `verifyModels` / `linkModels`）；CLI `engine/scripts/fetch-models.mjs`。
- 🔴 **「引擎换版本不重下模型」不是靠摆放位置就能成立的** —— 回读源码：`utils/inference.py:94`
  `_MODEL_DIR = join(BASE_PATH,'models')`、`utils/generic.py:24-25` 推出 `BASE_PATH = <引擎>/src`，
  且 `server/args.py` **没有** `--model-dir`（只有 `manga_translator.py:298-299` 的 `params['model_dir']` 运行期钩子）
  ⇒ 视觉模型**必须**出现在 `<引擎>/src/models/<子目录>/`，而 `src/` 一换版本就会连模型一起被删。
  ⇒ 解法：**权威副本在 `models-store/`，引擎树里那几份是硬链接**；换版本后 `--link` 零网络恢复。
- 三个"看起来能用、其实会静默出错"的点已在代码里显式处理（Range 不回 206 ⇒ 必须重新计而不是追加；
  `Content-Length` 在续传时是"剩余长度"不是"总长度"；校验失败只许自动重下**一次**）。

**实测（2026-10-05）**：
- `npm run check:models` —— **32/32**；`check:models:refute` —— 反证 **5/5** 按预期变红。
- 真实清单：`fetch-models.mjs --check` → **6/6 通过**（含 3.3 GB Sakura 权重的 sha256 全部与盘上字节一致）；
  `--link` 幂等（第二次「新建 0 / 已是 4」）。
- 迁移取证：`src/models/` 里 4 份与 `models-store/` 里对应文件的 **inode 完全相同**（68779986 / 68780091 两两相同）⇒ 是真硬链接不是复制。
- 真引擎加载（迁移后必须重验 —— 迁的就是引擎按硬编码路径要加载的文件）：
  以 `translator=none` 跑 `manga_translator local`，**1.1 分钟**跑完整条流水线并出图到
  `out-linkcheck/test_0.webp`（EXIT=0）：`DefaultDetector` 检测 → `Model48pxOCR` **21 个文本框**
  （识别出真实日文）→ 掩码细化 → `LamaLarge` 擦除 1128×1600 → 渲染落盘
  ⇒ 三个被迁移的模型都从**硬链接路径**成功加载，迁移没有破坏引擎。

### S4 · 档位 / 加速 / 降档 / 空闲卸载 ✅ 已完成（D-73）

- 硬件探测 `HardwareProfile` + 映射表（**Metal `unified < 24 ⇒ Tiny`**；UI 不出 Medium；Small 标"不推荐"+强警告）。✅
- 加速后端探测顺序 CUDA → MPS → CPU；GPU 启动失败 **自动回退 CPU 并以 `degraded` 上报，不静默**。✅（探测与启动参数已落地+断言；"GPU 启动失败→回退"的**现场**属 S7 真机项）
- 降档重试：**仅一次**，**服务级**（后续所有 item 用新档），与 item 级重试**不叠加**。✅
- 两级空闲卸载：Tier1 LLM 5 min（box-service 管，③ 不在引擎 TTL 内）；Tier2 视觉 30 min（引擎自带 `--models-ttl 1800`）。**前置条件：队列空闲**（无 running、无 queued、距最后一次完成 ≥ 阈值）。✅
- 🔴 **③ 的归属权从 Rust 移交到 box-service**（《04》§9.1 与 S2 实现冲突；`print-launch-plan` 摘掉 `llm` 条目，Rust 只打印不拉起；E11 由 `child-watch` 保住）。见 D-73 决策 1。
- **「从不卸载」选项**：✅ **已由实测关闭**（§7-③）—— 真 ③ 冷启动实测 **1.0–2.8s**，落在判据的"恢复快 ⇒ 不做独立选项"一支；机制层保留 `阈值 0 = 从不卸载`，S6 只做数字（分钟）控件，文案用实测数字（"下次翻译多等约 1–3 秒"）。见 D-73。
- **「准备中」不给百分比**（已拍板 §7-④）：精确进度只在 Box 应用区展示，契约面（`/engine/status`）不出百分比字段。（S5/S6 落）

**验收**：E5（注入 OOM → 降一档重试一次成功 + 日志留痕）、E6（空闲阈值 → LLM 退出且端口释放；再提交 → 自动拉起成功）。
✅ `npm run check:e5e6` **13/0**；逃生开关反证 **2/2**（关掉降档 / 关掉空闲卸载，对应断言必红）。
判定层 `npm run check:profile` **42/0** + 反证 **13/13**。真机数字见 `node service/scripts/llm-real-timing.mjs`。

### S5 · 契约增量 ✅ 已完成（D-74）

- 新增错误码 `ENGINE_NOT_READY(503)`：引擎 `starting/prewarming/downloading` 时收到任务 → **不建单、不分配序号**（与 `UNAVAILABLE` 严格区分：后者是**进程不在**）。✅
- 新增 `MODEL_DOWNLOAD_FAILED(503)`（模型缺失 / 校验失败 → 引导**重下**，而不是引导**重启**）。✅
- `/health` 的 `sidecar` 扩到 **9 字段**（**向后兼容**：新增字段仅供 Box，插件不依赖）。✅
  ⚠️ 本节原写"8 字段" —— 逐数《03》§5.1 是 **9 个**顶层键：`state` / `port` / `engine` /
  **`engineVersion`** / `tier` / `model` / `accel` / `warmed` / `llm{state,port}`。缺的那个正是
  S5 才补上的 `engineVersion`（安装事实：`models.manifest.json:engineCommit` 短 sha）。
- 新增 `GET /engine/status`（**需鉴权**，插件不用）→ `{engine, llm, tier, accel, warmed, config, models, recentStageLog}`。✅
- **引擎的"准备/卸载/降档"都不新增客户端状态机节点**（《03》§4.5）。✅

**验收**：契约自测新增条目 + **反证**（把 `ENGINE_NOT_READY` 改成 `UNAVAILABLE` → 断言必须变红）。
✅ `npm run check:contract` **77/0**（8 个实例场景 A–H，真服务 + 按状态构造的假引擎）；
`check:contract:refute` **4/4** 逃生开关按预期变红。
配套 `npm run check:engine-client` 由 32 条扩到 **42/0**、反证 5→**8/8**（新增 C 组 4 条配置快照、
V 组 2 条阶段日志、P3b/P3c「安装事实 ≠ 进程事实」、P4b「uvicorn 未接客」）。

### S6 · Box UI —— ✅ **已完成（见 D-75）**

设置页 ②翻译服务 **10 项 / 三小节**（服务与配对 3 · 推理引擎 4 · 模型与诊断 3）+ **引擎诊断视图**（进程状态 / 生效配置 / 模型状态 / 阶段日志 / 三个操作）+ 「准备中」L1–L4 文案 + 「首张稍慢」。✅

- 「已配置」与「已生效」分两值（`tier.configured` / `tier.effective`）；`/engine/options` **每次现读盘**，
  不用启动时冻结的 `config.*`（否则"改完刷新"会把用户刚写的值读成旧值）。
- 两档空闲卸载**生效时机不同**（`idleLlmMin` 即时 / `idleVisionMin` 需重启）—— 提示条分开写，不合成一句。
- 模型下载做成**任务**：启动即返回 + 并发 **`409 DOWNLOAD_IN_PROGRESS`**（不是 200「已在下载中」）。
- X-C3 **不给百分比**（§7-④）：它只在 box-service 没起来时出现、此刻读不到 HTTP，
  所以判据反过来写 —— **不许出现硬编码进度字面量**，明细取真实日志末行。
- **L4 不属启动期**（D-64）：状态词单列为「首图时完成」，不用「待开始」。
- 🔴 顺带修掉一个**本轮之前就存在**的可见缺陷：catalog 里 108 处 `**重点**` 被原样渲染成两个星号
  （文案全部直接进 DOM，从无解析器）。修法 = 一个 `emphasis()` + **逐个渲染点接上** + 裸文本"不许出现"断言。

⚠️ 落地三坑（与音乐缓存那次同族）：① `sections.tsx` 在 catalog 与渲染不同步时**直接 `throw`** → 必须同时改两处；
② 设置项**总数有硬编码锚点断言**（本轮项数仍 **33**，锚点未变）→ 条数一变要同步 `SPEC_ITEM_TOTAL` + `AGENTS.md` + `README.md`；
③ `check:docs` 比对的是**脚本自报的通过数**，不是项数常量。

**验收**：`check:settings` **134/0** + 反证 **62/62** · `check:units` **37/0**（新增 `NumberInput.tsx` → MANIFEST 12）·
`check:engine-settings` **61/0** + 反证 **5/5** · `check:contract` **77/0**（`S5.7` 顶层键 8 → 9）·
`check:docs` **14/0** · `tsc --noEmit` 0 错。

### S7 · 真机端到端 E1–E11 —— ✅ **已完成（本机可验部分，见 D-76）**

沿用《04》§14.2，逐项区分**可自动断言**与**只能真机确认**。三个"只能真机"项要单独列（不计入"已完成"）：**MPS 下的实际观感与稳定性**、**模型下载 5–8 GB 的真实耗时**、**Windows 侧全部三项**。

**验收环境 = macOS（已拍板 §7-①）**；Windows 并入 M5 的 Windows 机器上做，本机不排。

**结果**：正向交付 = `docs/engine-e2e-acceptance-report.md`（E1–E11 逐条：结论速览 + 复现命令 + 逐项实测 +
**unverified register 10 条** + **环境陷阱 19 条**）。11 条里 **4 条 ✅ 全绿、7 条 ✅⚠️**（未验半边逐条登记，
**一条都不计入"已完成"**）。过程中照出并修掉 **6 个真缺陷**（4 实现 / 1 断言 / 1 工程脚本），全部**修实现、不放宽断言**。

### S8 · 插件串联（最后一公里）—— ✅ **已完成（见 D-77）**

按 §3.5 的 P-1…P-4 改插件，然后**在真引擎下复跑 E9**（插件提交 → 同一队列 / 同一落盘规则 / 序号连续）。
⚠️ **P-4 必须删**（`DEMO_BYPASS_SERVICE_READY`），否则「服务未就绪」这条路径永远绕过去了 —— 那不是"能跑"，是"没测"。

**结果**（代码在 `miao-trans` 仓）：单测 **201** · `verify` **27/27** · `noservice` 探针 **10/10** ·
反证 **3 条 + 4 项 FAIL**（各真跑变红后按 shasum 还原）；**真引擎下复跑 E9 = 19/0**
（真实漫画站 + 真引擎；序号 001–031 连续、串行不交错、31 项全成功）。

### 关键路径与并行

- **关键路径：S0 → S1 → S2 → (S5) → S7 → S8**。S1 必须在 S0 之后（快照是它的唯一依据），**不能先写适配层**。
- **可并行**：S3（模型管理）与 S2（生命周期）互不阻塞；S6（UI）只依赖 S5 的字段定义，可与 S7 前半并行。
- **不可并行**：`service/src/engine-client.mjs`、`app/src-tauri/src/service.rs`、`docs/spec-notes.md` 是共享写入点 —— 沿用本项目纪律**串行派发**。

### 每个阶段收尾必做

1. `npm run selftest` / `check:ia` / `check:tls` / `check:music:refute` / `check:settings:refute` / `check:units:refute` / `check:docs` 全绿；
2. **改 `scripts/e2e.mjs:492` 的 D4a 口径**（R6，早在 S1 就要做，不要留到 S7）；
3. 条数一变同步 `AGENTS.md` / `README.md`（`check:docs` 会对账，漂移即红）；
4. 台账回写 `docs/spec-notes.md`（D-xx 续号，当前到 D-74）；
5. 每个"机制类"断言配反证轮，**反证变红才算数**。

---

## 6. 建议先做的三件事（最小验证集）

如果要先把风险降到最低、再决定投入，按这个顺序做：

1. **S0 的第一步**：装一个 3.11/3.12 的 Python，`pip install manga-image-translator`，确认 **torch 能 import 且 MPS 可用**。
   → 这一步就能证伪 R1（最高风险），成本却是最小的。
2. **拉 Sakura Tiny + `llama-server`，用 `test-manga/test_0.webp` 跑通一张真翻译**，测出**单张耗时 + 峰值内存 + 磁盘占用**。
   → 这三个数一出来，S2–S7 的估时才有依据，R2/R3 立刻从"担心"变成"数字"。
3. **同步改 `scripts/e2e.mjs` 的 D4a**（把"20 张 30 秒"换成真实耗时区间）。
   → 避免换引擎那天，一条过时断言把正确改动报成失败（R6）。

---

## 7. 拍板结果

> 2026-10-05 用户拍板，5 项全部关闭。**组织与交付（分工 / 里程碑 / 交付物 / 验收流程）见 `docs/engine-integration-delivery-plan.md`。**

| # | 事项 | 拍板 | 落点 |
|---|---|---|---|
| ① | **引擎链路的首发验证平台** | ✅ **改 macOS 首发**。PD-3 的理由来自音乐模块的上游参考实现（Windows-only），与引擎无关；且 macOS 是唯一可实测环境（§2.3） | S7 验收环境 = macOS；Windows 作为第二平台并入 M5 |
| ② | 磁盘余量是否够首次安装 5–8 GB？（实测**数据卷 89 GB 可用**，余量充足） | ✅ **接受**。但**安装前显式提示预留空间**，且模型目录与代码分离（便于单独清理/迁移） | S0 闸门加"磁盘预检 + 提示" |
| ③ | 空闲卸载默认值是否照《04》§9.1？ | ✅ **照搬 5 min / 30 min**（(a) 已拍）。**「从不卸载」选项走"先实测后定"**（(b) 已拍）：S4 实测卸载后再加载的耗时，由结果决定是否暴露该选项 | S4 实现 + S4 产出一条实测数据供定夺 |
| ④ | 「准备中」是否给下载百分比？ | ✅ **不给**（沿插件侧已拍板），精确进度只在 Box 应用区展示 | 契约面：`/engine/status` 不做百分比字段 |
| ⑤ | 是否本轮就做 **Windows 侧代码**（Job Object / `taskkill /T /F` 等）？ | ✅ **写代码，但不验收**。本机验不了 → 代码带 `#[cfg(windows)]` 隔离，验收标记 `unverified` 留给有 Windows 机器时（避免"写了还以为验过了"） | S2 范围含 Windows 分支；S7 的 E11 Windows 项标记未验 |

### ③ 的两问与结论（已拍板 2026-10-05）

《04》§9.1 定义的是**两级空闲卸载**——目的是"不用的时候把内存还给系统"，代价是"下次用要重新加载、变慢"：

| 层级 | 卸什么 | 空闲多久触发 | 能省多少内存 | 谁来实现 |
|---|---|---|---|---|
| **Tier 1** | 停掉 Sakura LLM server（第 3 个进程） | **5 分钟** | 按档位：Tiny ≈ 1.5–2 GB / Small ≈ 5 GB / Medium ≈ 9–10 GB | box-service（引擎的 TTL 管不到这个独立进程） |
| **Tier 2** | 释放引擎自己的视觉模型 | **30 分钟** | ≈ 1–2 GB | 引擎自带参数 `--models-ttl 1800` |

三条配套规则（《04》§9.2–9.4）：

1. **只在队列空闲时才允许卸**（无 running、无 queued、距上次任务完成 ≥ 阈值）——否则会把"正在排队等着的 LLM"卸掉，下一个任务又得冷启动；
2. **卸载 ≠ 未就绪**——卸完服务仍是 `running`，`/health` 照常应答，只是下一次任务变慢。这两件事的用户文案必须分开；
3. 《04》还允许用户选 **「从不卸载」**（两级都关，占内存换速度）。

**结论（两问都已拍）**：

- **(a) 两个数值（5 分钟 / 30 分钟）照搬吗？** → ✅ **照搬**。它来自《04》的内存基线，我们手上没有更准的数据。
- **(b) 「从不卸载」这个选项，本轮就做吗？** → ✅ **不预先定，走"先实测后定"**。先按 (a) 实现卸载，在 S4 实测"卸载后再提交任务要等多久恢复"：**恢复快（几秒）⇒ 该选项是多余复杂度，不做；恢复慢（十几秒）⇒ 值得暴露给用户。** 由实测结果决定，不拍脑袋。

---

## 附：本次测试的可复现步骤

```bash
cd /Users/doro/code/self/forFun/miao-dock
pkill -f "engine/src/server.mjs"; pkill -f "service/src/server.mjs"
node tmp-engine-test/probe.mjs     # 期望输出「合计 14/14」
```

产物落在 `tmp-engine-test/`（`tmp-*/` 已在 `.gitignore`，不入库、不写用户真实图片目录）。

> **注意**：该探针验的是**服务层**。它跑绿**不代表**翻译可用 —— 落盘的译文是占位图（§4.1）。
