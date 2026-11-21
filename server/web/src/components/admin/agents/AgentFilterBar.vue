<script setup lang="ts">
// 工具栏：搜索 / 排序 / 全选。
import { computed } from 'vue';
import { t } from '../../../composables/useI18n';
import type { AgentSortKey } from './types';

const props = defineProps<{
  search: string;
  sortKey: AgentSortKey;
  allSelected: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:search', v: string): void;
  (e: 'update:sortKey', v: AgentSortKey): void;
  (e: 'toggle-all'): void;
}>();

const searchModel = computed({
  get: () => props.search,
  set: (v: string) => emit('update:search', v),
});
const sortModel = computed<string>({
  get: () => props.sortKey,
  set: (v) => emit('update:sortKey', v as AgentSortKey),
});
</script>

<template>
  <!-- B3: 工具栏 搜索 / 排序 / 批量 -->
  <div class="mb-4 flex flex-wrap items-center gap-3">
    <input v-model="searchModel" :placeholder="t('agents.searchPlaceholder')" class="field-control min-w-[160px] flex-1" />
    <select v-model="sortModel" class="field-control">
      <option value="name">{{ t('agents.sortByName') }}</option>
      <option value="cpu">{{ t('agents.sortByCpu') }}</option>
      <option value="mem">{{ t('agents.sortByMem') }}</option>
      <option value="status">{{ t('agents.sortByStatus') }}</option>
    </select>
    <label class="flex cursor-pointer items-center gap-2 text-sm text-secondary">
      <input type="checkbox" :checked="allSelected" @change="$emit('toggle-all')" class="switch" />
      {{ t('agents.selectAll') }}
    </label>
  </div>
</template>
