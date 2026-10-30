import type { ModelDownloadView } from '@screens/settings/engine-api';
import type { ServiceState } from '@/ipc';

/**
 * 引导页的**全部文案**（设计稿逐字）。
 *
 * ## 为什么文案单独一层
 * 这一屏有三种形态、十来个分支，文案散在 JSX 里时会出现两类问题：
 *  ① 同一句话在两种形态下措辞不同（"服务未启动"与"本地服务没有运行"并存）；
 *  ② 改一个词要翻遍 500 行 JSX。
 * 收成一层之后，**界面文案只有这一处事实源**，判据也可以直接读它。
 *
 * ## 逐字约束
 * 下面每一句都对着设计稿 `js/manga.js` 的 `titleMap` / `descMap` / `nr-*` 抄。
 * 只有一处**刻意偏离**：`descOf('unassembled')` 不含体积字面量 —— 真实体积由
 * `runtime.requiredBytes` 现算后拼在装配页说明里（设计稿的「约 3.6 GB」是演示数据）。
 */

/** 标题（设计稿 `titleMap`，逐字）。 */
export const NOT_READY_TITLE: Record<Exclude<ServiceState, 'running'> | 'unassembled', string> = {
  stopped: '本地翻译服务没有运行',
  starting: '正在启动本地服务',
  stopping: '正在停止本地服务',
  error: '本地服务异常退出',
  unassembled: '翻译引擎还没有装配',
};

/** 说明（设计稿 `descMap`，逐字；未装配那一句按真实下载态分叉）。 */
export function descOf(state: string, download: ModelDownloadView | null): string {
  if (state === 'stopped') {
    return '启动本地服务后即可投放图片。已完成的作品、队列任务与设置都保存在本机，不会丢失。';
  }
  if (state === 'starting') {
    return '正在拉起 mangasvc 与引擎三进程，通常需要几秒钟。请保持喵坞在前台。';
  }
  if (state === 'stopping') {
    return '正在安全收尾正在处理的页面，完成后可以重新启动。';
  }
  if (state === 'error') {
    return '服务进程在启动后退出。下方保留了最近的诊断信息，可以先重启，仍然失败时查看完整日志。';
  }
  if (state === 'unassembled') {
    // 🔴 不带体积字面量：见文件头"逐字约束"
    return download?.state === 'done'
      ? '模型与运行环境已经就绪。启动本地服务后即可开始翻译。'
      : '首次使用需要下载视觉与翻译模型。下一步先确认下载位置与模型源，再开始下载。';
  }
  return '';
}

/** 在线精简页的摘要行：只讲**服务现状**，不掺装配进度。 */
export function summaryOf(
  state: string,
  err: string | null,
  degraded: boolean,
): { bad: boolean; title: string; sub: string } {
  if (state === 'error') {
    return {
      bad: true,
      title: '本地服务没能起来',
      sub: `${err ? `原因：${err} ` : ''}翻译任务暂时提交不了；浏览器插件此刻也会收到 503。`,
    };
  }
  if (degraded) {
    return {
      bad: true,
      title: '服务已降级',
      sub: '② 或 ③ 掉了一个，但 ① 还在 —— 服务能应答，翻译任务会失败。诊断见「设置 → 翻译服务 → 引擎诊断」。',
    };
  }
  if (state === 'running') {
    return { bad: false, title: '本地翻译服务已就绪', sub: '翻译全程在本机完成，图片不会上传到任何远端。' };
  }
  if (state === 'stopped') {
    return {
      bad: false,
      title: '本地服务未启动',
      sub: '点下方「启动本地服务」把它拉起来。首次启动需要装载模型，会慢一些。',
    };
  }
  if (state === 'stopping') {
    return { bad: false, title: '正在停止本地服务', sub: '子进程树回收需要几秒；完成后再点「重启本地服务」。' };
  }
  return {
    bad: false,
    title: '正在准备本地翻译服务',
    sub: '引擎已装好，服务正在把它拉起来；这一步没有可量化的进度，走完即就绪。',
  };
}

/** 下载按钮文案：只按真实 `step` 说，取不到就退回通用句。 */
export function downloadLabelOf(busy: boolean, download: ModelDownloadView | null): string {
  if (busy) return '正在发起…';
  const state = download?.state;
  if (state === 'interrupted' || state === 'failed') return '继续下载';
  if (state !== 'running') return '开始下载';
  if (download?.step === 'visual') return '视觉模型下载中';
  if (download?.step === 'llm' || download?.step === 'models') return '翻译模型下载中';
  return '下载引擎中';
}

/**
 * 装配页顶部那行现状（设计稿 `.nr-guide-note` 的位置）。
 *
 * 三种口径，优先级从高到低：
 *  ① **真的在下载** ⇒ 报"当前处于第 N 段"（用户点完按钮最想知道的就是这句）；
 *  ② **服务没起** ⇒ 说明"下面是磁盘装配状态"，否则已打勾的前两段会被读成"本次启动走到了第二段"；
 *  ③ 其余 ⇒ 报五段顺序。
 */
export function assemblyNoteOf(
  downloading: boolean,
  activeIndex: number,
  stepLabel: string | null,
  state: string,
): string {
  if (downloading && stepLabel) return `当前处于第 ${activeIndex + 1} 段：${stepLabel}`;
  if (state === 'stopped') return '本地服务未启动；下面是磁盘装配状态';
  return '装配分五段：环境 → 运行环境 → 视觉模型 → 翻译模型 → 就绪。';
}
