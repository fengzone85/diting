<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useTheme } from '../composables/useTheme';
import { useI18n } from '../composables/useI18n';
import type { PublicMeta } from '../services/types';

const props = defineProps<{
  title?: string;
  meta?: PublicMeta | null;
}>();

const { theme, set, applyQueryPreview } = useTheme();
const { locale, setLocale, t } = useI18n();
const displayTitle = computed(() => props.title || props.meta?.site_title || 'Diting');

const themeMenu = ref(false);
const hasThemePreview = ref(new URLSearchParams(window.location.search).has('theme'));

const themeOptions = computed(() => [
  { id: 'auto' as const, label: t('theme.auto') },
  { id: 'light' as const, label: t('theme.light') },
  { id: 'dark' as const, label: t('theme.dark') },
]);

function switchLang() {
  setLocale(locale.value === 'zh-CN' ? 'en-US' : 'zh-CN');
}

function pickTheme(id: 'auto' | 'light' | 'dark') {
  set(id);
  themeMenu.value = false;
}

function lockPreview() {
  applyQueryPreview();
  hasThemePreview.value = false;
}
</script>

<template>
  <header class="glass sticky top-0 z-50 mb-6">
    <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
      <RouterLink to="/" class="flex min-w-0 items-center gap-3 text-lg font-bold text-sky-500 hover:text-sky-400 sm:text-xl">
        <img v-if="meta?.logo_url" :src="meta.logo_url" class="h-7 w-7 flex-shrink-0 rounded object-cover sm:h-8 sm:w-8" :alt="displayTitle" />
        <span v-else class="status-dot status-online flex-shrink-0" />
        <div class="min-w-0">
          <span class="truncate text-content">{{ displayTitle }}</span>
          <span v-if="meta?.site_description" class="block truncate text-[10px] font-normal text-muted sm:text-xs">{{ meta.site_description }}</span>
        </div>
      </RouterLink>
      <nav class="flex items-center gap-3 text-sm text-content">
        <RouterLink to="/" class="hover:text-accent">{{ t('nav.dashboard') }}</RouterLink>
        <RouterLink to="/admin" class="hover:text-accent">{{ t('nav.admin') }}</RouterLink>
        <div class="relative">
          <button
            class="rounded-lg border border-divider px-2 py-1 text-xs hover:border-sky-500 hover:text-accent"
            :title="theme === 'dark' ? t('theme.light') : t('theme.dark')"
            @click="themeMenu = !themeMenu"
          >
            {{ theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '🌗' }}
          </button>
          <div v-if="themeMenu" class="absolute right-0 z-50 mt-2 w-32 rounded-lg border border-divider bg-surface p-1 shadow-xl">
            <button
              v-for="opt in themeOptions"
              :key="opt.id"
              class="block w-full rounded px-3 py-1.5 text-left text-xs hover:bg-slate-800/30"
              :class="theme === opt.id ? 'text-sky-500' : 'text-content'"
              @click="pickTheme(opt.id)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <button
          class="rounded-lg border border-divider px-2 py-1 text-xs hover:border-sky-500 hover:text-accent"
          :title="t('common.language')"
          @click="switchLang"
        >
          {{ locale === 'zh-CN' ? '中' : 'EN' }}
        </button>
      </nav>
    </div>
    <div v-if="hasThemePreview" class="border-t border-divider bg-sky-500/10 px-4 py-1.5 text-center text-xs text-sky-600">
      当前为 <code>?theme</code> 预览模式 ·
      <button class="underline hover:text-accent" @click="lockPreview">应用此预览</button>
    </div>
  </header>
</template>
