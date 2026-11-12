<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Sidebar from '../../components/admin/Sidebar.vue';
import AppHeader from '../../components/AppHeader.vue';
import { adminApi } from '../../services/adminApi';
import type { RestoreAuditReport, CapacityStatus } from '../../services/types';
import { loadAdmin, startAutoRefresh, stopAutoRefresh, useAdmin } from '../../composables/useAdmin';
import { setAutoRefreshPaused as setPublicAutoRefreshPaused } from '../../composables/useApp';
import { useI18n } from '../../composables/useI18n';

const menuOpen = ref(false);
const { t } = useI18n();
const router = useRouter();
const { state } = useAdmin();

// 顶栏直接复用公开页 AppHeader：站名/logo 取后台自己的 ui 设置，其余（主题/语言/形态）完全共用。
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

// 侧栏收起状态提升到这里（Sidebar 受控）：localStorage 记忆与展开/收起按钮都在外层统一处理。
const COLLAPSE_KEY = 'diting.admin.sidebar.collapsed';
const collapsed = ref(localStorage.getItem(COLLAPSE_KEY) === '1');
watch(collapsed, (v) => localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'));

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
  loadAdmin();
  loadRestoreAudit();
  loadCapacity();
  startAutoRefresh();
  // 后台管理页不需要公开页实时数据（DashboardView 等仍 useApp() 读 meta，
  // 其 onMounted 会启动 10s 轮询，这里暂停掉，避免后台无谓拉 public/agents+meta+overview）。
  setPublicAutoRefreshPaused(true);
});
onUnmounted(() => {
  stopAutoRefresh();
  // 离开后台恢复公开页轮询
  setPublicAutoRefreshPaused(false);
});
</script>

<template>
  <!-- 布局口径：顶栏全宽；侧栏固定在左侧，不参与内容居中；
       内容列 max-w-[1280px]（见下方 main）在侧栏右侧的剩余空间里 mx-auto 居中。 -->
  <div class="flex min-h-screen w-full flex-col">
    <!-- 顶栏：直接复用公开页 AppHeader（透明 → 滚动毛玻璃），仅切换后台开关 -->
    <AppHeader
      :title="siteTitle || undefined"
      :logo="siteLogo || undefined"
      home-to="/admin"
      :show-admin-link="false"
      show-logout
      show-menu
      class="!z-40"
      @open-menu="menuOpen = true"
      @logout="logout"
    />

    <div class="flex min-h-0 flex-1">
      <!-- 侧栏是浮动吸附卡片（自带外边距与圆角），不参与主内容居中 -->
      <Sidebar
        :open="menuOpen"
        :collapsed="collapsed"
        @update:collapsed="collapsed = $event"
        @close="menuOpen = false"
      />
      <main class="min-w-0 flex-1 p-4 lg:p-6">
        <!-- 内容列宽度与公开页一致（1280 上限），在侧栏右侧的剩余空间里居中 -->
        <div class="mx-auto w-full max-w-[1280px]">
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
          class="rounded border px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-50"
          :class="capacityBanner.level === 'full' ? 'border-rose-400/40' : 'border-amber-400/40'"
          @click="cleanupCapacity"
        >
          {{ capacityBusy ? t('capacityBanner.cleaning') : t('capacityBanner.cleanup') }}
        </button>
        <RouterLink to="/admin/settings" class="ml-auto text-xs underline">
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
          to="/admin/settings"
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
      </main>
    </div>
  </div>
</template>

