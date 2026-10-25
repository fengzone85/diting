<script setup lang="ts">
// 后台侧栏：参考 Komari 后台的信息架构——按「监控 / 运维 / 系统」分组，
// 桌面端可收起成图标轨（localStorage 记忆），移动端保持抽屉式全宽。
import { computed, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  DashboardOne, Monitor, Wallet, Robot, Log, Key, SettingTwo, LayoutTwo, Folder,
  Home, Logout, MenuFold, MenuUnfold, User,
} from '@icon-park/vue-next';
import { useI18n } from '../../composables/useI18n';

defineProps<{
  open?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const COLLAPSE_KEY = 'diting.admin.sidebar.collapsed';
const collapsed = ref(localStorage.getItem(COLLAPSE_KEY) === '1');

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0');
}

// 用 computed 而非一次性数组：切换语言时菜单文案需要跟着变（t() 内部读取 locale ref）。
const groups = computed(() => [
  {
    key: 'monitor',
    title: t('nav.group.monitor'),
    items: [
      { to: '/admin', label: t('nav.dashboard'), icon: DashboardOne },
      { to: '/admin/agents', label: t('nav.agents'), icon: Monitor },
      { to: '/admin/agent-artifacts', label: t('nav.agentArtifacts'), icon: Folder },
      { to: '/admin/billing', label: t('nav.billing'), icon: Wallet },
    ],
  },
  {
    key: 'ops',
    title: t('nav.group.ops'),
    items: [
      { to: '/admin/ai', label: t('nav.ai'), icon: Robot },
      { to: '/admin/audit-logs', label: t('nav.auditLogs'), icon: Log },
    ],
  },
  {
    key: 'system',
    title: t('nav.group.system'),
    items: [
      { to: '/admin/api-tokens', label: t('nav.apiTokens'), icon: Key },
      { to: '/admin/sessions', label: t('nav.sessions'), icon: User },
      { to: '/admin/settings', label: t('nav.settings'), icon: SettingTwo },
      { to: '/admin/template', label: t('nav.template'), icon: LayoutTwo },
    ],
  },
]);

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    router.push('/login');
  }
}

// 首页 /admin 必须精确匹配：用 startsWith 会让「仪表盘」在任意子页面都高亮。
function isActive(to: string) {
  if (to === '/admin') return route.path === '/admin';
  return route.path === to || route.path.startsWith(to + '/');
}
</script>

<template>
  <!-- mobile overlay -->
  <div
    v-if="open"
    class="fixed inset-0 z-40 bg-black/50 lg:hidden"
    @click="emit('close')"
  />
  <aside
    class="sidebar glass z-50 flex flex-shrink-0 flex-col p-3 transition-all duration-200 lg:static lg:translate-x-0"
    :class="[
      open ? 'sidebar-open' : 'sidebar-closed',
      collapsed ? 'is-collapsed' : '',
    ]"
  >
    <!-- 品牌 + 收起/展开 -->
    <div class="mb-4 flex items-center gap-2 px-1">
      <RouterLink to="/admin" class="brand flex min-w-0 items-center gap-2" :title="t('nav.admin')" @click="emit('close')">
        <span class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-sky-500/20 text-sm font-bold text-sky-300">D</span>
        <span class="label truncate text-lg font-bold text-sky-400">Diting</span>
      </RouterLink>
      <button
        class="collapse-toggle ml-auto hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-700/40 hover:text-white lg:flex"
        :title="collapsed ? t('nav.expand') : t('nav.collapse')"
        :aria-label="collapsed ? t('nav.expand') : t('nav.collapse')"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <MenuUnfold v-if="collapsed" :size="18" />
        <MenuFold v-else :size="18" />
      </button>
      <button
        class="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:text-white lg:hidden"
        :aria-label="t('common.close')"
        @click="emit('close')"
      >✕</button>
    </div>

    <!-- 分组菜单 -->
    <nav class="flex-1 space-y-4 overflow-y-auto">
      <div v-for="group in groups" :key="group.key">
        <p
          class="group-title mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-slate-500"
        >{{ group.title }}</p>
        <div class="space-y-1">
          <RouterLink
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            :title="item.label"
            :aria-label="item.label"
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
            :class="isActive(item.to)
              ? 'bg-sky-500/20 text-sky-300'
              : 'text-content hover:bg-slate-700/30'"
            @click="emit('close')"
          >
            <component :is="item.icon" :size="18" class="flex-shrink-0" />
            <span class="label truncate">{{ item.label }}</span>
          </RouterLink>
        </div>
      </div>
    </nav>

    <!-- 底部：返回主页 + 退出 -->
    <div class="mt-4 space-y-1 border-t border-white/10 pt-3">
      <RouterLink
        to="/"
        :title="t('nav.home')"
        class="footer-item flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-700/30 hover:text-white"
        @click="emit('close')"
      >
        <Home :size="18" class="flex-shrink-0" />
        <span class="label truncate">{{ t('nav.home') }}</span>
      </RouterLink>
      <button
        :title="t('nav.logout')"
        class="footer-item flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-400 hover:bg-rose-500/10 hover:text-rose-300"
        @click="logout"
      >
        <Logout :size="18" class="flex-shrink-0" />
        <span class="label truncate">{{ t('nav.logout') }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  width: 15rem;
}
.sidebar-closed {
  transform: translateX(-100%);
}
.sidebar-open {
  transform: translateX(0);
}
@media (min-width: 1024px) {
  /* 收起态：隐藏文案与分组标题、图标居中。
     必须只写在桌面端媒体查询内——否则「桌面收起后窗口变窄/手机打开同一浏览器」时，
     移动端抽屉会继承居中与零内边距（图标与文字浮在行中间）。 */
  .sidebar.is-collapsed .label,
  .sidebar.is-collapsed .group-title {
    display: none;
  }
  .sidebar.is-collapsed nav a,
  .sidebar.is-collapsed .footer-item {
    justify-content: center;
    padding-left: 0;
    padding-right: 0;
  }
  /* 桌面端改为 sticky 满高：页面很长时「返回主页/退出」仍固定在视口底部，
     中间菜单区自己滚动（此前 position: static 会让 footer 掉到长页面最下面）。 */
  .sidebar {
    position: sticky;
    top: 0;
    bottom: auto;
    height: 100vh;
    align-self: flex-start;
  }
  .sidebar-closed,
  .sidebar-open {
    transform: translateX(0);
  }
  /* 收起态宽度写在这里：Tailwind 的 lg:w-* 工具类会被上面 .sidebar 的 width
     覆盖（scoped 样式注入更晚），只能同层覆盖。 */
  .sidebar.is-collapsed {
    width: 4.5rem;
  }
  /* 收起态用「展开」图标顶替品牌位（对齐 Komari）：隐藏 D 字标与站名，
     收起/展开按钮居中占据原来 D 的位置，避免两个元素挤在一起重叠。 */
  .sidebar.is-collapsed .brand {
    display: none;
  }
  .sidebar.is-collapsed .collapse-toggle {
    margin-left: auto;
    margin-right: auto;
  }
}
</style>
