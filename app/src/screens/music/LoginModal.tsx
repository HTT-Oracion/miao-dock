import { LoaderCircle, X } from 'lucide-react';
import { IconButton } from '../../components/units';
import { providerLabel } from '../../music/platform';
import { useMusicStore } from '../../music/store';

/**
 * 登录弹窗。
 * 四平台统一走**官方网页登录窗口**（openLogin 已负责弹窗 + 轮询登录态），
 * 所以这里刻意不放二维码 —— 放一张二维码反而会让人以为要在这里扫。
 */
export function LoginModal() {
  const loginOpen = useMusicStore((s) => s.loginOpen);
  const loginProvider = useMusicStore((s) => s.loginProvider);
  const qrStatus = useMusicStore((s) => s.qrStatus);
  const qrLoading = useMusicStore((s) => s.qrLoading);
  const closeLogin = useMusicStore((s) => s.closeLogin);

  if (!loginOpen) return null;

  return (
    <div className="music-login-overlay" onClick={closeLogin}>
      <div className="music-login" onClick={(e) => e.stopPropagation()}>
        <div className="music-login-hd">
          <span className="music-card-title">登录 {providerLabel(loginProvider)}</span>
          <IconButton title="关闭" onClick={closeLogin}>
            <X size={15} />
          </IconButton>
        </div>

        <div className="music-login-body">
          {qrLoading ? <LoaderCircle className="music-login-spin" size={26} /> : null}
          <div className="music-login-note">已打开官方登录窗口，请在窗口中完成登录</div>
        </div>

        <div className="music-login-status">{qrStatus || ' '}</div>

        <button type="button" className="music-btn out" onClick={closeLogin}>
          取消
        </button>
      </div>
    </div>
  );
}
