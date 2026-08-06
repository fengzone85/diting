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

const status = computed(() => props.agent.status || (props.agent.online ? 'online' : 'offline'));
const statusText = computed(() => {
  const map: Record<string, string> = { online: t('card.online'), offline: t('card.offline'), warn: t('card.warn') };
  return map[status.value];
});
const cpu = computed(() => props.agent.cpu ?? props.agent.cpu_percent);
const merchantName = computed(() => providerAlias(props.agent.id, props.agent.merchant));
const padClass = computed(() => ({ mini:'p-3', compact:'p-3.5', comfortable:'p-5', large:'p-6' }[props.size || 'comfortable']));

function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

function probeTargets() {
  const p = props.agent.probes; if (!p) return [];
  if (Array.isArray(p)) return p;
  return Object.entries(p).map(([target, v]) => ({ target, ...(v as Record<string, unknown>) }));
}

function pctClass(v: number | null | undefined) {
  if (v == null) return ''; if (v >= 90) return 'text-rose-400'; if (v >= 70) return 'text-amber-400';
  return 'text-emerald-400';
}

const isWindows = computed(() => (props.agent.os || '').toLowerCase().includes('windows'));

// ---- sparkline ----
const hist = computed(() => props.sparklines?.[props.agent.id] || []);
const histOk = computed(() => Array.isArray(hist.value) && hist.value.length > 0);

function ptsString(values: (number | undefined | null)[], w = 60, h = 32) {
  const arr = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (arr.length === 0) return '';
  const max = Math.max(...arr, 1e-9), min = Math.min(...arr, 0), range = (max - min) || 1;
  return arr.map((v, i) => `${(i/(arr.length-1||1)*w).toFixed(1)},${(h-((v-min)/range)*(h-2)-1).toFixed(1)}`).join(' ');
}

const sparkCpuPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.cpu ?? x.cpu_percent) : [cpu.value]));
const sparkMemPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.mem_pct) : [props.agent.mem_pct]));
const sparkLoadPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.load1) : [props.agent.load1]));
const sparkTempPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.temp) : [props.agent.temp]));
const sparkSwapPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => x.swap_pct) : [props.agent.swap_pct]));
const sparkIOPtsR = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => +(x.disk_r_rate!/1048576).toFixed(1)) : [0]));
const sparkIOPtsW = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => +(x.disk_w_rate!/1048576).toFixed(1)) : [0]));
const sparkNetPts = computed(() => ptsString(histOk.value ? hist.value.map((x: SparklinePoint) => +((x.net_rx_rate||0)/1024).toFixed(1)) : [0]));

// 月流量进度（quota_gb > 0 时显示进度条）
const trafficPct = computed(() => {
  const q = props.agent.monthly_quota_gb;
  if (!q || q <= 0) return null;
  const used = ((props.agent.net_rx_month || 0) + (props.agent.net_tx_month || 0)) / 1073741824;
  return Math.min((used / q) * 100, 100);
});
</script>

<template>
  <RouterLink
    :to="`/node/${agent.id}`"
    class="glass card-hover node-card block"
    :class="[template === 'simple' ? 'p-4' : '', size === 'mini' ? 'text-xs' : '']"
    :draggable="draggable"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend', $event)"
  >
    <!-- ===== 旧版 .top：status dot + h3 + flags + badges ===== -->
    <div class="card-top">
      <span class="status-dot flex-shrink-0" :class="`status-${status}`" />
      <h3 class="min-w-0 flex-1 truncate font-bold text-content">{{ agent.name }}</h3>
      <img v-if="agent.country || agent.country_code"
        :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`"
        class="flag-icon" :alt="agent.country" />
      <span v-if="agent.group && !merchantName" class="badge">{{ agent.group }}</span>
      <span v-if="merchantName" class="badge">{{ merchantName }}</span>
      <span v-if="daysUntil(agent.expire_at) != null" class="badge"
        :class="(daysUntil(agent.expire_at) ?? 0) < 0 ? 'badge-danger' : (daysUntil(agent.expire_at) ?? 999) <= 7 ? 'badge-warn' : ''"
      >{{ (daysUntil(agent.expire_at) ?? 0) < 0 ? '过期' : '' }}{{ Math.abs(daysUntil(agent.expire_at) ?? 0) }}天</span>
      <span class="text-[10px] text-muted flex-shrink-0">{{ statusText }}</span>
    </div>

    <!-- ===== 旧版 .meta：hostname · os ===== -->
    <div v-if="agent.hostname || agent.os" class="card-meta">{{ [agent.hostname, agent.os].filter(Boolean).join(' · ') }}</div>
    <!-- ===== 旧版 .note ===== -->
    <div v-if="agent.note" class="card-note">📝 {{ agent.note }}</div>

    <!-- ===== 旧版 .metrics：3 列 grid ===== -->
    <div class="card-metrics">
      <div class="card-metric">
        <div class="m-spark"><svg class="spark" viewBox="0 0 60 32"><polyline v-if="sparkCpuPts" :points="sparkCpuPts" fill="none" stroke="#5cb6a5" stroke-width="1.5" /></svg></div>
        <div class="m-info"><span class="m-lbl">{{ t('card.cpu') }}</span><span class="m-val" :class="pctClass(cpu)">{{ formatPercent(cpu) }}</span></div>
      </div>
      <div class="card-metric">
        <div class="m-spark"><svg class="spark" viewBox="0 0 60 32"><polyline v-if="sparkMemPts" :points="sparkMemPts" fill="none" stroke="#6c9eff" stroke-width="1.5" /></svg></div>
        <div class="m-info"><span class="m-lbl">{{ t('card.memory') }}</span><span class="m-val" :class="pctClass(agent.mem_pct)">{{ formatPercent(agent.mem_pct) }}</span></div>
      </div>
      <div class="card-metric">
        <div class="m-spark"><svg class="spark" viewBox="0 0 60 32"><polyline v-if="sparkLoadPts" :points="sparkLoadPts" fill="none" stroke="#ffce5c" stroke-width="1.5" /></svg></div>
        <div class="m-info"><span class="m-lbl">{{ isWindows ? '进程' : '负载' }}</span><span class="m-val">{{ agent.load1 != null ? agent.load1.toFixed(2) : '—' }}</span></div>
      </div>
      <div class="card-metric">
        <div class="m-spark"><svg class="spark" viewBox="0 0 60 32"><polyline v-if="sparkTempPts" :points="sparkTempPts" fill="none" stroke="#ff7a59" stroke-width="1.5" /></svg></div>
        <div class="m-info"><span class="m-lbl">温度</span><span class="m-val">{{ agent.temp != null ? agent.temp.toFixed(1)+'°C' : '—' }}</span></div>
      </div>
      <div class="card-metric">
        <div class="m-spark"><svg class="spark" viewBox="0 0 60 32"><polyline v-if="sparkSwapPts" :points="sparkSwapPts" fill="none" stroke="#a06bff" stroke-width="1.5" /></svg></div>
        <div class="m-info"><span class="m-lbl">Swap</span><span class="m-val" :class="pctClass(agent.swap_pct)">{{ formatPercent(agent.swap_pct) }}</span></div>
      </div>
      <div class="card-metric">
        <div class="m-spark"><svg class="spark" viewBox="0 0 60 32"><polyline v-if="sparkIOPtsR" :points="sparkIOPtsR" fill="none" stroke="#4ea5d9" stroke-width="1.5" /><polyline v-if="sparkIOPtsW" :points="sparkIOPtsW" fill="none" stroke="#ff9f59" stroke-width="1.5" /></svg></div>
        <div class="m-info"><span class="m-lbl">IO</span><span class="m-val">{{ ((agent.disk_r_rate||0)/1048576).toFixed(2) }}/{{ ((agent.disk_w_rate||0)/1048576).toFixed(2) }}</span></div>
      </div>
      <!-- 网络+探针 跨3列 -->
      <div class="card-metric card-metric-wide">
        <div class="m-spark"><svg class="spark" viewBox="0 0 60 32"><polyline v-if="sparkNetPts" :points="sparkNetPts" fill="none" stroke="#4dd591" stroke-width="1.5" /></svg></div>
        <div class="m-info">
          <span class="m-lbl">网络</span>
          <span class="m-val">↓ {{ formatBitsPerSecond(agent.net_rx_rate) }} &nbsp;↑ {{ formatBitsPerSecond(agent.net_tx_rate) }}</span>
          <div v-if="probeTargets().length" class="card-probes">
            <span v-for="pt in probeTargets()" :key="pt.target" class="probe" :class="pt.ok!==false&&pt.ms!=null?'probe-ok':'probe-timeout'">{{ pt.target }} {{ pt.ok!==false&&pt.ms!=null?formatNumber(pt.ms as number,1):t('card.timeout') }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 磁盘条 + 月流量条（旧版 disk-row / traffic-row） ===== -->
    <div class="card-disk-row">
      <span class="m-lbl">{{ t('card.disk') }}</span>
      <div class="bar"><div class="bar-fill" :class="pctClass(agent.disk_pct)" :style="{ width: `${Math.min(agent.disk_pct||0,100)}%` }"></div></div>
      <span class="m-val">{{ formatBytes(agent.disk_used) }}/{{ formatBytes(agent.disk_total) }}</span>
    </div>
    <div class="card-disk-row">
      <span class="m-lbl">流量</span>
      <div v-if="trafficPct != null" class="bar"><div class="bar-fill" :class="pctClass(trafficPct)" :style="{ width: `${trafficPct}%` }"></div></div>
      <span class="m-val">{{ formatBytes((agent.net_rx_month||0)+(agent.net_tx_month||0)) }}</span>
    </div>

    <!-- ===== 旧版 .foot ===== -->
    <div class="card-foot">
      <span class="uptime">{{ t('card.uptime') }} {{ formatDuration(agent.uptime) }}</span>
      <div v-if="agent.monthly_quota_gb" class="text-[10px] text-muted">配额 {{ agent.monthly_quota_gb }} GB</div>
    </div>
  </RouterLink>
</template>
