<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import Sidebar from '../../components/admin/Sidebar.vue';
import { loadAdmin, startAutoRefresh, stopAutoRefresh } from '../../composables/useAdmin';

onMounted(() => {
  loadAdmin();
  startAutoRefresh();
});
onUnmounted(stopAutoRefresh);
</script>

<template>
  <div class="flex min-h-screen">
    <Sidebar />
    <main class="flex-1 p-6">
      <RouterView />
    </main>
  </div>
</template>
