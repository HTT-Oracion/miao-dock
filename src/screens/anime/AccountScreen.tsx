/**
 * 账号与同步（设计稿 ⑧）：三种登录 + 待同步队列 + 双侧冲突合并。
 *
 * 本期账号体系尚未接入：登录入口**禁用**并写明原因；
 * 队列与合并面板展示真实（空）状态 —— 不预置假账号、不编造待同步条目。
 */
import { KeyRound, LogIn, QrCode } from 'lucide-react';
import { Empty } from '@components/units';
import { useAnimeStore } from '@anime/store';
import { fmtClock } from '@anime/convert';
import { SectionHead } from '@screens/anime/shared';

const LOGIN_WAYS = [
  { id: 'email', label: '邮箱', hint: '邮箱 + 密码登录', icon: LogIn },
  { id: 'oauth', label: 'OAuth', hint: '第三方授权跳转', icon: KeyRound },
  { id: 'qr', label: '扫码', hint: 'TV / 手机扫码', icon: QrCode },
] as const;

export function AccountScreen() {
  const account = useAnimeStore((s) => s.account);
  const queue = useAnimeStore((s) => s.syncQueue);
  const conflicts = useAnimeStore((s) => s.conflicts);

  return (
    <div className="an-screen an-pad">
      <div className="an-acct">
        <div className="an-acct-col an-acct-col-left">
          <section className="an-panel">
            <SectionHead title={account.loggedIn ? '当前账号' : '登录'} />
            {account.loggedIn ? (
              <div className="an-acct-me">
                <b>{account.username}</b>
                <span>{account.email}</span>
                <span className="an-note">云端收藏 {account.cloudCount ?? 0} 条</span>
              </div>
            ) : (
              <>
                <p className="an-note">登录后收藏与进度可以跨设备同步；不登录也能正常用，只是数据只在这台机器上。</p>
                <div className="an-login-grid">
                  {LOGIN_WAYS.map((w) => (
                    <button key={w.id} type="button" className="an-login-way" disabled title="账号体系接入后可用">
                      <w.icon size={20} />
                      <b>{w.label}</b>
                      <span>{w.hint}</span>
                    </button>
                  ))}
                </div>
                <div className="an-note">账号中继在本机运行；登录入口会随账号体系一起开放。</div>
              </>
            )}
          </section>
        </div>

        <div className="an-acct-col">
          <section className="an-panel">
            <SectionHead title="待同步队列" count={queue.length} />
            {queue.length === 0 ? (
              <Empty inline>队列是空的。改了收藏或进度后会先入队，联网时按序推送。</Empty>
            ) : (
              <div className="an-queue">
                {queue.map((t) => (
                  <div key={t.id} className="an-queue-row">
                    <span
                      className={
                        t.state === 'pushed' ? 'an-dot is-ok' : t.state === 'retrying' ? 'an-dot is-warn' : 'an-dot'
                      }
                    />
                    <span>{t.label}</span>
                    <span className="an-sp" />
                    <span className="an-chip">
                      {t.state === 'pushed' ? '已推送' : t.state === 'retrying' ? '重试中' : '等待联网'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="an-panel">
            <SectionHead title="双侧冲突合并" count={conflicts.length} />
            {conflicts.length === 0 ? (
              <Empty inline>没有冲突。本地与云端对同一集进度不一致时，这里会列出两边的值与时间。</Empty>
            ) : (
              conflicts.map((c) => (
                <div key={`${c.subjectTitle}-${c.episodeIndex}`} className="an-conflict">
                  <div className="an-conflict-tt">
                    {c.subjectTitle} · 第 {c.episodeIndex} 话
                  </div>
                  <div className="an-conflict-grid">
                    <div className="an-conflict-side is-pick">
                      <span>本地 · 保留此侧</span>
                      <b className="an-num">{fmtClock(c.localMs)}</b>
                      <span className="an-note">更新于 {new Date(c.localAt).toLocaleString()}</span>
                    </div>
                    <div className="an-conflict-side">
                      <span>云端 · 放弃此侧</span>
                      <b className="an-num">{fmtClock(c.cloudMs)}</b>
                      <span className="an-note">更新于 {new Date(c.cloudAt).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
