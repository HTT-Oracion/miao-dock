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
  { id: 'units', script: 'e2e/units-structure-check.mjs', tier: 'static', refute: true, watch: ['app/src/**', 'e2e/units-structure-check.mjs'] },
  { id: 'ia', script: 'e2e/ia-structure-check.mjs', tier: 'static', watch: ['app/src/**', 'e2e/ia-structure-check.mjs'] },
  { id: 'music', script: 'e2e/music-platform-check.mjs', tier: 'static', refute: true, watch: ['app/src/**', 'service/src/music/**', 'e2e/music-platform-check.mjs'] },
  { id: 'settings', script: 'e2e/settings-media-check.mjs', tier: 'static', refute: true, watch: ['app/src/**', 'service/src/settings/**', 'e2e/settings-media-check.mjs'] },
  { id: 'quit', script: 'e2e/quit-command-check.mjs', tier: 'static', refute: true, watch: ['app/src-tauri/**', 'e2e/quit-command-check.mjs'] },
  { id: 'docpaths', script: 'e2e/docs-path-check.mjs', tier: 'static', refute: true, watch: ['**/*.md', 'docs/**', 'e2e/docs-path-check.mjs'] },
  { id: 'docs', script: 'e2e/docs-consistency-check.mjs', tier: 'static', watch: ['**/*.md', 'docs/**', 'package.json', 'e2e/docs-consistency-check.mjs'] },
  { id: 'bundle', script: 'e2e/bundle-targets-check.mjs', tier: 'static', refute: true, watch: ['app/**', 'e2e/bundle-targets-check.mjs'] },
  { id: 'layering', script: 'e2e/service/layering-check.mjs', tier: 'static', refute: true, watch: ['service/src/**', 'e2e/service/layering-check.mjs'] },
  { id: 'harness', script: 'e2e/service/harness-check.mjs', tier: 'static', refute: true, watch: ['e2e/service/**', 'app/src-tauri/src/**'] },
  { id: 'tls', script: 'e2e/tls-check.mjs', tier: 'static', watch: ['app/src-tauri/**', 'service/src/**', 'engine/**', 'e2e/tls-check.mjs'] },
  { id: 'registry', script: 'e2e/registry-check.mjs', tier: 'static', refute: true, watch: ['package.json', 'e2e/_check-registry.mjs', 'e2e/registry-check.mjs'] },

  // ---- service：起真实子进程，串行（端口竞争，见文件头）----
  { id: 'e2e', script: 'e2e/e2e.mjs', tier: 'service', watch: ['service/src/**', 'engine/src/**', 'e2e/**'] },
  { id: 'paths', script: 'e2e/service/paths-parity-check.mjs', tier: 'service', refute: true, watch: ['app/src-tauri/src/paths.rs', 'service/src/config.mjs'] },
  { id: 'store', script: 'e2e/service/store-parity-check.mjs', tier: 'service', refute: true, watch: ['app/src-tauri/src/boxsvc/store.rs', 'app/src-tauri/src/boxsvc/store/**', 'service/src/manga/store.mjs', 'e2e/service/store-parity-check.mjs'] },
  { id: 'engine-parity', script: 'e2e/service/engine-parity-check.mjs', tier: 'service', refute: true, watch: ['app/src-tauri/src/boxsvc/engine.rs', 'app/src-tauri/src/boxsvc/engine/**', 'service/src/engine-client.mjs', 'e2e/service/engine-parity-check.mjs'] },
  { id: 'engine-http', script: 'e2e/service/engine-http-parity-check.mjs', tier: 'service', refute: true, watch: ['app/src-tauri/src/boxsvc/engine/**', 'service/src/engine-client.mjs', 'e2e/service/engine-http-parity-check.mjs'] },
  { id: 'svc-selftest', script: 'e2e/service/selftest.mjs', tier: 'service', watch: ['service/src/**'] },
  { id: 'eng-selftest', script: 'e2e/engine/selftest.mjs', tier: 'service', watch: ['engine/src/**'] },
  { id: 'lifespan', script: 'e2e/lifespan-selftest.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'app/src-tauri/**'] },
  { id: 'lib-manage', script: 'e2e/service/library-manage-check.mjs', tier: 'service', refute: true, watch: ['service/src/**'] },
  { id: 'translate', script: 'e2e/service/translate-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'engine/src/**'] },
  { id: 'engine-client', script: 'e2e/service/engine-client-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'engine/src/**'] },
  { id: 'launch-plan', script: 'e2e/service/launch-plan-check.mjs', tier: 'service', watch: ['service/src/**', 'app/src-tauri/**'] },
  { id: 'profile', script: 'e2e/service/engine-profile-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'engine/src/**'] },
  { id: 'engine-settings', script: 'e2e/service/engine-settings-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'app/src/screens/settings/**'] },
  { id: 'e5e6', script: 'e2e/service/e5-e6-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'engine/src/**'] },
  { id: 'e4', script: 'e2e/service/e4-tier-check.mjs', tier: 'service', refute: true, watch: ['service/src/**'] },
  { id: 'e8', script: 'e2e/service/e8-accel-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'engine/src/**'] },
  { id: 'e10', script: 'e2e/service/e10-security-check.mjs', tier: 'service', refute: true, watch: ['service/src/**'] },
  { id: 'stall', script: 'e2e/service/stall-guard-check.mjs', tier: 'service', refute: true, watch: ['service/src/**'] },
  { id: 'retry', script: 'e2e/service/queue-retry-check.mjs', tier: 'service', refute: true, watch: ['service/src/**'] },
  { id: 'retranslate', script: 'e2e/service/retranslate-check.mjs', tier: 'service', refute: true, watch: ['service/src/**'] },
  { id: 'resilience', script: 'e2e/service/resilience-check.mjs', tier: 'service', refute: true, watch: ['service/src/**'] },
  { id: 'contract', script: 'e2e/service/contract-delta-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'engine/src/**'] },
  { id: 'child-watch', script: 'e2e/child-watch-check.mjs', tier: 'service', refute: true, watch: ['service/src/parent-watch.mjs', 'app/src-tauri/**'] },
  { id: 'child-watch-kill', script: 'e2e/child-watch-kill-check.mjs', tier: 'service', refute: true, watch: ['service/src/parent-watch.mjs', 'app/src-tauri/**'] },
  { id: 'stdio', script: 'e2e/child-output-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'app/src-tauri/**'] },
  { id: 'autostart', script: 'e2e/service-autostart-check.mjs', tier: 'service', refute: true, watch: ['service/src/**', 'app/src-tauri/**'] },
  { id: 'models', script: 'e2e/engine/model-store-check.mjs', tier: 'service', refute: true, watch: ['engine/**', 'models-store/**'] },
  { id: 'patches', script: 'e2e/engine/engine-patches-check.mjs', tier: 'service', refute: true, watch: ['engine/scripts/**', 'engine/patches/**'] },

  // ---- nightly：真实引擎 / 模型，分钟级，串行 ----
  { id: 'e3-real', script: 'e2e/engine/e3-real-full-chain-check.mjs', tier: 'nightly', watch: ['engine/**', 'service/src/**'] },
  { id: 'e7-real', script: 'e2e/engine/e7-real-verify-check.mjs', tier: 'nightly', refute: true, watch: ['engine/**', 'service/src/**'] },
  { id: 'e11', script: 'e2e/lifespan-selftest.mjs', args: ['--e11'], tier: 'nightly', refute: ['--e11', '--refute'], watch: ['service/src/**', 'app/src-tauri/**'] },
  { id: 'e11-real', script: 'e2e/lifespan-selftest.mjs', args: ['--e11', '--mode', 'real'], tier: 'nightly', watch: ['service/src/**', 'app/src-tauri/**'] },
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
