<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from '../composables/useI18n';
import { useTheme } from '../composables/useTheme';
import type { PublicMeta } from '../services/types';

const { t, locale, setLocale } = useI18n();
const { theme, set: setTheme } = useTheme();
const route = useRoute();

const props = defineProps<{ meta?: PublicMeta | null }>();

const isScrolled = ref(false);
function onScroll() { isScrolled.value = window.scrollY > 10; }
onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }));
onUnmounted(() => window.removeEventListener('scroll', onScroll));

const themeMenu = ref(false);
const displayTitle = computed(() => props.meta?.site_title || 'DiTing');
// 默认始终显示 logo：后台未配置或清空 logo_url 时回退到内置谛听头像
const logoSrc = computed(() => props.meta?.logo_url || '/logo.png');

const themeOptions = computed(() => [
  { id: 'auto' as const, label: t('theme.auto') },
  { id: 'light' as const, label: t('theme.light') },
  { id: 'dark' as const, label: t('theme.dark') },
]);

const pickTheme = (mode: 'auto' | 'light' | 'dark') => {
  setTheme(mode);
  themeMenu.value = false;
};

function switchLang() {
  setLocale(locale.value === 'zh-CN' ? 'en-US' : 'zh-CN');
}

const themeIcon = computed(() => {
  if (theme.value === 'dark') return '🌙';
  if (theme.value === 'light') return '☀️';
  return '🌗';
});
</script>

<template>
  <!-- 对齐 komari: 无 <header> 标签，无固定毛玻璃，滚动才出现 blur -->
  <div
    class="sticky top-0 z-10 border-b border-transparent transition-all duration-200"
    :class="isScrolled ? '!border-slate-500/10 backdrop-blur-lg' : 'bg-transparent'"
  >
    <div class="mx-auto flex h-14 max-w-[1280px] items-center px-4">
      <RouterLink to="/" class="flex cursor-pointer items-center gap-3">
        <img :src="logoSrc" class="size-8 rounded" :alt="displayTitle" />
        <h3 class="m-0 text-lg font-semibold text-content">{{ displayTitle }}</h3>
      </RouterLink>

      <div class="ml-auto flex items-center gap-1">
        <!-- 主题切换 -->
        <div class="relative">
          <button
            class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-base hover:bg-surface"
            :title="t('theme.auto')"
            @click.stop="themeMenu = !themeMenu"
          >
            {{ themeIcon }}
          </button>
          <div v-if="themeMenu" class="absolute right-0 z-50 mt-1 w-32 rounded-lg border border-divider bg-surface p-1 shadow-xl" @click.stop>
            <button
              v-for="opt in themeOptions"
              :key="opt.id"
              class="block w-full rounded px-3 py-1.5 text-left text-xs hover:bg-slate-800/30"
              :class="theme === opt.id ? 'text-accent' : 'text-content'"
              @click.stop="pickTheme(opt.id)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <!-- 语言切换 -->
        <button
          class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-xs font-semibold hover:bg-surface"
          :title="t('common.language')"
          @click="switchLang"
        >
          {{ locale === 'zh-CN' ? '中' : 'EN' }}
        </button>

        <!-- 管理后台 -->
        <RouterLink
          v-if="route.name !== 'admin'"
          to="/admin"
          class="inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-surface"
          :title="t('nav.admin')"
        >⚙</RouterLink>
      </div>
    </div>
  </div>
</template>
