<script setup lang="ts">
// 上线概览卡（对齐 Komari 的 overview 卡）：在线率圆环 + 健康结论 + 在线/离线数
import { computed } from 'vue';
import { Dashboard } from '@icon-park/vue-next';
import WidgetShell from './WidgetShell.vue';
import { useI18n } from '../../../composables/useI18n';

const props = defineProps<{
  title: string;
  total: number;
  online: number;
  offline: number;
  /** 离线节点名（已截断），悬停可看全量 */
  offlineNames: string[];
}>();

const { t } = useI18n();

const pct = computed(() => (props.total > 0 ? Math.round((props.online / props.total) * 100) : 0));
const ringStyle = computed(() => ({
  background: `conic-gradient(#38bdf8 ${pct.value}%, rgba(148, 163, 184, 0.22) 0)`,
}));
</script>

<template>
  <WidgetShell :title="title" :icon="Dashboard">
    <div class="flex h-full items-center gap-4">
      <div class="grid h-[76px] w-[76px] shrink-0 place-items-center rounded-full" :style="ringStyle">
        <div class="grid h-[58px] w-[58px] place-items-center rounded-full bg-slate-900">
          <span class="text-base font-semibold tabular-nums text-slate-100">{{ pct }}%</span>
        </div>
      </div>
      <div class="min-w-0 flex-1 space-y-1">
        <p class="text-sm font-medium" :class="offline ? 'text-amber-300' : 'text-emerald-400'">
          {{ offline ? t('dashboard.someOffline') : t('dashboard.allOnline') }}
        </p>
        <p class="text-xs text-slate-400">
          {{ t('dashboard.onlineNodes', { online, total }) }}
        </p>
        <p class="text-xs text-slate-400">
          {{ t('dashboard.offlineNodes') }}
          <span class="font-medium" :class="offline ? 'text-rose-300' : 'text-slate-300'">{{ offline }}</span>
        </p>
        <p
          v-if="offlineNames.length"
          class="truncate text-[11px] text-slate-500"
          :title="offlineNames.join('、')"
        >
          {{ offlineNames.join('、') }}
        </p>
      </div>
    </div>
  </WidgetShell>
</template>
