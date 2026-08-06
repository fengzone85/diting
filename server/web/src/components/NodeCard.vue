<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Agent, Sparklines, SparklinePoint } from '../services/types';
import { formatBytes, formatDuration, formatPercent, formatBitsPerSecond, formatNumber } from '../utils/format';
import { providerAlias } from '../composables/useApp';
import { useI18n } from '../composables/useI18n';

const { t } = useI18n();

const props = defineProps<{
  agent: Agent;
  template?: 'simple' | 'visual';
  draggable?: boolean;
  size?: 'mini' | 'compact' | 'comfortable' | 'large';
  tag?: string;
  sparklines?: Sparklines;
}>();

const emit = defineEmits<{
  (e: 'dragstart', event: DragEvent): void;
  (e: 'dragend', event: DragEvent): void;
}>();

const status = computed(() => {
  if (props.agent.status) return props.agent.status;
  return props.agent.online ? 'online' : 'offline';
});

const statusText = computed(() => {
  const map: Record<string, string> = {
    online: t('card.online'),
    offline: t('card.offline'),
    warn: t('card.warn'),
  };
  return map[status.value];
});
const cpu = computed(() => props.agent.cpu ?? props.agent.cpu_percent);
const merchantName = computed(() => providerAlias(props.agent.id, props.agent.merchant));
const padClass = computed(() => {
  const s = props.size || 'comfortable';
  return {
    mini: 'p-3',
    compact: 'p-3.5',
    comfortable: 'p-5',
    large: 'p-6',
  }[s];
});

function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

function avgProbe(points: unknown) {
  if (!points) return null;
  // 兼容对象格式 {ms, ok, loss}（旧版公开页 API）
  if (typeof points === 'object' && !Array.isArray(points)) {
    const p = points as { ms?: number; ok?: boolean };
    return p.ok !== false && typeof p.ms === 'number' ? p.ms : null;
  }
  // 数组格式 [{ms, ok}]
  const arr = points as { ms: number; ok: boolean }[];
  if (!arr?.length) return null;
  const ok = arr.filter((p) => p.ok !== false);
  if (!ok.length) return null;
  return +(ok.reduce((s, p) => s + p.ms, 0) / ok.length).toFixed(1);
}

function probeTargets() {
  const p = props.agent.probes;
  if (!p) return [];
  if (Array.isArray(p)) return p;
  return Object.entries(p).map(([target, v]) => ({ target, ...(v as Record<string, unknown>) }));
}

// 旧版卡片 pctClass：>90 红色、>70 橙色、正常绿色
function pctClass(v: number | null | undefined) {
  if (v == null) return '';
  if (v >= 90) return 'text-rose-400';
  if (v >= 70) return 'text-amber-400';
  return 'text-emerald-400';
}

const isWindows = computed(() => (props.agent.os || '').toLowerCase().includes('windows'));

// ---- sparkline 迷你图（points 数据，模板中内联 SVG） ----
const hist = computed(() => props.sparklines?.[props.agent.id] || []);
const histOk = computed(() => Array.isArray(hist.value) && hist.value.length > 0);
const SPARK_W = 60, SPARK_H = 16;

function ptsString(values: (number | undefined | null)[], w = SPARK_W, h = SPARK_H) {
  const arr = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (arr.length === 0) return '';
  const max = Math.max(...arr, 1e-9);
  const min = Math.min(...arr, 0);
  const range = (max - min) || 1;
  return arr.map((v, i) => {
    const x = (i / (arr.length - 1 || 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function ptsString2(rArr: (number | undefined | null)[], wArr: (number | undefined | null)[]) {
  return { r: ptsString(rArr), w: ptsString(wArr) };
}

const sparkCpuPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.cpu ?? x.cpu_percent) : [cpu.value]));
const sparkMemPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.mem_pct) : [props.agent.mem_pct]));
const sparkLoadPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.load1) : [props.agent.load1]));
const sparkTempPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.temp) : [props.agent.temp]));
const sparkSwapPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.swap_pct) : [props.agent.swap_pct]));
const sparkIOPts = computed(() => {
  const r = histOk.value ? hist.value.map((x: SparklinePoint) => +(x.disk_r_rate! / 1048576).toFixed(1)) : [0];
  const w = histOk.value ? hist.value.map((x: SparklinePoint) => +(x.disk_w_rate! / 1048576).toFixed(1)) : [0];
  return ptsString2(r, w);
});
const sparkNetPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => +((x.net_rx_rate || 0) / 1024).toFixed(1)) : [0]));
</script>

<template>
  <RouterLink
    :to="`/node/${agent.id}`"
    class="glass card-hover block text-slate-200"
    :class="[template === 'simple' ? 'p-4' : padClass, size === 'mini' ? 'text-xs' : '']"
    :draggable="draggable"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend', $event)"
  >
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <img
          v-if="agent.country || agent.country_code"
          :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`"
          class="h-5 w-7 rounded-sm"
          :alt="agent.country"
        />
        <div>
          <h3 class="font-semibold text-content">{{ agent.name }}</h3>
          <p v-if="template === 'visual' && (agent.group || merchantName)" class="text-xs text-secondary">
            {{ agent.group || '' }}{{ agent.group && merchantName ? ' · ' : '' }}{{ merchantName || '' }}
          </p>
        </div>
      </div>
      <div class="flex flex-col items-end gap-1">
        <span class="flex items-center gap-2 text-xs">
          <span class="status-dot" :class="`status-${status}`" />
          {{ statusText }}
        </span>
        <span v-if="agent.version" class="text-[10px] text-slate-600">v{{ agent.version }}</span>
      </div>
    </div>

    <span
      v-if="tag"
      class="mt-2 inline-block rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] text-sky-300"
    >{{ tag }}</span>

    <div v-if="template === 'simple'" class="mt-4 grid grid-cols-2 gap-4 text-sm">
      <div>
        <p class="text-secondary">{{ t('card.cpu') }}</p>
        <p class="font-medium">{{ formatPercent(cpu) }}</p>
      </div>
      <div>
        <p class="text-secondary">{{ t('card.memory') }}</p>
        <p class="font-medium">{{ formatBytes(agent.mem_used) }} / {{ formatBytes(agent.mem_total) }}</p>
      </div>
      <div>
        <p class="text-secondary">{{ t('card.disk') }}</p>
        <p class="font-medium">{{ formatBytes(agent.disk_used) }} / {{ formatBytes(agent.disk_total) }}</p>
      </div>
      <div>
        <p class="text-secondary">{{ t('card.uptime') }}</p>
        <p class="font-medium">{{ formatDuration(agent.uptime) }}</p>
      </div>
    </div>

    <div v-else>
      <!-- 旧版 .top：border-bottom + 名称 + badges -->
      <div class="card-top">
        <h3 class="min-w-0 flex-1 truncate text-sm font-bold text-content">{{ agent.name }}</h3>
        <span v-if="merchantName" class="badge">{{ merchantName }}</span>
        <span v-if="daysUntil(agent.expire_at) != null" class="badge"
          :class="(daysUntil(agent.expire_at) ?? 0) < 0 ? 'badge-danger' : (daysUntil(agent.expire_at) ?? 999) <= 7 ? 'badge-warn' : ''"
        >{{ (daysUntil(agent.expire_at) ?? 0) < 0 ? '过期' : '' }}{{ Math.abs(daysUntil(agent.expire_at) ?? 0) }}天</span>
      </div>
      <!-- 旧版 .meta：hostname · os -->
      <div v-if="agent.hostname || agent.os" class="card-meta">{{ [agent.hostname, agent.os].filter(Boolean).join(' · ') }}</div>
      <!-- 旧版 .note：备注 -->
      <div v-if="agent.note" class="card-note">📝 {{ agent.note }}</div>

      <!-- 旧版 .metrics：3 列 grid，每个 metric 独立 box -->
      <div class="card-metrics">
        <div class="card-metric">
          <div class="m-spark"><svg class="spark" viewBox="0 0 60 32" preserveAspectRatio="none"><polyline v-if="sparkCpuPts" :points="sparkCpuPts" fill="none" stroke="#5cb6a5" stroke-width="1.5" /></svg></div>
          <div class="m-info"><span class="m-lbl">{{ t('card.cpu') }}</span><span class="m-val" :class="pctClass(cpu)">{{ formatPercent(cpu) }}</span></div>
        </div>
        <div class="card-metric">
          <div class="m-spark"><svg class="spark" viewBox="0 0 60 32" preserveAspectRatio="none"><polyline v-if="sparkMemPts" :points="sparkMemPts" fill="none" stroke="#6c9eff" stroke-width="1.5" /></svg></div>
          <div class="m-info"><span class="m-lbl">{{ t('card.memory') }}</span><span class="m-val" :class="pctClass(agent.mem_pct)">{{ formatPercent(agent.mem_pct) }}</span></div>
        </div>
        <div class="card-metric">
          <div class="m-spark"><svg class="spark" viewBox="0 0 60 32" preserveAspectRatio="none"><polyline v-if="sparkLoadPts" :points="sparkLoadPts" fill="none" stroke="#ffce5c" stroke-width="1.5" /></svg></div>
          <div class="m-info"><span class="m-lbl">{{ isWindows ? '进程' : '负载' }}</span><span class="m-val">{{ agent.load1 != null ? agent.load1.toFixed(2) : '—' }}</span></div>
        </div>
        <div class="card-metric">
          <div class="m-spark"><svg class="spark" viewBox="0 0 60 32" preserveAspectRatio="none"><polyline v-if="sparkTempPts" :points="sparkTempPts" fill="none" stroke="#ff7a59" stroke-width="1.5" /></svg></div>
          <div class="m-info"><span class="m-lbl">温度</span><span class="m-val">{{ agent.temp != null ? agent.temp.toFixed(1) + '°C' : '—' }}</span></div>
        </div>
        <div class="card-metric">
          <div class="m-spark"><svg class="spark" viewBox="0 0 60 32" preserveAspectRatio="none"><polyline v-if="sparkSwapPts" :points="sparkSwapPts" fill="none" stroke="#a06bff" stroke-width="1.5" /></svg></div>
          <div class="m-info"><span class="m-lbl">Swap</span><span class="m-val" :class="pctClass(agent.swap_pct)">{{ formatPercent(agent.swap_pct) }}</span></div>
        </div>
        <div class="card-metric">
          <div class="m-spark"><svg class="spark" viewBox="0 0 60 32" preserveAspectRatio="none"><polyline v-if="sparkIOPts.r" :points="sparkIOPts.r" fill="none" stroke="#4ea5d9" stroke-width="1.5" /><polyline v-if="sparkIOPts.w" :points="sparkIOPts.w" fill="none" stroke="#ff9f59" stroke-width="1.5" /></svg></div>
          <div class="m-info"><span class="m-lbl">IO MB/s</span><span class="m-val">{{ ((agent.disk_r_rate || 0) / 1048576).toFixed(2) }}/{{ ((agent.disk_w_rate || 0) / 1048576).toFixed(2) }}</span></div>
        </div>
        <!-- 网络 + 探针：跨 3 列 -->
        <div class="card-metric card-metric-wide">
          <div class="m-spark"><svg class="spark" viewBox="0 0 60 32" preserveAspectRatio="none"><polyline v-if="sparkNetPts" :points="sparkNetPts" fill="none" stroke="#4dd591" stroke-width="1.5" /></svg></div>
          <div class="m-info"><span class="m-lbl">网络</span><span class="m-val">↓ {{ formatBitsPerSecond(agent.net_rx_rate) }} &nbsp;↑ {{ formatBitsPerSecond(agent.net_tx_rate) }}</span>
            <div v-if="probeTargets().length" class="card-probes">
              <span v-for="pt in probeTargets()" :key="pt.target" class="probe" :class="pt.ok !== false && pt.ms != null ? 'probe-ok' : 'probe-timeout'">{{ pt.target }} {{ pt.ok !== false && pt.ms != null ? `${formatNumber(pt.ms as number, 1)}ms` : t('card.timeout') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 磁盘条 + 月流量（旧版 disk-row） -->
      <div class="card-disk-row"><span class="m-lbl">{{ t('card.disk') }}</span><div class="bar"><div class="bar-fill" :class="pctClass(agent.disk_pct)" :style="{ width: `${Math.min(agent.disk_pct || 0, 100)}%` }"></div></div><span class="m-val">{{ formatBytes(agent.disk_used) }}/{{ formatBytes(agent.disk_total) }}</span></div>
      <div class="card-disk-row"><span class="m-lbl">流量</span><span class="m-val flex-1">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) }}</span></div>

      <!-- 旧版 .foot：uptime + 到期/配额 -->
      <div class="card-foot">
        <span class="uptime">{{ t('card.uptime') }} {{ formatDuration(agent.uptime) }}</span>
        <div v-if="agent.expire_at || agent.monthly_quota_gb" class="flex flex-wrap gap-1.5 text-secondary">
          <span v-if="agent.expire_at">
            {{ t('card.expire') }}
            <span :class="{ 'text-rose-400': (daysUntil(agent.expire_at) ?? 0) < 0, 'text-amber-400': (daysUntil(agent.expire_at) ?? 999) <= 7 && (daysUntil(agent.expire_at) ?? 0) >= 0 }">{{ agent.expire_at }}</span>
          </span>
          <span v-if="agent.monthly_quota_gb">{{ t('card.quota') }} {{ agent.monthly_quota_gb }} GB</span>
        </div>
      </div>
    </div>
  </RouterLink>
</template>
