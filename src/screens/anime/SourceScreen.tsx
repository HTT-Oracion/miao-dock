/**
 * 数据源与 BT（设计稿 ⑨）：源列表 + 本机导入 + 编辑器入口 + BT 任务 + Peer/PikPak。
 *
 * 源列表是**真的**：内置本地库恒在，用户自建源由服务侧 `<state>/sources.json` 落盘；
 * 在线 / RSS / 选择器 / 媒体服务器 / BT 的适配器按同一契约随后接入（编辑器仍禁用并写明原因）。
 * 「导入本机文件夹」把片复制进库根，是本机数据眼下唯一的入口。
 */
import { useState } from 'react';
import { FolderPlus, Link2, Pencil, Play, Plus, RefreshCw, ShieldAlert, Trash2, Zap } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Btn, Empty } from '@components/units';
import { formatBytes } from '@tools';
import { useToasts } from '@hooks';
import * as ipc from '@anime/ipc';
import { useAnimeStore } from '@anime/store';
import { SOURCE_KIND_LABEL } from '@anime/player-options';
import type { AnimeCookie, AnimeSourceRules, AnimeSourceTestItem, MediaSourceView } from '@anime/types';
import { ProgressBar, SectionHead } from '@screens/anime/shared';

/** 用户可自建的源类型（内置源不在列）；适配器未就绪的也列出来，保存后测试会明说 */
const ADDABLE_KINDS: MediaSourceView['kind'][] = ['rss', 'web', 'selector', 'jellyfin', 'emby', 'local', 'bt'];

/** 需要选择器规则的源类型（与 Rust `needs_rules` 同一口径） */
const needsRules = (kind: MediaSourceView['kind']) => kind === 'web' || kind === 'selector';

const EMPTY_RULES: AnimeSourceRules = { list: '', link: '', title: '', video: '' };

/** 只把填了的选择器交给服务端：空串会被当成"语法错" */
function tidyRules(rules: AnimeSourceRules): AnimeSourceRules {
  const out: AnimeSourceRules = { list: rules.list.trim() };
  for (const key of ['link', 'title', 'video'] as const) {
    const v = rules[key]?.trim();
    if (v) out[key] = v;
  }
  return out;
}

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
  const playRemoteSource = useAnimeStore((s) => s.playRemoteSource);
  const { push } = useToasts();
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{
    /** 有 id = 编辑已有源（保存时覆盖它），没有 = 新建 */
    id?: string;
    name: string;
    kind: MediaSourceView['kind'];
    url: string;
    rules: AnimeSourceRules;
  }>({
    name: '',
    kind: 'rss',
    url: '',
    rules: EMPTY_RULES,
  });
  /** 正在测试的源 id 与它的预览结果（同一次只测一个：避免连点把源打爆） */
  const [testing, setTesting] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; items: AnimeSourceTestItem[]; resolved?: string } | null>(null);
  /** 正在解析直链的源 id */
  const [resolving, setResolving] = useState<string | null>(null);
  /** 各源的会话 cookie（验证码窗口里取出来的，随抓取请求带上） */
  const [cookies, setCookies] = useState<Record<string, AnimeCookie[]>>({});
  /** 刚失败、需要用户去窗口里过验证码的源 id */
  const [challengeFor, setChallengeFor] = useState<string | null>(null);

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

  /** 测试一个源：RSS / 媒体服务器 / 通用网页源（带选择器）都真拉前几条 */
  const testSource = async (s: MediaSourceView) => {
    if (!s.url) {
      push('这个源没有地址，先补上再测', 'bad');
      return;
    }
    if (needsRules(s.kind) && !s.rules?.list?.trim()) {
      push('这个源还没配「列表选择器」，先点「编辑」补上规则', 'bad');
      return;
    }
    setTesting(s.id);
    try {
      const r = await ipc.animeTestSource(s.url, s.kind, 8, s.rules, cookies[s.id]);
      setPreview({ id: s.id, items: r.items });
      setChallengeFor(null);
      push(`「${s.name}」取到 ${r.count} 条`, 'good');
    } catch (e) {
      setPreview(null);
      // 失败时给「过验证码」入口：站点可能只是要一次人机验证，不是规则写错
      setChallengeFor(s.id);
      push(`测试失败：${e instanceof Error ? e.message : String(e)}`, 'bad');
    } finally {
      setTesting(null);
    }
  };

  /** 通用网页源：把列表里那一条的详情页地址解析成视频直链 */
  const resolveSource = async (s: MediaSourceView, pageUrl: string) => {
    if (!s.rules?.video?.trim()) {
      push('这个源还没配「视频地址选择器」，解析不出直链', 'bad');
      return;
    }
    setResolving(s.id);
    try {
      const r = await ipc.animeResolveSource(pageUrl, tidyRules(s.rules), cookies[s.id]);
      setPreview({ id: s.id, items: preview?.items ?? [], resolved: r.url });
      push(`解析到直链：${r.url}`, 'good');
    } catch (e) {
      push(`解析失败：${e instanceof Error ? e.message : String(e)}`, 'bad');
    } finally {
      setResolving(null);
    }
  };

  /** 打开「过验证码」窗口：内嵌网页，用户手动完成验证（不尝试识别或绕过） */
  const openChallenge = async (s: MediaSourceView) => {
    if (!s.url) {
      push('这个源没有地址', 'bad');
      return;
    }
    try {
      await ipc.animeOpenChallenge(s.url);
      push('在弹窗里完成验证，然后点「我已通过」', 'good');
    } catch (e) {
      push(`验证码窗口打不开：${e instanceof Error ? e.message : String(e)}`, 'bad');
    }
  };

  /** 用户说「已通过」：把窗口里的会话 cookie 收下来，带着它重试 */
  const passChallenge = async (s: MediaSourceView) => {
    if (!s.url) return;
    try {
      const r = await ipc.animeChallengeCookies(s.url);
      if (!r.cookies.length) {
        push('没读到会话 cookie —— 确认验证已在弹窗里完成', 'bad');
        return;
      }
      setCookies((m) => ({ ...m, [s.id]: r.cookies }));
      push(`已拿到 ${r.cookies.length} 条会话 cookie，重试一次`, 'good');
      await testSource(s);
    } catch (e) {
      push(`读会话失败：${e instanceof Error ? e.message : String(e)}`, 'bad');
    }
  };

  /** 编辑已有源：把它的字段灌进草稿，保存时覆盖同一个 id */
  const editSource = (s: MediaSourceView) => {
    setDraft({
      id: s.id,
      name: s.name,
      kind: s.kind,
      url: s.url ?? '',
      rules: { ...EMPTY_RULES, ...(s.rules ?? {}) },
    });
    setAdding(true);
  };

  /** 保存草稿源：新建用「时间戳 + 名称」保证唯一；编辑沿用原 id */
  const submitDraft = async () => {
    const name = draft.name.trim();
    if (!name) {
      push('先填个源名称', 'bad');
      return;
    }
    if (needsRules(draft.kind) && !draft.rules.list.trim()) {
      push('这一类源要填「列表选择器」（例如 `.list-item a`）', 'bad');
      return;
    }
    const rules = needsRules(draft.kind) ? tidyRules(draft.rules) : undefined;
    await saveSource({
      id: draft.id ?? `src-${Date.now().toString(36)}`,
      name,
      kind: draft.kind,
      url: draft.url.trim() || undefined,
      enabled: true,
      rules,
    });
    setDraft({ name: '', kind: 'rss', url: '', rules: EMPTY_RULES });
    setAdding(false);
    push(draft.id ? `已更新「${name}」` : `已添加「${name}」，点「测试」看看里面有什么`, 'good');
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
            {needsRules(draft.kind) && (
              <div className="an-src-rules">
                <input
                  className="an-set-in is-wide"
                  value={draft.rules.list}
                  placeholder="列表选择器（必填），如 .list-item"
                  aria-label="列表选择器"
                  onChange={(e) => setDraft((d) => ({ ...d, rules: { ...d.rules, list: e.target.value } }))}
                />
                <input
                  className="an-set-in"
                  value={draft.rules.link ?? ''}
                  placeholder="链接选择器（可选），如 a"
                  aria-label="链接选择器"
                  onChange={(e) => setDraft((d) => ({ ...d, rules: { ...d.rules, link: e.target.value } }))}
                />
                <input
                  className="an-set-in"
                  value={draft.rules.title ?? ''}
                  placeholder="标题选择器（可选），如 .title"
                  aria-label="标题选择器"
                  onChange={(e) => setDraft((d) => ({ ...d, rules: { ...d.rules, title: e.target.value } }))}
                />
                <input
                  className="an-set-in"
                  value={draft.rules.video ?? ''}
                  placeholder="视频地址选择器（可选），如 video[src]"
                  aria-label="视频地址选择器"
                  onChange={(e) => setDraft((d) => ({ ...d, rules: { ...d.rules, video: e.target.value } }))}
                />
              </div>
            )}
            <Btn kind="primary" size="sm" onClick={() => void submitDraft()}>
              {draft.id ? '保存修改' : '保存'}
            </Btn>
            <Btn
              kind="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
                setDraft({ name: '', kind: 'rss', url: '', rules: EMPTY_RULES });
              }}
            >
              取消
            </Btn>
          </div>
          <p className="an-note">
            RSS 与 Jellyfin / Emby 现在就能测（媒体服务器要在地址后带 <code>?api_key=…</code>）； 通用网页源（web /
            selector）按「列表 → 链接 → 标题」三条选择器抓条目，配了「视频地址选择器」还能在预览里解析直链。 BT
            适配器仍未接入，测试会明说。
          </p>
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
                    <Btn kind="ghost" size="sm" title="编辑名称 / 地址 / 选择器规则" onClick={() => editSource(s)}>
                      <Pencil size={13} /> 编辑
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
                    <span key={`${it.title}-${i}`} className="an-src-pv-row">
                      <span className="an-src-pv-tx">
                        <b>{it.title}</b>
                        <span>
                          {it.kind === 'torrent' ? 'BT' : it.kind === 'video' ? '直链' : '网页'}
                          {it.index ? ` · 第 ${it.index} 话` : ''}
                        </span>
                      </span>
                      {it.id && it.kind === 'video' ? (
                        <Btn
                          kind="ghost"
                          size="sm"
                          title="经本机服务侧中继播放这一集（api_key 不进地址）"
                          onClick={() => void playRemoteSource(s.id, it)}
                        >
                          <Play size={13} /> 播放
                        </Btn>
                      ) : null}
                      {needsRules(s.kind) && it.link ? (
                        <Btn
                          kind="ghost"
                          size="sm"
                          disabled={resolving === s.id}
                          title="按「视频地址选择器」解析这一条的直链"
                          onClick={() => void resolveSource(s, it.link as string)}
                        >
                          <Link2 size={13} /> {resolving === s.id ? '解析中' : '解析'}
                        </Btn>
                      ) : null}
                    </span>
                  ))}
                </div>
              )}
              {preview?.id === s.id && preview.resolved ? (
                <div className="an-src-preview">
                  <span className="an-src-pv-row">
                    <span className="an-src-pv-tx">
                      <b>解析到的直链</b>
                      <span>{preview.resolved}</span>
                    </span>
                  </span>
                </div>
              ) : null}
              {challengeFor === s.id ? (
                <div className="an-src-preview">
                  <span className="an-src-pv-row">
                    <span className="an-src-pv-tx">
                      <b>测试没通过</b>
                      <span>如果页面要求人机验证，先在弹窗里过一遍再重试（不识别、不绕过）。</span>
                    </span>
                    <Btn
                      kind="ghost"
                      size="sm"
                      title="打开内嵌网页，手动完成验证"
                      onClick={() => void openChallenge(s)}
                    >
                      <ShieldAlert size={13} /> 过验证码
                    </Btn>
                    <Btn
                      kind="ghost"
                      size="sm"
                      title="读出窗口里的会话 cookie 并重试"
                      onClick={() => void passChallenge(s)}
                    >
                      我已通过，重试
                    </Btn>
                  </span>
                </div>
              ) : null}
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
