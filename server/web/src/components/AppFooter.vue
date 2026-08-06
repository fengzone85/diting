<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../composables/useI18n';

const props = defineProps<{
  version?: string;
  meta?: Record<string, unknown> | null;
  ip?: string;
  browser?: string;
}>();

const socialItems = computed(() => {
  const m = (props.meta || {}) as Record<string, unknown>;
  return [
    { key: 'social_email', icon: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z', prefix: '', label: t('footer.email'), raw: (typeof m.social_email === 'string' && m.social_email.startsWith('mailto:')) ? m.social_email : m.social_email ? `mailto:${m.social_email}` : '' },
    { key: 'social_telegram', icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.05-.2s-.16-.05-.23-.03c-.1.02-1.64 1.04-4.62 3.05-.44.3-.84.45-1.19.44-.39-.01-1.14-.22-1.7-.4-.69-.22-1.23-.34-1.18-.72.02-.2.3-.4.82-.61 3.21-1.4 5.35-2.32 6.42-2.76 3.06-1.27 3.69-1.49 4.1-1.5.09 0 .29-.01.42.11.09.08.12.2.13.28.01.08.02.27 0 .38z', prefix: 'https://t.me/', label: 'Telegram', raw: m.social_telegram },
    { key: 'social_qq', icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm.5 3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5S11 7.83 11 7s.67-1.5 1.5-1.5zm0 12c-2.76 0-5-2.24-5-5 0-1.66.8-3.13 2.04-4.03.2-.15.47-.1.62.1.15.2.1.47-.1.62C9.17 9.79 8.5 10.78 8.5 12c0 2.21 1.79 4 4 4s4-1.79 4-4c0-1.22-.67-2.21-1.56-2.81-.2-.15-.25-.42-.1-.62.15-.2.42-.25.62-.1 1.24.9 2.04 2.37 2.04 4.03 0 2.76-2.24 5-5 5z', prefix: 'https://wpa.qq.com/msgrd?v=3&uin=', label: 'QQ', raw: m.social_qq },
    { key: 'social_website', icon: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z', prefix: '', label: t('footer.website'), raw: m.social_website },
    { key: 'social_github', icon: 'M12 2C6.48 2 2 6.48 2 12c0 4.42 2.86 8.17 6.83 9.5.5.08.66-.23.66-.5v-1.69c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.57 9.57 0 0 1 12 6.5c.85 0 1.7.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.16.59.67.5C19.14 20.17 22 16.42 22 12c0-5.52-4.48-10-10-10z', prefix: '', label: 'GitHub', raw: m.social_website || 'https://github.com/fengzone85/diting' },
  ];
});
</script>

<template>
  <footer class="mx-auto mt-12 w-full max-w-[1280px] px-4 py-4 text-xs text-secondary">
    <div class="flex w-full flex-row flex-wrap items-center justify-between gap-3">
      <!-- 左侧：版权 + IP 两排 -->
      <div class="flex flex-col gap-0.5">
        <div class="flex items-center gap-1">
          Powered by
          <a
            href="https://github.com/fengzone85/diting" target="_blank" rel="noopener noreferrer"
            class="font-medium text-content transition-opacity hover:opacity-80"
          >
            DiTing
          </a>
          <span v-if="version" class="text-muted">v{{ version }}</span>
        </div>
        <div v-if="ip">
          {{ t('footer.visitorIp') }}: {{ ip }}<span v-if="browser"> · {{ browser }}</span>
        </div>
      </div>

      <!-- 右侧：社交链接图标 -->
      <div v-if="socialItems.some((i) => i.raw)" class="flex items-center gap-3">
        <a
          v-for="item in socialItems.filter((i) => i.raw)"
          :key="item.key"
          :href="item.prefix + item.raw"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex h-5 w-5 items-center justify-center text-secondary transition-colors hover:text-content"
          :title="item.label"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4 fill-current">
            <path :d="item.icon" />
          </svg>
        </a>
      </div>
    </div>
  </footer>
</template>
