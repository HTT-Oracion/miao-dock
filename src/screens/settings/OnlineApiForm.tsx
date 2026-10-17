import { useEffect, useState } from 'react';
import { Btn, Select } from '@components/units';
import { errorText } from '@/ipc';
import { useToasts } from '@hooks';
import {
  saveTranslateCredentials,
  saveTranslateSettings,
  translateOptions,
  type TranslatePlatformOption,
} from '@screens/settings/translate-api';

/**
 * 在线 API 内嵌表单（备路径）。
 *
 * ## 不变量（ver2.2）
 * - `appSecret` **只在这条路上出站**：任何入站响应都不含它，输入框掩码显示。
 * - 选平台 + 填密钥 + 保存，**就地生效**为「翻译来源 = 在线」；不跳转到别处。
 * - 保存后由调用方决定要不要立刻拉起服务（来源切到在线，本地服务仍承载投放/队列/库）。
 */
export function OnlineApiForm({ onSaved }: { onSaved?: () => void }) {
  const { push } = useToasts();
  const [platforms, setPlatforms] = useState<TranslatePlatformOption[]>([]);
  const [platform, setPlatform] = useState('');
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void translateOptions()
      .then((o) => {
        setPlatforms(o.platforms);
        if (!platform && o.platforms[0]) setPlatform(o.platforms[0].id);
        if (!platform && o.settings.platform) setPlatform(o.settings.platform);
      })
      .catch(() => undefined);
  }, [platform]);

  const save = async () => {
    if (!platform) {
      push('请选择翻译平台', 'bad');
      return;
    }
    setBusy(true);
    try {
      await saveTranslateCredentials({ platform, appKey, appSecret });
      await saveTranslateSettings({ platform, source: 'online' });
      push('已保存在线翻译配置，来源已切换为在线', 'good');
      onSaved?.();
    } catch (e) {
      push(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nr-form">
      <div className="nr-form-line">
        <span className="nr-form-k">平台</span>
        {platforms.length > 0 ? (
          <Select
            value={platform}
            options={platforms.map((p) => ({ value: p.id, label: p.label }))}
            onChange={setPlatform}
            label="翻译平台"
          />
        ) : (
          <span className="nr-form-empty">（无可用平台）</span>
        )}
      </div>

      <label className="nr-form-line">
        <span className="nr-form-k">App Key</span>
        <input
          className="nr-form-in"
          type="text"
          value={appKey}
          onChange={(e) => setAppKey(e.target.value)}
          placeholder="粘贴平台分配的 App Key"
        />
      </label>

      <label className="nr-form-line">
        <span className="nr-form-k">App Secret</span>
        <input
          className="nr-form-in"
          type="password"
          value={appSecret}
          onChange={(e) => setAppSecret(e.target.value)}
          placeholder="只出站，不回显"
          autoComplete="new-password"
        />
      </label>

      {/* 🔴 这一层不能省：`nr-form` 是 column flex，按钮直接放进去会被拉成整行宽。 */}
      <div className="nr-form-acts">
        <Btn kind="primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存并使用在线翻译'}
        </Btn>
      </div>
    </div>
  );
}
