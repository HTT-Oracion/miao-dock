/**
 * 数据源与 BT（设计稿 ⑨）：源列表 + 本机导入 + 编辑器入口 + BT 任务 + Peer/PikPak。
 *
 * 源列表是**真的**：内置本地库恒在，用户自建源由服务侧 `<state>/sources.json` 落盘；
 * 在线 / RSS / 选择器 / 媒体服务器 / BT 的适配器按同一契约随后接入（编辑器仍禁用并写明原因）。
 * 「导入本机文件夹」把片复制进库根，是本机数据眼下唯一的入口。
 */
import { useEffect, useState } from 'react';
import { FolderPlus, Link2, Pencil, Play, Plus, RefreshCw, ShieldAlert, Trash2, Zap } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Btn, Empty } from '@components/units';
import { formatBytes } from '@tools';
import { useToasts } from '@hooks';
import * as ipc from '@anime/ipc';
import { useAnimeStore } from '@anime/store';
import { errText, tidyRules } from '@anime/convert';
import { SOURCE_KIND_LABEL } from '@anime/player-options';
import type { AnimeCookie, AnimeSourceRules, AnimeSourceTestItem, MediaSourceView } from '@anime/types';
import { ProgressBar, SectionHead } from '@screens/anime/shared';

/** 用户可自建的源类型（内置源不在列）；适配器未就绪的也列出来，保存后测试会明说 */
const ADDABLE_KINDS: MediaSourceView['kind'][] = ['rss', 'web', 'selector', 'jellyfin', 'emby', 'local', 'bt'];

/** 需要选择器规则的源类型（与 Rust `needs_rules` 同一口径） */
const needsRules = (kind: MediaSourceView['kind']) => kind === 'web' || kind === 'selector';

const EMPTY_RULES: AnimeSourceRules = { list: '', link: '', title: '', video: '' };

/** 「点选元素」按钮文案（与规则字段一一对应） */
const PICK_LABEL = { list: '列表', link: '链接', title: '标题', video: '视频地址' } as const;

export function SourceScreen() {
  const sources = useAnimeStore((s) => s.sources);
  const status = useAnimeStore((s) => s.status);
  const loadSources = useAnimeStore((s) => s.loadSources);
  const refresh = useAnimeStore((s) => s.refreshLibrary);
  const setView = useAnimeStore((s) => s.setView);
  const importFolder = useAnimeStore((s) => s.importFolder);
  const saveSource = useAnimeStore((s) => s.saveSource);
  const deleteSource = useAnimeStore((s) => s.deleteSource);
  const playRemoteSource = useAnimeStore((s) => s.playRemoteSource);
  const prefs = useAnimeStore((s) => s.prefs);
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
  /** 订阅导入：地址与忙碌态 */
  const [subUrl, setSubUrl] = useState('');
  const [subBusy, setSubBusy] = useState(false);

  const bt = useAnimeStore((s) => s.btTasks);
  const btStats = useAnimeStore((s) => s.btStats);
  const loadBt = useAnimeStore((s) => s.loadBt);
  const addBt = useAnimeStore((s) => s.addBt);
  const pauseBt = useAnimeStore((s) => s.pauseBt);
  const resumeBt = useAnimeStore((s) => s.resumeBt);
  const deleteBt = useAnimeStore((s) => s.deleteBt);
  const playBt = useAnimeStore((s) => s.playBt);
  const pikpakStatus = useAnimeStore((s) => s.pikpakStatus);
  const loadPikpak = useAnimeStore((s) => s.loadPikpak);
  const [magnet, setMagnet] = useState('');
  // 进屏拉一次 BT 任务与会话状态（会话没起时是空表，不编造）
  useEffect(() => {
    void loadBt();
    void loadPikpak();
  }, [loadBt, loadPikpak]);
  const [btBusy, setBtBusy] = useState(false);
  /** 点选元素：正在点的是哪一条规则 */
  const [picking, setPicking] = useState<'list' | 'link' | 'title' | 'video' | null>(null);

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
      const r = await ipc.animeResolveSource(pageUrl, tidyRules(s.rules), cookies[s.id], prefs.preferRes);
      setPreview({ id: s.id, items: preview?.items ?? [], resolved: r.url });
      push(`解析到直链：${r.url}`, 'good');
    } catch (e) {
      push(`解析失败：${e instanceof Error ? e.message : String(e)}`, 'bad');
    } finally {
      setResolving(null);
    }
  };

  /** 点选元素：打开源的页面，用户点一下，把 CSS 路径填进对应规则 */
  const pickInto = async (field: 'list' | 'link' | 'title' | 'video') => {
    const pageUrl = draft.url.trim();
    if (!pageUrl.startsWith('http')) {
      push('先在「地址」里填源地址 —— 点选打开的页面就是它', 'bad');
      return;
    }
    setPicking(field);
    try {
      await ipc.animeOpenPicker(pageUrl);
      const r = await ipc.animePickResult();
      if (r.ok && r.selector) {
        setDraft((d) => ({ ...d, rules: { ...d.rules, [field]: r.selector } }));
        push(`已填入：${r.selector}`, 'good');
      } else {
        push(r.reason ?? '没取到选择器', 'bad');
      }
    } catch (e) {
      push(`点选失败：${errText(e)}`, 'bad');
    } finally {
      setPicking(null);
    }
  };
  /** 从订阅地址拉规则草稿：填进编辑器由用户确认，**不自动保存** */
  const importSubscription = async () => {
    const url = subUrl.trim();
    if (!url.startsWith('http')) {
      push('订阅地址要 http:// 或 https:// 开头', 'bad');
      return;
    }
    setSubBusy(true);
    try {
      const r = await ipc.animeSubscribeSource(url);
      const d = r.draft;
      setDraft({
        name: d.name || '订阅源',
        kind: d.kind === 'selector' ? 'selector' : 'web',
        url: d.url || '',
        rules: { ...EMPTY_RULES, ...(d.rules ?? {}) },
      });
      setAdding(true);
      setSubUrl('');
      push('已导入规则草稿，检查后点「保存」', 'good');
    } catch (e) {
      push(`订阅导入失败：${errText(e)}`, 'bad');
    } finally {
      setSubBusy(false);
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
                <div className="an-acts">
                  <span className="an-note">在页面上点选：</span>
                  {(['list', 'link', 'title', 'video'] as const).map((f) => (
                    <Btn key={f} kind="ghost" size="sm" disabled={picking !== null} onClick={() => void pickInto(f)}>
                      {picking === f ? '点选中…' : PICK_LABEL[f]}
                    </Btn>
                  ))}
                </div>
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
        <p className="an-note">
          规则在上方「添加源」里手填（列表 / 链接 / 标题 / 视频地址四条选择器），保存后点「测试」当场验证；
          也可以从订阅地址导入一份规则草稿。
        </p>
        <div className="an-src-form">
          <input
            className="an-set-in is-wide"
            value={subUrl}
            placeholder="订阅地址（返回 {name, kind, url, rules} 的 JSON）"
            aria-label="订阅地址"
            onChange={(e) => setSubUrl(e.target.value)}
          />
          <Btn kind="ghost" size="sm" disabled={subBusy || !subUrl.trim()} onClick={() => void importSubscription()}>
            {subBusy ? '导入中…' : '从订阅导入'}
          </Btn>
        </div>
        <p className="an-note">「在页面上点选元素生成选择器」还没做 —— 它需要内嵌页注入脚本，另立一轮。</p>
      </section>

      <SectionHead title="BT 任务" count={bt.length} />
      <div className="an-src-form">
        <input
          className="an-set-in is-wide"
          value={magnet}
          placeholder="magnet:?xt=… 或种子地址"
          aria-label="磁力链接"
          onChange={(e) => setMagnet(e.target.value)}
        />
        <Btn
          kind="ghost"
          size="sm"
          disabled={btBusy || !magnet.trim()}
          onClick={() => {
            setBtBusy(true);
            void addBt(magnet).then((r) => {
              setBtBusy(false);
              push(r.message, r.ok ? 'good' : 'bad');
              if (r.ok) setMagnet('');
            });
          }}
        >
          {btBusy ? '添加中…' : '添加磁力'}
        </Btn>
        <Btn kind="ghost" size="sm" onClick={() => void loadBt()}>
          <RefreshCw size={12} /> 刷新
        </Btn>
      </div>
      <p className="an-note">
        {btStats.running
          ? `BT 会话在跑 · 监听端口 ${btStats.port || '自动'} · 任务 ${btStats.tasks ?? bt.length} 个`
          : 'BT 会话还没起（第一次添加磁力时才创建）；端口来自设置里的「监听端口」，改端口要重启动漫服务。'}
      </p>
      {bt.length === 0 ? (
        <Empty inline>没有 BT 任务。贴一条磁力链接开始下载；进度与做种比来自 librqbit 的真实统计。</Empty>
      ) : (
        bt.map((t) => (
          <div key={t.id} className="an-bt-row">
            <span className="an-bt-tx">
              <b>{t.name || `任务 ${t.id}`}</b>
              <span>
                {t.state === 'downloading'
                  ? '下载中'
                  : t.state === 'done'
                    ? '已完成（做种中）'
                    : t.state === 'paused'
                      ? '已暂停'
                      : t.state === 'failed'
                        ? `失败：${t.error ?? '未知原因'}`
                        : '准备中'}
                {` · 分享率 ${t.ratio.toFixed(2)}`}
              </span>
              <ProgressBar value={t.totalBytes ? Math.round((t.progressBytes / t.totalBytes) * 100) : 0} />
            </span>
            <span className="an-num">
              {formatBytes(t.progressBytes)} / {formatBytes(t.totalBytes)}
            </span>
            <Btn
              kind="ghost"
              size="sm"
              disabled={!prefs.btStream}
              title={prefs.btStream ? '边下边播（等字节就位再发）' : '设置里关掉了「边下边播」'}
              onClick={() => {
                void playBt(t.id, t.name).then((r) => push(r.message, r.ok ? 'good' : 'bad'));
              }}
            >
              播放
            </Btn>
            {t.state === 'downloading' ? (
              <Btn kind="ghost" size="sm" title="暂停" onClick={() => void pauseBt(t.id)}>
                暂停
              </Btn>
            ) : (
              <Btn kind="ghost" size="sm" title="继续" onClick={() => void resumeBt(t.id)}>
                继续
              </Btn>
            )}
            <Btn kind="ghost" size="sm" title="删除任务（保留文件）" onClick={() => void deleteBt(t.id)}>
              <Trash2 size={12} />
            </Btn>
          </div>
        ))
      )}

      <section className="an-panel">
        <SectionHead title="Peer 过滤与 PikPak" />
        <p className="an-note">
          peer 过滤：设置里的订阅地址在启动时交给 librqbit（blocklist_url），改地址要重启动漫服务。
        </p>
        <p className="an-note">{pikpakStatus ? pikpakStatus.reason : 'PikPak 接口状态没拉到。'}</p>
        <div className="an-acts">
          <Btn kind="ghost" size="sm" onClick={() => void loadPikpak()}>
            <RefreshCw size={12} /> 刷新接口状态
          </Btn>
          <Btn kind="ghost" size="sm" onClick={() => setView('states')}>
            去三态页看空态样例
          </Btn>
        </div>
      </section>
    </div>
  );
}
