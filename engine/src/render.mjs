// 「译文」渲染器 —— 模拟引擎的输出画面
//
// 为什么需要它：真实模型未就绪（docs/spec-notes.md D-09），但验收要求落盘产物是**真实可打开的图片**，
// 且「原创 ↔ 译文」在对照页中肉眼可分。因此渲染一张**版式化**的假译文：
//   · 纸面底 + 文本行 + 对话框轮廓 —— 看起来像一页译好的漫画，而不是纯色块
//   · 顶部 4px 色带颜色由 seq 决定 —— 给自动化验收一个**可像素级校验的每页标识**
//     （校验：取顶部色带中心像素，其色相应 ≈ (seq*47)%360，见 e2e/engine/selftest.mjs）
//
// 输出统一为 PNG。真实引擎若保持原容器格式也无需改 Service：落盘扩展名取自对返回字节的嗅探
// （见 service/src/manga/store.mjs `_writeItem`）。
import { encodePng, hslToRgb, hueForSeq } from './png.mjs';

/** 纸面与线条色（粉彩同族，用作模拟版式，不替代设计令牌） */
const PAPER = [251, 251, 254];
const INK_SOFT = [216, 211, 232];
const INK_MID = [140, 133, 163];
const FRAME = [229, 222, 245];

/** 确定性伪随机：同一 seq 永远渲染出同一张图（便于回归比对与自测断言） */
function lcg(seed) {
  let s = (Math.floor(seed) * 2654435761) % 4294967296;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * 渲染一张「译文」页。
 * @param {number} width  原图宽（输出同尺寸，便于对照页左右同框）
 * @param {number} height 原图高
 * @param {number} seq    序号（决定色带与版式）
 * @returns {Buffer} PNG 字节
 */
export function renderTranslatedPage(width, height, seq) {
  const w = Math.max(1, Math.min(4096, Math.floor(width) || 400));
  const h = Math.max(1, Math.min(4096, Math.floor(height) || 600));
  const rand = lcg(seq || 1);

  const marginY = Math.round(h * 0.06);
  const lineCount = Math.max(3, Math.min(18, Math.round((h - marginY * 2) / 56)));
  const lineGap = (h - marginY * 2) / lineCount;
  const lineH = Math.max(3, Math.min(10, Math.round(lineGap * 0.22)));

  const lines = [];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push({
      y: Math.round(marginY + i * lineGap),
      x0: Math.round(w * (0.07 + rand() * 0.05)),
      x1: Math.round(w * (0.62 + rand() * 0.31)),
      dark: rand() < 0.35,
    });
  }

  const bubbles = [];
  const bubbleCount = w > 220 ? 2 : 1;
  for (let i = 0; i < bubbleCount; i += 1) {
    bubbles.push({
      bw: Math.round(w * (0.34 + rand() * 0.14)),
      bh: Math.round(h * (0.1 + rand() * 0.06)),
      bx: Math.round(w * (0.08 + rand() * 0.3)),
      by: Math.round(marginY + ((i + 0.5) * (h - marginY * 2)) / (bubbleCount + 0.6)),
    });
  }

  const band = hslToRgb(hueForSeq(seq), 0.72, 0.68); // 顶部色带：每页标识
  const frameW = Math.max(1, Math.round(Math.min(w, h) * 0.012));

  return encodePng(w, h, (x, y, put) => {
    let r = PAPER[0];
    let g = PAPER[1];
    let b = PAPER[2];

    if (y < 4) {
      // 顶部 4px 色带：每页标识，**优先级高于外框**
      // （若让外框先判断，真实页面尺寸下 frameW≫4 会把色带整条吞掉——曾是真实缺陷）
      [r, g, b] = band;
    } else if (x < frameW || y < frameW || x >= w - frameW || y >= h - frameW) {
      [r, g, b] = FRAME;
    } else {
      for (const ln of lines) {
        if (y >= ln.y && y < ln.y + lineH && x >= ln.x0 && x < ln.x1) {
          [r, g, b] = ln.dark ? INK_MID : INK_SOFT;
          break;
        }
      }
      for (const bb of bubbles) {
        if (x >= bb.bx && x < bb.bx + bb.bw && y >= bb.by && y < bb.by + bb.bh) {
          const onEdge = x < bb.bx + 2 || x >= bb.bx + bb.bw - 2 || y < bb.by + 2 || y >= bb.by + bb.bh - 2;
          [r, g, b] = onEdge ? INK_MID : [255, 255, 255];
          break;
        }
      }
    }
    put(r, g, b);
  });
}

export { hueForSeq };
