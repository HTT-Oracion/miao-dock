import { useState } from 'react';
import { useMusicStore } from '@music/store';
import { AccountMenu } from '@screens/music/PlatformMenu';

/**
 * 左栏顶行：标题 + 右侧登录区。
 * 登录区两态：已登录显示头像+昵称（点开账号菜单）；未登录显示「未登录」（直接开登录弹窗）。
 *
 * ## 平台胶囊不在这一行了（ver3 挪走）
 *
 * 设计稿把平台切换放在**中间列的顶行**，与搜索框同一行 —— 那是同一个问题的两半：
 * 「在哪个平台搜」和「搜什么」。留在这里会变成"平台在左、搜索在右"两处各管一半。
 * 见 `RightPanel` 的 `.music-topbar`。
 */
export function TopBar() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const openLogin = useMusicStore((s) => s.openLogin);
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

      {menuOpen ? <AccountMenu onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
