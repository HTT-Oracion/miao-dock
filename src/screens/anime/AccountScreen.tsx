/**
 * 账号与同步（设计稿 ⑧）：三种登录 + 待同步队列 + 双侧冲突合并。
 *
 * 登录走**本机中继桩**（`animesvc/account`）：邮箱密码 / 设备码（OAuth）/ 扫码（轮询）三条路都真跑，
 * 桩与真中继是同一套契约（换 base URL 即可）。桩里「模拟另一端确认」是**明确标注**的替身动作 ——
 * 真中继由手机 / 浏览器完成那一步。
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, LogIn, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { Btn, Empty } from '@components/units';
import { useAnimeStore } from '@anime/store';
import { fmtClock } from '@anime/convert';
import { SectionHead } from '@screens/anime/shared';
import { useToasts } from '@hooks';

type Mode = 'email' | 'oauth' | 'qr';

const LOGIN_WAYS = [
  { id: 'email' as const, label: '邮箱', hint: '邮箱 + 密码登录', icon: LogIn },
  { id: 'oauth' as const, label: 'OAuth', hint: '设备码授权', icon: KeyRound },
  { id: 'qr' as const, label: '扫码', hint: '手机扫码授权', icon: QrCode },
];

interface DeviceState {
  code: string;
  userCode: string;
  status: 'pending' | 'ok' | 'expired';
}

export function AccountScreen() {
  const account = useAnimeStore((s) => s.account);
  const queue = useAnimeStore((s) => s.syncQueue);
  const conflicts = useAnimeStore((s) => s.conflicts);
  const loadAccount = useAnimeStore((s) => s.loadAccount);
  const loginPassword = useAnimeStore((s) => s.loginPassword);
  const startDevice = useAnimeStore((s) => s.startDevice);
  const pollDevice = useAnimeStore((s) => s.pollDevice);
  const approveDevice = useAnimeStore((s) => s.approveDevice);
  const logoutAccount = useAnimeStore((s) => s.logoutAccount);
  const syncNow = useAnimeStore((s) => s.syncNow);
  const resolveConflict = useAnimeStore((s) => s.resolveConflict);
  const { push } = useToasts();

  const [mode, setMode] = useState<Mode>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceState | null>(null);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  // 设备码 / 扫码：拿到码之后按中继给的间隔轮询，直到 ok / expired
  useEffect(() => {
    if (!device || device.status !== 'pending') return;
    const timer = window.setInterval(() => {
      void pollDevice(device.code).then((st) => {
        if (st !== 'pending') setDevice((d) => (d ? { ...d, status: st } : d));
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [device, pollDevice]);

  const submitPassword = useCallback(async () => {
    if (!email.trim() || !password) {
      push('邮箱与密码都要填', 'bad');
      return;
    }
    setBusy(true);
    const r = await loginPassword(email.trim(), password);
    setBusy(false);
    push(r.message, r.ok ? 'good' : 'bad');
    if (r.ok) setPassword('');
  }, [email, password, loginPassword, push]);

  const beginDevice = useCallback(
    async (kind: 'oauth' | 'qr') => {
      setBusy(true);
      const r = await startDevice(kind);
      setBusy(false);
      if (!r) return;
      setDevice({ code: r.deviceCode, userCode: r.userCode, status: 'pending' });
    },
    [startDevice],
  );

  const confirmOnDevice = useCallback(async () => {
    if (!device) return;
    await approveDevice(device.code);
    const st = await pollDevice(device.code);
    if (st !== 'pending') setDevice((d) => (d ? { ...d, status: st } : d));
  }, [device, approveDevice, pollDevice]);

  const doSync = useCallback(async () => {
    setBusy(true);
    const r = await syncNow();
    setBusy(false);
    push(r.message, r.ok ? 'good' : 'bad');
  }, [syncNow, push]);

  return (
    <div className="an-screen an-pad">
      <div className="an-acct">
        <div className="an-acct-col an-acct-col-left">
          <section className="an-panel">
            <SectionHead title={account.loggedIn ? '当前账号' : '登录'} />
            {account.loggedIn ? (
              <>
                <div className="an-acct-me">
                  <b>{account.username ?? account.email ?? '已登录'}</b>
                  <span>{account.email}</span>
                  <span className="an-note">
                    云端 {account.cloudCount ?? 0} 条
                    {account.lastSyncAt
                      ? ` · 上次同步 ${new Date(account.lastSyncAt).toLocaleString()}`
                      : ' · 还没同步过'}
                  </span>
                </div>
                <div className="an-acts">
                  <Btn kind="primary" size="sm" disabled={busy} onClick={() => void doSync()}>
                    <RefreshCw size={12} /> {busy ? '同步中…' : '立即同步'}
                  </Btn>
                  <Btn kind="ghost" size="sm" disabled={busy} onClick={() => void logoutAccount()}>
                    退出登录
                  </Btn>
                </div>
              </>
            ) : (
              <>
                <p className="an-note">登录后收藏与进度可以跨设备同步；不登录也能正常用，只是数据只在这台机器上。</p>
                <div className="an-login-grid">
                  {LOGIN_WAYS.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      className={mode === w.id ? 'an-login-way is-on' : 'an-login-way'}
                      onClick={() => {
                        setMode(w.id);
                        setDevice(null);
                      }}
                    >
                      <w.icon size={20} />
                      <b>{w.label}</b>
                      <span>{w.hint}</span>
                    </button>
                  ))}
                </div>

                {mode === 'email' ? (
                  <div className="an-src-form">
                    <input
                      className="an-set-in"
                      value={email}
                      placeholder="邮箱"
                      aria-label="邮箱"
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <input
                      className="an-set-in"
                      value={password}
                      type="password"
                      placeholder="密码"
                      aria-label="密码"
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <Btn kind="primary" size="sm" disabled={busy} onClick={() => void submitPassword()}>
                      登录
                    </Btn>
                  </div>
                ) : (
                  <div className="an-device">
                    {device ? (
                      <>
                        <div className="an-device-code">
                          <span>在另一端输入这串码</span>
                          <b className="an-num">{device.userCode}</b>
                          <span className="an-note">
                            {device.status === 'pending'
                              ? '等待确认…（桩在本机，点下面按钮模拟另一端确认）'
                              : device.status === 'ok'
                                ? '已确认，正在登录'
                                : '已过期，重新获取'}
                          </span>
                        </div>
                        {device.status === 'pending' ? (
                          <Btn kind="ghost" size="sm" onClick={() => void confirmOnDevice()}>
                            <Smartphone size={12} /> 模拟另一端确认
                          </Btn>
                        ) : null}
                      </>
                    ) : (
                      <Btn
                        kind="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void beginDevice(mode === 'qr' ? 'qr' : 'oauth')}
                      >
                        {busy ? '获取中…' : '获取设备码'}
                      </Btn>
                    )}
                  </div>
                )}
                <div className="an-note">中继在本机运行（本地桩）；换真中继只改地址，不改这条链路。</div>
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
                      {t.state === 'pushed' ? '已推送' : t.state === 'retrying' ? '重试中' : '等待推送'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="an-panel">
            <SectionHead title="双侧冲突合并" count={conflicts.length} />
            {conflicts.length === 0 ? (
              <Empty inline>
                没有冲突。本地与云端对同一集进度不一致时，这里会列出两边的值与时间；按设置里的冲突策略处理。
              </Empty>
            ) : (
              conflicts.map((c) => (
                <div key={c.id} className="an-conflict">
                  <div className="an-conflict-tt">
                    {c.subjectTitle} · 第 {c.episodeIndex} 话
                  </div>
                  <div className="an-conflict-grid">
                    <div className="an-conflict-side is-pick">
                      <span>本地</span>
                      <b className="an-num">{fmtClock(c.localMs)}</b>
                      <span className="an-note">更新于 {new Date(c.localAt).toLocaleString()}</span>
                      <Btn kind="primary" size="sm" onClick={() => void resolveConflict(c.id, 'local')}>
                        保留本地
                      </Btn>
                    </div>
                    <div className="an-conflict-side">
                      <span>云端</span>
                      <b className="an-num">{fmtClock(c.cloudMs)}</b>
                      <span className="an-note">更新于 {new Date(c.cloudAt).toLocaleString()}</span>
                      <Btn kind="ghost" size="sm" onClick={() => void resolveConflict(c.id, 'remote')}>
                        采纳云端
                      </Btn>
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
