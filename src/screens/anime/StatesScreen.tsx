/**
 * 三态规范（设计稿 ⑩）：骨架 / 空态 / 错误态的落地样例 + 示例数据开关。
 *
 * 为什么「载入示例数据」放在这里：示例是**显式动作**，不是静默的假数据。
 * 这样新装的人能先看看界面长什么样，也能一键清掉 —— 清空只删 `demo-` 前缀目录。
 */
import { Eraser, Sparkles } from 'lucide-react';
import { Btn, Empty, ErrorState, Skeleton } from '@components/units';
import { useAnimeStore } from '@anime/store';

export function StatesScreen() {
  const loadDemo = useAnimeStore((s) => s.loadDemo);
  const clearDemo = useAnimeStore((s) => s.clearDemo);
  const loading = useAnimeStore((s) => s.loading);
  const subjects = useAnimeStore((s) => s.subjects);
  const error = useAnimeStore((s) => s.error);
  const hasDemo = subjects.some((s) => s.id.startsWith('demo-'));

  return (
    <div className="an-screen an-pad">
      <div className="an-hd-row">
        <b>三态规范</b>
        <span className="an-note">骨架 / 空态 / 错误态 —— 全模块统一语汇</span>
        <span className="an-sp" />
        <Btn kind="primary" size="sm" disabled={loading} onClick={() => void loadDemo()}>
          <Sparkles size={13} /> 载入示例数据
        </Btn>
        <Btn kind="ghost" size="sm" disabled={loading || !hasDemo} onClick={() => void clearDemo()}>
          <Eraser size={13} /> 清空示例
        </Btn>
      </div>

      {error ? (
        <ErrorState
          title="服务没答上来"
          message={error}
          actions={
            <Btn kind="primary" size="sm" onClick={() => void loadDemo()}>
              再试一次
            </Btn>
          }
        />
      ) : null}

      <div className="an-states">
        <section className="an-states-col">
          <div className="an-states-hd">骨架 · 加载中</div>
          <div className="an-panel">
            <Skeleton height={110} radius={12} />
            <div className="an-panel-gap">
              <Skeleton height={13} width="72%" />
              <Skeleton height={10} width="46%" />
            </div>
            <div className="an-grid an-grid-3 an-panel-gap">
              <Skeleton height={72} radius={10} />
              <Skeleton height={72} radius={10} />
              <Skeleton height={72} radius={10} />
            </div>
            <div className="an-panel-gap">
              <Skeleton height={10} width="88%" />
              <Skeleton height={10} width="64%" />
            </div>
          </div>
          <p className="an-note">列表与详情首屏用骨架，不用整屏转圈：结构先出来，内容后到位，加载完成时布局不跳。</p>
        </section>

        <section className="an-states-col">
          <div className="an-states-hd">空态 · 没有内容</div>
          <Empty>
            <b>追番列表还空着</b>
            <div className="an-empty-sub">去探索页翻两下，遇到对味的就点颗心，攒起来慢慢补。</div>
            <div className="an-empty-acts">
              <Btn kind="primary" size="sm">
                去探索
              </Btn>
            </div>
          </Empty>
          <Empty>
            <b>缓存是空的</b>
            <div className="an-empty-sub">把想囤的番先下下来，通勤路上没网也能看。</div>
          </Empty>
          <p className="an-note">空态必须给下一步动作，不只喊「暂无数据」；语气松弛，不写公文。</p>
        </section>

        <section className="an-states-col">
          <div className="an-states-hd">错误态 · 出了岔子</div>
          <ErrorState
            title="这个源连不上"
            message="Jellyfin · 家庭影音库：连接超时（5s），192.168.1.20:8096 不可达"
            actions={
              <>
                <Btn kind="primary" size="sm">
                  重试
                </Btn>
                <Btn kind="ghost" size="sm">
                  换个源
                </Btn>
              </>
            }
          />
          <ErrorState
            title="这集放不出来"
            message="第 12 话 · 当前源解码失败；已记住这个坏源，重试前不会再选它"
            actions={
              <>
                <Btn kind="primary" size="sm">
                  换源重试
                </Btn>
                <Btn kind="ghost" size="sm">
                  播放缓存版本
                </Btn>
              </>
            }
          />
          <p className="an-note">错误态说清「哪坏了 + 能干嘛」；切源类失败要记住坏源，别让人重复踩。</p>
        </section>
      </div>
    </div>
  );
}
