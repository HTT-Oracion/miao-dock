import type { ModelDownloadView } from '@screens/settings/engine-api';

/**
 * 引擎下载态 → 工具条芯片的**唯一映射**（与 `nav.ts` 的 `STATE_VIEW` 并列，不混用）。
 *
 * ## 为什么单独成文件
 * 工具条右侧那枚「引擎下载中 / 下载中断」芯片的文案、色相、是否可点击、是否带进度环，
 * 全部由这里一处推导。与 `STATE_VIEW`（服务五态）刻意**分开**：下载态不是服务态
 * （下载时服务本就未启动），混进去会让用户以为「下载完服务必然就绪」。
 *
 * 🔴 纪律（与方案 §关键交互决策同）：
 *   · 只在 `running` / `interrupted` / `failed` / 「缺件未开始」时出现；
 *   · `done` **不**在这里出现 —— 完成后回到服务五态（由 `STATE_VIEW` 负责），
 *     避免两种语义相互冒充。
 *   · 文案严格区分「继续下载」（补齐缺口）与「重新下载」（从头再来），不编一种。
 */
export interface DownloadChip {
  /** 芯片文案 */
  text: string;
  /** 色相令牌（`--md-*`）；颜色只由状态点承载 */
  colorVar: string;
  /** 是否可点击（点了回下载视图） */
  clickable: boolean;
  /** 是否展示细环形进度（仅 `running`） */
  showRing: boolean;
  /** 环心百分比（`showRing=true` 时取；`null` = 准备中，不显示假 0%） */
  percent: number | null;
  /** 是否警示色（中断 / 失败），右侧据此放播放按钮 */
  isAlert: boolean;
}

/**
 * 由 `modelDownload` 视图推导工具条芯片。
 *
 * @param view      `/engine/status` 的 `modelDownload`
 * @param engineMissing 运行时是否缺件（未装配）—— 决定 `idle` 态要不要给「需下载引擎」
 * @returns 不需要展示下载芯片（应回落服务五态）时返回 `null`
 */
export function engineDownloadChip(
  view: ModelDownloadView | null | undefined,
  engineMissing: boolean,
): DownloadChip | null {
  if (!view) return null;
  switch (view.state) {
    case 'running':
      return {
        text: '引擎下载中',
        colorVar: '--md-blue',
        clickable: true,
        showRing: true,
        percent: view.percent,
        isAlert: false,
      };
    case 'interrupted':
      return {
        text: '下载中断',
        colorVar: '--md-error',
        clickable: true,
        showRing: false,
        percent: null,
        isAlert: true,
      };
    case 'failed':
      return {
        text: '下载失败',
        colorVar: '--md-error',
        clickable: true,
        showRing: false,
        percent: null,
        isAlert: true,
      };
    case 'idle':
      // 缺件未开始 ⇒ 给一枚可点击的「需下载引擎」，引导用户去引导/下载页。
      if (engineMissing) {
        return {
          text: '需下载引擎',
          colorVar: '--md-warning',
          clickable: true,
          showRing: false,
          percent: null,
          isAlert: false,
        };
      }
      return null;
    default:
      // done 等终态：回落服务五态，本文件不接管。
      return null;
  }
}

/** 下载态是否「进行中或待续」（决定内容区要不要切到下载视图） */
export function isDownloadActive(view: ModelDownloadView | null | undefined): boolean {
  if (!view) return false;
  return view.state === 'running' || view.state === 'interrupted' || view.state === 'failed';
}
