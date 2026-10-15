/**
 * 自测注册表（数据）—— `run-checks.mjs`（分层聚合 runner）与 `registry-check.mjs`
 * （注册表完整性钉子）共用的唯一事实源。
 *
 * ## 为什么拆成独立模块
 * 注册表若内联在 runner 里，完整性钉子就只能**正则解析 runner 源码**来读它 ——
 * 解析失败会表现为「假红」（格式一变就红），而解析太松又会漏（假绿）。
 * 拆成数据模块后钉子直接 import，无解析歧义。
 *
 * ## 字段
 *   id     唯一键（kebab-case）；反证轮条目为 `<id>-refute`（自动派生）
 *   script 相对仓库根的脚本路径
 *   args   附加参数（缺省无）
 *   tier   static（纯文件分析，可并行）| service（起真实进程，**串行**）|
 *          nightly（真引擎/模型，串行）| refute（反证轮，串行）
 *   refute true = 有 --refute 变体；传数组则用该数组作反证轮参数（如 e11）
 *   watch  --changed 的过滤 glob；缺省 = 任何变更都跑它（保守）
 *
 * ## 与命令清单（`e2eScripts.json`）的关系
 * 本文件是**分层路由**的唯一事实源（tier / watch / 反证轮的派生规则）；
 * 「这条命令叫什么、怎么跑」在 `e2eScripts.json`（`npm run task -- <id>`）。
 * 两侧的 id **不要求同名**（清单沿用 `npm run` 时代的名字：`check:units` / `selftest:service`…），
 * 靠 `(script, args)` 连接键对上，由 `registry-check.mjs` 双向断言 —— 名字可以各自演进，
 * "跑的东西是不是同一个"必须逐字节一致。
 *
 * 🔴 service 层为何恒串行：各脚本用 findFreePort 从**固定且互相重叠的区间**
 * （5300–5800）「先探测再绑定」拿端口。并行时两个脚本可能同时探到同一端口空闲、
 * 随后都去 bind——轻则起不来，重则 A 的请求打到 B 的服务上，**产出交叉污染的
 * 假结果**。这是正确性问题，不是性能问题：宁慢，不串。
 */
export const TIER_ORDER = ['static', 'service', 'nightly', 'refute'];
export const TIER_CONCURRENCY = { static: 8, service: 1, nightly: 1, refute: 1 };
export const TIER_TIMEOUT_MS = { static: 300_000, service: 900_000, nightly: 1_800_000, refute: 1_800_000 };

const CHECKS = [
  // ---- static：纯文件分析，可并行 ----
  {
    id: 'units',
    script: 'e2e/units-structure-check.mjs',
    tier: 'static',
    refute: true,
    watch: ['src/**', 'e2e/units-structure-check.mjs'],
  },
  {
    id: 'ia',
    script: 'e2e/ia-structure-check.mjs',
    tier: 'static',
    watch: ['src/**', 'e2e/ia-structure-check.mjs'],
  },
  {
    id: 'music',
    script: 'e2e/music-platform-check.mjs',
    tier: 'static',
    refute: true,
    watch: ['src/**', 'src-tauri/src/music/**', 'e2e/music-platform-check.mjs'],
  },
  {
    id: 'settings',
    script: 'e2e/settings-media-check.mjs',
    tier: 'static',
    refute: true,
    // `e2eScripts.json`：FEATURES.gen.script 判的是「gen:licenses 有没有地方注册着」（清单是其一）
    watch: ['src/**', 'src-tauri/src/mangasvc/engine/**', 'e2eScripts.json', 'e2e/settings-media-check.mjs'],
  },
  {
    id: 'quit',
    script: 'e2e/quit-command-check.mjs',
    tier: 'static',
    refute: true,
    watch: ['src-tauri/**', 'e2e/quit-command-check.mjs'],
  },
  {
    id: 'docpaths',
    script: 'e2e/docs-path-check.mjs',
    tier: 'static',
    refute: true,
    watch: ['**/*.md', 'docs/**', 'e2e/docs-path-check.mjs'],
  },
  {
    id: 'docs',
    script: 'e2e/docs-consistency-check.mjs',
    tier: 'static',
    // 命令收束后「文档引用的命令是否存在」要同时对 package.json 与 e2eScripts.json 判 ⇒ 清单进 watch
    watch: ['**/*.md', 'docs/**', 'package.json', 'e2eScripts.json', 'e2e/docs-consistency-check.mjs'],
  },
  {
    id: 'bundle',
    script: 'e2e/bundle-targets-check.mjs',
    tier: 'static',
    refute: true,
    watch: ['**', 'e2e/bundle-targets-check.mjs'],
  },
  {
    id: 'packaged',
    script: 'e2e/packaged-smoke.mjs',
    tier: 'nightly',
    refute: true,
    watch: [
      'src-tauri/tauri.conf.json',
      'src-tauri/tauri.windows.conf.json',
      'src-tauri/src/paths.rs',
      'src-tauri/src/service.rs',
      'e2e/packaged-smoke.mjs',
    ],
  },
  {
    id: 'resources',
    script: 'e2e/resources-check.mjs',
    tier: 'static',
    refute: true,
    watch: [
      'src-tauri/src/paths.rs',
      'src-tauri/src/service.rs',
      'src-tauri/src/bin/mangasvc.rs',
      'src-tauri/tauri.conf.json',
      'e2e/resources-check.mjs',
    ],
  },
  {
    id: 'harness',
    script: 'e2e/service/harness-check.mjs',
    tier: 'static',
    refute: true,
    watch: ['e2e/service/**', 'src-tauri/src/**'],
  },
  {
    id: 'tls',
    script: 'e2e/tls-check.mjs',
    tier: 'static',
    watch: ['src-tauri/**', 'src-tauri/src/**', 'engine/**', 'e2e/tls-check.mjs'],
  },
  {
    id: 'registry',
    script: 'e2e/registry-check.mjs',
    tier: 'static',
    refute: true,
    // 收束之后它守的是**三方**：package.json（三类入口白名单）· e2eScripts.json（命令清单）· 本注册表
    watch: [
      'package.json',
      'e2eScripts.json',
      'e2e/_commands.mjs',
      'e2e/_check-registry.mjs',
      'e2e/registry-check.mjs',
    ],
  },

  // ---- service：起真实子进程，串行（端口竞争，见文件头）----
  { id: 'e2e', script: 'e2e/e2e.mjs', tier: 'service', watch: ['src-tauri/src/**', 'engine/src/**', 'e2e/**'] },
  {
    id: 'paths',
    script: 'e2e/service/paths-parity-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/paths.rs',
      'e2e/service/golden/paths-selftest.json',
      'e2e/service/_gen-golden.mjs',
      'e2e/service/_paths-report.mjs',
      'e2e/service/paths-parity-check.mjs',
    ],
  },
  {
    id: 'runtime-probe',
    script: 'e2e/service/runtime-probe-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/runtime_probe.rs',
      'src-tauri/src/mangasvc/engine/patches.rs',
      'src-tauri/src/mangasvc/routes.rs',
      'src-tauri/src/mangasvc/handlers.rs',
      'engine/scripts/setup-engine.mjs',
      'e2e/service/runtime-probe-check.mjs',
    ],
  },
  {
    id: 'path-single-source',
    script: 'e2e/service/path-single-source-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/paths.rs',
      'src-tauri/src/mangasvc/engine/runtime_probe.rs',
      'src-tauri/src/mangasvc.rs',
      'e2e/service/path-single-source-check.mjs',
    ],
  },
  {
    id: 'launch-gate',
    script: 'e2e/service/launch-gate-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/service.rs',
      'src-tauri/src/mangasvc/engine/runtime_probe.rs',
      'src-tauri/src/bin/mangasvc.rs',
      'e2e/service/launch-gate-check.mjs',
    ],
  },
  {
    id: 'install-guide',
    script: 'e2e/service/install-guide-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'docs/install-guide-windows.md',
      'docs/install-guide-macos.md',
      'engine/models.manifest.json',
      'src-tauri/src/paths.rs',
      'package.json',
      'e2eScripts.json',
      'e2e/service/install-guide-check.mjs',
    ],
  },
  {
    id: 'notready-state',
    script: 'e2e/service/notready-state-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/service.rs',
      'src-tauri/src/mangasvc/engine/state.rs',
      'src/screens/NotReadyScreen.tsx',
      'src/ipc.ts',
      'src/App.tsx',
      'e2e/service/notready-state-check.mjs',
    ],
  },
  {
    id: 'models-guide',
    script: 'e2e/service/models-guide-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/model_status.rs',
      'src-tauri/src/mangasvc/engine/model_store.rs',
      'src-tauri/src/bin/mangasvc.rs',
      'src/screens/settings/EngineDiag.tsx',
      'src/screens/settings/engine-api.ts',
      'engine/models.manifest.json',
      'e2e/service/models-guide-check.mjs',
    ],
  },
  {
    id: 'size-guide',
    script: 'e2e/service/size-guide-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/model_status.rs',
      'src-tauri/src/mangasvc/engine/model_store.rs',
      'src-tauri/src/bin/mangasvc.rs',
      'src/screens/settings/EngineDiag.tsx',
      'src/screens/settings/engine-api.ts',
      'src/styles/settings.scss',
      'engine/models.manifest.json',
      'docs/install-guide-windows.md',
      'docs/install-guide-macos.md',
      'e2e/service/size-guide-check.mjs',
    ],
  },
  {
    id: 'model-runner',
    script: 'e2e/service/model-runner-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/state.rs',
      'src-tauri/src/mangasvc/engine/model_store.rs',
      'src-tauri/src/mangasvc/engine/fetch_models.rs',
      'src-tauri/src/mangasvc/handlers.rs',
      'src-tauri/src/service.rs',
      'e2e/service/model-runner-check.mjs',
    ],
  },
  {
    id: 'platform-guide',
    script: 'e2e/service/platform-guide-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/model_store.rs',
      'src-tauri/src/mangasvc/engine/model_status.rs',
      'src-tauri/src/mangasvc/engine/fetch_models.rs',
      'engine/models.manifest.json',
      'e2e/service/platform-guide-check.mjs',
    ],
  },
  {
    id: 'macos-compat',
    script: 'e2e/service/macos-compat-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/paths.rs',
      'engine/scripts/install-engine-deps.mjs',
      'docs/install-guide-macos.md',
      'docs/install-guide-windows.md',
      'README.md',
      'e2e/service/install-guide-check.mjs',
      'e2e/service/macos-compat-check.mjs',
    ],
  },
  {
    id: 'macos-signing',
    script: 'e2e/service/macos-signing-check.mjs',
    tier: 'static',
    refute: true,
    watch: [
      'src-tauri/entitlements.plist',
      'src-tauri/tauri.conf.json',
      'scripts/mac-signing-preflight.mjs',
      // W7 判的是「sign:preflight 登记着 + app:build:mac 串上了它」：
      // 前者在 e2eScripts.json，后者在 package.json，两处都得进 watch
      'package.json',
      'e2eScripts.json',
      'docs/spec-notes-1.md',
      'e2e/service/macos-signing-check.mjs',
    ],
  },
  {
    id: 'progress-truth',
    script: 'e2e/service/progress-truth-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src/screens/NotReadyScreen.tsx',
      'src-tauri/src/mangasvc/engine/state.rs',
      'src-tauri/src/ipc.ts',
      'src/App.tsx',
      'e2e/service/progress-truth-check.mjs',
    ],
  },
  {
    id: 'offline-fallback',
    script: 'e2e/service/offline-fallback-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine.rs',
      'src-tauri/src/mangasvc/engine/model_store.rs',
      'src-tauri/src/mangasvc/engine/fetch_models.rs',
      'e2e/service/offline-fallback-check.mjs',
    ],
  },
  {
    id: 'store',
    script: 'e2e/service/store-parity-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/store.rs',
      'src-tauri/src/mangasvc/store/**',
      'e2e/service/golden/store-selftest.json',
      'e2e/service/store-parity-check.mjs',
    ],
  },
  {
    id: 'store-exec',
    script: 'e2e/service/store-exec-parity-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/store/**',
      'e2e/service/golden/store-exec-selftest.json',
      'e2e/service/_gen-golden.mjs',
      'e2e/service/_store-exec-report.mjs',
      'e2e/service/store-exec-parity-check.mjs',
    ],
  },
  {
    id: 'routes',
    script: 'e2e/service/routes-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc.rs',
      'src-tauri/src/mangasvc/routes.rs',
      'src-tauri/src/mangasvc/handlers.rs',
      'e2e/service/routes-check.mjs',
    ],
  },
  {
    id: 'engine-parity',
    script: 'e2e/service/engine-parity-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine.rs',
      'src-tauri/src/mangasvc/engine/**',
      'e2e/service/golden/engine-selftest.json',
      'e2e/service/_gen-golden.mjs',
      'e2e/service/engine-parity-check.mjs',
    ],
  },
  {
    id: 'engine-http',
    script: 'e2e/service/engine-http-parity-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/**',
      'engine/src/png.mjs',
      'e2e/service/golden/engine-http-selftest.json',
      'e2e/service/_gen-golden.mjs',
      'e2e/service/_engine-http-report.mjs',
      'e2e/service/engine-http-parity-check.mjs',
    ],
  },
  {
    id: 'llm-supervisor',
    script: 'e2e/service/llm-supervisor-parity-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/supervisor.rs',
      'engine/src/mock-llm.mjs',
      'e2e/service/golden/llm-selftest.json',
      'e2e/service/_gen-golden.mjs',
      'e2e/service/_llm-report.mjs',
      'e2e/service/llm-supervisor-parity-check.mjs',
    ],
  },
  {
    id: 'drain-runtime',
    script: 'e2e/service/drain-runtime-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/drain.rs',
      'src-tauri/src/mangasvc/store/exec.rs',
      'e2e/service/drain-runtime-check.mjs',
    ],
  },
  { id: 'svc-selftest', script: 'e2e/service/selftest.mjs', tier: 'service', watch: ['src-tauri/src/**'] },
  { id: 'eng-selftest', script: 'e2e/engine/selftest.mjs', tier: 'service', watch: ['engine/src/**'] },
  {
    id: 'lifespan',
    script: 'e2e/lifespan-selftest.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**', 'src-tauri/**'],
  },
  {
    id: 'lib-manage',
    script: 'e2e/service/library-manage-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**'],
  },
  // ⚠️ watch 已从 `src-tauri/src/**` + `engine/src/**` 收窄到**翻译域**（F5.5 换靶）：
  //    断言面 = `mangasvc::translate::**`（门面/设置/密钥/错误/协议） + 5 条路由（handlers/routes）
  //    + 纯逻辑面的冻结金标与生成器。继续挂着整个 src 会让任何一处无关改动都重跑这一组
  //    （而它要起 8 个反证子进程、每个再 spawn 几十个 mangasvc 用例）。
  {
    id: 'translate',
    script: 'e2e/service/translate-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/translate/**',
      'src-tauri/src/mangasvc/handlers.rs',
      'src-tauri/src/mangasvc/routes.rs',
      'e2e/service/golden/translate-selftest.json',
      'e2e/service/_gen-golden.mjs',
      'e2e/service/translate-check.mjs',
    ],
  },

  {
    id: 'launch-plan',
    script: 'e2e/service/launch-plan-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**', 'src-tauri/**'],
  },
  // ⚠️ watch 收窄到**档位/加速/看守判定**所在的三个落点 + 纯判定面的金标（F5.5 换靶）：
  //    断言面 = `profile.rs`（H/T/A/D/I 判定）+ `supervisor.rs`（L 组 `--llm-selftest` 场景表）
  //    + `golden/llm-selftest.json`（真进程取证的金标）。挂着整个 src 会让无关改动重跑这一组。
  {
    id: 'profile',
    script: 'e2e/service/engine-profile-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/profile.rs',
      'src-tauri/src/mangasvc/engine/supervisor.rs',
      'src-tauri/src/mangasvc/engine/state.rs',
      'e2e/service/golden/llm-selftest.json',
      'e2e/service/_llm-report.mjs',
      'e2e/service/engine-profile-check.mjs',
    ],
  },
  {
    id: 'engine-settings',
    script: 'e2e/service/engine-settings-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**', 'src/screens/settings/**'],
  },
  {
    id: 'e5e6',
    script: 'e2e/service/e5-e6-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**', 'engine/src/**'],
  },
  // ⚠️ e4 / e8 / e10 / stall / retry 的 watch 已从 `service/src/**` 改为 **Rust 源码**：
  //    本轮把它们的取证与反证锚点都搬进了 Rust 侧（改完必须 cargo build），
  //    若 watch 还指着 Node 源码 ⇒「改了 Rust 却不重跑这些检查」= 静默漏跑。
  {
    id: 'e4',
    script: 'e2e/service/e4-tier-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine.rs',
      'src-tauri/src/mangasvc/engine/state.rs',
      'src-tauri/src/mangasvc/engine/supervisor.rs',
      'e2e/service/e4-tier-check.mjs',
    ],
  },
  {
    id: 'e8',
    script: 'e2e/service/e8-accel-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/profile.rs',
      'src-tauri/src/mangasvc/engine/state.rs',
      'engine/src/**',
      'e2e/service/e8-accel-check.mjs',
    ],
  },
  {
    id: 'e10',
    script: 'e2e/service/e10-security-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/mangasvc.rs', 'src-tauri/src/mangasvc/**', 'e2e/service/e10-security-check.mjs'],
  },
  {
    id: 'stall',
    script: 'e2e/service/stall-guard-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/store/exec.rs',
      'src-tauri/src/mangasvc/engine/client.rs',
      'e2e/service/stall-guard-check.mjs',
    ],
  },
  {
    id: 'retry',
    script: 'e2e/service/queue-retry-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/handlers.rs',
      'src-tauri/src/mangasvc/store/exec.rs',
      'src/App.tsx',
      'e2e/service/queue-retry-check.mjs',
    ],
  },
  {
    id: 'retranslate',
    script: 'e2e/service/retranslate-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**'],
  },
  {
    id: 'resilience',
    script: 'e2e/service/resilience-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**'],
  },
  {
    id: 'contract',
    script: 'e2e/service/contract-delta-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**', 'engine/src/**'],
  },
  {
    id: 'child-watch',
    script: 'e2e/child-watch-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'src-tauri/src/child_watch.rs',
      'src-tauri/src/service.rs',
      'src-tauri/src/mangasvc/engine/supervisor.rs',
      'engine/scripts/child-watch.mjs',
    ],
  },
  {
    id: 'child-watch-kill',
    script: 'e2e/child-watch-kill-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/child_watch.rs', 'engine/scripts/child-watch.mjs'],
  },
  {
    id: 'stdio',
    script: 'e2e/child-output-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**', 'src-tauri/**'],
  },
  {
    id: 'autostart',
    script: 'e2e/service-autostart-check.mjs',
    tier: 'service',
    refute: true,
    watch: ['src-tauri/src/**', 'src-tauri/**'],
  },
  // A3d 起是**双靶**（Node 对照端 + Rust 移植）⇒ 两侧源码都得进 watch，少一边就是"改了不红"。
  {
    id: 'models',
    script: 'e2e/engine/model-store-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'engine/model-store.mjs',
      'engine/scripts/fetch-models.mjs',
      'src-tauri/src/mangasvc/engine/model_store.rs',
      'src-tauri/src/mangasvc/engine/fetch_models.rs',
    ],
  },
  {
    id: 'patches',
    script: 'e2e/engine/engine-patches-check.mjs',
    tier: 'service',
    refute: true,
    watch: [
      'engine/scripts/**',
      'src-tauri/src/mangasvc/engine/patches.rs',
      'src-tauri/src/bin/mangasvc.rs',
      'e2e/engine/engine-patches-check.mjs',
    ],
  },
  // D3 / B4：纯文件 + 短 CLI（真 tar / `--print-plan`），不起服务、不占端口 ⇒ static 层并行跑
  {
    id: 'extract-atomic',
    script: 'e2e/engine/extract-atomic-check.mjs',
    tier: 'static',
    refute: true,
    watch: [
      'engine/scripts/atomic-extract.mjs',
      'engine/scripts/setup-engine.mjs',
      'e2e/engine/extract-atomic-check.mjs',
    ],
  },
  {
    id: 'pydensecrf-wheel',
    script: 'e2e/engine/pydensecrf-wheel-check.mjs',
    tier: 'static',
    refute: true,
    watch: [
      'engine/wheels.manifest.json',
      'engine/scripts/install-engine-deps.mjs',
      'docs/install-guide-windows.md',
      'docs/install-guide-macos.md',
      'e2e/engine/pydensecrf-wheel-check.mjs',
    ],
  },
  // W16 拿 `engine/VERSIONS.lock` §1 当事实源对拍清单里的 URL ⇒ 那份锁改了也必须重跑本门。
  {
    id: 'engine-bootstrap',
    script: 'e2e/service/engine-bootstrap-check.mjs',
    tier: 'static',
    refute: true,
    watch: [
      'engine/runtime.manifest.json',
      'engine/VERSIONS.lock',
      'engine/wheels.manifest.json',
      'engine/models.manifest.json',
      'src-tauri/src/mangasvc/handlers.rs',
      'src-tauri/src/mangasvc/engine/state.rs',
      'src-tauri/src/mangasvc/engine/runtime_setup.rs',
      'src/engine-download.ts',
      'src/screens/NotReadyScreen.tsx',
      'src/screens/engine/DownloadPanel.tsx',
      'src/screens/settings/OnlineApiForm.tsx',
      'src/components/units/ProgressRing.tsx',
      'e2e/service/engine-bootstrap-check.mjs',
    ],
  },

  // ---- nightly：真实引擎 / 模型，分钟级，串行 ----
  {
    id: 'e3-real',
    script: 'e2e/engine/e3-real-full-chain-check.mjs',
    tier: 'nightly',
    watch: ['engine/**', 'src-tauri/src/**'],
  },
  {
    id: 'e7-real',
    script: 'e2e/engine/e7-real-verify-check.mjs',
    tier: 'nightly',
    refute: true,
    watch: ['engine/**', 'src-tauri/src/**'],
  },
  {
    id: 'e11',
    script: 'e2e/lifespan-selftest.mjs',
    args: ['--e11'],
    tier: 'nightly',
    refute: ['--e11', '--refute'],
    watch: ['src-tauri/src/**', 'src-tauri/**'],
  },
  {
    id: 'e11-real',
    script: 'e2e/lifespan-selftest.mjs',
    args: ['--e11', '--mode', 'real'],
    tier: 'nightly',
    watch: ['src-tauri/src/**', 'src-tauri/**'],
  },
  // B4：**真装一次** wheel（`--no-index --no-deps` 成功 + 真二进制 + 构造 DenseCRF）。
  // 硬前置：盘上得有一颗 `--build-wheel` 产出的 wheel ⇒ 只在跑过构建的机器上有意义，故归 nightly。
  {
    id: 'pydensecrf-wheel-install',
    script: 'e2e/engine/pydensecrf-wheel-install-check.mjs',
    tier: 'nightly',
    watch: [
      'engine/wheels.manifest.json',
      'engine/scripts/install-engine-deps.mjs',
      'e2e/engine/pydensecrf-wheel-install-check.mjs',
    ],
  },
  // C4：**真引擎**在 HF 离线旗标下跑通一张真翻译（要真权重 + 真引擎 ⇒ 分钟级，nightly）。
  {
    id: 'offline-real',
    script: 'e2e/service/offline-real-check.mjs',
    tier: 'nightly',
    watch: [
      'src-tauri/src/mangasvc/engine.rs',
      'src-tauri/src/mangasvc/engine/state.rs',
      'src-tauri/src/service.rs',
      'engine/models.manifest.json',
      'e2e/service/offline-real-check.mjs',
    ],
  },
  // E3：**真安装器**跑一次静默卸载 ⇒ 验「不挂住」+「不碰用户自装的运行时 / 作品目录」。
  {
    id: 'uninstall-keep',
    script: 'e2e/bundle-uninstall-keep-check.mjs',
    tier: 'nightly',
    watch: ['src-tauri/nsis/**', 'src-tauri/tauri.windows.conf.json', 'e2e/bundle-uninstall-keep-check.mjs'],
  },
  // G4：**夹具版真装配** —— 真跑产品自己的 `mangasvc --engine-bootstrap`：
  //   两批 pip 的顺序与各自成功、随包 wheel 端到端（自检①真 import）、兼容补丁落 venv、
  //   按 dest 解包、建链、长路径体检、就绪标记。
  //   硬前置：`cargo build --bin mangasvc` + 本机跑过 `setup:engine` ⇒ 只在开发机上有意义，故归 nightly。
  {
    id: 'engine-bootstrap-real',
    script: 'e2e/engine/engine-bootstrap-real-check.mjs',
    tier: 'nightly',
    refute: true,
    watch: [
      'src-tauri/src/mangasvc/engine/**',
      'engine/runtime.manifest.json',
      'engine/models.manifest.json',
      'engine/wheels.manifest.json',
      'engine/wheels/**',
      'e2e/engine/engine-bootstrap-real-check.mjs',
    ],
  },
];

/**
 * 派生反证轮条目：`<id>-refute`，归 refute 层。
 * 派生而非手写：漏一条 `refute: true` 就会被 registry-check 的覆盖断言抓到
 * （npm 有 `check:X:refute` 而注册表无对应项 ⇒ 红）。
 */
export function buildRegistry() {
  const all = [...CHECKS];
  for (const c of CHECKS) {
    if (!c.refute) continue;
    all.push({
      id: `${c.id}-refute`,
      script: c.script,
      args: Array.isArray(c.refute) ? c.refute : ['--refute'],
      tier: 'refute',
      watch: c.watch,
    });
  }
  return all;
}
