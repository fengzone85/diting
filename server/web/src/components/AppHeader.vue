<script setup lang="ts">
import { RouterLink } from 'vue-router';

defineProps<{
  title?: string;
}>();
</script>

<template>
  <header class="glass sticky top-0 z-50 mb-6">
    <div class="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
      <RouterLink to="/" class="flex items-center gap-3 text-xl font-bold text-sky-400 hover:text-sky-300">
        <span class="status-dot status-online" />
        {{ title || 'Diting' }}
      </RouterLink>
      <nav class="flex items-center gap-6 text-sm text-slate-300">
        <RouterLink to="/" class="hover:text-white">首页</RouterLink>
        <RouterLink to="/admin" class="hover:text-white">管理</RouterLink>
      </nav>
    </div>
  </header>
</template>
