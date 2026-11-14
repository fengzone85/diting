<script setup lang="ts">
// 后台侧栏：经典停靠列（参考设计）。桌面是真实布局列（展开 15rem ↔ 收起 4rem 图标栏、内滚、右边界），
// 移动是抽屉 + 遮罩。开合由父级 AdminLayout 单状态 sidebarOpen 控制（localStorage 记忆）。
// 收起态保留图标导航（仅图标居中 + title 提示、隐藏文字与分组标题），不再整列消失。
// 按功能域分组：节点 / 告警与通知 / 站点与外观 / 安全 / 系统。
// 二级菜单对齐参考面板：多分节域（告警/站点/维护）是「可展开父项 + 子路由链接」，
// 父项点击只开合不导航；当前路由命中子项时自动展开；图标栏里点父项先展开侧栏再开子菜单。
import { computed, ref, watch, type Component } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  DashboardOne, Monitor, Wallet, Robot, Log, Key, SettingTwo, LayoutTwo, Folder,
  Home, Logout, User, Alarm, Theme, Down,
} from '@icon-park/vue-next';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  open: boolean;
  isMobile: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'open'): void;
}>();

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

interface NavChild { to: string; label: string }
interface NavItem { to: string; label: string; icon: Component; children?: NavChild[] }
interface NavGroup { key: string; title: string; items: NavItem[] }

// 用 computed 而非一次性数组：切换语言时菜单文案需要跟着变（t() 内部读取 locale ref）。
// 子项标签复用各分节原标题（settings.*/site.* 键），与路由 props.section 一一对应。
const groups = computed<NavGroup[]>(() => [
  {
    // 节点域：清单 + 成本 + 分发物料（对齐参考面板的「服务器」域，含批量与终端类操作）
    key: 'nodes',
    title: t('nav.group.nodes'),
    items: [
      { to: '/admin', label: t('nav.dashboard'), icon: DashboardOne },
      { to: '/admin/agents', label: t('nav.agents'), icon: Monitor },
      { to: '/admin/billing', label: t('nav.billing'), icon: Wallet },
      { to: '/admin/agent-artifacts', label: t('nav.agentArtifacts'), icon: Folder },
    ],
  },
  {
    // 告警域：五个分节拆为子路由（侧栏二级菜单），AI 分析报告与之同组
    key: 'alerts',
    title: t('nav.group.alerts'),
    items: [
      {
        to: '/admin/alerting', label: t('nav.alerting'), icon: Alarm,
        children: [
          { to: '/admin/alerting/thresholds', label: t('settings.alertThresholds') },
          { to: '/admin/alerting/group', label: t('settings.groupAlertRules') },
          { to: '/admin/alerting/probe', label: t('settings.probeTargets') },
          { to: '/admin/alerting/notify', label: t('settings.notify') },
          { to: '/admin/alerting/channels', label: t('settings.groupChannels') },
        ],
      },
      { to: '/admin/ai', label: t('nav.ai'), icon: Robot },
    ],
  },
  {
    // 外观域：站点七个分节拆为子路由；玻璃拟态外观与主题市场仍是独立页
    key: 'site',
    title: t('nav.group.site'),
    items: [
      {
        to: '/admin/site', label: t('nav.site'), icon: LayoutTwo,
        children: [
          { to: '/admin/site/basic', label: t('site.basic') },
          { to: '/admin/site/display', label: t('site.display') },
          { to: '/admin/site/public', label: t('site.public') },
          { to: '/admin/site/custom', label: t('site.custom') },
          { to: '/admin/site/social', label: t('settings.socialLinks') },
          { to: '/admin/site/token', label: t('settings.setupToken') },
          { to: '/admin/site/billing', label: t('settings.billingTitle') },
        ],
      },
      { to: '/admin/template', label: t('nav.template'), icon: Theme },
    ],
  },
  {
    // 安全域：凭据、登录设备/2FA/IP 白名单、审计
    key: 'security',
    title: t('nav.group.security'),
    items: [
      { to: '/admin/api-tokens', label: t('nav.apiTokens'), icon: Key },
      { to: '/admin/sessions', label: t('nav.sessions'), icon: User },
      { to: '/admin/audit-logs', label: t('nav.auditLogs'), icon: Log },
    ],
  },
  {
    // 系统域：数据保留、备份恢复、容量保险丝拆为子路由
    key: 'system',
    title: t('nav.group.system'),
    items: [
      {
        to: '/admin/maintenance', label: t('nav.maintenance'), icon: SettingTwo,
        children: [
          { to: '/admin/maintenance/retention', label: t('settings.retentionTitle') },
          { to: '/admin/maintenance/backup', label: t('settings.backup') },
          { to: '/admin/maintenance/restore', label: t('settings.restoreAuditTitle') },
          { to: '/admin/maintenance/files', label: t('settings.backupFiles') },
          { to: '/admin/maintenance/capacity', label: t('settings.capacityTitle') },
        ],
      },
    ],
  },
]);

// ---- 二级菜单开合（对齐参考面板语义）：父项点击只切换，不导航 ----
const openSubMenus = ref<Record<string, boolean>>({});

function toggleParent(item: NavItem) {
  // 图标栏（桌面收起）里子菜单无处显示：先展开侧栏，再打开对应子菜单
  if (!props.open && !props.isMobile) {
    emit('open');
    openSubMenus.value[item.to] = true;
    return;
  }
  openSubMenus.value[item.to] = !openSubMenus.value[item.to];
}

// 当前路由落在某父项的子路由时自动展开它（含直接深链进入 / 刷新）；不主动收起其它父项。
watch(() => route.path, (path) => {
  for (const g of groups.value) {
    for (const item of g.items) {
      if (item.children && (path === item.to || path.startsWith(item.to + '/'))) {
        openSubMenus.value[item.to] = true;
      }
    }
  }
}, { immediate: true });

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    router.push('/login');
  }
}

// 仅移动抽屉在导航后关闭；桌面停靠列保持开（同参考面板语义）。
function onNavClick() {
  if (props.isMobile) emit('close');
}

// 首页 /admin 必须精确匹配：用 startsWith 会让「仪表盘」在任意子页面都高亮。
function isActive(to: string) {
  if (to === '/admin') return route.path === '/admin';
  return route.path === to || route.path.startsWith(to + '/');
}
</script>

<template>
  <!-- 遮罩：仅移动抽屉（<1024）需要；桌面停靠列不遮罩 -->
  <div
    v-if="open && isMobile"
    class="fixed inset-0 z-[45] bg-black/50"
    @click="emit('close')"
  />
  <aside
    class="sidebar flex-shrink-0 overflow-y-auto overflow-x-hidden"
    :class="[
      isMobile ? 'sidebar-mobile' : 'sidebar-desktop',
      open ? 'is-open' : 'is-closed',
    ]"
  >
    <!-- 内层 min-width 固定：宽度动画时文字不重排（同参考面板的固定内层宽度）；收起态切到图标栏宽度 -->
    <div class="sidebar-inner flex min-h-full flex-col p-3">
      <!-- 移动关闭按钮（桌面开关在顶栏） -->
      <div v-if="isMobile" class="mb-4 flex items-center justify-end px-1">
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:text-white"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >✕</button>
      </div>

      <!-- 分组菜单 -->
      <nav class="flex-1 space-y-4">
        <div v-for="group in groups" :key="group.key">
          <p
            class="group-title mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted"
          >{{ group.title }}</p>
          <div class="space-y-1">
            <div v-for="item in group.items" :key="item.to">
              <!-- 叶子项：直接导航 -->
              <RouterLink
                v-if="!item.children"
                :to="item.to"
                :title="item.label"
                :aria-label="item.label"
                class="nav-item flex items-center gap-3 rounded-lg border-l-[3px] px-3 py-2 text-sm transition-colors"
                :class="isActive(item.to)
                  ? 'border-[var(--accent)] bg-surface text-accent'
                  : 'border-transparent text-content hover:bg-surface'"
                @click="onNavClick"
              >
                <component :is="item.icon" :size="18" class="flex-shrink-0" />
                <span class="nav-label truncate">{{ item.label }}</span>
              </RouterLink>

              <!-- 父项：点击只开合子菜单（对齐参考面板，不导航）；命中子路由时整行高亮 -->
              <template v-else>
                <button
                  type="button"
                  class="nav-item flex w-full items-center gap-3 rounded-lg border-l-[3px] px-3 py-2 text-sm transition-colors"
                  :class="isActive(item.to)
                    ? 'border-[var(--accent)] bg-surface text-accent'
                    : 'border-transparent text-content hover:bg-surface'"
                  :title="item.label"
                  :aria-label="item.label"
                  :aria-expanded="!!openSubMenus[item.to]"
                  @click="toggleParent(item)"
                >
                  <component :is="item.icon" :size="18" class="flex-shrink-0" />
                  <span class="nav-label truncate">{{ item.label }}</span>
                  <Down
                    :size="14"
                    class="sub-chevron ml-auto flex-shrink-0 transition-transform duration-200"
                    :class="openSubMenus[item.to] ? 'rotate-180' : ''"
                  />
                </button>
                <!-- 子菜单层：grid-rows 0fr↔1fr 高度动画（无第三方动画库）；图标栏里整层隐藏 -->
                <div
                  class="sub-layer grid transition-[grid-template-rows] duration-200 ease-out"
                  :class="openSubMenus[item.to] ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
                >
                  <div class="overflow-hidden">
                    <div class="ml-4 space-y-0.5 border-l border-divider py-1 pl-2">
                      <RouterLink
                        v-for="c in item.children"
                        :key="c.to"
                        :to="c.to"
                        :title="c.label"
                        class="nav-child block rounded-lg px-3 py-1.5 text-[13px] transition-colors"
                        :class="isActive(c.to)
                          ? 'bg-surface font-medium text-accent'
                          : 'text-secondary hover:bg-surface hover:text-content'"
                        @click="onNavClick"
                      >{{ c.label }}</RouterLink>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </nav>

      <!-- 底部：返回主页 + 退出（钉到列底） -->
      <div class="mt-auto space-y-1 border-t border-divider pt-3">
        <RouterLink
          to="/"
          :title="t('nav.home')"
          :aria-label="t('nav.home')"
          class="footer-item flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-secondary hover:bg-slate-700/30 hover:text-white"
          @click="onNavClick"
        >
          <Home :size="18" class="flex-shrink-0" />
          <span class="nav-label truncate">{{ t('nav.home') }}</span>
        </RouterLink>
        <button
          :title="t('nav.logout')"
          :aria-label="t('nav.logout')"
          class="footer-item flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-secondary hover:bg-rose-500/10 hover:text-content"
          @click="logout"
        >
          <Logout :size="18" class="flex-shrink-0" />
          <span class="nav-label truncate">{{ t('nav.logout') }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-divider);
}

/* ---------- 桌面（≥1024）：真实停靠列，展开 15rem ↔ 收起 4rem 图标栏 ---------- */
@media (min-width: 1024px) {
  .sidebar-desktop {
    position: relative;
    height: 100%;
    transition: width 0.2s ease;
  }
  .sidebar-desktop.is-open {
    width: 15rem;
  }
  /* 收起＝图标栏（rail）：保留 4rem 真实列宽与右边界，仅显示图标，不整列消失 */
  .sidebar-desktop.is-closed {
    width: 4rem;
  }
  /* 宽度动画期间内容不重排：展开态固定 15rem，收起态切到图标栏宽度 */
  .sidebar-inner {
    min-width: 15rem;
  }
  .sidebar-desktop.is-closed .sidebar-inner {
    min-width: 4rem;
    padding: 0.75rem 0.5rem;
  }
  /* 图标栏：隐藏文字与分组标题，图标居中，去左强调边改用底色高亮（选中态 bg-surface/text-accent 仍生效） */
  .sidebar-desktop.is-closed .group-title,
  .sidebar-desktop.is-closed .nav-label {
    display: none;
  }
  /* 图标栏：子菜单层与展开箭头隐藏；点父项先展开侧栏再开子菜单（toggleParent） */
  .sidebar-desktop.is-closed .sub-layer,
  .sidebar-desktop.is-closed .sub-chevron {
    display: none;
  }
  .sidebar-desktop.is-closed .nav-item,
  .sidebar-desktop.is-closed .footer-item {
    justify-content: center;
    gap: 0;
    padding-left: 0;
    padding-right: 0;
    border-left-width: 0;
  }
}

/* ---------- 移动（<1024）：抽屉 + 遮罩 ---------- */
@media (max-width: 1023.98px) {
  .sidebar-mobile {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: 15rem;
    z-index: 50;
    transition: transform 0.2s ease;
  }
  .sidebar-mobile.is-open {
    transform: translateX(0);
  }
  .sidebar-mobile.is-closed {
    transform: translateX(-100%);
  }
}
</style>