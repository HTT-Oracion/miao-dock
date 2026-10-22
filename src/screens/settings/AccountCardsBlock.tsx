import { Btn } from '@components/units';
import { memberLabel } from '@music/convert';
import { PLATFORMS } from '@music/platform';
import { useMusicStore } from '@music/store';
import type { MusicProvider } from '@music/types';
import { SubTitle } from '@screens/settings/parts';

/**
 * 设置页 ③ 的第一张卡：四个平台的账号状态（设计稿 `.account-grid` / `.account-card`）。
 *
 * 设计稿把账号入口放在两处 —— 音乐屏左栏那一行，以及设置页这张卡。产品此前只有前者，
 * 这一张补齐的是"**在设置里就能看清哪个平台登着、要不要退出**"这件事：
 * 左栏那一行只显示**当前播放源**的账号，其余三个平台的状态在那一屏看不到。
 *
 * 🔴 数据只来自 `loginInfos`（壳层启动时批量探测、登录成功后由 store 回写），
 *    本组件不自己发请求、也不放任何一个演示数字。
 * `null` 是"还没探到 / 探测失败"，界面写「状态未知」而不是「未登录」——
 * 后者是一个我们并不知道的断言（与灵动岛那条口径一致）。
 */
export function AccountCardsBlock() {
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const openLogin = useMusicStore((s) => s.openLogin);
  const logoutFor = useMusicStore((s) => s.logoutFor);

  return (
    <div className="set-group">
      <SubTitle head="登录后同步歌单、收藏与播放记录；凭证仅保存在本机">音乐账号</SubTitle>
      <div className="account-grid">
        {PLATFORMS.map((p) => {
          const info = loginInfos[p.id as MusicProvider];
          const logged = !!info?.logged_in;
          // 小字三种取值各自都是"看得见的fact"：登着 → 昵称 + 会员态；
          // 明确没登 → 未登录；探测没回来 → 状态未知（不假装知道）
          const sub = info ? (logged ? `${info.nickname || '已登录'} · ${memberLabel(info)}` : '未登录') : '状态未知';
          const id = p.id as MusicProvider;
          return (
            <div className="account-card" key={id} data-account-id={id}>
              <span className="provider-orb" style={{ '--pc': p.color } as React.CSSProperties}>
                {p.short}
              </span>
              <span className="account-card-tx">
                <strong>{p.label}</strong>
                <small>{sub}</small>
              </span>
              {logged ? (
                <Btn kind="ghost" title={`${p.label}：退出登录`} onClick={() => void logoutFor(id)}>
                  退出
                </Btn>
              ) : (
                <Btn kind="primary" title={`${p.label}：登录`} onClick={() => void openLogin(id)}>
                  登录
                </Btn>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
