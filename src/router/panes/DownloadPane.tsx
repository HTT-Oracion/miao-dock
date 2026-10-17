import { useNavigate, useOutletContext } from 'react-router-dom';
import { Btn } from '@components/units';
import { errorText } from '@/ipc';
import { useEngineDownload, useToasts } from '@hooks';
import { DEFAULT_PATH } from '@/router/routes';
import type { ShellCtx } from '@/router/panes/shell-context';
import { DownloadPanel } from '@screens/engine/DownloadPanel';

/**
 * 独立下载页（`/engine-download`）的屏装配件。
 *
 * ## 为什么是路由而不是覆盖层
 * 「返回上一个操作页面」要真的走浏览器返回栈；覆盖层只能自己记来源，刷新即丢。
 * 路由也让下载页可深链（排障时直接把地址发给用户）。
 *
 * ## 关闭与返回是两件事
 * · 返回：下载继续在后台跑，侧栏入口保留；
 * · 关闭（仅 done）：写 dismissal、移除侧栏入口，再返回。
 */
export function DownloadPane() {
  const { status, download, downloadEntry, dismissDownload, applyDownload } = useOutletContext<ShellCtx>();
  const navigate = useNavigate();
  const { push } = useToasts();
  const { start } = useEngineDownload();

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

  if (!download || downloadEntry === 'hidden') {
    return (
      <div className="notready">
        <div className="nr-sum">
          <span className="nr-dot" />
          <div>
            <div className="nr-sum-t">当前没有进行中的下载</div>
            <div className="nr-sum-d">下载会在后台继续；完成后可从侧栏的下载入口回来看结果。</div>
          </div>
        </div>
        <div className="nr-acts">
          <Btn kind="primary" onClick={back}>
            返回
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <DownloadPanel
      view={download}
      requiredBytes={status?.runtime?.requiredBytes}
      onContinue={() => void run(false)}
      onRedownload={() => void run(true)}
      onBack={back}
      onClose={() => {
        dismissDownload();
        back();
      }}
    />
  );
}
