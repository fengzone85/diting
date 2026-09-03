<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';
const { t } = useI18n();
</script>
<template>
  <div class="py-12 text-center text-slate-500">
    <slot>{{ t('ui.empty') }}</slot>
  </div>
</template>
