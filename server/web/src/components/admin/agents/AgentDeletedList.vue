<script setup lang="ts">
// F11：最近删除（软删节点，7 天缓冲期内可恢复）。
import { t } from '../../../composables/useI18n';
import type { DeletedAgent } from '../../../services/types';

defineProps<{ open: boolean; agents: DeletedAgent[] }>();

defineEmits<{
  (e: 'toggle'): void;
  (e: 'restore', id: string): void;
}>();
</script>

<template>
  <div class="mb-4 flex items-center justify-between">
    <button class="text-xs text-secondary hover:text-sky-300" @click="$emit('toggle')">
      {{ open ? t('agents.deletedHide') : t('agents.deletedToggle') }}
    </button>
    <span v-if="open" class="text-xs text-muted">{{ t('agents.deletedHint') }}</span>
  </div>
  <div v-if="open" class="glass mb-4 p-4">
    <div v-if="!agents.length" class="text-xs text-muted">{{ t('agents.deletedEmpty') }}</div>
    <ul v-else class="space-y-2">
      <li v-for="d in agents" :key="d.id" class="flex items-center justify-between gap-3 text-sm">
        <span class="truncate text-slate-300">
          {{ d.name }}<span class="ml-2 text-xs text-muted">{{ d.id }}</span>
        </span>
        <span class="flex shrink-0 items-center gap-3">
          <span class="text-xs text-amber-300">{{ t('agents.daysLeft', { n: d.days_left }) }}</span>
          <button class="rounded-lg bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500" @click="$emit('restore', d.id)">
            {{ t('agents.restore') }}
          </button>
        </span>
      </li>
    </ul>
  </div>
</template>
