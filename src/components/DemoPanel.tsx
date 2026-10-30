import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Btn, IconButton } from '@components/units';
import { DEMO_STATES, useDemoOverride, type DemoState } from '@/stores/demo-override';

/**
 * 演示面板（设计稿 `.demo-fab` + `.demo-drawer`）—— 开发态专用，生产构建整块不渲染。
 *
 * ## 为什么要有它
 * 引导页与下载页的六种形态在真机上**很难凑齐**：要么等一次真实装配（几分钟到几十分钟），
 * 要么手动杀掉子进程制造异常。演示面板把这六种状态变成一次点击 —— 且**走的仍是真实状态机**
 * （`demo.ts` 只换状态机的输入，渲染与判定一行都不改）。
 *
 * ## 与设计稿的差异（刻意）
 * 设计稿面板有五组（漫画服务 / 队列与投放 / 漫画库 / 音乐 / 番剧 / 设置与全局）。
 * 本产品只做**本次重构范围内的【漫画服务】一组** —— 其余分组对应的屏不在本轮范围内，
 * 摆上去就等于给它们开一条绕过真实状态机的后门。
 *
 * ## 触发方式
 * 右下角那枚胶囊（`.demo-fab`）＋ `Ctrl+Shift+D`。Esc 关闭（与其它浮层同一口径）。
 */
export function DemoPanel() {
  const active = useDemoOverride((s) => s.active);
  const set = useDemoOverride((s) => s.set);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!import.meta.env.DEV) return null;

  const pick = (id: DemoState) => {
    set(active === id ? null : id);
    setOpen(false);
  };

  return (
    <>
      <Btn
        kind="bare"
        className="demo-fab"
        ariaLabel="打开设计演示面板"
        title="状态演示 · Ctrl+Shift+D"
        ariaExpanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Sparkles size={13} />
        <span>演示</span>
      </Btn>

      {open ? (
        <div className="demo-drawer">
          <div className="demo-mask" onClick={() => setOpen(false)} />
          <aside className="demo-panel" role="dialog" aria-modal="true" aria-labelledby="demoTitle">
            <header className="demo-head">
              <div>
                <span className="modal-kicker">DESIGN REVIEW</span>
                <h2 id="demoTitle">状态演示</h2>
              </div>
              <IconButton title="关闭" onClick={() => setOpen(false)}>
                <X size={18} />
              </IconButton>
            </header>
            <div className="demo-body">
              <div className="demo-group">
                <h3>漫画服务</h3>
                <div className="demo-grid">
                  {DEMO_STATES.map((s) => (
                    <Btn
                      key={s.id}
                      kind="bare"
                      className={active === s.id ? 'demo-btn is-on' : 'demo-btn'}
                      ariaPressed={active === s.id}
                      title={s.hint}
                      onClick={() => pick(s.id)}
                    >
                      {s.label}
                    </Btn>
                  ))}
                  <Btn
                    kind="bare"
                    className="demo-btn is-wide"
                    disabled={active === null}
                    onClick={() => {
                      set(null);
                      setOpen(false);
                    }}
                  >
                    恢复真实状态
                  </Btn>
                </div>
              </div>
            </div>
            <footer className="demo-foot">这些开关只影响界面读取的状态输入，不会写入真实服务。</footer>
          </aside>
        </div>
      ) : null}
    </>
  );
}
