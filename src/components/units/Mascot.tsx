/**
 * 空态插画（设计稿 `.mascot-svg`）。
 *
 * 一只趴在纸上的猫 —— 设计稿在**所有空态**里都用它（搜索结果为空、右栏无播放、
 * 漫画库为空…），是空态的**统一面孔**，不是某屏的私有装饰。
 *
 * ## 为什么画成内联 SVG 而不是一张图
 * 它全部由 `var(--surface)` / `var(--ink)` / `var(--accent)` 这类语义令牌上色，
 * 深色主题与六套皮肤都能跟着走；换成 PNG 就要为每个主题各出一份，且颜色一改就脱节。
 *
 * ## `mood`
 * `sleep` 多画三笔"困意"（Z 字），用于「还没有内容」这类需要更安静语气的空态。
 */
export function Mascot({ mood }: { mood?: 'sleep' }) {
  return (
    <svg className="mascot-svg" viewBox="0 0 132 112" fill="none" aria-hidden="true">
      <ellipse cx="66" cy="102" rx="40" ry="5" fill="var(--miao-line)" opacity=".7" />
      <path
        d="M36 56c0-18 13-30 30-30s30 12 30 30v22c0 12-13 20-30 20s-30-8-30-20V56Z"
        fill="var(--miao-surface)"
        stroke="var(--miao-ink)"
        strokeWidth="1.8"
      />
      <path
        d="M42 32 38 13l17 10M90 32l4-19-17 10"
        fill="var(--miao-surface-2)"
        stroke="var(--miao-ink)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M46 57c3-4 8-4 11 0M75 57c3-4 8-4 11 0" stroke="var(--miao-ink)" strokeWidth="2" strokeLinecap="round" />
      <path d="M62 68c3 3 7 3 10 0" stroke="var(--miao-ink)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M56 38c4-6 16-6 20 0" stroke="var(--miao-accent-ink)" strokeWidth="1.2" opacity=".55" />
      <path
        d="M51 79c-8 0-14 5-14 12v9h60v-9c0-7-6-12-14-12"
        fill="var(--miao-surface-2)"
        stroke="var(--miao-ink)"
        strokeWidth="1.8"
      />
      <rect
        x="72"
        y="72"
        width="38"
        height="28"
        rx="3"
        fill="var(--miao-accent-soft)"
        stroke="var(--miao-ink)"
        strokeWidth="1.5"
        transform="rotate(-6 91 86)"
      />
      <path
        d="M79 82h24M79 88h17"
        stroke="var(--miao-ink)"
        strokeWidth="1.1"
        opacity=".5"
        transform="rotate(-6 91 86)"
      />
      <path d="M104 49l1.8 4.2 4.2 1.8-4.2 1.8L104 61l-1.8-4.2L98 55l4.2-1.8z" fill="var(--miao-accent)" opacity=".8" />
      <path d="M24 42l1.2 2.8 2.8 1.2-2.8 1.2L24 50l-1.2-2.8L20 46l2.8-1.2z" fill="var(--miao-accent)" opacity=".6" />
      {mood === 'sleep' ? (
        <path
          d="M104 31q4-3 8 0M106 26l4 0M106 23l5 0"
          stroke="var(--miao-muted)"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}
