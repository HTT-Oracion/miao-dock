/**
 * 路由装配 —— 主窗的页面切换入口。
 *
 * ## 为什么三条路由都渲染同一个外壳
 * 外壳（侧栏 + 工具条 + 常驻层）**不能随导航重挂载**：音乐在壳上常驻播放，
 * 设置页与未就绪屏的状态也都住在壳里。所以「切屏」在壳内部按 URL 换内容，
 * 而不是换组件树 —— 路由表在这里的职责是「**声明哪些路径合法、各自对应哪一屏**」，
 * 以及把非法路径改写回默认落点。
 *
 * ## 守卫
 * 未知路径（手工改 hash、深链写错、视图改名后的旧链）**不落进任何一屏**，
 * 由兜底路由 `replace` 改写回 `DEFAULT_PATH` —— 用 `replace` 而不是 `push`，
 * 免得在历史里留一条死链。视图合法性同样由这张表兜住：
 * `/translate/xxx` 不是一条已登记的路由，走的就是这条兜底。
 */
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { App } from '@/App';
import { DEFAULT_PATH, SCREEN_ROUTES } from '@/router/routes';

export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Navigate to={DEFAULT_PATH} replace />} />
        {SCREEN_ROUTES.map((r) => (
          <Route key={r.path} path={r.path} element={<App />} />
        ))}
        <Route path="*" element={<Navigate to={DEFAULT_PATH} replace />} />
      </Routes>
    </HashRouter>
  );
}
