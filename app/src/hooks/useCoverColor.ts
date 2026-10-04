import { useEffect, useState } from 'react';
import { VINYL_COLOR_DEF } from '@music/player-options';

/** 取色结果：hex 供 CSS 变量用，isLight 供后续文字对比用 */
export interface CoverColor {
  hex: string;
  isLight: boolean;
}

/** 取色失败时的兜底色 —— 与设置页「彩胶自定义色」的默认值同源，保证观感一致 */
const FALLBACK: CoverColor = { hex: VINYL_COLOR_DEF, isLight: false };

/** 感知亮度阈值：0.299R+0.587G+0.114B 超过它就算浅色 */
const LIGHT_LUMA = 160;

/**
 * 本地取封面主色（不联网、不引依赖）。
 *
 * 归属（2026-10-04 收口）：`use*` 命名的 hook 一律住 `src/hooks/`（spec-notes D-41）。
 * 本 hook 住在 `screens/music/` 时是收口的漏网之鱼 —— 而漏的原因很典型：
 * 收口时只迁了"当时唯一那个无业务依赖的 hook"（useEsc），
 * 判断依据是"纯不纯"，而不是"名字是不是 use 开头"。
 * 现在由 `HOOKS.noMisplacedUse` 断言按**文件名**判，不再依赖人对"纯不纯"的判断。
 * （注意：hooks 目录**允许**依赖业务模块 —— 它本身就是业务 hook 的家；
 * 禁止依赖业务的是 `components/units`。）
 *
 * 做法：`<img crossOrigin="anonymous">` 载入封面 → 画到 16×16 的小 canvas →
 * 对像素求平均色 → 返回 `{ hex, isLight }`。
 *
 * 为什么刻意用 16×16：
 *  - 我们要的只是「大致主色」，不是精确配色，小画布一次 `drawImage` 就把整图缩成
 *    16×16，均摊计算量极小、又快；
 *  - 缩得越小，封面四角留白/边框/水印这类局部细节在均值里的权重越低，主体的
 *    大面积色更容易胜出，避免被边缘的白色/黑色带偏。
 *
 * 为什么要整段 try/catch 兜底（这是本 hook 的关键约束）：
 *  - `getImageData` 会因画布被跨域污染（tainted canvas）而抛 `SecurityError`。
 *    封面有两条来源 —— 在线歌曲走本地音频代理 `/cover?url=...`（代理带
 *    `Access-Control-Allow-Origin: *`，可读）；本地歌曲走 `convertFileSrc()` 的
 *    asset 协议（WebView 不一定给 CORS 头，可能不可读）。
 *  - 也就是说"读不到像素"是完全可能的正常情况，绝不能把异常抛给组件 ——
 *    取色只是 `--vinyl-accent` 的锦上添花，失败了也必须能正常出画面。
 *    所以任何失败（onerror / 无 2D 上下文 / 空像素 / 跨域污染）一律静默回落到 FALLBACK。
 */
export function useCoverColor(url: string): CoverColor {
  const [color, setColor] = useState<CoverColor>(FALLBACK);

  useEffect(() => {
    // url 为空（无封面 / 非彩胶皮肤不取色）：立即回到默认色，避免上一首的颜色残留
    if (!url) {
      setColor(FALLBACK);
      return;
    }

    // alive 标志：图片解码是异步的，组件卸载或 url 已切换后不能再 setState
    let alive = true;
    const img = new Image();
    // 带上 CORS 请求头，代理来源才不会把画布污染（一旦污染 getImageData 必抛）
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';

    img.onload = () => {
      if (!alive) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(img, 0, 0, 16, 16);
        const { data } = ctx.getImageData(0, 0, 16, 16);

        // 只累加不透明像素：透明边角的 (0,0,0) 会把均值拉黑
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 8) continue; // 近似透明，跳过
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n += 1;
        }
        if (!n) throw new Error('no opaque pixel');

        r = Math.round(r / n);
        g = Math.round(g / n);
        b = Math.round(b / n);
        const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        // 感知亮度（人眼对绿最敏感、对蓝最不敏感）
        const isLight = 0.299 * r + 0.587 * g + 0.114 * b > LIGHT_LUMA;
        if (alive) setColor({ hex, isLight });
      } catch {
        // 跨域污染 / 解码异常：静默回落，绝不上抛到组件
        if (alive) setColor(FALLBACK);
      }
    };

    img.onerror = () => {
      // 载入失败（网络/协议不支持）：同样回落
      if (alive) setColor(FALLBACK);
    };

    img.src = url;

    return () => {
      // 卸载或 url 变化：断开回调，防迟到的解码结果 setState
      alive = false;
      img.onload = null;
      img.onerror = null;
    };
  }, [url]);

  return color;
}
