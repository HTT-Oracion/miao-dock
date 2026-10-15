/**
 * 「音域回响」皮肤专属：随音乐起伏的**频谱场景**（2D Canvas 版）。
 *
 * ## ⚠️ 明确的偏离：为什么不做参考实现那套 three.js + GLSL 的 3D 体素地形
 *
 * 参考实现（components/SpectrumScene.tsx，909 行）用 three.js 建 WebGL 场景，
 * 把频谱映射成一片会起伏的 3D 立方体地形。本项目**刻意不引入 three.js**：
 *   ① 新依赖 = 打包体积 + 供应链面 + 与"零重型依赖"的项目基调相悖；
 *   ② 每个展开播放器切换都会创建/销毁 WebGL context，而 context 数量有硬上限，
 *      频繁切换（正是本皮肤的使用方式）容易触发 context 丢失、表现为"切回来没效果"；
 *   ③ 我们**已经有** `audioGraph` 这个唯一的音频图入口，用它拿真实频谱 + 2D canvas
 *      画柱状/地形起伏，能拿到"随节拍起伏、暂停回落、封面取色派生冷暖双色"这些
 *      **可感知的等价效果**，成本却低一个量级。
 * 因此本文件是**等效替代**：视觉语言向参考靠（近黑底、冷暖双色、圆拱状起伏），
 * 但实现是 2D 的。详见交付报告「音域回响：偏离说明」。
 *
 * ## 音频来源：只走 audioGraph 的唯一入口
 *
 * `createMediaElementSource` 对同一元素**只能调一次**，全前端只允许 audioGraph 出现
 * （断言 AUDIO.singleEntry 守着）。本组件因此只调 `attachAnalyser(findAudioElement())`
 * 拿现成的 AnalyserNode，再 `readLevels(node, N)` 读电平——**绝不自己建图**。
 *
 * ## 降级路径（不能白屏、不能报错）
 *
 * 拿不到音频图有两种常见原因：元素不可接管（非 CORS 模式，接管会静音）、
 * WebView 不支持 AudioContext。attachAnalyser 在这种情况下返回 null →
 * 本组件切到**纯 CSS 动画**的频谱占位（`skin-spectrum-fallback`），
 * 视觉上仍是一屏会动的频谱，不会白屏。
 *
 * ## 省电：非该皮肤不渲染、不跑 RAF
 *
 * `active` 为假时组件直接 return null，RAF 与 canvas 都不存在；切到该皮肤才挂载。
 * （参考实现让 3D 场景常驻正是为了绕开 WebGL context 反复重建，我们没这个问题。）
 */
import { useEffect, useRef, useState } from 'react';
import { attachAnalyser, findAudioElement, readLevels } from '@music/audioGraph';

interface SpectrumSceneProps {
  /** 是否为「音域回响」皮肤：非该皮肤时不渲染、不跑 RAF */
  active: boolean;
  isPlaying: boolean;
  /** 冷暖双色（由封面取色派生：deep 冷、light 暖），画柱体的渐变端点 */
  deep: string;
  light: string;
}

/** 柱子数量。56 根在 2D 下足够密，又不会每帧画太多路径 */
const BAR_COUNT = 56;
/** 静音/暂停时的电平下限（与 audioGraph.readLevels 的 floor 同量级，避免柱子归零像坏了） */
const IDLE_LEVEL = 0.04;

export function SpectrumScene({ active, isPlaying, deep, light }: SpectrumSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 拿不到音频图 → true → 切 CSS 降级动画
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!active || fallback) return;

    let alive = true;
    let raf = 0;
    let node: AnalyserNode | null = null;

    // 只取现成图；取不到就降级（不建图、不外抛）
    void attachAnalyser(findAudioElement()).then((g) => {
      if (!alive) return;
      if (g) node = g.node;
      else setFallback(true);
    });

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      // 尺寸跟随容器（首次或窗口变化时重设）
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#05070c';
      ctx.fillRect(0, 0, w, h);

      // 暂停或没有图时：用下限电平画一条静止的基线（"静止回落"）
      const levels =
        node && isPlaying
          ? readLevels(node, BAR_COUNT, IDLE_LEVEL)
          : (new Array(BAR_COUNT).fill(IDLE_LEVEL) as number[]);

      // 横向基线网格（低成本地给出"地形"的纵深感）
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      const baseline = h * 0.72;
      for (let k = 1; k <= 3; k++) {
        const y = baseline + (h - baseline) * (k / 4);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const barW = w / BAR_COUNT;
      const maxBarH = h * 0.46;
      const grad = ctx.createLinearGradient(0, baseline, 0, baseline - maxBarH);
      grad.addColorStop(0, deep);
      grad.addColorStop(1, light);
      ctx.fillStyle = grad;

      for (let i = 0; i < BAR_COUNT; i++) {
        // 圆拱包络：中间高、两侧低，读起来像一片起伏的地形而不是一条平齐的柱阵
        const envelope = 0.45 + 0.55 * Math.sin((Math.PI * i) / (BAR_COUNT - 1));
        const bh = Math.max(2, levels[i] * envelope * maxBarH);
        const x = i * barW;
        const bw = Math.max(1, barW * 0.62);
        // 柱体：从基线向上
        ctx.fillRect(x + (barW - bw) / 2, baseline - bh, bw, bh);
        // 倒影：向下的浅色镜像，让"站立在网格上"的感觉更稳
        ctx.globalAlpha = 0.18;
        ctx.fillRect(x + (barW - bw) / 2, baseline, bw, bh * 0.5);
        ctx.globalAlpha = 1;
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [active, fallback, isPlaying, deep, light]);

  // 非该皮肤：不渲染、不跑 RAF
  if (!active) return null;

  return (
    <div className="skin-spectrum-layer" aria-hidden>
      {fallback ? (
        // 降级：纯 CSS 动画频谱（拿不到音频图时仍有一屏会动的画面）
        <div className="skin-spectrum-fallback" style={{ background: '#05070c' }}>
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              className="skin-spectrum-fbar"
              style={{
                background: `linear-gradient(180deg, ${light}, ${deep})`,
                animationDelay: `${(i % 12) * 0.09}s`,
              }}
            />
          ))}
        </div>
      ) : (
        <canvas ref={canvasRef} className="skin-spectrum-canvas" />
      )}
    </div>
  );
}
