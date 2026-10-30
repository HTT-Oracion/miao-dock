import { useState } from 'react';
import { ChevronRight, User } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { Btn } from '@components/units';
import { PLATFORM_MAP, providerLabel } from '@music/platform';
import { AccountMenu } from '@screens/music/PlatformMenu';

/**
 * 账号与平台入口（设计稿放在**工具条右侧动作组** `.toolbar-actions` 里）。
 *
 * 早先它住在左栏底部（`.ms-foot`）—— 那是"资料库卡片的页脚"，但账号是**全应用级**的
 * 身份状态：左栏切 Tab 时它不该跟着变位置，也不该被左卡的宽度压成两行小字。
 * 移到工具条后，它与标题同处一条信息带，切屏时位置恒定。
 *
 * 两种形态：
 * - 已登录：头像（首字母或图片）+ 昵称，点开账号菜单；
 * - 未登录：人形图标 + 「未登录」，点开登录弹窗。
 */
export function ToolbarAccount() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const openLogin = useMusicStore((s) => s.openLogin);
  const [menuOpen, setMenuOpen] = useState(false);

  const info = loginInfos[playbackSource];
  const logged = !!info?.logged_in;
  const provider = providerLabel(playbackSource);
  const meta = PLATFORM_MAP[playbackSource];

  return (
    <>
      <Btn
        kind="ghost"
        size="sm"
        className="toolbar-account"
        ariaLabel={logged ? '账号与平台' : '登录'}
        title={logged ? `${info?.nickname ?? '已登录'} · ${provider}` : `${provider} · 点击登录`}
        onClick={() => (logged ? setMenuOpen(true) : void openLogin())}
      >
        <span
          className={logged ? 'ms-avatar is-on' : 'ms-avatar'}
          style={{ '--pc': meta.color } as React.CSSProperties}
        >
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
        {/*
         * 两行结构照设计稿 `.ms-account-tx`：**strong 在上（昵称）、small 在下（平台 · 状态）**。
         * 平台名不是可有可无的装饰 —— 用户可能同时登了两个平台，只有昵称
         * 看不出"这是哪家的账号"，而工具条只显示当前播放源的那个。
         */}
        <span className="toolbar-account-tx">
          <strong>{logged ? info?.nickname || '已登录' : '未登录'}</strong>
          <small>{logged ? `${provider} · 已登录` : `${provider} · 点击登录`}</small>
        </span>
        <ChevronRight size={12} aria-hidden="true" />
      </Btn>

      {menuOpen ? <AccountMenu onClose={() => setMenuOpen(false)} /> : null}
    </>
  );
}
