<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import Sidebar from '../../components/admin/Sidebar.vue';
import { loadAdmin, startAutoRefresh, stopAutoRefresh } from '../../composables/useAdmin';
import { setAutoRefreshPaused as setPublicAutoRefreshPaused } from '../../composables/useApp';
import { useI18n } from '../../composables/useI18n';

const menuOpen = ref(false);
const { t } = useI18n();

onMounted(() => {
  loadAdmin();
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
      <RouterView />
    </main>
  </div>
</template>
