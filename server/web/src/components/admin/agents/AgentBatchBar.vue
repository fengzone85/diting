<script setup lang="ts">
// 批量操作条：选中 N 台后的批量删除 / 重置 / 续期 / 分发 / 取消。
import { t } from '../../../composables/useI18n';

defineProps<{ count: number }>();

defineEmits<{
  (e: 'delete'): void;
  (e: 'reset'): void;
  (e: 'renew'): void;
  (e: 'distribute'): void;
  (e: 'clear'): void;
}>();
</script>

<template>
  <div v-if="count" class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
    <span class="text-sm text-sky-200">{{ t('agents.selected', { n: count }) }}</span>
    <button class="rounded-lg bg-rose-600 px-3 py-1 text-xs text-white hover:bg-rose-500" @click="$emit('delete')">{{ t('agents.batchDelete') }}</button>
    <button class="rounded-lg bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-500" @click="$emit('reset')">{{ t('agents.batchReset') }}</button>
    <button class="rounded-lg bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500" @click="$emit('renew')">{{ t('agents.batchRenew') }}</button>
    <button class="rounded-lg bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-500" @click="$emit('distribute')">{{ t('dist.open') }}</button>
    <button class="rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800" @click="$emit('clear')">{{ t('common.cancel') }}</button>
  </div>
</template>
