<script setup lang="ts">
import { onMounted } from 'vue';
import Sidebar from '../../components/admin/Sidebar.vue';
import { loadAdmin } from '../../composables/useAdmin';

onMounted(loadAdmin);
</script>

<template>
  <div class="flex min-h-screen">
    <Sidebar />
    <main class="flex-1 p-6">
      <RouterView />
    </main>
  </div>
</template>
