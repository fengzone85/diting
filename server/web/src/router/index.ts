import { createRouter, createWebHistory } from 'vue-router';
import { getAuthStatus } from '../services/auth';
import HomeView from '../views/HomeView.vue';
import NodeDetailView from '../views/NodeDetailView.vue';
import LoginView from '../views/LoginView.vue';
import AdminLayout from '../views/admin/AdminLayout.vue';
import DashboardView from '../views/admin/DashboardView.vue';
import AgentsView from '../views/admin/AgentsView.vue';
import AgentDetailView from '../views/admin/AgentDetailView.vue';
import SettingsView from '../views/admin/SettingsView.vue';
import TemplateView from '../views/admin/TemplateView.vue';
import BillingView from '../views/admin/BillingView.vue';
import AiView from '../views/admin/AiView.vue';
import AuditLogView from '../views/admin/AuditLogView.vue';

const routes = [
  { path: '/', component: HomeView },
  { path: '/node/:id', component: NodeDetailView, props: true },
  { path: '/login', component: LoginView },
  {
    path: '/admin',
    component: AdminLayout,
    meta: { requiresAuth: true },
    children: [
      { path: '', component: DashboardView },
      { path: 'agents', component: AgentsView },
      { path: 'agents/:id', component: AgentDetailView, props: true },
      { path: 'billing', component: BillingView },
      { path: 'ai', component: AiView },
      { path: 'settings', component: SettingsView },
      { path: 'template', component: TemplateView },
      { path: 'audit-logs', component: AuditLogView },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (to.meta.requiresAuth) {
    const status = await getAuthStatus();
    if (!status.logged_in) {
      return { path: '/login', query: { redirect: to.fullPath } };
    }
  }
});

export default router;
