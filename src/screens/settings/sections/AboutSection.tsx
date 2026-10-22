// 设置页 —— 由 sections.tsx 按 Section 拆分（D-150）。
import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { GroupNote, PendingRow, ReadOnly, Row, RowNote, SubTitle } from '@screens/settings/parts';
import { ABOUT } from '@screens/settings/catalog';
import { LicensesBlock } from '@screens/settings/LicensesBlock';
import { itemOf } from './shared';

/**
 * ⑤ 关于 —— 3 项。
 *
 * live：版本号（Tauri `getVersion()`）· 第三方许可（枚举清单，台账 D-84）
 * pending：开源反馈（缺一个真实可打开的仓库地址）
 *
 * 版本号取 Tauri 的 `getVersion()`（构建时的真实版本），不是手写常量。
 * 拿不到就明说"读取失败"，**不退回硬编码字符串** —— 一个与实际构建无关的
 * 版本号比没有版本号更糟：它会让人以为看的是当前这个包。
 *
 * 本组与①通用一样**手工渲染**（不用 `Group`）：版本号那一行下面要跟一条条件附注，
 * 而"附注紧跟它所属的那一行"这件事只有手写位置才能保证。
 */
export function AboutSection() {
  const [ver, setVer] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const v = await getVersion();
        if (alive) setVer(v);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const g = ABOUT.groups[0];
  const versionItem = itemOf(g, 'version');

  return (
    <>
      {/* 组说明缺省即不渲染（GroupNote 自守）：catalog 未给 ABOUT.note 时这一行自动消失 */}
      <GroupNote summary={ABOUT.noteSummary}>{ABOUT.note as string}</GroupNote>

      {/* ── 卡一：品牌头 + 一句话定位 + 版本号（设计稿 `.about-head` / `.about-desc`）── */}
      <div className="set-group">
        <div className="about-head">
          <img className="about-avatar" src="/assets/icons/miao-logo.png" alt="喵坞" width={58} height={58} />
          <div className="about-id">
            <h3>喵坞 MiaoDock</h3>
            <p>本地漫画翻译与安静的音乐播放器。</p>
          </div>
          {ver ? <span className="chip chip-soft">v{ver}</span> : null}
        </div>
        <div className="about-desc">
          把喜欢的故事留在本机。翻译、播放与设置都在离线环境里完成，只有在线翻译和音乐平台会访问网络。
        </div>
        <Row item={versionItem}>
          <ReadOnly>{failed ? '读取失败' : (ver ?? '读取中…')}</ReadOnly>
        </Row>
        {failed ? (
          <RowNote>
            读不到构建版本（WebView 未获 <code>core:app:allow-version</code> 授权时会这样）。 这里不用手写版本号顶上 ——
            那会让你以为看的是当前这个包。
          </RowNote>
        ) : null}
        {/* 原先这里还有一行「检查更新」—— 该项目已整条删除（缺的是更新源这个外部事实，
            且托盘上从来没有这一项）。留着它会让本组在渲染时直接抛错：`itemOf` 找不到项就
            抛 —— 那道守卫是对的，错的是没跟着删的这行引用。 */}
      </div>

      {/* ── 卡二：第三方许可 + 开源反馈（设计稿同卡）── */}
      <div className="set-group">
        <SubTitle head="清单枚举自 npm 与 Rust 两侧依赖；列的是各包自己声明的许可">第三方许可</SubTitle>
        <LicensesBlock item={itemOf(g, 'licenses')} />
        <PendingRow item={itemOf(g, 'oss-feedback')} />
      </div>

      {/* 收尾说明（设计稿 `.s-note`）：这一句回答的是"我的东西会不会被传出去" */}
      <div className="set-note-inline">
        <Info size={13} />
        <span>喵坞不会上传漫画原图与本地音乐。在线 API 只发送当前批次的原文与语种信息。</span>
      </div>
    </>
  );
}
