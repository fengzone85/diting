<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import Sidebar from '../../components/admin/Sidebar.vue';
import { adminApi } from '../../services/adminApi';
import type { RestoreAuditReport } from '../../services/types';
import { loadAdmin, startAutoRefresh, stopAutoRefresh } from '../../composables/useAdmin';
import { setAutoRefreshPaused as setPublicAutoRefreshPaused } from '../../composables/useApp';
import { useI18n } from '../../composables/useI18n';

const menuOpen = ref(false);
const { t } = useI18n();

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

onMounted(() => {
  loadAdmin();
  loadRestoreAudit();
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
  <div class="flex min-h-screen">
    <Sidebar :open="menuOpen" @close="menuOpen = false" />
    <main class="flex-1 p-4 lg:p-6">
      <button
        class="mb-4 flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 lg:hidden"
        @click="menuOpen = true"
      >
        <span>☰</span>
        {{ t('nav.menu') }}
      </button>
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
    </main>
  </div>
</template>
