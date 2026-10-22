import { useState } from 'react';
import { providerLabel } from '@music/platform';
import { useMusicStore } from '@music/store';
import { AccountMenu, PlatformPicker } from '@screens/music/PlatformMenu';

/**
 * 顶行：标题 +「当前平台」Badge（点开平台切换弹窗）+ 右侧登录区。
 * 登录区两态：已登录显示头像+昵称（点开多平台切换菜单）；未登录显示「未登录」（点开平台选择）。
 * 两个入口共用一个 PlatformPicker —— 它们的目的相同（选平台/登录），没必要做两套。
 */
export function TopBar() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const openLogin = useMusicStore((s) => s.openLogin);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const info = loginInfos[playbackSource];
  const logged = !!info?.logged_in;

  return (
    <div className="music-top">
      <div className="music-top-l">
        <span className="music-title">音乐播放器</span>
        <button type="button" className="music-plat" title="切换平台" onClick={() => setPickerOpen(true)}>
          当前平台：{providerLabel(playbackSource)}
        </button>
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

      {pickerOpen ? <PlatformPicker onClose={() => setPickerOpen(false)} /> : null}
      {menuOpen ? <AccountMenu onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
