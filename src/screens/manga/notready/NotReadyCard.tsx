import type { ReactNode } from 'react';
import { Mascot } from '@components/units';

/**
 * 引导页的**卡片外壳** —— 设计稿 `.notready > .nr-wrap > .nr-card` 的那三层。
 *
 * ## 为什么要有这一层
 * 引导页有三种形态（在线精简页 / 装配流程页 / 服务状态页），它们的**前四块完全相同**：
 * 页面内距 → 居中容器 → 白卡 → 插画 → 状态胶囊 → 大标题 → 说明。三种形态各自写一遍
 * 就是三份会漂移的 DOM（改一处忘了另两处，表现是"同一张卡在三种状态下边距不一样"）。
 * 这里把它收成一处：形态只负责"标题之后画什么"。
 *
 * ## 为什么装饰弧在这里而不在样式里
 * `.nr-card::after` 是**纯装饰**（右上角一团淡色）。它必须挂在卡上、且卡要 `overflow:hidden`
 * —— 两者分居 JSX 与 CSS 时，任一边被改成"另一个容器"都会让弧跑出卡片外（实测过一次：
 * 弧跑到 `.nr-wrap` 上，横向多出 30px 滚动条）。所以结构固定在这里，样式只管画。
 */
export function NotReadyCard({
  mood,
  kicker,
  title,
  desc,
  children,
}: {
  /** 插画表情：`sleep` 用于"需要处理 / 没起来"这类更安静的语境 */
  mood?: 'sleep';
  /** 状态胶囊（`.nr-kicker` 里那一枚） */
  kicker: ReactNode;
  title: ReactNode;
  desc: ReactNode;
  /** 标题与说明之后的内容（动作行 / 时间线 / 诊断 / 两栏面板…） */
  children: ReactNode;
}) {
  return (
    <div className="notready">
      <div className="nr-wrap">
        <section className="nr-card">
          <div className="nr-illu">
            <Mascot mood={mood} />
          </div>
          <div className="nr-kicker">{kicker}</div>
          <h1 className="nr-title">{title}</h1>
          <p className="nr-desc">{desc}</p>
          {children}
        </section>
      </div>
    </div>
  );
}
