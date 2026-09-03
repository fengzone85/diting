<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';
const { t } = useI18n();
</script>
<template>
  <div class="py-12 text-center text-slate-400">
    <div class="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-sky-500" />
    <slot>{{ t('ui.loading') }}</slot>
  </div>
</template>
