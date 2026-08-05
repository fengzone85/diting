<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useTheme } from '../composables/useTheme';
import type { PublicMeta } from '../services/types';

const props = defineProps<{
  title?: string;
  meta?: PublicMeta | null;
}>();

const { theme, toggle } = useTheme();
const displayTitle = computed(() => props.title || props.meta?.site_title || 'Diting');
</script>

<template>
  <header class="glass sticky top-0 z-50 mb-6">
    <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
      <RouterLink to="/" class="flex min-w-0 items-center gap-3 text-lg font-bold text-sky-400 hover:text-sky-300 sm:text-xl">
        <img v-if="meta?.logo_url" :src="meta.logo_url" class="h-7 w-7 flex-shrink-0 rounded object-cover sm:h-8 sm:w-8" :alt="displayTitle" />
        <span v-else class="status-dot status-online flex-shrink-0" />
        <div class="min-w-0">
          <span class="truncate">{{ displayTitle }}</span>
          <span v-if="meta?.site_description" class="block truncate text-[10px] font-normal text-slate-500 sm:text-xs">{{ meta.site_description }}</span>
        </div>
      </RouterLink>
      <nav class="flex items-center gap-3 text-sm text-slate-300">
        <RouterLink to="/" class="hover:text-white">首页</RouterLink>
        <RouterLink to="/admin" class="hover:text-white">管理</RouterLink>
        <button
          class="rounded-lg border border-slate-700 px-2 py-1 text-xs hover:border-sky-500 hover:text-white"
          :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'"
          @click="toggle"
        >
          {{ theme === 'dark' ? '🌙' : '☀️' }}
        </button>
      </nav>
    </div>
  </header>
</template>
