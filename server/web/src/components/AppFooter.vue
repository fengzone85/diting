<script setup lang="ts">
import { computed } from 'vue';
import type { PublicMeta } from '../services/types';
import { t } from '../composables/useI18n';

const props = defineProps<{
  version?: string;
  meta?: PublicMeta | null;
  ip?: string;
  browser?: string;
}>();

const socialItems = computed(() => [
  { key: 'social_email', icon: '✉', prefix: 'mailto:', label: '邮箱', raw: props.meta?.social_email },
  { key: 'social_telegram', icon: '✈', prefix: 'https://t.me/', label: 'Telegram', raw: props.meta?.social_telegram },
  { key: 'social_qq', icon: '🐧', prefix: 'https://wpa.qq.com/msgrd?v=3&uin=', label: 'QQ', raw: props.meta?.social_qq },
  { key: 'social_website', icon: '🌐', prefix: '', label: '网站', raw: props.meta?.social_website },
]);

function href(item: typeof socialItems.value[number]) {
  if (!item.raw) return '';
  const raw = item.raw.trim();
  if (item.key === 'social_website') return raw;
  return item.prefix + encodeURIComponent(raw);
}
</script>

<template>
  <footer class="mt-12 py-6 text-center text-xs text-slate-500">
    <p class="mb-2">
      Powered by
      <a href="https://github.com/fengzone85/diting" target="_blank" rel="noopener" class="hover:text-sky-400">DiTing</a>
      <span v-if="version" class="ml-1">v{{ version }}</span>
    </p>
    <div v-if="socialItems.some((i) => i.raw)" class="flex justify-center gap-3">
      <a
        v-for="item in socialItems.filter((i) => i.raw)"
        :key="item.key"
        :href="href(item)"
        target="_blank"
        rel="noopener"
        class="hover:text-sky-400"
        :title="item.label"
      >
        {{ item.icon }}
      </a>
    </div>
    <p v-if="ip" class="mt-2 text-[11px] text-slate-600">
      {{ t('footer.visitorIp') }}: {{ ip }}<span v-if="browser"> · {{ browser }}</span>
    </p>
  </footer>
</template>
