<script setup lang="ts">
// 资源容量卡（对齐 Komari 的 resources 卡）：集群总核心 / 总内存 / 总磁盘
import { computed } from 'vue';
import { Cpu, HardDisk, Memory, Server } from '@icon-park/vue-next';
import WidgetShell from './WidgetShell.vue';
import { useI18n } from '../../../composables/useI18n';
import { formatBytes } from '../../../utils/format';

const props = defineProps<{
  title: string;
  cores: number;
  memTotal: number;
  diskTotal: number;
  nodeCount: number;
}>();

const { t } = useI18n();

const rows = computed(() => [
  { key: 'cores', icon: Cpu, label: t('dashboard.cores'), value: props.cores > 0 ? String(props.cores) : '—' },
  { key: 'mem', icon: Memory, label: t('dashboard.memTotal'), value: props.memTotal > 0 ? formatBytes(props.memTotal) : '—' },
  { key: 'disk', icon: HardDisk, label: t('dashboard.diskTotal'), value: props.diskTotal > 0 ? formatBytes(props.diskTotal) : '—' },
]);
</script>

<template>
  <WidgetShell :title="title" :icon="Server">
    <div class="space-y-2">
      <div
        v-for="r in rows"
        :key="r.key"
        class="flex items-center justify-between gap-2 border-b border-slate-700/40 pb-1.5 text-xs last:border-0"
      >
        <span class="flex min-w-0 items-center gap-1.5 text-slate-400">
          <component :is="r.icon" :size="14" />
          <span class="truncate">{{ r.label }}</span>
        </span>
        <span class="shrink-0 font-semibold tabular-nums text-slate-200">{{ r.value }}</span>
      </div>
      <p class="pt-1 text-[11px] text-slate-500">{{ t('dashboard.capacityCount', { n: nodeCount }) }}</p>
    </div>
  </WidgetShell>
</template>
