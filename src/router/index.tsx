/**
 * 路由装配 —— 主窗的页面切换入口。
 *
 * ## 为什么壳是一个 layout route
 * 外壳（侧栏 + 工具条 + 常驻层）**不能随导航重挂载**：音乐在壳上常驻播放
 * （`<MusicKernel/>` 是全 app 的 `<audio>`），设置页与未就绪屏的状态也住在壳里。
 * layout route 正是这个语义：壳挂一次，**屏内容随 URL 换**。
 *
 * ## 屏由谁渲染
 * 路由表（`routes.ts`）给出「路径 → 哪个屏装配件」；装配件在 `panes/`，
 * 数据经壳的 `<Outlet context>` 下来（见 `panes/shell-context.ts`）。
 *
 * ## 守卫
 * 未知路径（手工改 hash、视图改名后的旧链）**不落进任何一屏**，由兜底路由 `replace`
 * 改写回 `DEFAULT_PATH` —— 用 `replace` 而不是 `push`，免得在历史里留一条死链。
 */
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { App } from '@/App';
import { DEFAULT_PATH, OVERLAY_ROUTES, SCREEN_ROUTES } from '@/router/routes';
import { ScreenPane } from '@/router/panes';
import { DownloadPane } from '@/router/panes/DownloadPane';

export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<App />}>
          {SCREEN_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={<ScreenPane pane={r.screen} />} />
          ))}
          {OVERLAY_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={<DownloadPane />} />
          ))}
        </Route>
        <Route path="/" element={<Navigate to={DEFAULT_PATH} replace />} />
        <Route path="*" element={<Navigate to={DEFAULT_PATH} replace />} />
      </Routes>
    </HashRouter>
  );
}
