import { Info, RefreshCw } from 'lucide-react';
import { Btn } from '@components/units';
import type { ModelDownloadView } from '@screens/settings/engine-api';
import type { PreflightView } from '@screens/engine/download/copy';
import { CheckCell } from '@screens/engine/download/CheckCell';

/**
 * 下载前检查（设计稿 `.ed-preflight`）—— 只在 `state === 'idle'` 时渲染。
 *
 * ## 它为什么必须有
 * 设计稿的首次装配路径是「CTA 打开下载页**预检态** → 确认目录 / 磁盘 / 模型源后
 * 才创建下载任务」。没有这一块，用户点「开始下载」就是直接下 3.6 GB，
 * 连"下到哪"都来不及看一眼。
 *
 * ## 第三、四格换过问题
 * 设计稿写的是「磁盘空间 / 模型源延迟」，服务端没有这两个出口。这里换成
 * 「下载器 / 模型清单」两枚**真实判据**（见 `copy.ts` 的 `preflightOf`）。
 */
export function Preflight({
  view,
  data,
  checking,
  onRecheck,
  onOpenDir,
}: {
  view: ModelDownloadView;
  data: PreflightView;
  checking: boolean;
  onRecheck: () => void;
  onOpenDir: () => void;
}) {
  return (
    <section className="ed-preflight">
      <div className="ed-preflight-head">
        <div>
          <span className="modal-kicker">PRE-FLIGHT</span>
          <h3>下载前检查</h3>
          <p>确认保存位置与网络状态后开始；下载中可关闭此页，进度会保留。</p>
        </div>
        <Btn kind="ghost" size="sm" disabled={checking} onClick={onRecheck}>
          <RefreshCw size={13} />
          {checking ? '检测中' : '重新检测'}
        </Btn>
      </div>
      <div className="ed-preflight-grid">
        <CheckCell label="总下载" value={data.total.value} hint={data.total.hint} ok={data.total.ok} />
        <div className="ed-check ed-check-dir">
          <span>保存位置</span>
          <strong className="ed-path" title={view.rootDir}>
            {data.dir || '—'}
          </strong>
          <div className="ed-check-actions">
            <Btn kind="text" onClick={onOpenDir} disabled={!view.rootDir}>
              打开目录
            </Btn>
          </div>
        </div>
        <CheckCell label="下载器" value={data.runner.value} hint={data.runner.hint} ok={data.runner.ok} />
        <CheckCell label="模型清单" value={data.manifest.value} hint={data.manifest.hint} ok={data.manifest.ok} />
      </div>
      <div className="ed-preflight-note">
        <Info size={11} />
        下载支持断点续传；完成后可在本页启动本地服务。
      </div>
    </section>
  );
}
