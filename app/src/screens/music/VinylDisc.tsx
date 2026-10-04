/**
 * 「透明彩胶」皮肤专属：右上角伸出的半透明**彩色胶片**（黑胶唱片）。
 *
 * ## 为什么是纯 CSS 实现、无内部状态
 *
 * 旋转、光晕呼吸全部交给 CSS 动画；播放/暂停只切 `animationPlayState`，
 * 不触发任何重渲染 —— 逐帧用 JS 改 transform 会和歌词的 RAF 抢主线程。
 *
 * ## 为什么 accentColor 由外部传入而不是内部取色
 *
 * 胶片色 = 「彩胶配色」设置（auto 跟随封面 / custom 用户固定色），
 * 该设置在 ExpandedPlayer 里统一派生（见其 vinylAccent），组件只负责呈现，
 * 避免"取色逻辑有两个 owner"。
 *
 * ## 与参考实现的差异（诚实说明）
 *
 * 参考实现用一张 SVG（feTurbulence 位移）压出"低频弯曲的明暗胶纹"。
 * 本项目不引额外资源，胶纹用 `repeating-radial-gradient`（细密同心纹）+
 * 两层柔光近似，**观感略平**，但不影响"唱片形态 + 旋转 + 暂停停转"这些核心语义。
 */
import type { CSSProperties } from 'react';

interface VinylDiscProps {
  isPlaying: boolean;
  /** 胶片颜色（同时用作歌词高亮色），hex */
  accentColor: string;
  /** 专辑封面 URL，空串时渲染纯色片芯 */
  coverUrl: string;
}

/** 允许在 style 里写 CSS 自定义属性（--x）的写法（与 ExpandedPlayer 同款，避免用 any） */
type CSSVarStyle = CSSProperties & Record<`--${string}`, string | number>;

/** hex（#rrggbb）→ rgba 字符串。只处理本模块用到的 6 位 hex。 */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function VinylDisc({ isPlaying, accentColor, coverUrl }: VinylDiscProps) {
  const hasCover = !!coverUrl;
  // 细密同心纹 + 两处柔光（上亮下暗，制造盘面弧度）+ 胶片底色（半透明，透出浅色底）
  const discBackground = [
    'repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,0.09) 0px, rgba(255,255,255,0.09) 1px, rgba(255,255,255,0) 1px, rgba(255,255,255,0) 6px)',
    'radial-gradient(circle at 34% 28%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 46%)',
    'radial-gradient(circle at 66% 72%, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0) 52%)',
    hexToRgba(accentColor, 0.56),
  ].join(', ');

  return (
    <div className="skin-vinyl-layer" style={{ '--disc': 'min(72vh, 44vw)' } as CSSVarStyle} aria-hidden>
      {/* 光晕：与胶片同心的大范围柔光，播放时呼吸 */}
      <div
        className="skin-vinyl-glow"
        style={{
          background: `radial-gradient(circle, ${hexToRgba(accentColor, 0.3)} 0%, ${hexToRgba(
            accentColor,
            0.13,
          )} 42%, rgba(255,255,255,0) 68%)`,
          animationPlayState: isPlaying ? 'running' : 'paused',
        }}
      />
      {/* 入场层：从右上角滑入放大 */}
      <div className="skin-vinyl-disc-wrap">
        {/* 旋转层：暂停即停转（把"静止"作为暂停的视觉语言） */}
        <div
          className="skin-vinyl-disc"
          style={{
            background: discBackground,
            boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.28), inset 0 0 60px ${hexToRgba(accentColor, 0.35)}`,
            animationPlayState: isPlaying ? 'running' : 'paused',
          }}
        >
          {/* 片芯：封面圆（随盘旋转） */}
          <div className="skin-vinyl-label">
            {hasCover ? (
              <img src={coverUrl} alt="" draggable={false} />
            ) : (
              <div
                className="skin-vinyl-label-empty"
                style={{
                  background: `linear-gradient(135deg, ${hexToRgba(accentColor, 0.85)}, ${hexToRgba(
                    accentColor,
                    0.5,
                  )})`,
                }}
              />
            )}
          </div>
        </div>
        {/* 高光层：conic 反光固定不随盘旋转（反光属于环境光，不该跟着转） */}
        <div className="skin-vinyl-sheen" />
      </div>
    </div>
  );
}
