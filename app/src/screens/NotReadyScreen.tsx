import { useState } from 'react';
import type { ServiceStatus } from '../ipc';
import { Btn } from '../components/atoms';

/**
 * L1–L4 启动分层（《02》§2.2）。
 *
 * 四层是「即开即用」的时间轴：用户看到的每一段等待都有名字，而不是一个转圈。
 * 本迭代 L2/L3 由模拟引擎顶替（spec-notes D-09），但**文案与阶段划分照方案原样**——
 * 真实引擎接入时这段界面不需要改。
 */
const STAGES = [
  { id: 'L1', name: '环境就绪', text: '正在检查运行环境' },
  { id: 'L2', name: '模型文件就绪', text: '正在准备翻译模型' },
  { id: 'L3', name: '预热', text: '正在预热' },
  { id: 'L4', name: '首图惰性初始化', text: '首张稍慢，后续加快' },
] as const;

/**
 * 画面 X-C3 · 服务未就绪 / 启动中（《02》§5.4）。
 *
 * 展示 L1–L4 阶段进度 + 当前阶段文案 + 日志入口 + 重试；sidecar 未就绪时为 `degraded`。
 * 这一屏的责任不是「道歉」，而是**把卡在哪儿说清楚** —— 所以日志默认展开、可复制。
 */
export function NotReadyScreen({
  status,
  onRestart,
}: {
  status: ServiceStatus | null;
  onRestart: () => void;
}) {
  const [showLog, setShowLog] = useState(true);

  const state = status?.state ?? 'starting';
  const err = status?.last_error ?? null;

  // 阶段推进：starting 时按已就绪的子进程推断；running 时四层全过
  const reached = state === 'running' ? 4 : state === 'error' ? 0 : status?.sidecar_port ? 2 : 1;

  return (
    <div className="notready">
      <div className="notice">
        {state === 'error' ? (
          <>
            <b>本地服务没能起来。</b>
            {err ? <> 原因：{err}</> : null} 翻译任务暂时提交不了；浏览器插件此刻也会收到 503。
          </>
        ) : state === 'stopped' ? (
          <>
            <b>本地服务未启动。</b> 点「重启本地服务」把它拉起来。
          </>
        ) : (
          <>
            <b>正在准备本地翻译服务。</b> 首次启动需要装载模型；这一步以后，翻译是纯本地的，
            不会把图片传到任何远端。
          </>
        )}
      </div>

      {STAGES.map((s, i) => (
        <div key={s.id} className={i + 1 === reached + 1 ? 'stage is-current' : 'stage'}>
          <span className="stage-idx num">{i + 1}</span>
          <div>
            <div className="stage-text">{s.text}</div>
          </div>
          <span className="stage-note">
            {i < reached ? '已完成' : i === reached ? '进行中' : '待开始'}
          </span>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Btn kind="primary" onClick={onRestart}>
          重启本地服务
        </Btn>
        <Btn kind="ghost" onClick={() => setShowLog((v) => !v)}>
          {showLog ? '收起日志' : '查看日志'}
        </Btn>
        {status?.port ? <span className="muted" style={{ fontSize: 11 }}>服务端口 {status.port}</span> : null}
        {status?.sidecar_port ? (
          <span className="muted" style={{ fontSize: 11 }}>
            引擎端口 {status.sidecar_port}
          </span>
        ) : null}
      </div>

      {showLog ? (
        <div className="logbox">
          {(status?.log ?? []).slice(-120).join('\n') || '（暂无日志）'}
        </div>
      ) : null}
    </div>
  );
}
