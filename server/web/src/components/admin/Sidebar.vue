<script setup lang="ts">
// 后台侧栏：按功能域分组（节点 / 告警与通知 / 站点与外观 / 安全 / 系统），
// 对齐同类项目的后台信息架构：先监控对象，再告警通知，
// 然后外观内容，最后安全与系统维护；配置类不再混进「监控」。
// 桌面端可收起成图标轨（localStorage 记忆），移动端保持抽屉式全宽。
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  DashboardOne, Monitor, Wallet, Robot, Log, Key, SettingTwo, LayoutTwo, Folder,
  Home, Logout, MenuFold, MenuUnfold, User, Alarm, Theme,
} from '@icon-park/vue-next';
import { useI18n } from '../../composables/useI18n';

// collapsed 由父级 AdminLayout 持有（localStorage 记忆）：侧栏是 fixed 浮卡，
// 展开/收起只改变自身宽度，顶栏 / 内容 / 页脚仍按视口居中、不随之移动。
const props = defineProps<{
  open?: boolean;
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'update:collapsed', value: boolean): void;
}>();

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const collapsed = computed(() => !!props.collapsed);
const rightAnchored = ref(false);
let anchorQuery: MediaQueryList | null = null;

function syncAnchor() {
  rightAnchored.value = !!anchorQuery?.matches;
}
function onAnchorChange(e: MediaQueryListEvent) {
  rightAnchored.value = e.matches;
}
onMounted(() => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  anchorQuery = window.matchMedia('(min-width: 1808px)');
  syncAnchor();
  anchorQuery?.addEventListener('change', onAnchorChange);
});
onUnmounted(() => {
  anchorQuery?.removeEventListener('change', onAnchorChange);
});

// 常驻档右缘锚定：收起向右、展开向左；抽屉档左缘锚定，方向相反。
const toggleIcon = computed(() => (
  collapsed.value === rightAnchored.value ? MenuFold : MenuUnfold
));

function toggleCollapsed() {
  emit('update:collapsed', !collapsed.value);
}

// 用 computed 而非一次性数组：切换语言时菜单文案需要跟着变（t() 内部读取 locale ref）。
const groups = computed(() => [
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
    // 告警域：阈值/分组覆盖/通知渠道同页，AI 分析报告与之同组
    key: 'alerts',
    title: t('nav.group.alerts'),
    items: [
      { to: '/admin/alerting', label: t('nav.alerting'), icon: Alarm },
      { to: '/admin/ai', label: t('nav.ai'), icon: Robot },
    ],
  },
  {
    // 外观域：站点信息与默认主题、玻璃拟态外观与主题市场
    key: 'site',
    title: t('nav.group.site'),
    items: [
      { to: '/admin/site', label: t('nav.site'), icon: LayoutTwo },
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
    // 系统域：数据保留、备份恢复、容量保险丝
    key: 'system',
    title: t('nav.group.system'),
    items: [
      { to: '/admin/maintenance', label: t('nav.maintenance'), icon: SettingTwo },
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
  <!-- 遮罩：移动端抽屉 + 桌面悬浮抽屉（1024~1807）都需要；常驻模式（≥1808）隐藏 -->
  <div
    v-if="open"
    class="fixed inset-0 z-[45] bg-black/50 min-[1808px]:hidden"
    @click="emit('close')"
  />
  <aside
    class="sidebar glass z-50 flex flex-shrink-0 flex-col p-3 transition-all duration-200"
    :class="[
      open ? 'sidebar-open' : 'sidebar-closed',
      collapsed ? 'is-collapsed' : '',
    ]"
  >
    <!-- 收起/展开（品牌 logo 与站名已移到后台顶栏，侧栏不再重复） -->
    <div class="mb-4 flex items-center gap-2 px-1">
      <button
        class="collapse-toggle hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-700/40 hover:text-white lg:flex"
        :title="collapsed ? t('nav.expand') : t('nav.collapse')"
        :aria-label="collapsed ? t('nav.expand') : t('nav.collapse')"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <component :is="toggleIcon" :size="18" />
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
              ? 'bg-sky-500/20 text-content'
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
        class="footer-item flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-400 hover:bg-rose-500/10 hover:text-content"
        @click="logout"
      >
        <Logout :size="18" class="flex-shrink-0" />
        <span class="label truncate">{{ t('nav.logout') }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* ---------- ① <1024：移动端全屏抽屉 ---------- */
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

/* ---------- 桌面公共：浮卡外观（高度随视口自适应） ---------- */
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
  /* 高度按内容自适应 + 垂直居中：
     top/bottom 只作为可用区间（顶栏下沿 ~ 底部 12px 缝），
     height: fit-content 让卡片只包住菜单内容，margin-block: auto 把它居中在该区间内。
     窗口过矮时 max-height 封顶，菜单区内部滚动。 */
  .sidebar {
    position: fixed;
    top: 4.3125rem;                              /* 顶栏 56 + 边框 1 + 缝 12 */
    bottom: 0.75rem;
    height: fit-content;
    max-height: calc(100vh - 5.0625rem);         /* 69 + 12 */
    max-height: calc(100dvh - 5.0625rem);
    margin-top: auto;
    margin-bottom: auto;
    border-radius: 0.75rem;
    z-index: 50;
    overflow: hidden;                            /* 圆角内裁切 */
  }
  /* flex 子项默认 min-height:auto 会让菜单撑破 max-height，必须归零才能内部滚动 */
  .sidebar nav {
    min-height: 0;
  }
  /* 收起态用「展开」图标顶替品牌位（对齐参考面板） */
  .sidebar.is-collapsed .collapse-toggle {
    margin-left: auto;
    margin-right: auto;
  }
}

/* ---------- ② 1024 ~ 1807：放不下「1280 内容 + 240 侧栏」→ 悬浮抽屉 ----------
   默认完全移出屏幕，点顶栏菜单按钮滑出（覆盖内容，不推动任何元素），点遮罩/菜单项收回。 */
@media (min-width: 1024px) and (max-width: 1807.98px) {
  .sidebar {
    left: 0.75rem;
    right: auto;
    /* 展开宽度由最长菜单文字决定；8rem 仅作底线，不压住中文自然宽度 */
    width: max-content;
    min-width: 8rem;
    max-width: 18rem;
    transform: translateX(calc(-100% - 1.5rem));
  }
  .sidebar.sidebar-open {
    transform: translateX(0);
  }
  .sidebar.sidebar-closed {
    transform: translateX(calc(-100% - 1.5rem));
  }
  .sidebar.is-collapsed {
    width: 4.5rem;
    min-width: 4.5rem;
  }
}

/* ---------- ③ ≥1808：常驻挂在内容区左外侧，右边缘锚点 ----------
   锚点是右边缘（视口中心 - 640px - 12px），宽度变化只向左伸/向右收，
   顶栏、内容页、页脚因此始终钉在视口正中、零位移。 */
@media (min-width: 1808px) {
  .sidebar {
    left: auto;
    /* 右边缘锚点 = 内容区左边缘（视口中心 - 640）再让 12px；与自身宽度无关 */
    right: calc(50% + 652px);
    /* 宽度随菜单文字自适应：max-content 由最长标签决定，8rem 兜底、20rem 封顶（超出则省略号） */
    width: max-content;
    min-width: 8rem;
    max-width: 20rem;
  }
  .sidebar-closed,
  .sidebar-open {
    transform: translateX(0);
  }
  .sidebar.is-collapsed {
    width: 4.5rem;
    min-width: 4.5rem;
    /* 右边缘仍是内容区左外侧，只是宽度变小 → 视觉上「向右收起」 */
    right: calc(50% + 652px);
  }
}
</style>
