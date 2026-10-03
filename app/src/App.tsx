import { useCallback, useMemo, useState } from 'react';
import { apiPost, errorText, isApiError, openPath, quitApp, serviceRestart } from './ipc';
import { useLibrary, useQuitRequest, useService, useTasks, useToasts } from './hooks';
import { initialMode, persistMode, useThemeTokens } from './theme/apply';
import type { ThemeMode } from './theme/tokens';
import { Badge, Btn, Pill } from './components/atoms';
import { QuitConfirm } from './components/QuitConfirm';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { ViewTabs } from './components/ViewTabs';
import { QueueEmpty, QueueTable } from './screens/QueueScreen';
import { NotReadyScreen } from './screens/NotReadyScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { DropScreen } from './screens/DropScreen';
import { MusicScreen } from './screens/MusicScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import {
  isBlockedWhenNotReady,
  stateView,
  type Screen,
  type TranslateView,
} from './nav';
import type { CancelResponse, LibraryResponse, TaskRow } from './types';
import { formatBytes } from './util';

/**
 * 喵坞应用外壳（《02》§5.1 / 《09》§3）：侧栏 78 + 工具条 62 + 应用区。
 *
 * ## 一处刻意的取舍：服务未就绪时，哪些屏让位
 *
 * 让位：翻译三视图（数据全在服务里，没服务毫无意义）→ 让位给 X-C3。
 * 不让位：设置页（承载「看状态、重启服务、复制令牌、切主题、跑规格自检」，
 * 恰恰是服务出问题时最需要用到的那一屏，挡掉只会让人更没辙）；音乐屏
 * （ver2.0 起为独立应用，与翻译引擎无依赖关系）。
 * 判定集中在 `isBlockedWhenNotReady` 一处，避免拦截纪律散落到多处失效。
 */
export function App() {
  const [screen, setScreen] = useState<Screen>('translate');
  const [view, setView] = useState<TranslateView>('drop');
  const [mode, setMode] = useState<ThemeMode>(() => initialMode());
  const [quitOpen, setQuitOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useThemeTokens(mode);

  const { status, ipcError } = useService();
  const running = status?.state === 'running';
  const { data: tasks, error: tasksError, reload: reloadTasks } = useTasks(running);
  const { data: lib, error: libError } = useLibrary(running, refreshKey);
  const { toasts, push } = useToasts();

  useQuitRequest(() => setQuitOpen(true));

  const setTheme = useCallback((m: ThemeMode) => {
    setMode(m);
    persistMode(m);
  }, []);

  const refreshAll = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void reloadTasks();
  }, [reloadTasks]);

  const restart = useCallback(async () => {
    try {
      push('正在重启本地服务…', 'info');
      await serviceRestart();
    } catch (e) {
      push(errorText(e), 'bad');
    }
  }, [push]);

  const rows = tasks?.tasks ?? [];
  const hasRows = rows.length > 0;
  const queueDepth = (tasks?.running ?? 0) + (tasks?.queued ?? 0);
  const libRoot = (lib as LibraryResponse | null)?.root ?? status?.root_dir ?? '';

  const cancel = async (t: TaskRow) => {
    try {
      const r = await apiPost<CancelResponse>(`/tasks/${t.taskId}/cancel`, {});
      push(`已取消「${t.comicName}」，保留了 ${r.keptItems} 张已落盘的译文`, 'info');
      refreshAll();
    } catch (e) {
      push(errorText(e), 'bad');
    }
  };

  /**
   * 「重试」走的是**本地续做**（`POST /library/{name}/resume`），不是重新上传：
   * 服务端不保留已上传的原图字节，但原图早已落盘，续做直接读磁盘补缺页。
   * 因此重试不会新增编号、不会覆盖原图（spec-notes G-07）。
   */
  const retry = async (t: TaskRow) => {
    try {
      await apiPost(`/library/${encodeURIComponent(t.comicName)}/resume`, {});
      push(`「${t.comicName}」的待译页已重新加入队列`, 'good');
      refreshAll();
    } catch (e) {
      // 没有缺页时服务端返回 404 —— 对用户来说这是「已经译完了」，不是错误
      if (isApiError(e) && e.status === 404) push(`「${t.comicName}」没有待续做的页`, 'info');
      else push(errorText(e), 'bad');
    }
  };

  const openTaskDir = (t: TaskRow) => {
    openPath(t.outputDir).catch((e: unknown) => push(errorText(e), 'bad'));
  };

  const blocked = !running;
  // 哪些屏在服务未就绪时让位，判定集中在 nav.ts 一处（设置页与音乐屏有例外）
  const showNotReady = blocked && isBlockedWhenNotReady(screen);

  const libSummary = useMemo(() => {
    const l = lib as LibraryResponse | null;
    if (!l) return '扫描中…';
    return `${l.count} 部 · ${l.totalImages} 张 · 占 ${formatBytes(l.totalBytes)} · ${l.root}`;
  }, [lib]);

  const toolbar = useMemo(() => {
    if (showNotReady) {
      return {
        title: '服务未就绪',
        subtitle: '本地翻译服务还没起来；起来之后这里会显示任务队列',
        actions: <ServicePill status={status?.state ?? 'starting'} />,
      };
    }
    // 音乐屏不随翻译服务状态变化：它的标题恒定，占位内容自己说明进度
    if (screen === 'music') {
      return {
        title: '音乐',
        subtitle: '本地音乐与在线音源 · ver2.0 新增应用（播放内核待实现）',
        actions: null,
      };
    }
    if (screen === 'settings') {
      return { title: '设置', subtitle: '令牌配对 · 外观 · 规格自检', actions: null };
    }
    // 翻译应用内：工具条随视图切换（与 ver1.0 同一套文案，只是判定源从 screen 变成 view）
    switch (view) {
      case 'library':
        return {
          title: '本地漫画库',
          subtitle: libSummary,
          actions: (
            <>
              <Btn kind="ghost" onClick={() => openPath(libRoot).catch((e: unknown) => push(errorText(e), 'bad'))}>
                打开根目录
              </Btn>
              <Btn kind="primary" onClick={() => setView('drop')}>
                继续翻译
              </Btn>
            </>
          ),
        };
      case 'drop':
        return {
          title: '本机投放',
          subtitle: '拖入图片或文件夹 · 与插件共用同一条队列',
          actions: <Badge>单次上限 20 张</Badge>,
        };
      default:
        return {
          title: '任务队列',
          subtitle: `串行执行 · 同一时刻只跑 1 个任务 · 队内 ${queueDepth} 个`,
          actions: (
            <>
              <Badge>单次上限 20 张</Badge>
              <ServicePill status={status?.state ?? 'starting'} />
            </>
          ),
        };
    }
  }, [libRoot, libSummary, push, queueDepth, screen, showNotReady, status?.state, view]);

  // 翻译应用的视图 Tab 行；音乐屏不加（《09》§3.3），设置页是全局页也不加
  const showViewTabs = !showNotReady && screen === 'translate';

  return (
    <div className="shell">
      <Sidebar screen={screen} onScreen={setScreen} state={status?.state ?? 'starting'} />

      <div className="main">
        <Toolbar title={toolbar.title} subtitle={toolbar.subtitle} actions={toolbar.actions} />

        {showViewTabs ? <ViewTabs view={view} onView={setView} /> : null}

        <div className="content">
          {ipcError ? (
            <div className="notice is-bad">
              <b>无法与桌面端主进程通信。</b> {ipcError}
            </div>
          ) : null}

          {showNotReady ? (
            <NotReadyScreen status={status} onRestart={() => void restart()} />
          ) : screen === 'music' ? (
            <MusicScreen />
          ) : screen === 'translate' ? (
            view === 'queue' ? (
              hasRows ? (
                <QueueTable rows={rows} onCancel={cancel} onRetry={retry} onOpen={openTaskDir} />
              ) : (
                <QueueEmpty onGoPlugin={() => setScreen('settings')} onGoDrop={() => setView('drop')} />
              )
            ) : view === 'library' ? (
              <LibraryScreen lib={lib} onRefresh={refreshAll} onToast={push} refreshKey={refreshKey} />
            ) : (
              <DropScreen
                rootDir={status?.root_dir ?? null}
                onSubmitted={refreshAll}
                onToast={push}
                onGoLibrary={() => setView('library')}
              />
            )
          ) : (
            <SettingsScreen status={status} mode={mode} onMode={setTheme} onToast={push} />
          )}

          {tasksError ? <div className="notice is-bad">任务列表读取失败：{tasksError}</div> : null}
          {libError ? <div className="notice is-bad">漫画库读取失败：{libError}</div> : null}
        </div>
      </div>

      {quitOpen ? (
        <QuitConfirm onStay={() => setQuitOpen(false)} onQuit={() => void quitApp()} />
      ) : null}

      <div className="toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={t.kind === 'bad' ? 'toast is-bad' : t.kind === 'good' ? 'toast is-good' : 'toast'}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function ServicePill({ status }: { status: 'stopped' | 'starting' | 'running' | 'error' }) {
  const v = stateView(status);
  return <Pill colorVar={v.colorVar}>{v.text}</Pill>;
}
