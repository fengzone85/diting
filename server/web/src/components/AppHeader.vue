<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Logout } from '@icon-park/vue-next';
import { useI18n } from '../composables/useI18n';
import { useTheme } from '../composables/useTheme';
import type { PublicMeta } from '../services/types';

const { t, locale, setLocale } = useI18n();
const { theme, set: setTheme } = useTheme();

const props = withDefaults(defineProps<{
  meta?: PublicMeta | null;
  /** 站名 / logo 覆盖（后台拿自己的 ui 设置，公开页不传则用 meta） */
  title?: string;
  logo?: string;
  /** 品牌链接目标，默认 '/'（后台传 '/admin'，避免跳出后台） */
  homeTo?: string;
  /** 右侧「管理后台」入口，默认显示；后台自身传 false */
  showAdminLink?: boolean;
  /** 后台：右侧显示退出 */
  showLogout?: boolean;
  /** 后台：左侧显示侧栏开关（桌面常驻） */
  showMenu?: boolean;
  /** 布局变体：public 居中 1280 + 滚动毛玻璃；admin 全宽 + 静态边框（应用壳内不滚 window） */
  variant?: 'public' | 'admin';
}>(), {
  // Boolean prop 未传时 Vue 会转成 false，这里显式给默认值，保证公开页仍显示「管理后台」入口
  showAdminLink: true,
  variant: 'public',
});

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void;
  (e: 'logout'): void;
}>();

const isScrolled = ref(false);
function onScroll() { isScrolled.value = window.scrollY > 10; }
onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }));
onUnmounted(() => window.removeEventListener('scroll', onScroll));

const themeMenu = ref(false);
const displayTitle = computed(() => props.title || props.meta?.site_title || 'DiTing');
// 默认始终显示 logo：后台未配置或清空 logo_url 时回退到内置谛听头像
const logoSrc = computed(() => props.logo || props.meta?.logo_url || '/logo.png');
const homeTo = computed(() => props.homeTo || '/');
const showAdminLink = computed(() => props.showAdminLink);
const isAdmin = computed(() => props.variant === 'admin');

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
  <!-- public: 无 <header> 标签、滚动才出现 blur；admin: 应用壳内静态边框（window 不滚） -->
  <div
    class="z-10 border-b transition-all duration-200"
    :class="isAdmin
      ? 'border-divider bg-[var(--bg-primary)]'
      : ['sticky top-0 border-transparent', isScrolled ? '!border-slate-500/10 backdrop-blur-lg' : 'bg-transparent']"
  >
    <div class="flex h-14 items-center px-4" :class="isAdmin ? 'w-full' : 'mx-auto max-w-[1280px]'">
      <!-- 后台：侧栏开关（桌面常驻；公开页不传 showMenu 故不显示） -->
      <button
        v-if="showMenu"
        class="mr-2 flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-surface"
        :aria-label="t('nav.menu')"
        @click="emit('toggle-sidebar')"
      >
        ☰
      </button>

      <RouterLink :to="homeTo" class="flex cursor-pointer items-center gap-3">
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

        <!-- 管理后台（公开页入口；后台自身关闭） -->
        <RouterLink
          v-if="showAdminLink"
          to="/admin"
          class="inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-surface"
          :title="t('nav.admin')"
        >⚙</RouterLink>

        <!-- 退出（后台） -->
        <button
          v-if="showLogout"
          class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-500/10 hover:text-rose-300"
          :title="t('nav.logout')"
          :aria-label="t('nav.logout')"
          @click="emit('logout')"
        >
          <Logout :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>
