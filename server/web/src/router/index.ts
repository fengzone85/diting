import { createRouter, createWebHistory } from 'vue-router';
import { makeAuthGuard } from './guard';
// 首页保留 eager（首屏必经，省一次请求）；其余视图全部路由懒加载。
// 修复（2026-10-12 主页性能）：此前全量静态 import 使 NodeDetailView 进入入口
// 依赖链，其依赖的 echarts(504KB) 被 modulepreload 强制首屏加载（主页并不
// 使用图表），admin 全部视图代码也混入主包。懒加载后 echarts 仅在进入详情页
// 时按需拉取，admin 视图各自独立 chunk。
import HomeView from '../views/HomeView.vue';

const routes = [
  { path: '/', component: HomeView },
  { path: '/node/:id', component: () => import('../views/NodeDetailView.vue'), props: true },
  { path: '/login', component: () => import('../views/LoginView.vue') },
  // 安装向导：未安装时服务端把所有页面 307 到这里（复刻上游安装向导入口）
  { path: '/install', component: () => import('../views/InstallView.vue') },
  {
    path: '/admin',
    component: () => import('../views/admin/AdminLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', component: () => import('../views/admin/DashboardView.vue') },
      { path: 'agents', component: () => import('../views/admin/AgentsView.vue') },
      { path: 'agents/:id', component: () => import('../views/admin/AgentDetailView.vue'), props: true },
      { path: 'agent-artifacts', component: () => import('../views/admin/AgentArtifactsView.vue') },
      { path: 'billing', component: () => import('../views/admin/BillingView.vue') },
      { path: 'alerting', component: () => import('../views/admin/AlertingView.vue') },
      { path: 'ai', component: () => import('../views/admin/AiView.vue') },
      { path: 'site', component: () => import('../views/admin/SiteSettingsView.vue') },
      { path: 'template', component: () => import('../views/admin/TemplateView.vue') },
      { path: 'audit-logs', component: () => import('../views/admin/AuditLogView.vue') },
      { path: 'api-tokens', component: () => import('../views/admin/ApiTokensView.vue') },
      { path: 'sessions', component: () => import('../views/admin/SessionsView.vue') },
      { path: 'maintenance', component: () => import('../views/admin/MaintenanceView.vue') },
      // 旧「设置」页已按域拆开（2026-11 后台信息架构重组），保留深链兼容：
      // 原页面里备份/容量位于最下方，重定向到承接它们的「系统维护」。
      { path: 'settings', redirect: '/admin/maintenance' },
    ],
  },
  // catch-all 必须放在最后：服务端 SPA fallback 对未知路径返回 200 + index.html，
  // 没有这条路由时用户看到的是白屏而非 404 页。
  { path: '/:pathMatch(.*)*', component: () => import('../views/NotFoundView.vue') },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(makeAuthGuard());

export default router;
