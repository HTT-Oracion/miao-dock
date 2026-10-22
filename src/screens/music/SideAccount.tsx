import { useState } from 'react';
import { ChevronRight, User } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { Btn } from '@components/units';
import { providerLabel } from '@music/platform';
import { AccountMenu } from '@screens/music/PlatformMenu';

/**
 * 左栏**底部**的账号行（设计稿 `.ms-foot` / `.ms-account`）。
 *
 * 设计稿把账号放在左资料库的最下面（贴底），而不是顶部：
 * 顶部那一行留给"平台 + 搜索"（在中间列顶行），左栏从顶到底只有
 * 「三个 Tab → 资料库列表 → 我是谁」。账号是**低频**动作，贴底既符合习惯，
 * 也不会在每次切 Tab 时抢占视线。
 *
 * 两种形态：
 * - 已登录：头像（首字母）+ 昵称 + 「平台 · 已登录」，点开账号菜单；
 * - 未登录：人形图标 + 「未登录」+「平台 · 点击登录」，点开登录弹窗。
 */
export function SideAccount() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const openLogin = useMusicStore((s) => s.openLogin);
  const [menuOpen, setMenuOpen] = useState(false);

  const info = loginInfos[playbackSource];
  const logged = !!info?.logged_in;
  const provider = providerLabel(playbackSource);

  return (
    <div className="ms-foot">
      <Btn
        kind="bare"
        className="ms-account"
        ariaLabel={logged ? '账号与平台' : '登录'}
        title={logged ? '账号与平台' : '登录'}
        onClick={() => (logged ? setMenuOpen(true) : void openLogin())}
      >
        <span className={logged ? 'ms-avatar is-on' : 'ms-avatar'}>
          {logged ? (
            info?.avatar ? (
              <img src={info.avatar} alt="" />
            ) : (
              (info?.nickname ?? '?').slice(0, 1)
            )
          ) : (
            <User size={13} />
          )}
        </span>
        <span className="ms-account-tx">
          <strong>{logged ? info?.nickname || '已登录' : '未登录'}</strong>
          <small>{logged ? `${provider} · 已登录` : `${provider} · 点击登录`}</small>
        </span>
        <ChevronRight size={13} className="ms-account-chev" />
      </Btn>

      {menuOpen ? <AccountMenu onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
