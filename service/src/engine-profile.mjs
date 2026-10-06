// 硬件探测 / 档位映射 / 加速后端 —— 《04》§7 在服务层的落地点
//
// 契约依据（按证据强度排序）：
//   ① 《04》§7.1 `HardwareProfile` 结构 · §7.2 **档位映射表** · §7.3 加速后端 · §7.4 探测顺序与降级
//   ② 《02》§5 设置页「推理引擎」：档位单选 Tiny/Small/Medium，**物理不可行档位不出现**、
//      Small 保留但标「不推荐」+ 选中强警告；档位旁显示该档**预估内存**
//   ③ 《03》§5.1 `sidecar.tier`（`tiny|small|medium`）/ `sidecar.accel`（`cuda|mps|cpu`）枚举
//
// 为什么单独成文件：本模块是「硬件事实 → 档位/后端决策」的**唯一**推理处。
//   把它塞进 `engine-client.mjs`（那个文件是「box-service ↔ 引擎」的唯一耦合点，
//   只该放引擎协议细节）会让「换台机器换档位」这条逻辑散进协议代码里。
//
// 🔴 两条纪律（本文件为断言与反证而设计）：
//   ① **全部纯函数、导入零副作用** —— 硬件事实由 `deps` 注入。否则「16GB Mac 落 Tiny」
//      这条断言只能在那台 Mac 上跑，换台机器就变成假绿（恰好也是 Tiny）或假红。
//   ② **映射表逐行照抄《04》§7.2**，不做"顺手优化"。§7.2 的 `else` 分支本身就是
//      把「Medium 在 16GB Mac 上不可行」**升级成了映射逻辑的一部分** —— 改它 = 改契约。
import { execFileSync } from 'node:child_process';
import os from 'node:os';

/** 档位枚举（顺序 = 设置页展示顺序，由低到高） */
export const TIERS = ['tiny', 'small', 'medium'];
/** 加速后端枚举（《03》§5.1 `sidecar.accel`） */
export const ACCELS = ['cuda', 'mps', 'cpu'];
/** 用户可选清单的完整取值（含 `auto`）—— 只在反证开关下会全量出现 */
export const ACCELS_WITH_AUTO = ['auto', 'cuda', 'mps', 'cpu'];
/** GPU 种类（《04》§7.1 `GpuKind`） */
export const GPU_KINDS = ['cuda', 'metal', 'cpu'];

/**
 * 各档峰值内存**估算**（《02》§5 表：Tiny ≈ 9.4 / Small ≈ 12.8 / Medium ≈ 17.6 GB）。
 * 🔴 这三个数是**整机峰值估算**，且原文标注「估算、待实测校准」——不是实测值，
 *    也不是纯权重体积。它只用于两件事：设置页展示 + 可行性判定。
 */
export const TIER_PEAK_GB = { tiny: 9.4, small: 12.8, medium: 17.6 };

const BYTES_PER_GB = 1024 ** 3;

/** 字节 → GB（保留 1 位小数；`os.totalmem()` 的尾数无工程意义） */
export function bytesToGb(bytes) {
  return Math.round((Number(bytes) / BYTES_PER_GB) * 10) / 10;
}

/**
 * 档位映射 —— 《04》§7.2 表格**逐行照抄**。
 *
 * | CUDA `vram >= 16` | Medium |  | CUDA `vram >= 10` | Small |  | CUDA `vram >= 4` | Tiny |
 * | Metal `unified >= 32` | Medium |  | Metal `unified >= 24` | Small |  | Metal `else` | **Tiny** |
 * | 纯 CPU | **Tiny**（提示速度受限） |
 *
 * ⚠️ 原文只给出了 CUDA `>= 4` 的行，**没写 `vram < 4` 落哪** —— 这里取 `tiny`
 *   （Tiny 是枚举下界，也是唯一能跑的档）。这是**对原文空白的显式裁定**，不是"照抄"，
 *   已记入台账（`docs/spec-notes.md`），不藏在代码里。
 *
 * @param {{totalRamGb?:number, gpu:{kind:string, vramGb?:number, unifiedGb?:number}}} profile
 * @returns {'tiny'|'small'|'medium'}
 */
export function mapTier(profile) {
  const gpu = (profile && profile.gpu) || {};
  if (gpu.kind === 'cuda') {
    const vram = Number(gpu.vramGb);
    if (!Number.isFinite(vram)) return 'tiny';
    if (vram >= 16) return 'medium';
    if (vram >= 10) return 'small';
    return 'tiny'; // 原文的 `>= 4` 与「< 4」同落 Tiny
  }
  if (gpu.kind === 'metal') {
    const unified = Number(gpu.unifiedGb);
    if (!Number.isFinite(unified)) return 'tiny';
    if (unified >= 32) return 'medium';
    if (unified >= 24) return 'small';
    return 'tiny'; // **16GB Mac 落此**（§7.2 修订点）
  }
  return 'tiny'; // 纯 CPU：速度受限，仅 Tiny（§7.3）
}

/**
 * 加速后端探测 —— 《04》§7.4 的「探测顺序 CUDA → MPS → CPU」。
 *
 * 注意这里判的是**探测顺序的产物**：`gpu.kind` 已经由 `detectGpu()` 按「先 CUDA 后 Metal」
 * 选出来了，本函数只做「种类 → 后端名」的映射，**不再重复探测**（两处都探会出现
 * 「GPU 报 cuda、后端报 mps」这类自相矛盾）。
 */
export function detectAccel(gpu) {
  if (gpu && gpu.kind === 'cuda') return 'cuda';
  if (gpu && gpu.kind === 'metal') return 'mps';
  return 'cpu';
}

/**
 * 加速后端 → 启动参数（《04》§7.3）。
 *
 * | 后端 | 引擎 | llama-server |
 * | MPS   | `--use-gpu` | 权重上 GPU |
 * | CUDA  | `--use-gpu` | `--n_gpu_layers -1`（全上 GPU；显存不足可调层数） |
 * | CPU   | 不加 `--use-gpu` | 全留 CPU（`--n_gpu_layers 0`） |
 *
 * ⚠️ `llmGpuLayers` 返回 **`-1`/`0` 的语义值**，不是命令行字符串。
 *   「-1 与 99 等价吗」这种细节不在这里猜 —— 由调用方（S4-b 的 LlmSupervisor）决定，
 *   并在那里用断言钉住（见 `service/scripts/engine-profile-check.mjs`）。
 */
export function accelLaunchFlags(accel) {
  const onCpu = accel === 'cpu';
  return { engineUseGpu: !onCpu, llmGpuLayers: onCpu ? 0 : -1 };
}

/** 加速后端的中文名（设置页与诊断视图共用一处文案，避免两处各写一套对不上） */
export const ACCEL_LABELS = {
  auto: '自动',
  cuda: 'CUDA',
  mps: 'MPS（Metal）',
  cpu: 'CPU',
};

/**
 * 解析**实际生效**的加速后端（S6 设置页「加速后端」的落地处）。
 *
 * ## 为什么不能"用户选什么就报什么"
 * `sidecar.accel` 的用途是"让界面和事实对账"。若用户在 Metal 机器上选了 `cuda` 而我们如实
 * 报 `cuda`，那就是**用一个假字段配一个假控件**：界面说 CUDA，实际跑的是 MPS，而两边都"绿"。
 * 所以这里把"用户想选的"与"硬件能给的"合成一个**只能有一个答案**的结论，并且
 * **把不一致显式报出来**（`mismatch`）—— 界面据此显示「已请求 CUDA，本机为 MPS」。
 *
 * ⚠️ 与 §7.4-3 的 `degraded` 是**两件事**，不要合并：
 *    · `resolveAccel` 管的是"**后端选谁**"（静态，启动时定）；
 *    · `degraded` 管的是"选了 GPU 却**实际回退到 CPU**"（动态，意味着性能下降 ⇒ 要告警）。
 *    把"用户选了 cpu"也报成 degraded，会让人以为出故障了，而那是他自己选的。
 *
 * @param {{choice?:string, hardwareAccel?:string, useGpu?:boolean}} p
 * @returns {{accel:string, degraded:boolean, mismatch:string|null, reason:string}}
 */
export function resolveAccel({ choice = 'auto', hardwareAccel = 'cpu', useGpu = true } = {}) {
  // 「不许用 GPU」这一支优先：`accel=cpu`（用户设置）或 `MIAO_ENGINE_USE_GPU=0`（注入）都落这
  if (useGpu === false) {
    // 🔴 必须分清**两种** `useGpu === false` —— 它们外观相同、含义相反（E8 取证时照出）：
    //   · `choice === 'cpu'`：用户在设置页选了「强制 CPU」⇒ 这是**他主动要的**，
    //     `config.mjs` 由此把 `engineUseGpu` 也算成 false（见 `config.engineUseGpu` 那行）。
    //     §7.4-3 管的是"指定 GPU 后端**启动失败**"，不是用户不要 GPU ⇒ **不报 degraded**。
    //   · `choice` 是 auto / 某个 GPU 后端：那就是 Rust 侧检测到 GPU 起不来、注入
    //     `MIAO_ENGINE_USE_GPU=0` 重拉（见 `server.mjs` §7.4-3 那段）⇒ 真回退，**必须 degraded**。
    // 合并成一件事的后果是"用户自己点了 CPU，界面却报故障"——正是本函数头注释警告的那种误导。
    const byUserChoice = choice === 'cpu';
    return {
      accel: 'cpu',
      degraded: !byUserChoice && hardwareAccel !== 'cpu',
      mismatch: null,
      reason: byUserChoice
        ? '用户指定 CPU（非回退）'
        : (hardwareAccel === 'cpu' ? '硬件本就无 GPU' : `已回退 CPU（硬件推荐 ${hardwareAccel}）`),
    };
  }
  if (choice === 'auto' || choice === hardwareAccel) {
    return { accel: hardwareAccel, degraded: false, mismatch: null, reason: choice === 'auto' ? '按硬件探测' : '用户指定' };
  }
  // 用户指定了一个本机没有的后端。**不假装它生效**，也不静默丢掉 —— 报硬件事实 + 记下不一致。
  return {
    accel: hardwareAccel,
    degraded: false,
    mismatch: `已请求 ${choice}，本机可用后端为 ${hardwareAccel}`,
    reason: '用户指定的后端在本机不可用，按硬件探测值执行',
  };
}

/**
 * 加速后端**候选项**（《02》§5：下拉「自动 / CUDA / MPS / CPU」，默认自动）。
 *
 * 「物理不可行的档位不出现」这条纪律同样适用于后端：Metal 机器上不列 CUDA
 * —— 列出来就等于给一个点了不会有任何作用的选项（假控件比缺控件更伤）。
 * `cpu` 恒在（它是唯一在任何机器上都成立的兜底）。
 *
 * @param {string} hardwareAccel 硬件探测出的后端
 * @param {{all?:boolean}} [opts] `all` = **反证开关**：把四个都列出来（用来证明上面那条
 *   筛选真的在起作用，而不是"恰好本机只有三项"）。
 */
export function accelOptions(hardwareAccel, { all = false } = {}) {
  const order = all ? ACCELS_WITH_AUTO : ['auto', ...(hardwareAccel === 'cpu' ? [] : [hardwareAccel]), 'cpu'];
  const labels = {
    auto: `按硬件探测（本机 → ${ACCEL_LABELS[hardwareAccel] || hardwareAccel}）`,
    cuda: 'NVIDIA 显卡（CUDA）',
    mps: 'Apple Metal（MPS）',
    cpu: '强制 CPU（最慢，但兼容性最好）',
  };
  return order.map((value) => ({ value, label: ACCEL_LABELS[value] || value, detail: labels[value] }));
}

/**
 * 探测 GPU 种类。
 *
 * · macOS ⇒ **Metal**（Apple Silicon 的统一内存 = 整机内存；`unified_gb = total_ram_gb`）。
 *   ⚠️ 不区分 arm64/x64 —— Intel Mac 的内存同样是统一内存，判据一致。
 * · 其他平台 ⇒ 先试 NVIDIA（`nvidia-smi` 读显存），失败即 **CPU**（核显/无独显，§7.3）。
 *   Windows 侧本机不可实测 ⇒ 标 `unverified`（见 `docs/` 的 unverified register）。
 *
 * @param {{platform?:string, arch?:string, totalRamGb?:number, runNvidiaSmi?:Function}} deps
 */
export function detectGpu(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const totalRamGb = deps.totalRamGb;

  if (platform === 'darwin') {
    return {
      kind: 'metal',
      unifiedGb: totalRamGb,
      name: arch === 'arm64' ? 'Apple Silicon（Metal 统一内存）' : 'Apple（Metal 统一内存）',
    };
  }

  const readVram = deps.runNvidiaSmi ?? defaultNvidiaVramGb;
  let vramGb = null;
  try { vramGb = readVram(); } catch { vramGb = null; }
  if (Number.isFinite(vramGb) && vramGb > 0) {
    return { kind: 'cuda', vramGb, name: 'NVIDIA（CUDA）' };
  }
  return { kind: 'cpu', name: 'CPU（无可用独显）' };
}

/**
 * 读 NVIDIA 显存总量（GiB）。
 * `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` 输出单位是 **MiB**。
 * 读不到 → 返回 `null`（本机 macOS 上必然如此；这不是错误，是"没有独显"）。
 */
function defaultNvidiaVramGb() {
  const out = execFileSync(
    'nvidia-smi',
    ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const first = String(out).split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!first) return null;
  const mib = Number.parseFloat(first);
  return Number.isFinite(mib) ? Math.round((mib / 1024) * 10) / 10 : null;
}

/**
 * 探测整机硬件档位画像（《04》§7.1）。
 *
 * 全部硬件事实可由 `deps` 注入 —— 这是本模块可被断言与反证的**前提**。
 * @returns {{platform:string, arch:string, totalRamGb:number, gpu:object, accel:string, recommendedTier:string}}
 */
export function probeHardware(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const totalRamGb = Number.isFinite(deps.totalRamGb)
    ? deps.totalRamGb
    : bytesToGb(deps.totalMemBytes ?? os.totalmem());

  const gpu = deps.gpu ?? detectGpu({ ...deps, platform, arch, totalRamGb });
  return {
    platform,
    arch,
    totalRamGb,
    gpu,
    accel: detectAccel(gpu),
    recommendedTier: mapTier({ totalRamGb, gpu }),
  };
}

/**
 * 物理可行的档位集合 —— 决定设置页**哪些档位出现**（《02》§5「物理不可行档位不出现」）。
 *
 * 判定池按后端分：
 *   · metal（统一内存）/ cpu —— 权重与整机内存**竞争**，按《02》§5 的整机峰值估算判；
 *   · cuda —— 权重进**显存**，按《04》§7.2 的 vram 阈值判（与整机 RAM 无关）。
 *   · Tiny 恒为可行档（它是枚举下界 / 唯一在任何硬件上都"能跑"的档）。
 *
 * 本机（16GB Mac）⇒ `['tiny','small']`：Medium 的 17.6 GB > 16 GB，**物理不可行**，
 * 正是《02》§5 §7 表格里「❌ UI 不提供」的那一格。
 */
export function feasibleTiers(profile) {
  const gpu = (profile && profile.gpu) || {};
  if (gpu.kind === 'cuda') {
    const vram = Number(gpu.vramGb);
    return TIERS.filter((tier) => {
      if (tier === 'tiny') return true;
      if (!Number.isFinite(vram)) return false;
      return tier === 'small' ? vram >= 10 : vram >= 16;
    });
  }
  const totalRamGb = Number(profile && profile.totalRamGb);
  return TIERS.filter((tier) => tier === 'tiny' || TIER_PEAK_GB[tier] <= totalRamGb);
}

/**
 * 设置页档位选项（《02》§5）：可行档位 + 预估内存 + 「推荐」/「不推荐」标注。
 *
 * 规则：可行但不是推荐档 ⇒ `warning` 非空（原文：「Small **保留**但标注「不推荐」，
 * 选中时**强警告**（内存吃紧、翻译可能明显变卡）」）。16GB Mac 上 Small 正是这一格。
 */
export function tierOptions(profile) {
  const recommendedTier = profile && profile.recommendedTier
    ? profile.recommendedTier
    : mapTier(profile);
  return feasibleTiers(profile).map((tier) => ({
    tier,
    peakGb: TIER_PEAK_GB[tier],
    recommended: tier === recommendedTier,
    warning: tier === recommendedTier ? null : '内存吃紧，翻译可能明显变卡',
  }));
}
