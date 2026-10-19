/**
 * 数据源与 BT（设计稿 ⑨）：源列表 + 编辑器入口 + BT 任务 + Peer/PikPak。
 *
 * 源列表只列**真实存在**的两项（内置本地源 / 本地缓存）；在线源、BT、媒体服务器
 * 随 M3/M5 接入后出现。编辑器入口现在禁用并写明"什么时候能用"，不做一个点了没反应的按钮。
 */
import { Plus, RefreshCw } from 'lucide-react';
import { Btn, Empty } from '@components/units';
import { formatBytes } from '@tools';
import { useAnimeStore } from '@anime/store';
import { SOURCE_KIND_LABEL } from '@anime/player-options';
import { ProgressBar, SectionHead } from '@screens/anime/shared';

export function SourceScreen() {
  const sources = useAnimeStore((s) => s.sources);
  const cache = useAnimeStore((s) => s.cache);
  const status = useAnimeStore((s) => s.status);
  const loadSources = useAnimeStore((s) => s.loadSources);
  const refresh = useAnimeStore((s) => s.refreshLibrary);
  const setView = useAnimeStore((s) => s.setView);

  const bt = cache.filter((t) => t.state === 'downloading' || t.state === 'seeding' || t.state === 'paused');

  return (
    <div className="an-screen an-pad">
      <div className="an-hd-row">
        <b>数据源与 BT</b>
        <span className="an-sp" />
        <Btn kind="ghost" size="sm" onClick={() => void loadSources()} title="重新读取数据源">
          <RefreshCw size={13} /> 刷新
        </Btn>
        <Btn kind="primary" size="sm" disabled title="添加源（M3 开放）">
          <Plus size={13} /> 添加源
        </Btn>
      </div>

      <div className="an-panel">
        <SectionHead
          title="动漫服务"
          action={
            <span className={status?.running ? 'an-chip is-ok' : 'an-chip'}>
              {' '}
              {status?.running ? '运行中' : '未启动'}{' '}
            </span>
          }
        />
        <div className="an-svc-grid">
          <div>
            <span>端口</span>
            <b className="an-num">{status?.port ?? '—'}</b>
          </div>
          <div>
            <span>库根</span>
            <b title={status?.rootDir ?? ''}>{status?.rootDir ?? '—'}</b>
          </div>
          <div>
            <span>状态目录</span>
            <b title={status?.paths.animeStateDir ?? ''}>{status?.paths.animeStateDir ?? '—'}</b>
          </div>
        </div>
        <div className="an-acts" style={{ marginTop: 8 }}>
          <Btn kind="ghost" size="sm" onClick={() => void refresh()} title="重新扫描番剧库">
            <RefreshCw size={13} /> 重新扫描
          </Btn>
        </div>
      </div>

      <SectionHead title="媒体源" count={sources.length} />
      {sources.length === 0 ? (
        <Empty inline>还没有数据源。刷新一次；内置源会随模块一起出现。</Empty>
      ) : (
        <div className="an-src-list">
          {sources.map((s) => (
            <div key={s.id} className={s.enabled ? 'an-src-row' : 'an-src-row is-off'}>
              <span
                className={s.health === 'ok' ? 'an-dot is-ok' : s.health === 'timeout' ? 'an-dot is-warn' : 'an-dot'}
              />
              <span className="an-src-row-tx">
                <b>{s.name}</b>
                <span>
                  {SOURCE_KIND_LABEL[s.kind] ?? s.kind}
                  {s.url ? ` · ${s.url}` : ''}
                </span>
              </span>
              <span className="an-chip is-plain">{s.enabled ? '启用' : '停用'}</span>
            </div>
          ))}
        </div>
      )}

      <section className="an-panel">
        <SectionHead title="自定义源编辑器" />
        <p className="an-note">RSS 源填订阅地址；选择器源点选页面元素生成规则，写完可当场测试一条。</p>
        <div className="an-acts">
          <Btn kind="ghost" size="sm" disabled title="M3 开放">
            RSS 编辑器…
          </Btn>
          <Btn kind="ghost" size="sm" disabled title="M3 开放">
            选择器编辑器…
          </Btn>
          <Btn kind="ghost" size="sm" disabled title="M3 开放">
            导入 / 导出
          </Btn>
        </div>
      </section>

      <SectionHead title="BT 任务" count={bt.length} />
      {bt.length === 0 ? (
        <Empty inline>没有 BT 任务。选一个磁力源开始下载后，任务会在这里，进度条同时喂给边下边播。</Empty>
      ) : (
        bt.map((t) => (
          <div key={t.id} className="an-bt-row">
            <span className="an-bt-tx">
              <b>
                {t.title} · 第 {t.episodeIndex} 话
              </b>
              <span>
                {t.state === 'downloading' ? '下载中' : t.state === 'seeding' ? '做种中' : '已暂停'}
                {t.bufferedMs ? ` · 已缓冲 ${Math.round(t.bufferedMs / 1000)}s` : ''}
              </span>
              <ProgressBar value={t.sizeBytes ? Math.round((t.receivedBytes / t.sizeBytes) * 100) : 0} />
            </span>
            <span className="an-num">
              {formatBytes(t.receivedBytes)} / {formatBytes(t.sizeBytes)}
            </span>
          </div>
        ))
      )}

      <section className="an-panel">
        <SectionHead title="Peer 过滤与 PikPak" />
        <p className="an-note">按规则订阅屏蔽异常 peer；PikPak 云离线可给磁力任务加速。两项随 M5 一起接入。</p>
        <div className="an-acts">
          <Btn kind="ghost" size="sm" onClick={() => setView('states')}>
            去三态页看空态样例
          </Btn>
        </div>
      </section>
    </div>
  );
}
