import { RotateCcw, Settings, X } from 'lucide-react';
import { Btn, ColorPicker, IconButton, Range, Swatches } from '@components/units';
import { useEsc } from '@hooks/useEsc';
import { DL_BASE_COLORS, DL_HIGHLIGHT_COLORS, DL_LINE_COUNT, DL_LYRICS_SIZE } from '@music/player-options';
import { LYRICS_COLOR_NAMES } from '@music/player-options';
import { useMusicStore } from '@music/store';

/**
 * 桌面歌词设置弹窗（从播放条右侧的「桌面歌词设置」图标唤起）。
 *
 * ## 为什么这里是一套**独立**偏好，而不是复用设置页的歌词项
 *
 * 展开播放器可以铺满整屏，桌面歌词窗只有 160px 高且 `resizable(false)`
 * （几何写死在 `src-tauri/src/lyrics_window.rs` 的 `WIN_H`）。两边共用一个字号时，
 * 用户为了详情页把字号拉到 48，桌面歌词就被撑成两行巨字 —— 这不是假设，
 * 是字号量程对齐 17–48 之后立刻出现的问题。参考实现同样是两套字段，本弹窗照此办理。
 *
 * ## 本弹窗保留了参考实现的哪几项（逐项裁定见交付报告）
 *
 * 做：字号 / 高亮色（已唱行）/ 底色（未唱行）/ 显示行数。
 * 不做：字体（本移植没有字体导入能力：Rust 侧没有 `get_system_fonts`、
 *      也没有自定义字体注册，摆一个下拉框只能改到一个没人消费的字段）；
 *      显示翻译（歌词数据里**有** translation 字段，但从 `parseLrc` 到推送载荷
 *      到本窗渲染，整条链路都没有翻译的位置，做它要改冻结契约 —— 见报告）；
 *      隐藏解锁按钮（本移植的解锁是"双击歌词条"，根本没有"解锁按钮"这种东西，
 *      引入它得先定义一套新交互）。
 *
 * ## 「实时预览」怎么算
 *
 * 每个控件改的是 store 里同一个字段，store 的 setter 顺手把偏好推给歌词窗
 * （`pushLyricsPrefs`），所以**真正的实时预览就是桌面歌词窗本身**。弹窗里那条
 * 小样只是给"窗口没开"时的一点即时反馈 —— 它用的是同一份 store 值，不是另画一套。
 *
 * 复用方式：受控组件（`open` + `onClose`），由调用方决定开合；组件自身不持开合状态，
 * 这样 PlayerBar 之外（例如以后从设置页唤起）也能直接复用同一个弹窗。
 */
export function DesktopLyricsSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  /*
   * Esc 关闭挂在组件常驻期间（不随 open 卸载重挂）：
   * 关闭态下不响应，避免一个没打开的弹窗抢走全局 Esc。
   */
  useEsc(() => {
    if (open) onClose();
  });

  // 四项偏好都从音乐模块的全局 store 读、setter 回写同一份 —— 弹窗不缓存、不落盘。
  const fontSize = useMusicStore((s) => s.desktopLyricsFontSize);
  const setFontSize = useMusicStore((s) => s.setDesktopLyricsFontSize);
  const highlightColor = useMusicStore((s) => s.desktopLyricsHighlightColor);
  const setHighlightColor = useMusicStore((s) => s.setDesktopLyricsHighlightColor);
  const baseColor = useMusicStore((s) => s.desktopLyricsBaseColor);
  const setBaseColor = useMusicStore((s) => s.setDesktopLyricsBaseColor);
  const lineCount = useMusicStore((s) => s.desktopLyricsLineCount);
  const setLineCount = useMusicStore((s) => s.setDesktopLyricsLineCount);
  const resetAll = useMusicStore((s) => s.resetDesktopLyricsPrefs);

  if (!open) return null;

  // 行数候选由常量区间生成，不手写 [2,3,4,5] —— 改 DL_LINE_COUNT 时这里跟着变
  const lineCounts: number[] = [];
  for (let n = DL_LINE_COUNT.min; n <= DL_LINE_COUNT.max; n += 1) lineCounts.push(n);

  return (
    <div className="music-dlset-overlay" onClick={onClose}>
      {/* 阻止冒泡：点弹窗内部不应触发遮罩的「点击关闭」 */}
      <div className="music-dlset" onClick={(e) => e.stopPropagation()}>
        <div className="music-dlset-hd">
          <div>
            {/* 设计稿 kicker：`DESKTOP LYRICS` */}
            <span className="music-dlset-kicker">DESKTOP LYRICS</span>
            <span className="music-dlset-title">
              <Settings size={15} /> 桌面歌词设置
            </span>
            <p className="music-dlset-sub">只作用于桌面歌词窗，展开播放器的歌词不受影响。</p>
          </div>
          <IconButton title="关闭" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>

        <div className="music-dlset-body">
          {/*
            即时小样：用下面各控件正在编辑的同一份 store 值渲染，窗口没开时也能看到效果。
            aria-hidden —— 它是纯视觉示意，读屏用户从控件本身就能拿到全部信息。
            两句的标注文案取自设计稿（`上一句歌词 · 未高亮` / `正在唱的这一句 · 高亮`）：
            它们同时说明"这两行分别是什么"和"哪个是当前句"。
          */}
          <div className="music-dlset-preview" aria-hidden="true">
            <div
              className="music-dlset-pv-line"
              style={{ fontSize: `${Math.round(fontSize * 0.86)}px`, color: baseColor }}
            >
              上一句歌词 · 未高亮
            </div>
            <div className="music-dlset-pv-line" style={{ fontSize: `${fontSize}px`, color: highlightColor }}>
              正在唱的这一句 · 高亮
            </div>
          </div>

          {/* 字号 */}
          <div className="music-dlset-row">
            <div className="music-dlset-label">字号</div>
            <div className="music-dlset-ctl">
              <Range
                label="桌面歌词字号"
                min={DL_LYRICS_SIZE.min}
                max={DL_LYRICS_SIZE.max}
                step={DL_LYRICS_SIZE.step}
                value={fontSize}
                suffix="px"
                onChange={setFontSize}
              />
            </div>
            <div className="music-dlset-hint">
              桌面歌词窗里<b>正在唱那一行</b>的字号；其余行按它的 0.86 倍缩小。与展开播放器的歌词字号相互独立。
            </div>
          </div>

          {/* 高亮色 */}
          <div className="music-dlset-row">
            <div className="music-dlset-label">高亮色（已唱）</div>
            <div className="music-dlset-ctl">
              <Swatches
                label="桌面歌词高亮色"
                colors={DL_HIGHLIGHT_COLORS}
                names={LYRICS_COLOR_NAMES}
                value={highlightColor}
                onPick={setHighlightColor}
              />
              <ColorPicker label="桌面歌词高亮色（自定义）" value={highlightColor} onChange={setHighlightColor} />
            </div>
            <div className="music-dlset-hint">正在唱的那一行的颜色。与展开播放器的歌词高亮色相互独立。</div>
          </div>

          {/* 底色 */}
          <div className="music-dlset-row">
            <div className="music-dlset-label">底色（未唱）</div>
            <div className="music-dlset-ctl">
              <Swatches label="桌面歌词底色" colors={DL_BASE_COLORS} value={baseColor} onPick={setBaseColor} />
              <ColorPicker label="桌面歌词底色（自定义）" value={baseColor} onChange={setBaseColor} />
            </div>
            <div className="music-dlset-hint">其余未高亮行（上一句及更早）的颜色，用来把焦点让给当前句。</div>
          </div>

          {/* 行数 */}
          <div className="music-dlset-row">
            <div className="music-dlset-label">显示行数</div>
            <div className="music-dlset-ctl">
              <div className="music-dlset-seg" role="group" aria-label="桌面歌词显示行数">
                {lineCounts.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={n === lineCount ? 'music-dlset-segbtn is-on' : 'music-dlset-segbtn'}
                    aria-pressed={n === lineCount}
                    onClick={() => setLineCount(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="music-dlset-hint">
              一次显示几行（含当前句，当前句在最下方，往上回溯前几句）。窗口高度固定为
              160px，行数多时把字号调小一些更稳妥。
            </div>
          </div>
        </div>

        <div className="music-dlset-ft">
          {/* 恢复默认：四项一起回出厂值（store 里是一个 action，不是四次 setter） */}
          <Btn size="sm" title="把字号 / 高亮色 / 底色 / 行数一起恢复为默认值" onClick={resetAll}>
            <RotateCcw size={13} /> 恢复默认
          </Btn>
          <Btn size="sm" kind="primary" onClick={onClose}>
            完成
          </Btn>
        </div>

        <div className="music-dlset-note">改动会立即生效并记住；桌面歌词窗开着时即时可见，没开则下次打开时应用。</div>
      </div>
    </div>
  );
}
