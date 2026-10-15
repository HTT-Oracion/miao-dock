/**
 * 封面取色基础设施（六皮肤视觉的前提）—— **唯一实现**，住 `src/hooks/`。
 *
 * ## 为什么它必须住在 hooks/
 *
 * `use*` 命名的 hook 一律住 `src/hooks/`（spec-notes D-41 收口），
 * 由断言 `HOOKS.noMisplacedUse` 按**文件名**守着。
 * 本模块与「封面取色」这件事在历史上被写过两次：
 * 第一次收口时只迁了「当时唯一那个无业务依赖的 hook」，取色这份成了漏网之鱼；
 * 第二次在六皮肤对齐时，又在 `screens/music/` 下新写了一份（靠改文件名绕过命名门禁）。
 * 现在两份**合并回本文件** —— 同一件事只能有一份实现。
 *
 * 归属说明（桶规范见 `hooks/index.ts` 文件头）：本模块是**纯 DOM 行为类**，
 * 与 `useEsc` 同类，故**不进业务桶**，以 `@hooks/useCoverColor` 直接引入。
 * 注意 hooks 目录**允许**依赖业务模块（禁止依赖业务的是 `components/units`）。
 *
 * ## 为什么这一段是六皮肤的前提
 *
 * 参考实现里「现代 / 沉浸 / 封面渐染 / 透明彩胶」四种皮肤的背景与文字色**都依赖封面**——
 * 现代背景 = 封面主色 + 其 0.25 暗色；沉浸背景 = 封面主色映射到柔和色板；
 * 封面渐染背景 = 封面**右缘**主色；透明彩胶胶片色 = 封面主色经 HSV 钳制。
 * 这些都只能在**运行时**拿到封面像素后才知道，所以**没法写死在 CSS 里**——
 * 必须由 JS 取色，再把结果作为 CSS 变量注入（见 ExpandedPlayer 的 rootStyle）。
 *
 * ## 失败必须回落，绝不外抛
 *
 * 取色只是锦上添花，画面必须在任何情况下都出得来。三条失败路径都要吞掉：
 *   ① 图片加载失败（网络/协议不支持）→ onerror；
 *   ② canvas 被跨域污染（封面走代理 URL，本地歌曲走 asset://）→ `getImageData` 抛 `SecurityError`；
 *   ③ 无 2D 上下文 / 空像素。
 * 任何一条都静默回落到 DEFAULT，绝不把异常抛给组件。
 *
 * ## 两处口径变更（合并时确认过，非顺手改）
 *
 * ① **通用兜底色**：旧版用 `VINYL_COLOR_DEF`（设置页「彩胶自定义色」的默认值）。
 *    那是**彩胶专用色**，让所有皮肤都拿它兜底会让非彩胶皮肤偏色（沉浸的柔和色板尤其明显）。
 *    故通用兜底改用中性深蓝黑 `#1a1a2e`（对齐参考实现）；彩胶自己的兜底仍由
 *    `player-options` 的 `VINYL_COLOR_DEF` 负责 —— 两者各管各的，不再混用。
 * ② **亮度阈值**：旧版是 `160/255`（≈0.627，0-255 域），现为 **0.55（0-1 域）**，对齐参考实现。
 *    阈值高低直接决定同一张封面配深色字还是浅色字，差 0.08 足以让白底封面误判成深色底。
 */
import { useEffect, useState } from 'react';

/** 取色结果：hex 供 CSS 用，rgb 供派生（暗色/柔和色板），isLight 供文字色二选一 */
export interface CoverColor {
  hex: string;
  rgb: [number, number, number];
  isLight: boolean;
}

/** 取不到色时的兜底色 —— 与参考实现同款深蓝黑，任何皮肤都能压得住白字 */
const DEFAULT_COLOR: CoverColor = { hex: '#1a1a2e', rgb: [26, 26, 46], isLight: false };

/** 感知亮度阈值（WCAG 近似 0.299R+0.587G+0.114B）：超过它算浅色 → 文字翻深色 */
const LIGHT_LUMA = 0.55;

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * 从图片提取**主色**（现代 / 沉浸 / 透明彩胶用）。
 *
 * 做法照参考实现：缩到 100×100 加速采样 → 逐像素按「离中心越近权重越高」加权平均 →
 * 对结果做一次饱和度增强（把偏离灰轴的分量放大 35%）→ 用感知亮度判定明暗。
 * 为什么中心加权：封面四角常是留白/边框/水印，纯平均会被边缘的白色或黑色带偏。
 */
function extractDominantColor(img: HTMLImageElement): CoverColor {
  try {
    const size = 100;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return DEFAULT_COLOR;

    ctx.drawImage(img, 0, 0, size, size);
    // 跨域污染会在这一步抛 SecurityError —— 由外层 catch 吞掉
    const { data } = ctx.getImageData(0, 0, size, size);

    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        if (data[idx + 3] < 128) continue; // 跳过透明像素（其 RGB 会把均值拉黑）
        const cx = Math.abs(x - size / 2) / (size / 2);
        const cy = Math.abs(y - size / 2) / (size / 2);
        const weight = 1 - Math.min(cx + cy, 1) * 0.5;
        r += data[idx] * weight;
        g += data[idx + 1] * weight;
        b += data[idx + 2] * weight;
        count += weight;
      }
    }
    if (count === 0) return DEFAULT_COLOR;

    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);

    // 饱和度增强：把每通道偏离灰轴的部分放大，主色更「跳」一点
    const avg = (r + g + b) / 3;
    r = Math.min(255, Math.max(0, Math.round(r + (r - avg) * 0.35)));
    g = Math.min(255, Math.max(0, Math.round(g + (g - avg) * 0.35)));
    b = Math.min(255, Math.max(0, Math.round(b + (b - avg) * 0.35)));

    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return { hex: toHex(r, g, b), rgb: [r, g, b], isLight: luminance > LIGHT_LUMA };
  } catch {
    // ② 跨域污染 / 解码异常：静默回落
    return DEFAULT_COLOR;
  }
}

/**
 * 提取封面**最右侧竖条**的主色（封面渐染用）。
 *
 * 为什么单独取右缘而不是复用平均主色：封面渐染是把封面满铺在左侧、右侧背景要与之
 * **无缝相融**——融合发生在封面右缘，所以右侧背景必须等于右缘那一列的颜色，用整图平均色会错位。
 * 做法：只统计最右 10% 竖条，每通道按 4bit 量化分桶（4096 桶），取**像素最多的桶**的均值，
 * 相当于「右缘最常见的颜色」，比直接平均更不容易被一小撮噪点带偏。
 */
function extractRightEdgeColor(img: HTMLImageElement): CoverColor {
  try {
    const size = 100;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return DEFAULT_COLOR;

    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    const stripX = Math.floor(size * 0.9);
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let y = 0; y < size; y++) {
      for (let x = stripX; x < size; x++) {
        const idx = (y * size + x) * 4;
        if (data[idx + 3] < 128) continue;
        const key = ((data[idx] >> 4) << 8) | ((data[idx + 1] >> 4) << 4) | (data[idx + 2] >> 4);
        const bk = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        bk.n++;
        bk.r += data[idx];
        bk.g += data[idx + 1];
        bk.b += data[idx + 2];
        buckets.set(key, bk);
      }
    }
    if (buckets.size === 0) return DEFAULT_COLOR;

    let best = { n: 0, r: 0, g: 0, b: 0 };
    for (const bk of buckets.values()) if (bk.n > best.n) best = bk;

    const r = Math.round(best.r / best.n);
    const g = Math.round(best.g / best.n);
    const b = Math.round(best.b / best.n);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return { hex: toHex(r, g, b), rgb: [r, g, b], isLight: luminance > LIGHT_LUMA };
  } catch {
    return DEFAULT_COLOR;
  }
}

/** 取色缓存：同一 URL 不重复解码（切换皮肤/重开播放器时不重复计算，也顺带压住 StrictMode 双调用） */
const dominantCache = new Map<string, CoverColor>();
const edgeCache = new Map<string, CoverColor>();

/**
 * 通用「异步取色」hook：空 URL 直接回落；命中缓存直接返回；
 * 否则新建 `<img crossOrigin="anonymous">` 解码后取色，失败回落。
 *
 * 为什么用 requestAnimationFrame 之外的模式：这里是**一次性**事件驱动（图片 onload），
 * 不需要轮询。cancelled 标志防止卸载/换歌后迟到的回调 setState。
 */
function useExtractColor(
  url: string,
  cache: Map<string, CoverColor>,
  extract: (img: HTMLImageElement) => CoverColor,
): CoverColor {
  const [color, setColor] = useState<CoverColor>(() => cache.get(url) ?? DEFAULT_COLOR);

  useEffect(() => {
    if (!url) {
      // 无封面 / 不该取色的皮肤：立即回落，避免上一首的颜色残留到这一首
      setColor(DEFAULT_COLOR);
      return;
    }
    const cached = cache.get(url);
    if (cached) {
      setColor(cached);
      return;
    }

    let cancelled = false;
    const img = new Image();
    // 代理来源带 Access-Control-Allow-Origin，不设 crossOrigin 会把画布污染 → getImageData 必抛
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';

    img.onload = () => {
      if (cancelled) return;
      const c = extract(img);
      if (cancelled) return;
      cache.set(url, c);
      setColor(c);
    };
    img.onerror = () => {
      if (cancelled) return;
      setColor(DEFAULT_COLOR);
    };

    img.src = url;

    return () => {
      cancelled = true;
      // 断开闭包引用让 img 可被回收；不置 src=''（那会取消正在进行的加载）
      img.onload = null;
      img.onerror = null;
    };
  }, [url, cache, extract]);

  return color;
}

/** 封面主色（现代 / 沉浸 / 透明彩胶）—— 返回值含 rgb，供派生暗色与柔和色板 */
export function useCoverColor(url: string): CoverColor {
  return useExtractColor(url, dominantCache, extractDominantColor);
}

/** 封面右缘主色（封面渐染）—— 与主色分开缓存，互不覆盖 */
export function useCoverEdgeColor(url: string): CoverColor {
  return useExtractColor(url, edgeCache, extractRightEdgeColor);
}

// ------------------------------------------------------------------ 沉浸柔和色板
//
// 沉浸背景不直接用封面原色（原色往往过艳/过灰，整屏铺开会刺眼或发闷），
// 而是把封面色相映射到一小组**深色中性**固定色，再在亮度上做「左深右浅、但差别不大」的微调。

/** 沉浸固定色板（照参考实现：青 / 深蓝 / 深橙 / 紫粉 / 黄 / 红 / 绿 / 灰） */
const VIVID_PALETTE: { hue: number; hex: string; rgb: [number, number, number] }[] = [
  { hue: 194, hex: '#126d83', rgb: [18, 109, 131] },
  { hue: 232, hex: '#303679', rgb: [48, 54, 121] },
  { hue: 18, hex: '#804127', rgb: [128, 65, 39] },
  { hue: 313, hex: '#7e356e', rgb: [126, 53, 110] },
  { hue: 44, hex: '#7e681f', rgb: [126, 104, 31] },
  { hue: 354, hex: '#7d2c33', rgb: [125, 44, 51] },
  { hue: 84, hex: '#5e8023', rgb: [94, 128, 35] },
  { hue: -1, hex: '#333333', rgb: [51, 51, 51] },
];

/** 把 rgb 转成 HSL（h∈[0,360), s/l∈[0,1]） */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return [((h % 360) + 360) % 360, s, l];
}

/** HSL → hex */
function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = l;
    g = l;
    b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h / 360 + 1 / 3);
    g = hue2rgb(p, q, h / 360);
    b = hue2rgb(p, q, h / 360 - 1 / 3);
  }
  return toHex(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

/** 在保持色相/饱和度的前提下微调亮度（±dL），返回 hex —— 用于 deep/light 两个端点 */
function shiftLightness([r, g, b]: [number, number, number], dL: number): string {
  const [h, s, l] = rgbToHsl(r, g, b);
  const nl = Math.min(0.97, Math.max(0.03, l + dL));
  return hslToHex(h, s, nl);
}

/**
 * 封面主色 → 沉浸背景色：取封面**色相**在固定色板里找最近的固定色；
 * 封面几乎无色（饱和度 < 0.08）时用灰色板。再返回 deep/light（仅 ±0.07 亮度微调）——
 * 这三个值拼成 `linear-gradient(90deg, deep, hex, light)`，即「左略深、右略浅但差别不大」的柔和背景。
 */
export function makeVividColor(
  cr: number,
  cg: number,
  cb: number,
): { hex: string; deep: string; light: string; rgb: [number, number, number] } {
  const [h, s] = rgbToHsl(cr, cg, cb);

  // 饱和度极低 → 灰色（色板里 hue=-1 的项不参与色相匹配）
  if (s < 0.08) {
    const gray = VIVID_PALETTE[VIVID_PALETTE.length - 1];
    return {
      hex: gray.hex,
      deep: shiftLightness(gray.rgb, -0.07),
      light: shiftLightness(gray.rgb, 0.07),
      rgb: gray.rgb,
    };
  }

  // 色相环取最近固定色（环形距离）
  let best = VIVID_PALETTE[0];
  let bestDist = 361;
  for (const c of VIVID_PALETTE) {
    if (c.hue < 0) continue;
    const dist = Math.min(Math.abs(h - c.hue), 360 - Math.abs(h - c.hue));
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return {
    hex: best.hex,
    deep: shiftLightness(best.rgb, -0.07),
    light: shiftLightness(best.rgb, 0.07),
    rgb: best.rgb,
  };
}
