<script setup lang="ts">
import { t } from '../composables/useI18n';

defineProps<{
  version?: string;
  meta?: Record<string, unknown> | null;
  ip?: string;
  browser?: string;
}>();
</script>

<template>
  <footer class="mx-auto mt-12 w-full max-w-[1280px] px-4 py-4 text-xs text-secondary">
    <div class="flex w-full flex-row justify-between gap-4">
      <div class="flex items-center gap-1">
        Powered by
        <a
          href="https://github.com/fengzone85/diting" target="_blank" rel="noopener noreferrer"
          class="font-medium text-content transition-opacity hover:opacity-80"
        >
          DiTing
        </a>
        <span v-if="version" class="ml-1 text-muted">v{{ version }}</span>
      </div>
      <div v-if="ip" class="text-right">
        {{ t('footer.visitorIp') }}: {{ ip }}<span v-if="browser"> · {{ browser }}</span>
      </div>
    </div>
  </footer>
</template>
