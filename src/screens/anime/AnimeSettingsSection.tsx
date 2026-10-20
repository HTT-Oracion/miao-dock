/**
 * 「番剧设置」小节 —— 由设置页作为第 6 个分组挂载（设计稿 ⑥）。
 *
 * 数据源是 `anime/settings-catalog.ts` 的八组 30 项；真实值住在 `anime/prefs.ts`。
 * 排版复用设置页的 `SubTitle` / `Row`（行高、说明、默认值小字只由一处保证），
 * 控件皮肤用本模块自己的 `.an-set-*` —— 设置页的窄控件列放不下本模块这些输入框。
 *
 * 纪律：**没有「假控件」** —— 做不到的项整条删掉，不留只显示"预留能力"的空行；
 * 其余每一项都真的读写 `prefs` 并立即落 localStorage。
 */
import type { ReactNode } from 'react';
import { useNav } from '@hooks';
import { Btn, Switch } from '@components/units';
import { useAnimeStore } from '@anime/store';
import type { AnimePrefs } from '@anime/prefs';
import { prefsKey } from '@anime/prefs';
import { ANIME_SETTING_GROUPS, type AnimeControl } from '@anime/settings-catalog';
import { Row, SubTitle } from '@screens/settings/parts';

export function AnimeSettingsSection() {
  const prefs = useAnimeStore((s) => s.prefs);
  const setPref = useAnimeStore((s) => s.setPref);
  const setView = useAnimeStore((s) => s.setView);
  const libraryRoot = useAnimeStore((s) => s.libraryRoot);
  const applyLibraryRoot = useAnimeStore((s) => s.applyLibraryRoot);
  const applyProxy = useAnimeStore((s) => s.applyProxy);
  const { setScreen } = useNav();

  /** 跳到番剧屏的某个子页（设置里的「去管理源 / 管理账号」不是死按钮） */
  const goAnime = (view: 'source' | 'account') => {
    setView(view);
    setScreen('anime');
  };

  /** 库根 / 代理地址这类「改了要重启服务才生效」的输入：给一个显式「应用」 */
  const applyText = (key: keyof AnimePrefs) => {
    if (key === 'libraryRoot') {
      const dir = String(prefs.libraryRoot ?? '');
      // 与当前生效根一致就别重启：重启会打断正在看的进度
      if (dir.trim() === libraryRoot) return;
      void applyLibraryRoot(dir);
      return;
    }
    if (key === 'proxyUrl') {
      void applyProxy(prefs.proxy, String(prefs.proxyUrl ?? ''));
    }
  };

  const textPending = (key: keyof AnimePrefs) =>
    key === 'libraryRoot' && String(prefs.libraryRoot ?? '').trim() !== libraryRoot;

  const renderControl = (c: AnimeControl, label: string): ReactNode => {
    switch (c.kind) {
      case 'switch':
        return (
          <Switch on={Boolean(prefs[c.key])} onToggle={() => setPref(c.key, !prefs[c.key] as never)} label={label} />
        );
      case 'seg':
        return (
          <div className="an-seg" role="group" aria-label={label}>
            {c.options.map((o) => (
              <button
                key={String(o.value)}
                type="button"
                className={prefs[c.key] === o.value ? 'an-seg-btn is-on' : 'an-seg-btn'}
                aria-pressed={prefs[c.key] === o.value}
                onClick={() => {
                  setPref(c.key, o.value as never);
                  // 代理切档立刻生效（自定义档才需要再填地址）
                  if (c.key === 'proxy') void applyProxy(String(o.value), String(prefs.proxyUrl ?? ''));
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        );
      case 'text':
        return (
          <span className="an-set-row">
            <input
              className={c.wide ? 'an-set-in is-wide' : 'an-set-in'}
              value={String(prefs[c.key] ?? '')}
              placeholder={c.placeholder}
              aria-label={label}
              onChange={(e) => setPref(c.key, e.target.value as never)}
            />
            {(c.key === 'libraryRoot' || c.key === 'proxyUrl') && (
              <Btn
                kind="ghost"
                size="sm"
                title={c.key === 'libraryRoot' ? '切换到该库根并重新扫描' : '按此地址应用代理'}
                onClick={() => applyText(c.key)}
              >
                {textPending(c.key) ? '应用' : '重载'}
              </Btn>
            )}
          </span>
        );
      case 'number':
        return (
          <span className="an-set-num">
            <input
              className="an-set-in is-num"
              type="number"
              min={1}
              value={Number(prefs[c.key] ?? 0)}
              aria-label={label}
              onChange={(e) => setPref(c.key, Math.max(1, Number(e.target.value) || 1) as never)}
            />
            <span className="an-note">{c.unit}</span>
          </span>
        );
      case 'buttons':
        return (
          <div className="an-acts">
            {c.buttons.map((b) =>
              b.includes('源') ? (
                <Btn key={b} kind="ghost" size="sm" onClick={() => goAnime('source')}>
                  {b}
                </Btn>
              ) : b.includes('账号') ? (
                <Btn key={b} kind="ghost" size="sm" onClick={() => goAnime('account')}>
                  {b}
                </Btn>
              ) : b === '导出' || b === '导入' ? (
                <Btn key={b} kind="ghost" size="sm" onClick={() => void transferPrefs(b === '导出')}>
                  {b}
                </Btn>
              ) : (
                <Btn key={b} kind="ghost" size="sm" disabled title="M3 开放">
                  {b}
                </Btn>
              ),
            )}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div className="set-group">
        <SubTitle>总览</SubTitle>
        <div className="set-row">
          <div className="set-row-label">
            <div className="set-row-title">
              <span className="set-row-name">番剧设置</span>
            </div>
            <div className="set-row-why is-one">
              八组 34 项：番剧库 / 播放 / 字幕 / 数据源 / 媒体选择 / 缓存与 BT / 账号与同步 / 备份。
            </div>
          </div>
          <div className="set-row-ctl">
            <span className="an-chip is-plain">{ANIME_SETTING_GROUPS.length} 组</span>
          </div>
        </div>
      </div>

      {ANIME_SETTING_GROUPS.map((g) => (
        <div key={g.id} className="set-group">
          <SubTitle>{g.title}</SubTitle>
          {g.items.map((it) => (
            <Row key={it.id} item={{ id: it.id, label: it.label, state: 'live', why: it.why, def: it.def }}>
              {renderControl(it.control, it.label)}
            </Row>
          ))}
        </div>
      ))}
    </>
  );
}

/** 设置备份：导出到剪贴板 / 从剪贴板恢复（真动作，不是占位按钮） */
async function transferPrefs(exporting: boolean): Promise<void> {
  try {
    if (exporting) {
      const raw = localStorage.getItem(prefsKey()) ?? '{}';
      await navigator.clipboard.writeText(raw);
      return;
    }
    const text = await navigator.clipboard.readText();
    const parsed = JSON.parse(text) as Partial<AnimePrefs>;
    localStorage.setItem(prefsKey(), JSON.stringify(parsed));
  } catch (e) {
    console.error('[anime] 设置备份失败（剪贴板不可用或内容不是合法 JSON）', e);
  }
}
