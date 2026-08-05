<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import Sidebar from '../../components/admin/Sidebar.vue';
import { loadAdmin, startAutoRefresh, stopAutoRefresh } from '../../composables/useAdmin';

const menuOpen = ref(false);

onMounted(() => {
  loadAdmin();
  startAutoRefresh();
});
onUnmounted(stopAutoRefresh);
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
        菜单
      </button>
      <RouterView />
    </main>
  </div>
</template>
