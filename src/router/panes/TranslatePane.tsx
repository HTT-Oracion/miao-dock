/**
 * 漫画翻译应用的屏装配件（B1 改造的产物）。
 *
 * 它做两件事，按原 App 三元链的顺序：**让位守卫 → 三个视图**。
 * 让位之所以在这里而不是路由表里：它是"服务没起来时这一屏长什么样"，
 * 属于 translate 自己的形态；路由只负责"这个路径属于哪一屏"。
 *
 * 其余数据全部来自 `<Outlet context>`（见 `shell-context.ts`）—— 本组件不自己持状态。
 */
import { useOutletContext } from 'react-router-dom';
import type { ShellCtx } from '@/router/panes/shell-context';
import { NotReadyScreen } from '@screens/library/NotReadyScreen';
import { QueueEmpty, QueueTable } from '@screens/QueueScreen';
import { LibraryScreen } from '@screens/LibraryScreen';
import { DropScreen } from '@screens/DropScreen';

export function TranslatePane() {
  const {
    showNotReady,
    status,
    source,
    download,
    startService,
    restart,
    setScreen,
    setDownloadViewOpen,
    view,
    setView,
    hasRows,
    rows,
    cancelingIds,
    cancel,
    retry,
    viewComic,
    openTaskDir,
    deleteTasks,
    lib,
    libraryFocus,
    setLibraryFocus,
    newBookRequest,
    setNewBookRequest,
    refreshAll,
    refreshKey,
    rootDir,
  } = useOutletContext<ShellCtx>();

  if (showNotReady) {
    return (
      <NotReadyScreen
        status={status}
        source={source}
        // D-231⑥：四段装配时间线的进度事实源。壳层 `download` 本来就有（工具条芯片与
        // 下载视图都读它），这里只透传，**不扩壳层契约**。
        download={download}
        onStart={() => void startService()}
        onRestart={() => void restart()}
        // D1：「运行时未装配」态上的指引入口 —— 送到设置页（翻译服务组里有引擎诊断与装法）
        onOpenGuide={() => setScreen('settings')}
        // G5：点「开始下载」⇒ 发起下载并把内容区切到下载视图。
        onOpenDownload={() => setDownloadViewOpen(true)}
      />
    );
  }

  if (view === 'queue') {
    return hasRows ? (
      <QueueTable
        rows={rows}
        cancelingIds={cancelingIds}
        onCancel={cancel}
        onRetry={retry}
        onViewComic={viewComic}
        onOpenDir={openTaskDir}
        onDelete={deleteTasks}
      />
    ) : (
      <QueueEmpty onGoSettings={() => setScreen('settings')} onGoDrop={() => setView('drop')} />
    );
  }

  if (view === 'library') {
    return (
      <LibraryScreen
        lib={lib}
        tasks={rows}
        focus={libraryFocus}
        onFocusHandled={() => setLibraryFocus(null)}
        newBookSignal={newBookRequest}
        onNewBookHandled={() => setNewBookRequest(false)}
        onRefresh={refreshAll}
        refreshKey={refreshKey}
      />
    );
  }

  return <DropScreen rootDir={rootDir} onSubmitted={refreshAll} onGoLibrary={() => setView('library')} />;
}
