import { LogOut, X } from 'lucide-react';
import { PLATFORMS, providerLabel } from '@music/platform';
import { useMusicStore } from '@music/store';
import type { MusicProvider } from '@music/platform';
import { IconButton } from '@components/units';
import { useEsc } from '@hooks/useEsc';

/**
 * 平台相关的两个浮层：
 *  · PlatformPicker —— 「当前平台」Badge 与「未登录」按钮点开的**平台切换弹窗**；
 *  · AccountMenu    —— 已登录时点开会话区弹出的**多平台切换菜单**（附退出登录）。
 *
 * 为什么点平台项要分三种结果：设计稿把「切换播放源」与「登录」放在同一个列表里，
 * 但两者后果不同 —— 已登录且非当前源才切源；未登录先登录（登录成功后 store 会自动收起并刷新）。
 */

/** 单个平台的状态徽标：当前播放源 > 已登录 > 未登录（优先级即视觉权重） */
function StatusBadge({ current, logged }: { current: boolean; logged: boolean }) {
  if (current) return <span className="pf-badge is-cur">当前</span>;
  if (logged) return <span className="pf-badge is-on">已登录</span>;
  return <span className="pf-badge is-off">未登录</span>;
}

export function PlatformPicker({ onClose }: { onClose: () => void }) {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const switchPlaybackSource = useMusicStore((s) => s.switchPlaybackSource);
  const openLogin = useMusicStore((s) => s.openLogin);

  useEsc(onClose);

  const pick = (p: MusicProvider, logged: boolean, isCur: boolean) => {
    if (!logged) void openLogin(p);
    else if (!isCur) void switchPlaybackSource(p);
    onClose();
  };

  return (
    <div className="pf-overlay" onClick={onClose}>
      <div className="pf-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pf-hd">
          <span className="music-card-title">切换平台</span>
          <IconButton title="关闭" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="pf-list">
          {PLATFORMS.map((p) => {
            const logged = !!loginInfos[p.id]?.logged_in;
            const isCur = p.id === playbackSource;
            return (
              <div key={p.id} className="pf-item" onClick={() => pick(p.id, logged, isCur)}>
                {/* 26px 圆角色块（设计稿 M2）：品牌色作底 + 单字白字，作为平台的第一识别位 */}
                <span className="pf-chip" style={{ background: p.color }}>
                  {p.short}
                </span>
                <div className="pf-txt">
                  <b className="pf-name">{p.label}</b>
                  <span className="pf-desc">{p.desc}</span>
                </div>
                <StatusBadge current={isCur} logged={logged} />
              </div>
            );
          })}
        </div>
        <div className="pf-note">切换播放源会刷新左右两栏内容；未登录的平台请先登录。</div>
      </div>
    </div>
  );
}

export function AccountMenu({ onClose }: { onClose: () => void }) {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const switchPlaybackSource = useMusicStore((s) => s.switchPlaybackSource);
  const openLogin = useMusicStore((s) => s.openLogin);
  const logoutFor = useMusicStore((s) => s.logoutFor);

  useEsc(onClose);
  const cur = loginInfos[playbackSource];

  return (
    <>
      <div className="ac-backdrop" onClick={onClose} />
      <div className="ac-menu">
        <div className="ac-hd">
          <span className="music-ava">
            {cur?.avatar ? <img src={cur.avatar} alt="" /> : (cur?.nickname ?? '?').slice(0, 1)}
          </span>
          <div className="ac-txt">
            <b>{cur?.nickname || '已登录'}</b>
            <span>{providerLabel(playbackSource)}</span>
          </div>
        </div>
        <div className="ac-list">
          {PLATFORMS.map((p) => {
            const logged = !!loginInfos[p.id]?.logged_in;
            const isCur = p.id === playbackSource;
            return (
              <button
                key={p.id}
                type="button"
                className="ac-item"
                onClick={() => {
                  if (!logged) void openLogin(p.id);
                  else if (!isCur) void switchPlaybackSource(p.id);
                  onClose();
                }}
              >
                <span className="ac-dot" style={{ background: p.color }} />
                <span className="ac-name">{p.label}</span>
                <StatusBadge current={isCur} logged={logged} />
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="ac-out"
          onClick={() => {
            void logoutFor(playbackSource);
            onClose();
          }}
        >
          <LogOut size={13} /> 退出登录（{providerLabel(playbackSource)}）
        </button>
      </div>
    </>
  );
}
