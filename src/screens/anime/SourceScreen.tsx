/**
 * 数据源与 BT（设计稿 ⑨）：源列表 + 本机导入 + 编辑器入口 + BT 任务 + Peer/PikPak。
 *
 * 源列表是**真的**：内置本地库恒在，用户自建源由服务侧 `<state>/sources.json` 落盘；
 * 在线 / RSS / 选择器 / 媒体服务器 / BT 的适配器按同一契约随后接入（编辑器仍禁用并写明原因）。
 * 「导入本机文件夹」把片复制进库根，是本机数据眼下唯一的入口。
 */
import { useState } from 'react';
import { FolderPlus, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Btn, Empty } from '@components/units';
import { formatBytes } from '@tools';
import { useToasts } from '@hooks';
import * as ipc from '@anime/ipc';
import { useAnimeStore } from '@anime/store';
import { SOURCE_KIND_LABEL } from '@anime/player-options';
import type { AnimeSourceTestItem, MediaSourceView } from '@anime/types';
import { ProgressBar, SectionHead } from '@screens/anime/shared';

/** 用户可自建的源类型（内置源不在列）；适配器未就绪的也列出来，保存后测试会明说 */
const ADDABLE_KINDS: MediaSourceView['kind'][] = ['rss', 'web', 'selector', 'jellyfin', 'emby', 'local', 'bt'];

export function SourceScreen() {
  const sources = useAnimeStore((s) => s.sources);
  const cache = useAnimeStore((s) => s.cache);
  const status = useAnimeStore((s) => s.status);
  const loadSources = useAnimeStore((s) => s.loadSources);
  const refresh = useAnimeStore((s) => s.refreshLibrary);
  const setView = useAnimeStore((s) => s.setView);
  const importFolder = useAnimeStore((s) => s.importFolder);
  const saveSource = useAnimeStore((s) => s.saveSource);
  const deleteSource = useAnimeStore((s) => s.deleteSource);
  const { push } = useToasts();
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ name: string; kind: MediaSourceView['kind']; url: string }>({
    name: '',
    kind: 'rss',
    url: '',
  });
  /** 正在测试的源 id 与它的预览结果（同一次只测一个：避免连点把源打爆） */
  const [testing, setTesting] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; items: AnimeSourceTestItem[] } | null>(null);

  const bt = cache.filter((t) => t.state === 'downloading' || t.state === 'seeding' || t.state === 'paused');

  /** 选一个文件夹 → 复制进库根 → 重新扫描（源目录不动，用户可自行清理） */
  const pickFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: '选择要导入的番剧文件夹' });
    if (!picked || Array.isArray(picked)) return;
    setImporting(true);
    const r = await importFolder(picked);
    push(r.message, r.ok ? 'good' : 'bad');
    setImporting(false);
    void loadSources();
  };

  /** 测试一个源：RSS 拉前几条；其余类型由服务侧明说「未接入」 */
  const testSource = async (s: MediaSourceView) => {
    if (!s.url) {
      push('这个源没有地址，先补上再测', 'bad');
      return;
    }
    setTesting(s.id);
    try {
      const r = await ipc.animeTestSource(s.url, s.kind);
      setPreview({ id: s.id, items: r.items });
      push(`「${s.name}」取到 ${r.count} 条`, 'good');
    } catch (e) {
      setPreview(null);
      push(`测试失败：${e instanceof Error ? e.message : String(e)}`, 'bad');
    } finally {
      setTesting(null);
    }
  };

  /** 保存草稿源：id 用名字的拼音/哈希不可靠，直接用「时间戳 + 名称」保证唯一 */
  const submitDraft = async () => {
    const name = draft.name.trim();
    if (!name) {
      push('先填个源名称', 'bad');
      return;
    }
    await saveSource({
      id: `src-${Date.now().toString(36)}`,
      name,
      kind: draft.kind,
      url: draft.url.trim() || undefined,
      enabled: true,
    });
    setDraft({ name: '', kind: 'rss', url: '' });
    setAdding(false);
    push(`已添加「${name}」，点「测试」看看里面有什么`, 'good');
  };

  return (
    <div className="an-screen an-pad">
      <div className="an-hd-row">
        <b>数据源与 BT</b>
        <span className="an-sp" />
        <Btn kind="ghost" size="sm" onClick={() => void loadSources()} title="重新读取数据源">
          <RefreshCw size={13} /> 刷新
        </Btn>
        <Btn
          kind="primary"
          size="sm"
          disabled={importing}
          onClick={() => void pickFolder()}
          title="把本机文件夹复制进番剧库根"
        >
          <FolderPlus size={13} /> 导入本机文件夹
        </Btn>
        <Btn kind="ghost" size="sm" onClick={() => setAdding((v) => !v)} title="添加一个 RSS / 在线 / 媒体服务器源">
          <Plus size={13} /> 添加源
        </Btn>
      </div>

      {adding && (
        <div className="an-panel">
          <SectionHead title="添加源" />
          <div className="an-src-form">
            <input
              className="an-set-in"
              value={draft.name}
              placeholder="源名称，如 Mikan"
              aria-label="源名称"
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <select
              className="an-set-in"
              value={draft.kind}
              aria-label="源类型"
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as MediaSourceView['kind'] }))}
            >
              {ADDABLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SOURCE_KIND_LABEL[k] ?? k}
                </option>
              ))}
            </select>
            <input
              className="an-set-in is-wide"
              value={draft.url}
              placeholder="订阅地址 / 服务器地址"
              aria-label="源地址"
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            />
            <Btn kind="primary" size="sm" onClick={() => void submitDraft()}>
              保存
            </Btn>
            <Btn kind="ghost" size="sm" onClick={() => setAdding(false)}>
              取消
            </Btn>
          </div>
          <p className="an-note">RSS 现在就能测；在线 / 选择器 / 媒体服务器 / BT 保存后测试会明说适配器未接入。</p>
        </div>
      )}

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
            <div key={s.id} className="an-src-cell">
              <div className={s.enabled ? 'an-src-row' : 'an-src-row is-off'}>
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
                {s.kind === 'builtin' ? (
                  <span className="an-chip is-plain">内置</span>
                ) : (
                  <>
                    <span className="an-chip is-plain">{s.enabled ? '启用' : '停用'}</span>
                    <Btn kind="ghost" size="sm" onClick={() => void saveSource({ ...s, enabled: !s.enabled })}>
                      {s.enabled ? '停用' : '启用'}
                    </Btn>
                    <Btn
                      kind="ghost"
                      size="sm"
                      disabled={testing === s.id || !s.url}
                      title={s.url ? '拉前几条看看这个源里有什么' : '这个源没有地址'}
                      onClick={() => void testSource(s)}
                    >
                      <Zap size={13} /> {testing === s.id ? '测试中' : '测试'}
                    </Btn>
                    <Btn kind="ghost" size="sm" title="删除该源" onClick={() => void deleteSource(s.id)}>
                      <Trash2 size={13} />
                    </Btn>
                  </>
                )}
              </div>
              {preview?.id === s.id && preview.items.length > 0 && (
                <div className="an-src-preview">
                  {preview.items.slice(0, 5).map((it, i) => (
                    <span key={`${it.title}-${i}`}>
                      <b>{it.title}</b>
                      <span>
                        {it.kind === 'torrent' ? 'BT' : it.kind === 'video' ? '直链' : '网页'}
                        {it.index ? ` · 第 ${it.index} 话` : ''}
                      </span>
                    </span>
                  ))}
                </div>
              )}
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
