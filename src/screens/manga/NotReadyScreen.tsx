import { useState } from 'react';
import { errorText } from '@/ipc';
import { useEngineDownload, useToasts } from '@hooks';
import type { ServiceStatus } from '@/ipc';
import type { ModelDownloadView } from '@screens/settings/engine-api';
import type { TranslateSource } from '@screens/settings/translate-api';
import { ASSEMBLY_PHASES, assemblyNotes, type StageNote } from '@screens/manga/assembly';
import { AssemblyForm } from '@screens/manga/notready/AssemblyForm';
import { OnlineForm } from '@screens/manga/notready/OnlineForm';
import { ServiceForm } from '@screens/manga/notready/ServiceForm';
import { hasStartedDownload, isRuntimeUnready, lastLogLine, logOpenByDefault } from '@screens/manga/notready/derive';

/**
 * 引导页（服务未就绪 / 启动中 / 引擎未装配）—— 结构照设计稿 `.notready > .nr-wrap > .nr-card`。
 *
 * ## 本文件只做一件事：**分派**
 * 三种形态各自住在 `notready/` 下，这里只算共用派生量、按状态选一个形态渲染：
 *
 * | 形态 | 文件 | 判据 |
 * |---|---|---|
 * | ① 在线精简页 | `OnlineForm` | `source === 'online'` |
 * | ② 装配流程页 | `AssemblyForm` | `isRuntimeUnready(status)` |
 * | ③ 服务状态页 | `ServiceForm` | 其余（stopped / starting / stopping / error / running） |
 *
 * 拆开的理由：三种形态的**结构差得很远**（一句摘要 vs 五段时间线 + 两栏 vs 诊断三格），
 * 塞进一个组件后每个分支都要重读整份 JSX 才能确认"我改的这处影响哪几态"。
 *
 * ## 五段与「下载两步」不是同一台状态机
 * `modelDownload.step`（prepare/runtime/visual/llm）回答装配到哪一段；
 * `modelDownload.stage`（stage1/stage2）只服务下载详情页的两轮指示器。
 * 本屏只消费前者与 `runtime.sets`，不拿 `status.phase` 当进度事实源。
 */
export function NotReadyScreen({
  status,
  source,
  download,
  onStart,
  onRestart,
  onOpenGuide,
  onOpenDownload,
  onDownloadStarted,
}: {
  status: ServiceStatus | null;
  /** 翻译来源（P-D1 / P-D3）。`online` 时本屏走**精简页** */
  source: TranslateSource | null;
  /** 引擎下载态 —— 五段时间线的唯一进度事实源 */
  download: ModelDownloadView | null;
  /** 手动启动（仅 `stopped` 时用） */
  onStart: () => void;
  onRestart: () => void;
  /** 运行时尚缺件时的指引入口（设置页完整诊断） */
  onOpenGuide: () => void;
  /** 开始/继续下载后切到下载页 */
  onOpenDownload: () => void;
  /** 把刚发起的下载视图写回壳层（下载页立刻有内容） */
  onDownloadStarted: (view: ModelDownloadView | null) => void;
}) {
  const { push: onToast } = useToasts();
  const { busy, start } = useEngineDownload();
  const [userLog, setUserLog] = useState<boolean | null>(null);

  const state = status?.state ?? 'starting';
  const failed = state === 'error';
  /** 日志默认展开只在失败时（用户第一眼就该看到原因）；用户手动切过之后以手动为准 */
  const logOpen = userLog ?? logOpenByDefault(failed);
  const toggleLog = () => setUserLog(!logOpen);

  const notes: StageNote[] = assemblyNotes(status, download);
  const activeIndex = notes.findIndex((n) => n === 'active' || n === 'failed');
  const detail = lastLogLine(status?.log);

  // ---- 形态① 在线精简页 ----
  if (source === 'online') {
    return <OnlineForm status={status} onStart={onStart} onRestart={onRestart} />;
  }

  // ---- 形态② 装配流程页 ----
  if (isRuntimeUnready(status) && status?.runtime) {
    /**
     * CTA 的两种语义（设计稿口径）：
     * · **还没开始**：只打开下载页的预检态，由那一页确认目录 / 体积后再创建下载任务
     *   （设计稿：「CTA 打开下载页预检态，确认目录、磁盘与模型源后才创建下载任务」）；
     * · **已经开过**（中断 / 失败 / 进行中）：直接续传并进下载页 —— 再确认一遍等于把同一件事问两次。
     */
    const onPrimary = async () => {
      if (!hasStartedDownload(download)) {
        onOpenDownload();
        return;
      }
      try {
        const r = await start(false);
        onDownloadStarted(r.view);
        // 单飞守卫（已在下载）也直接去下载页：用户要的是看进度，不是看报错。
        onOpenDownload();
      } catch (e) {
        onToast(errorText(e), 'bad');
      }
    };

    return (
      <AssemblyForm
        status={status}
        download={download}
        notes={notes}
        activeIndex={activeIndex}
        detail={detail}
        logOpen={logOpen}
        busy={busy}
        onToggleLog={toggleLog}
        onPrimary={() => void onPrimary()}
        onOpenGuide={onOpenGuide}
      />
    );
  }

  // ---- 形态③ 服务状态页 ----
  return (
    <ServiceForm
      status={status}
      download={download}
      notes={notes}
      detail={detail}
      logOpen={logOpen}
      busy={busy}
      onToggleLog={toggleLog}
      onStart={onStart}
      onRestart={onRestart}
      onOpenGuide={onOpenGuide}
      onToast={onToast}
    />
  );
}

/** 段名表（给"第 N 段"文案与判据共用；导出避免各处再拼一份） */
export { ASSEMBLY_PHASES };
