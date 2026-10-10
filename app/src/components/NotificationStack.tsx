import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toastBus, useToastList } from '@/toastBus';
import type { BusToast, ToastKind } from '@/toastBus';

/**
 * 通知堆叠（topRight）—— 轻提示的**唯一**渲染层（2026-10-11 改版）。
 *
 * ## 为什么从灵动岛剥离
 * 灵动岛一条胶囊一次只能显示一条提示，且音乐播放态会把它顶掉 —— 用户连发几个操作
 * （批量删除、归并、返工）时只能看到最后一条。改成 antd `notification`（topRight）的
 * 形态：**多条并存、逐条关闭、自动消失**，操作反馈不再互相覆盖。
 *
 * ## 与 antd 的关系：只借形态，不引依赖
 * 参考的是 antd notification 的交互形态（topRight 堆叠 + 语义色 + 逐条关闭 +
 * 自动消失），**不引入 antd 依赖** —— 引入整个 antd 只为通知一个组件，包体与主题
 * 两头都不划算（antd 的样式变量与本项目的 `--md-*` 令牌是两套体系，主题对齐反而费劲）。
 * 视觉逐项取自本项目既有语汇：卡片底 `--md-surface` / 描边 `--md-line` / 阴影与
 * `.di-capsule` 同值 / 圆角 12 与 `.card` 同档 / 语义色沿用 `di-dot-*` 的同一套映射。
 *
 * ## 为什么还在 toastBus 上
 * `ISLAND.singleSource` 的裁定不变：全应用只有**一条**吐司队列（toastBus），
 * `useToasts().push` / music/Toast 转发器照旧往里推 —— 改的只是**渲染层**。
 * 灵动岛从此只承载音乐播放态（components/DynamicIsland.tsx）。
 *
 * ## 生命周期
 * 自动消失的 TTL 仍在总线（`toastBus.push` 内 3.8s / 报错 6.5s，与旧灵动岛一致）；
 * 这里只补两件事：**手动关闭走退场动画**（先置 leaving，180ms 后才真正出队），
 * **入场动画**靠 CSS（`.ntf` 挂载即播）。TTL 到点直接出队 —— 静默消失，与旧灵动岛一致。
 */

/** kind → 语义色（沿用 `.di-dot-*` 的同一套映射，见 music.scss；info = 品牌色） */
const KIND_TO_COLOR: Record<ToastKind, string> = {
  info: 'var(--md-pink)',
  good: 'var(--md-success)',
  bad: 'var(--md-error)',
  warning: 'var(--md-warning)',
  loading: 'var(--md-blue)',
  blue: 'var(--md-blue)',
};

/** 手动关闭的退场时长 —— 必须与 app.scss `.ntf.is-leaving` 的 animation 时长一致 */
const LEAVE_MS = 180;

export function NotificationStack() {
  const list = useToastList();

  // 正在退场的条目： dismissal 延迟到动画播完，所以总线里还在、但渲染成退场态
  const leavingRef = useRef<Set<number>>(new Set());

  if (list.length === 0) return null;

  return (
    <div className="ntf-stack" role="region" aria-label="通知">
      {list.map((t) => (
        <NotificationCard key={t.id} toast={t} leavingRef={leavingRef} />
      ))}
    </div>
  );
}

function NotificationCard({
  toast,
  leavingRef,
}: {
  toast: BusToast;
  /** 共享的"正在退场"登记表（`{ current }` 形态，规避 RefObject 的 readonly/null 变体） */
  leavingRef: { current: Set<number> };
}) {
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef<number | null>(null);

  const close = useCallback(() => {
    if (leavingRef.current?.has(toast.id)) return; // 双击关闭：退场只走一次
    leavingRef.current?.add(toast.id);
    setLeaving(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      toastBus.dismiss(toast.id);
    }, LEAVE_MS);
  }, [toast.id, leavingRef]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <div className={leaving ? 'ntf is-leaving' : 'ntf'} role="status" aria-live="polite">
      <span className="ntf-dot" style={{ background: KIND_TO_COLOR[toast.kind] }} aria-hidden="true" />
      <span className="ntf-text">{toast.text}</span>
      <span className="ntf-close">
        <button
          type="button"
          className="ui-cbtn"
          title="关闭通知"
          aria-label="关闭通知"
          onClick={close}
        >
          <X size={13} />
        </button>
      </span>
    </div>
  );
}
