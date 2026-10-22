import { useState } from 'react';
import { PLATFORMS } from '@music/platform';
import { useMusicStore } from '@music/store';
import { AccountMenu } from '@screens/music/PlatformMenu';

/**
 * 顶行：标题 + 平台胶囊行（设计稿 `.platform-bar`）+ 右侧登录区。
 * 登录区两态：已登录显示头像+昵称（点开多平台切换菜单）；未登录显示「未登录」（点开登录弹窗）。
 *
 * ## 平台切换是**一排胶囊**，不是"先开弹窗再选"
 *
 * 设计稿把四个平台摊在顶行：切平台是一步动作（点哪个是哪个），
 * 而旧实现是一个「当前平台：X」按钮 → 弹窗 → 再选一次，同一件事要两次点击，
 * 还看不出"另外三个平台长什么样"。弹窗仍保留在**账号菜单**里（那里要选的是登录账号，
 * 是另一件事）。
 */
export function TopBar() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const openLogin = useMusicStore((s) => s.openLogin);
  const switchPlaybackSource = useMusicStore((s) => s.switchPlaybackSource);
  const [menuOpen, setMenuOpen] = useState(false);

  const info = loginInfos[playbackSource];
  const logged = !!info?.logged_in;

  return (
    <div className="music-top-wrap">
      <div className="music-top">
        <div className="music-top-l">
          <span className="music-title">音乐播放器</span>
        </div>

        <div className="music-top-r">
          {logged ? (
            <button type="button" className="music-user" title="账号与平台" onClick={() => setMenuOpen(true)}>
              <span className="music-ava">
                {info?.avatar ? <img src={info.avatar} alt="" /> : (info?.nickname ?? '?').slice(0, 1)}
              </span>
              <span className="music-nick">{info?.nickname || '已登录'}</span>
            </button>
          ) : (
            /*
             * 设计稿：点「未登录」**直接开登录弹窗**（不是先弹平台选择再点一次）。
             * 未登录时用户的意图就是"我要登录"，中间夹一层平台选择等于让同一件事点两次；
             * 平台切换在登录弹窗的左栏里已经能选，不丢功能。
             */
            <button type="button" className="music-btn out" onClick={() => void openLogin()}>
              未登录
            </button>
          )}
        </div>
      </div>

      {/* 平台胶囊行（设计稿 `.platform-bar`）：短名 + 登录态色点，点哪个切哪个 */}
      <div className="platform-bar" role="tablist" aria-label="播放平台">
        {PLATFORMS.map((p) => {
          const on = p.id === playbackSource;
          const li = loginInfos[p.id];
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={on}
              className={on ? 'platform-pill is-active' : 'platform-pill'}
              title={`${p.label}${li?.logged_in ? ' · 已登录' : ' · 未登录'}`}
              onClick={() => {
                if (!on) void switchPlaybackSource(p.id);
              }}
            >
              <span
                className="prov-dot"
                style={{ background: p.color, opacity: li?.logged_in ? 1 : 0.35 }}
                aria-hidden="true"
              />
              {p.label.replace('音乐', '').trim()}
            </button>
          );
        })}
      </div>

      {menuOpen ? <AccountMenu onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
