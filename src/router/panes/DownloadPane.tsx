import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Btn } from '@components/units';
import { errorText } from '@/ipc';
import { useEngineDownload, useToasts } from '@hooks';
import { toastBus } from '@/stores/toastBus';
import { useDemoOverride } from '@/stores/demo-override';
import { demoDownload } from '@screens/manga/demo';
import { DEFAULT_PATH } from '@/router/routes';
import { assemblyNotes } from '@screens/manga/assembly';
import type { ShellCtx } from '@/router/panes/shell-context';
import { DownloadPanel } from '@screens/engine/DownloadPanel';
import { pauseEngineDownload } from '@screens/settings/engine-api';
import type { ModelDownloadView } from '@screens/settings/engine-api';

/**
 * 预检态的"还没开始"视图（`state='idle'`）。
 *
 * 🔴 字段全部是 `null` / 空 —— 预检页要显示的是**还没有**的进度：
 *    编一个 0% 或一段假字节会让"还没开始"读成"卡住了"。
 */
function idleDownloadView(): ModelDownloadView {
  return {
    state: 'idle',
    running: false,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    tail: [],
    rootDir: '',
    manifest: '',
    runner: '',
    runnerExists: false,
    percent: null,
    receivedBytes: null,
    totalBytes: null,
    speedBps: null,
    etaMs: null,
    stage: null,
    step: null,
    currentId: null,
    assemblyPercent: null,
    assemblyIndeterminate: false,
    canResume: false,
    interruptedReason: null,
  };
}

/**
 * 独立下载页（`/engine-download`）的屏装配件。
 *
 * ## 为什么是路由而不是覆盖层
 * 「返回上一个操作页面」要真的走浏览器返回栈；覆盖层只能自己记来源，刷新即丢。
 * 路由也让下载页可深链（排障时直接把地址发给用户）。
 *
 * ## 引导页的 CTA 是**先看预检、再开始**（设计稿口径）
 * 设计稿的首次装配流程是「CTA 打开下载页预检态 → 确认目录 / 磁盘 / 模型源后才创建下载任务」。
 * 所以引导页点「开始下载」只**打开本页**，真正的 `start()` 落在本页的「开始下载」上。
 *
 * 🔴 例外：**已经在下载**（`running` / `interrupted`）时直接进本页继续看进度 ——
 *    那种情况下再让用户点一次"开始下载"等于让同一个任务开第二遍。
 *
 * ## 关闭与返回是两件事
 * · 返回：下载继续在后台跑，侧栏入口保留；
 * · 关闭（仅 done）：写 dismissal、移除侧栏入口，再返回。
 */
export function DownloadPane() {
  const { status, download, dismissDownload, applyDownload } = useOutletContext<ShellCtx>();
  /** 当前是否处在演示态（演示夹具的下载任务在服务端并不存在，动作不能真打后端） */
  const demoActive = useDemoOverride((s) => s.active);
  const navigate = useNavigate();
  const { push } = useToasts();
  const { start } = useEngineDownload();
  /*
   * 预检态：本页可以被"还没有任何下载记录"的入口打开（引导页的「开始下载」）。
   * 真机上这个入口几乎必走 —— 首次装配时 `download` 恒为 `idle`，
   * 若没有这一层，`.ed-preflight` 永远画不出来。
   */
  const [preflight] = useState(true);

  const back = () => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate(DEFAULT_PATH, { replace: true });
  };

  const run = async (fresh: boolean) => {
    try {
      const r = await start(fresh);
      applyDownload(r.view);
    } catch (e) {
      push(errorText(e), 'bad');
    }
  };

  /**
   * 暂停：服务端杀下载子进程、`.part` 留盘 ⇒ 之后「继续下载」接着下。
   * 失败（例如刚好自己下完了，服务端回 409 `DOWNLOAD_NOT_RUNNING`）如实弹错，不假装成功。
   *
   * 🔴 **演示态下不打后端**：演示面板把"五段装配中"做成夹具（`screens/manga/demo.ts`），
   *    服务端并没有这条下载任务。真打过去会收到 409「当前没有正在进行的下载」，
   *    而界面上明明显示"下载中" —— 用户看到的是自相矛盾的两句话。
   *    演示态该做的是**在夹具上模拟暂停**，不是去杀一个不存在的进程。
   */
  const pause = async () => {
    if (demoActive) {
      applyDownload(demoDownload(download, 'unassembled'));
      toastBus.push('已暂停下载（演示）', 'info', '演示态不会真的中断后台任务');
      return;
    }
    try {
      const r = await pauseEngineDownload();
      applyDownload(r.download);
    } catch (e) {
      push(errorText(e), 'bad');
    }
  };

  /*
   * 无下载记录时的两种形态：
   *  · **预检态**（`preflight` 或"运行时确实缺件"）：画完整的下载页（环 + 预检四格 + 五段），
   *    用户在这里确认目录与体积后才点「开始下载」—— 这是设计稿规定的首次装配路径；
   *  · **空态**：既不缺件也没下载过 ⇒ 说清"没有进行中的下载"，给一条返回。
   */
  const idleView = preflight || status?.runtime?.ready === false;
  if (!download && !idleView) {
    return (
      <div className="notready">
        <div className="nr-wrap">
          <section className="nr-card">
            <div className="nr-kicker">
              <span className="chip chip-soft">本地服务</span>
            </div>
            <h1 className="nr-title">当前没有进行中的下载</h1>
            <p className="nr-desc">下载会在后台继续；完成后可从侧栏的下载入口回来看结果。</p>
            <div className="nr-actions">
              <Btn kind="primary" onClick={back}>
                返回
              </Btn>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <DownloadPanel
      // 没有下载记录时给一具 `idle` 视图：预检态要能画环、画四格、画五段
      view={download ?? idleDownloadView()}
      // 预检里的「总下载」三段与「保存位置」都从服务状态读（不自己估体积）
      status={status}
      // 五段形态与引导页同一处算（不是下载页自己拼一套）
      notes={assemblyNotes(status, download)}
      onContinue={() => void run(false)}
      onRedownload={() => void run(true)}
      onPause={() => void pause()}
      onBack={back}
      onClose={() => {
        dismissDownload();
        back();
      }}
    />
  );
}
