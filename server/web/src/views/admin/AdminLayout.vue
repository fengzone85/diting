<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Sidebar from '../../components/admin/Sidebar.vue';
import AppHeader from '../../components/AppHeader.vue';
import AppFooter from '../../components/AppFooter.vue';
import { adminApi } from '../../services/adminApi';
import { publicApi } from '../../services/publicApi';
import type { RestoreAuditReport, CapacityStatus } from '../../services/types';
import { loadAdmin, startAutoRefresh, stopAutoRefresh, useAdmin } from '../../composables/useAdmin';
import { setAutoRefreshPaused as setPublicAutoRefreshPaused, useApp } from '../../composables/useApp';
import { useI18n } from '../../composables/useI18n';

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const { state } = useAdmin();
const { state: appState } = useApp();

// 页脚版本/构建信息：后台的全局 AppFooter 改由本布局渲染进滚动列（App.vue 按 isAdminRoute 隐藏），
// 数据与公开页同源（/api/version，服务端 6h 缓存），并行加载不阻塞首屏。
const version = ref('');
const buildTime = ref('');
const hash = ref('');
const agentLatest = ref('');
async function loadVersion() {
  try {
    const info = await publicApi.version();
    version.value = info.version || info.data?.version || '';
    buildTime.value = info.build_time || info.data?.build_time || '';
    hash.value = info.hash || info.data?.hash || '';
    agentLatest.value = info.agent_latest || info.data?.agent_latest || '';
  } catch {
    version.value = '';
    buildTime.value = '';
    hash.value = '';
    agentLatest.value = '';
  }
}

// 顶栏直接复用公开页 AppHeader（admin 变体：全宽 + 静态边框），站名/logo 取后台自己的 ui 设置。
const siteUi = computed(() => (state.settings?.ui || {}) as Record<string, unknown>);
const siteTitle = computed(() => String(siteUi.value.site_title || ''));
const siteLogo = computed(() => String(siteUi.value.logo_url || ''));

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    router.push('/login');
  }
}

// 侧栏开合（参考设计单状态）：桌面是真实停靠列（默认开），移动是抽屉（默认关）。
// 桌面偏好持久化；跨断点回桌面时优先读偏好，不强制展开（缩放鲁棒）。
const SIDEBAR_KEY = 'diting.admin.sidebar.open';
const MOBILE_QUERY = '(max-width: 1023.98px)';
function mobileNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_QUERY).matches
    : false;
}
function readPref(): boolean {
  const v = localStorage.getItem(SIDEBAR_KEY);
  return v === null ? true : v === '1';
}
const isMobile = ref(mobileNow());
const sidebarOpen = ref(isMobile.value ? false : readPref());
let mql: MediaQueryList | null = null;
function onBreakpointChange(e: MediaQueryListEvent) {
  isMobile.value = e.matches;
  sidebarOpen.value = e.matches ? false : readPref();
}
watch(sidebarOpen, (v) => {
  if (!isMobile.value) localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0');
});

// 内容列是页面唯一滚动容器。子路由切换（侧栏二级菜单）时回到顶部：
// 同一视图组件跨子路由复用实例，不重置会带着上一页的滚动位置进新分节。
const scrollEl = ref<HTMLElement | null>(null);
watch(() => route.path, () => {
  if (scrollEl.value) scrollEl.value.scrollTop = 0;
});

// F8.6：恢复审查黄条。恢复自较早的备份时，下一次 prune 会删掉大量过期明细，
// 必须在顶部提示，而不是等数据静默消失。关闭状态按「报告 ts」记在 sessionStorage，
// 同一份报告不再打扰（新的恢复产生新 ts，会重新提示）。
const RESTORE_BANNER_KEY = 'diting.restoreAuditDismissed';
const restoreReport = ref<RestoreAuditReport | null>(null);
const restoreDismissed = ref(false);

async function loadRestoreAudit() {
  try {
    const r = await adminApi.getRestoreAudit();
    restoreReport.value = r.report || null;
    const ts = String(r.report?.ts || '');
    restoreDismissed.value = !!ts && sessionStorage.getItem(RESTORE_BANNER_KEY) === ts;
  } catch {
    // 黄条是增强信息：未登录 / 旧服务端（404）时静默跳过
    restoreReport.value = null;
  }
}

const restoreBanner = computed(() => {
  const r = restoreReport.value;
  if (!r || restoreDismissed.value) return null;
  const retention = (r.checks || []).find((c) => c.id === 'retention');
  if (!retention || retention.status !== 'warn') return null;
  const v = retention.value || {};
  const rows = Number(v.expired_rows || 0);
  if (!rows) return null;
  const pct = Math.round(Number(v.ratio || 0) * 100);
  const mtime = Number(r.backup?.mtime || 0);
  // 备份年龄用备份文件时间算；老脚本没带 mtime 时退化为「较早的备份」文案
  const days = mtime && r.ts ? Math.max(0, Math.floor((r.ts - mtime) / 86400000)) : 0;
  return { rows, pct, days, ts: r.ts };
});

function dismissRestoreBanner() {
  const ts = String(restoreReport.value?.ts || '');
  try { if (ts) sessionStorage.setItem(RESTORE_BANNER_KEY, ts); } catch { /* 隐私模式忽略 */ }
  restoreDismissed.value = true;
}

// F12：容量保险丝黄条（80% 预警 / 100% 已暂停历史写入）。
// 比恢复审查更紧急，放在最上面；清理按钮直接调后端（只删过期明细）。
const capacityStatus = ref<CapacityStatus | null>(null);
const capacityBusy = ref(false);

async function loadCapacity() {
  try { capacityStatus.value = await adminApi.getCapacity(); } catch { capacityStatus.value = null; }
}

const capacityBanner = computed(() => {
  const s = capacityStatus.value;
  if (!s || !s.enabled || s.level === 'ok') return null;
  return { level: s.level, pct: Math.round(s.pct * 100), skipped: s.skipped };
});

async function cleanupCapacity() {
  if (!confirm(t('capacityBanner.cleanupConfirm'))) return;
  capacityBusy.value = true;
  try {
    const r = await adminApi.cleanupCapacity();
    capacityStatus.value = r;
    if (r.paused) alert(t('capacityBanner.stillFull'));
  } catch (e) {
    alert((e as Error).message || t('capacityBanner.cleanupFailed'));
  } finally {
    capacityBusy.value = false;
  }
}

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mql = window.matchMedia(MOBILE_QUERY);
    isMobile.value = mql.matches;
    sidebarOpen.value = mql.matches ? false : readPref();
    mql.addEventListener('change', onBreakpointChange);
  }
  loadAdmin();
  loadRestoreAudit();
  loadCapacity();
  void loadVersion();
  startAutoRefresh();
  // 后台管理页不需要公开页实时数据（DashboardView 等仍 useApp() 读 meta，
  // 其 onMounted 会启动 10s 轮询，这里暂停掉，避免后台无谓拉 public/agents+meta+overview）。
  setPublicAutoRefreshPaused(true);
});
onUnmounted(() => {
  mql?.removeEventListener('change', onBreakpointChange);
  stopAutoRefresh();
  // 离开后台恢复公开页轮询
  setPublicAutoRefreshPaused(false);
});
</script>

<template>
  <!-- 经典停靠布局（参考设计）：固定视口高应用壳、整页不滚；顶栏全宽（admin 变体）；
       侧栏是真实停靠列（桌面展开 15rem ↔ 收起 4rem 图标栏），内容列在其右侧内滚。无浮卡、无视口阈值、无预留槽。 -->
  <div class="flex h-screen w-full flex-col overflow-hidden">
    <!-- 顶栏：复用公开页 AppHeader 的 admin 变体（全宽 + 静态边框），菜单开关桌面常驻 -->
    <AppHeader
      variant="admin"
      :title="siteTitle || undefined"
      :logo="siteLogo || undefined"
      home-to="/admin"
      :show-admin-link="false"
      show-logout
      show-menu
      class="!z-40"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @logout="logout"
    />

    <div class="flex min-h-0 flex-1">
      <!-- 侧栏：桌面停靠列（占真实宽度），移动抽屉 + 遮罩 -->
      <Sidebar
        :open="sidebarOpen"
        :is-mobile="isMobile"
        @close="sidebarOpen = false"
        @open="sidebarOpen = true"
      />
      <main ref="scrollEl" class="min-w-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable] lg:px-6 lg:pb-6">
        <!-- 内容列：1280 可读性上限，居中于剩余宽度（侧栏已占真实列，无需预留槽）。
             顶部留白放在列上而非 main：main 无 padding-top，吸顶标题栏才能贴齐滚动口顶。 -->
        <div class="mx-auto w-full max-w-[1280px] pt-4 lg:pt-6">
      <!-- F12：容量保险丝（比恢复审查更紧急，放最上面） -->
      <div
        v-if="capacityBanner"
        class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm"
        :class="capacityBanner.level === 'full'
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-200'"
      >
        <span>
          {{
            capacityBanner.level === 'full'
              ? t('capacityBanner.full', { pct: capacityBanner.pct, skipped: capacityBanner.skipped })
              : t('capacityBanner.warn', { pct: capacityBanner.pct })
          }}
        </span>
        <button
          :disabled="capacityBusy"
          class="btn-ghost px-2 py-1 text-xs"
          :class="capacityBanner.level === 'full' ? 'border-rose-400/40' : 'border-amber-400/40'"
          @click="cleanupCapacity"
        >
          {{ capacityBusy ? t('capacityBanner.cleaning') : t('capacityBanner.cleanup') }}
        </button>
        <RouterLink to="/admin/maintenance/capacity" class="ml-auto text-xs underline">
          {{ t('capacityBanner.settings') }}
        </RouterLink>
      </div>

      <!-- F8.6：恢复自较早备份时提示「下次清理会删多少」 -->
      <div
        v-if="restoreBanner"
        class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
      >
        <span>
          {{
            restoreBanner.days
              ? t('restoreAudit.banner', { days: restoreBanner.days, pct: restoreBanner.pct, rows: restoreBanner.rows })
              : t('restoreAudit.bannerNoAge', { pct: restoreBanner.pct, rows: restoreBanner.rows })
          }}
        </span>
        <RouterLink
          to="/admin/maintenance/restore"
          class="rounded border border-amber-400/40 px-2 py-1 text-xs hover:bg-amber-500/20"
        >
          {{ t('restoreAudit.view') }}
        </RouterLink>
        <button class="ml-auto text-xs opacity-70 hover:opacity-100" @click="dismissRestoreBanner">
          {{ t('restoreAudit.dismiss') }}
        </button>
      </div>
      <RouterView />
        </div>
        <!-- 全局页脚移入滚动列：随内容内滚，不再落在 h-screen 壳外撑出整页滚动条 -->
        <AppFooter
          :meta="appState.meta"
          :version="version"
          :build-time="buildTime"
          :hash="hash"
          :agent-latest="agentLatest"
          :ip="appState.visitor?.ip"
          :browser="appState.visitor?.browser"
        />
      </main>
    </div>
  </div>
</template>