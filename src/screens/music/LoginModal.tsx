import { ExternalLink, LoaderCircle, X } from 'lucide-react';
import { Btn, IconButton } from '@components/units';
import { memberLabel } from '@music/convert';
import { PLATFORM_MAP, providerLabel } from '@music/platform';
import type { MusicProvider } from '@music/types';
import { useMusicStore } from '@music/store';

/**
 * 登录弹窗（设计稿 `login-modal`：左平台列表 + 右面板两栏）。
 *
 * ## 为什么右栏是「打开官方窗口」而不是设计稿里的二维码
 * 设计稿画的是扫码登录，但那在本项目里**不是真实能力**：`openLogin` 走的是
 * 平台官方网页窗口（登录后 Rust 侧回读 Cookie 并落盘），`qrUrl` 从未被赋值。
 * 照搬一张二维码就等于**伪造一个不存在的流程** —— 用户扫了不会有任何反应。
 * 所以右栏保留真实动作（打开官方窗口）+ 真实的轮询状态（`qrStatus` 由 store 轮询写入），
 * 只把**结构**按设计稿做成两栏：左选平台、右看当前平台的状态。
 *
 * ## 未登录与已登录是同一张弹窗的两面
 * 已登录时右栏换成账号卡 + 退出登录，而不是另起一个弹窗 ——
 * 用户点的是同一个「音乐账号」入口。
 */
const PROVIDERS: MusicProvider[] = ['netease', 'kugou', 'qqmusic', 'migu'];

export function LoginModal() {
  const loginOpen = useMusicStore((s) => s.loginOpen);
  const loginProvider = useMusicStore((s) => s.loginProvider);
  const qrStatus = useMusicStore((s) => s.qrStatus);
  const qrLoading = useMusicStore((s) => s.qrLoading);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const closeLogin = useMusicStore((s) => s.closeLogin);
  const openLogin = useMusicStore((s) => s.openLogin);
  const logoutFor = useMusicStore((s) => s.logoutFor);

  if (!loginOpen) return null;

  const info = loginInfos[loginProvider];
  const logged = !!info?.logged_in;
  const name = providerLabel(loginProvider);
  // 平台色与短名（设计稿 `.provider-orb` / `.avatar-lg` 都用它）
  const meta = PLATFORM_MAP[loginProvider];

  return (
    <div className="music-login-overlay" onClick={closeLogin}>
      <div className="music-login" onClick={(e) => e.stopPropagation()}>
        <div className="music-login-hd">
          <div>
            <span className="music-login-kicker">MUSIC ACCOUNT</span>
            <span className="music-login-title">{logged ? '音乐账号' : '登录音乐账号'}</span>
            {/* 标题下那句说明是设计稿 `.modal-head p` 的原话；缺了它，标题只说"要做什么"、不说"为什么值得做" */}
            <p className="music-login-sub">登录后同步歌单、收藏与播放记录</p>
          </div>
          <IconButton title="关闭" onClick={closeLogin}>
            <X size={15} />
          </IconButton>
        </div>

        <div className="music-login-cols">
          {/* 左：平台列表（点一行即切换当前平台并重新发起登录） */}
          <div className="music-login-platforms">
            {PROVIDERS.map((p) => {
              const it = loginInfos[p];
              const on = !!it?.logged_in;
              const pm = PLATFORM_MAP[p];
              return (
                <Btn
                  key={p}
                  kind="bare"
                  className={p === loginProvider ? 'login-platform is-active' : 'login-platform'}
                  onClick={() => void openLogin(p)}
                >
                  {/* 平台色圆标（设计稿 `.provider-orb`）：列表里四行只差一个字，靠颜色区分比靠字形快 */}
                  <span className="provider-orb" style={{ '--pc': pm.color } as React.CSSProperties}>
                    {pm.short}
                  </span>
                  <span className="login-platform-tx">
                    <strong>{providerLabel(p)}</strong>
                    <small>{on ? it?.nickname || '已登录' : '未登录'}</small>
                  </span>
                  {on ? <span className="chip chip-success">已登录</span> : null}
                </Btn>
              );
            })}
          </div>

          {/* 右：面板（未登录 = 打开官方窗口；已登录 = 账号卡） */}
          <div className="music-login-panel">
            {logged ? (
              <>
                <div className="login-panel-head">
                  <span className="provider-orb" style={{ '--pc': meta.color } as React.CSSProperties}>
                    {meta.short}
                  </span>
                  <div>
                    <h3>{name}</h3>
                    <p>账号已连接</p>
                  </div>
                </div>
                <div className="login-account">
                  <span className="avatar-lg" style={{ '--pc': meta.color } as React.CSSProperties}>
                    {(info?.nickname ?? '?').slice(0, 1)}
                  </span>
                  <div>
                    <h4>{info?.nickname || '已登录'}</h4>
                    {/* 会员态来自平台回读，措辞与设置页③的平台卡同出处（`memberLabel`） */}
                    <p>{memberLabel(info ?? {})} · 收藏与歌单已同步</p>
                  </div>
                  <Btn kind="ghost" size="sm" onClick={() => void logoutFor(loginProvider)}>
                    退出登录
                  </Btn>
                </div>
                <p className="login-note">登录凭证只保存在本机。退出后，当前平台的歌单、收藏与搜索源会变为不可用。</p>
              </>
            ) : (
              <>
                <div className="login-panel-head">
                  <span className="provider-orb" style={{ '--pc': meta.color } as React.CSSProperties}>
                    {meta.short}
                  </span>
                  <div>
                    <h3>登录{name}</h3>
                    {/* 这里不再重复一遍"登录后同步…"：弹窗头已经写了同一句，
                        而设计稿这行的原文是「扫码后同步…」—— 本产品的登录不是扫码
                        （见文件头），照搬会变成一句做不到的承诺。 */}
                  </div>
                </div>

                <div className="login-wait">
                  {qrLoading ? <LoaderCircle className="music-login-spin" size={22} /> : <ExternalLink size={22} />}
                  <div className="login-wait-tx">
                    <h4>在官方窗口中完成登录</h4>
                    <p>
                      已为 {name} 打开登录窗口，登录成功后这里会自动更新。
                      <br />
                      登录凭证只保存在本机。
                    </p>
                  </div>
                </div>

                {/* 状态行来自 store 的真实轮询（`qrStatus`），不是写死的进度 */}
                {qrStatus ? <p className="login-status">{qrStatus}</p> : null}

                <p className="login-note">没有账号？可以先使用本地音乐，或在设置里切换播放源。</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
