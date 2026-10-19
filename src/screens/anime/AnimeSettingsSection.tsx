/**
 * 「番剧设置」小节 —— 由设置页作为第 6 个分组挂载（设计稿 ⑥）。
 *
 * 数据源是 `anime/settings-catalog.ts` 的八组 30 项；真实值住在 `anime/prefs.ts`。
 * 排版复用设置页的 `SubTitle` / `Row`（行高、说明、默认值小字只由一处保证），
 * 控件皮肤用本模块自己的 `.an-set-*` —— 设置页的窄控件列放不下本模块这些输入框。
 *
 * 纪律：**没有「假控件」**。弹幕是占位项（只显示"预留能力"），
 * 其余每一项都真的读写 `prefs` 并立即落 localStorage。
 */
import type { ReactNode } from 'react';
import { useNav } from '@/router/use-nav';
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
  const { setScreen } = useNav();

  /** 跳到番剧屏的某个子页（设置里的「去管理源 / 管理账号」不是死按钮） */
  const goAnime = (view: 'source' | 'account') => {
    setView(view);
    setScreen('anime');
  };

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
                onClick={() => setPref(c.key, o.value as never)}
              >
                {o.label}
              </button>
            ))}
          </div>
        );
      case 'text':
        return (
          <input
            className={c.wide ? 'an-set-in is-wide' : 'an-set-in'}
            value={String(prefs[c.key] ?? '')}
            placeholder={c.placeholder}
            aria-label={label}
            onChange={(e) => setPref(c.key, e.target.value as never)}
          />
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
      case 'placeholder':
        return <span className="an-chip is-plain">{c.note}</span>;
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
              八组 30 项：番剧库 / 播放 / 字幕 / 数据源 / 媒体选择 / 缓存与 BT / 账号与同步 / 备份。
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
