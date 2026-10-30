import { Check, ChevronDown, X } from 'lucide-react';

import { MenuButton } from '@components/units';
import type { ChildStatus } from '@/ipc';

/**
 * 三进程状态按钮：默认只显示**首个进程**，点击展开其余。
 *
 * 判据（用户 2026-10-30 提的）：一行 `service✓(34136) · engine✓(35540) · llm✗`
 * 在窄窗里既挤又难扫 —— 正常时只需要知道"活着"，异常时才需要展开看是谁挂了。
 *
 * 因此：
 * - 收起时只显示第一个进程 + 成功/失败图标；
 * - **有任何进程没活** ⇒ 右侧多一枚红色警告按钮（可点开下拉）；
 * - 展开后的每一项都用 lucide 图标 + 颜色区分（成功绿 / 失败红）。
 */
export function ServiceStatusButton({
  children,
  mode,
}: {
  /** `/service/status` 的 `children`（service / engine / llm） */
  children: ChildStatus[];
  /** 引擎模式，放在下拉头里；`null` = 未知 */
  mode?: string | null;
}) {
  const list = children ?? [];
  const first = list[0];
  const failed = list.filter((c) => !c.alive);

  if (!first) {
    return (
      <span className="svc-st is-idle">
        <X size={12} />
        三进程 —
      </span>
    );
  }

  return (
    <MenuButton
      menuClass="svc-st-menu"
      trigger={({ open, toggle }) => (
        <span className="svc-st-wrap">
          <button
            type="button"
            className={first.alive ? 'svc-st is-ok' : 'svc-st is-bad'}
            aria-haspopup="menu"
            aria-expanded={open}
            title={`${first.name}${first.alive ? ' 运行中' : ' 未启动'}${first.pid ? ` · pid ${first.pid}` : ''}`}
            onClick={toggle}
          >
            {first.alive ? <Check size={12} /> : <X size={12} />}
            {first.name}
            <span className="svc-st-port">{first.pid ? `(${first.pid})` : '—'}</span>
            <ChevronDown size={11} className="svc-st-chev" />
          </button>
          {failed.length > 0 ? (
            <span
              className="svc-st-warn"
              title={`${failed.map((c) => c.name).join('、')} 未启动`}
              aria-label={`${failed.length} 个进程未启动`}
            >
              <X size={11} />
              {failed.length}
            </span>
          ) : null}
        </span>
      )}
    >
      {() => (
        <>
          <div className="svc-st-head">三进程{mode ? ` · ${mode}` : ''}</div>
          {list.map((c) => (
            <div key={c.name} className={c.alive ? 'svc-st-row is-ok' : 'svc-st-row is-bad'}>
              {c.alive ? <Check size={12} /> : <X size={12} />}
              <span className="svc-st-name">{c.name}</span>
              <span className="svc-st-pid">{c.pid ? `pid ${c.pid}` : '未启动'}</span>
            </div>
          ))}
        </>
      )}
    </MenuButton>
  );
}
