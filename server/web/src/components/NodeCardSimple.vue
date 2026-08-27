<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Agent } from '../services/types';
import { formatBytes, formatBitsPerSecond } from '../utils/format';
import { providerAlias } from '../composables/useApp';
import { useI18n } from '../composables/useI18n';
import { ArrowUp, ArrowDown, Upload, Download } from '@icon-park/vue-next';

const { t } = useI18n();

const props = defineProps<{
  agent: Agent;
  draggable?: boolean;
  tag?: string;
}>();

const emit = defineEmits<{
  (e: 'dragstart', event: DragEvent): void;
  (e: 'dragend', event: DragEvent): void;
}>();

const cpu = computed(() => props.agent.cpu ?? props.agent.cpu_percent ?? 0);
const memPct = computed(() => props.agent.mem_pct ?? 0);
const merchantName = computed(() => providerAlias(props.agent.id, props.agent.merchant));

const memUsed = computed(() => {
  const a = props.agent;
  if (a.mem_used != null && a.mem_total != null) return `${formatBytes(a.mem_used)} / ${formatBytes(a.mem_total)}`;
  return '';
});

const diskUsed = computed(() => {
  const a = props.agent;
  const list = Array.isArray(a.disks) ? a.disks : [];
  if (list.length > 0) {
    let used = 0, total = 0;
    for (const d of list) { used += Number(d.used) || 0; total += Number(d.total) || 0; }
    if (total > 0) return `${formatBytes(used)} / ${formatBytes(total)}`;
  }
  if (a.disk_used != null && a.disk_total != null) return `${formatBytes(a.disk_used)} / ${formatBytes(a.disk_total)}`;
  return '';
});
const diskPct = computed(() => {
  const a = props.agent;
  const list = Array.isArray(a.disks) ? a.disks : [];
  if (list.length > 0) {
    let used = 0, total = 0;
    for (const d of list) { used += Number(d.used) || 0; total += Number(d.total) || 0; }
    return total > 0 ? (used / total) * 100 : 0;
  }
  return a.disk_pct ?? 0;
});

const trafficUsed = computed(() => {
  const a = props.agent;
  const used = (a.net_rx_month || 0) + (a.net_tx_month || 0);
  const limit = a.monthly_quota_gb ? a.monthly_quota_gb * 1073741824 : undefined;
  return { used, limit };
});
const trafficPct = computed(() => {
  const { used, limit } = trafficUsed.value;
  if (!limit || limit <= 0) return 0;
  return Math.min((used / limit) * 100, 100);
});

function barStatus(pct: number): string {
  if (pct >= 95) return 'error';
  if (pct >= 80) return 'warning';
  if (pct >= 60) return 'info';
  return 'success';
}
function barBg(status: string): string {
  switch (status) {
    case 'error': return 'var(--danger)';
    case 'warning': return 'var(--warning)';
    case 'info': return 'var(--accent)';
    default: return 'var(--success)';
  }
}

const uptimeDays = computed(() => {
  const s = props.agent.uptime;
  if (!s) return 0;
  return Math.floor(s / 86400);
});

function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}
const expireDays = computed(() => daysUntil(props.agent.expire_at));

const netOut = computed(() => formatBitsPerSecond(props.agent.net_tx_rate));
const netIn = computed(() => formatBitsPerSecond(props.agent.net_rx_rate));

const totalUp = computed(() => formatBytes(props.agent.net_tx_month ?? 0));
const totalDown = computed(() => formatBytes(props.agent.net_rx_month ?? 0));

// 探针数据解析
function parseProbes(): Record<string, { ts?: number; ms?: number; ok?: boolean; loss?: number }> {
  const p = props.agent.probes;
  if (!p) return {};
  if (typeof p === 'string') {
    try { return JSON.parse(p); } catch { return {}; }
  }
  return p || {};
}

// 固定 20 根柱子（对齐 Komari 的 ps=20）
const BAR_COUNT = 20;

// 延迟柱状图数据 - 对齐 Komari 的 latencyRenderBars
// 注意：Komari 的柱子高度完全相同（h-full），视觉区分只靠颜色和图案
const latencyBars = computed(() => {
  const probes = parseProbes();
  const entries = Object.entries(probes);
  if (entries.length === 0) {
    return Array.from({ length: BAR_COUNT }, (_, i) => ({
      key: `empty-${i}`,
      className: 'bg-muted-foreground/10',
      tooltip: '',
    }));
  }
  // 有数据时：用当前探针值循环填充 20 根柱子
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const [target, v] = entries[i % entries.length];
    const ms = v.ms ?? 0;
    const ok = v.ok !== false;
    return {
      key: `${target}-${i}`,
      className: !ok ? 'bg-signal-5' : latencyColorClass(ms),
      tooltip: `${target}: ${ok ? ms.toFixed(0) + 'ms' : 'timeout'}`,
    };
  });
});

// 丢包柱状图数据 - 对齐 Komari 的 lossRenderBars
const lossBars = computed(() => {
  const probes = parseProbes();
  const entries = Object.entries(probes);
  if (entries.length === 0) {
    return Array.from({ length: BAR_COUNT }, (_, i) => ({
      key: `empty-${i}`,
      className: 'bg-muted-foreground/10',
      tooltip: '',
    }));
  }
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const [target, v] = entries[i % entries.length];
    const loss = v.loss ?? 0;
    const ok = v.ok !== false;
    return {
      key: `${target}-${i}`,
      className: !ok ? 'bg-signal-5 ping-signal-pattern-4' : lossColorClass(loss),
      tooltip: `${target}: ${ok ? loss.toFixed(1) + '%' : 'timeout'}`,
    };
  });
});

// 延迟颜色分级 - 对齐 Komari 的 ys 函数
function latencyColorClass(ms: number): string {
  if (ms <= 60) return 'bg-signal-1';
  if (ms <= 100) return 'bg-signal-2';
  if (ms <= 160) return 'bg-signal-3 ping-signal-pattern-2';
  if (ms <= 200) return 'bg-signal-4 ping-signal-pattern-3';
  return 'bg-signal-5 ping-signal-pattern-4';
}

// 丢包颜色分级 - 对齐 Komari 的 ws 函数
function lossColorClass(loss: number): string {
  if (loss <= 1) return 'bg-signal-1';
  if (loss <= 3) return 'bg-signal-2';
  if (loss <= 6) return 'bg-signal-3 ping-signal-pattern-2';
  if (loss <= 9) return 'bg-signal-4 ping-signal-pattern-3';
  return 'bg-signal-5 ping-signal-pattern-4';
}

const avgLatency = computed(() => {
  const probes = parseProbes();
  const entries = Object.entries(probes).filter(([, v]) => v.ok !== false && v.ms != null);
  if (entries.length === 0) return '—';
  const avg = entries.reduce((s, [, v]) => s + (v.ms || 0), 0) / entries.length;
  return avg.toFixed(0) + 'ms';
});

const avgLoss = computed(() => {
  const probes = parseProbes();
  const entries = Object.entries(probes);
  if (entries.length === 0) return '0%';
  const failed = entries.filter(([, v]) => v.ok === false).length;
  return ((failed / entries.length) * 100).toFixed(1) + '%';
});

const tags = computed(() => {
  const a = props.agent;
  const result: string[] = [];
  if ((a as any).tags) {
    try {
      const parsed = typeof (a as any).tags === 'string' ? JSON.parse((a as any).tags) : (a as any).tags;
      if (Array.isArray(parsed)) {
        for (const tag of parsed) {
          if (typeof tag === 'string') result.push(tag);
          else if (tag && typeof tag === 'object' && 'name' in tag) result.push(String(tag.name));
          else if (tag && typeof tag === 'object' && 'text' in tag) result.push(String(tag.text));
        }
      }
    } catch { /* ignore */ }
  }
  return result;
});
</script>

<template>
  <RouterLink
    :to="`/node/${agent.id}`"
    class="glass card-hover node-card-simple block"
    :draggable="draggable"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend', $event)"
  >
    <!-- Header: status + name + flag/tag - 对齐 Komari CardX header px-4 py-3 -->
    <div class="flex items-center gap-2 min-w-0 px-4 py-3">
      <div class="relative size-2.5 shrink-0">
        <span class="size-2.5 rounded-full block" :style="{ background: agent.online ? 'var(--success)' : 'var(--danger)' }"></span>
        <span class="animate-ping absolute inset-0 rounded-full opacity-60" :style="{ background: agent.online ? 'var(--success)' : 'var(--danger)' }"></span>
      </div>
      <span class="text-sm font-bold flex-1 min-w-0 truncate text-content">{{ agent.name }}</span>
      <div class="flex gap-1.5 items-center shrink-0">
        <img
          v-if="agent.country"
          :src="`/flags/${(agent.country || '').toLowerCase()}.svg`"
          class="size-5 shrink-0"
          :alt="agent.country"
        />
        <span v-if="tag" class="text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-muted-foreground leading-tight">{{ tag }}</span>
        <span v-if="merchantName && !tag" class="text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-muted-foreground leading-tight">{{ merchantName }}</span>
      </div>
    </div>

    <!-- Content area: 对齐 Komari 内容区 p-4 pt-0 + flex flex-col gap-3 -->
    <div class="flex flex-col gap-3 px-4 pb-4">
    <!-- Uptime + Price row -->
    <div class="relative z-20 flex items-center gap-1.5 -mt-1 h-[19px] overflow-hidden">
      <span class="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-muted-foreground leading-tight">
        {{ t('card.uptime') }} {{ uptimeDays }}d
      </span>
      <span v-if="agent.price" class="min-w-0 truncate text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-muted-foreground leading-tight">
        {{ agent.currency || '¥' }}{{ agent.price }}/mo
      </span>
    </div>

    <!-- Metrics: 2-col grid - 对齐 Komari wt: gap-x-4 gap-y-2.5 -->
    <div class="grid grid-cols-2 gap-x-4 gap-y-2.5">
      <!-- CPU -->
      <div class="flex flex-col gap-1">
        <div class="flex justify-between text-xs">
          <span class="text-muted">CPU</span>
          <span class="tabular-nums font-medium text-content">{{ cpu.toFixed(1) }}%</span>
        </div>
        <div class="relative w-full overflow-hidden rounded-full" style="height: 4px; background: var(--bg-surface);">
          <div class="h-full rounded-full transition-[width] duration-300 ease-out" :style="{ width: `${Math.min(cpu, 100)}%`, background: barBg(barStatus(cpu)) }"></div>
        </div>
        <div class="text-[11px] text-muted truncate">
          {{ agent.load1 != null ? agent.load1.toFixed(2) : '—' }}, {{ agent.load5 != null ? agent.load5.toFixed(2) : '—' }}, {{ agent.load15 != null ? agent.load15.toFixed(2) : '—' }}
        </div>
      </div>
      <!-- RAM -->
      <div class="flex flex-col gap-1">
        <div class="flex justify-between text-xs">
          <span class="text-muted">RAM</span>
          <span class="tabular-nums font-medium text-content">{{ memPct.toFixed(1) }}%</span>
        </div>
        <div class="relative w-full overflow-hidden rounded-full" style="height: 4px; background: var(--bg-surface);">
          <div class="h-full rounded-full transition-[width] duration-300 ease-out" :style="{ width: `${Math.min(memPct, 100)}%`, background: barBg(barStatus(memPct)) }"></div>
        </div>
        <div class="text-[11px] text-muted truncate" :title="memUsed">{{ memUsed }}</div>
      </div>
      <!-- Disk -->
      <div class="flex flex-col gap-1">
        <div class="flex justify-between text-xs">
          <span class="text-muted">{{ t('card.disk') }}</span>
          <span class="tabular-nums font-medium text-content">{{ diskPct.toFixed(1) }}%</span>
        </div>
        <div class="relative w-full overflow-hidden rounded-full" style="height: 4px; background: var(--bg-surface);">
          <div class="h-full rounded-full transition-[width] duration-300 ease-out" :style="{ width: `${Math.min(diskPct, 100)}%`, background: barBg(barStatus(diskPct)) }"></div>
        </div>
        <div class="text-[11px] text-muted truncate">{{ diskUsed }}</div>
      </div>
      <!-- Traffic -->
      <div class="flex flex-col gap-1">
        <div class="flex justify-between text-xs">
          <span class="text-muted">{{ t('public.traffic') }}</span>
          <span class="tabular-nums font-medium" :style="{ color: trafficPct >= 95 ? 'var(--danger)' : trafficPct >= 80 ? 'var(--warning)' : 'var(--success)' }">
            {{ trafficPct > 0 ? `${trafficPct.toFixed(1)}%` : '∞' }}
          </span>
        </div>
        <div class="relative w-full overflow-hidden rounded-full" style="height: 4px; background: var(--bg-surface);">
          <div
            v-if="trafficPct > 0"
            class="h-full rounded-full transition-[width] duration-300 ease-out"
            :style="{ width: `${trafficPct}%`, background: barBg(barStatus(trafficPct)) }"
          ></div>
        </div>
        <div class="text-[11px] truncate" :style="{ color: trafficPct >= 95 ? 'var(--danger)' : 'var(--text-muted)' }">
          {{ formatBytes(trafficUsed.used) }}<span v-if="trafficUsed.limit"> / {{ formatBytes(trafficUsed.limit) }}</span>
        </div>
      </div>
    </div>

    <!-- 3 mini cards: Net speed / Total traffic / Expire -->
    <div class="grid gap-1.5 grid-cols-3">
      <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" style="padding: 6px 8px;">
        <div class="text-[11px] text-muted-foreground flex items-center gap-1">
          <ArrowUp :size="11" />
          <span class="tabular-nums truncate">{{ netOut }}</span>
        </div>
        <div class="text-[11px] text-success flex items-center gap-1">
          <ArrowDown :size="11" />
          <span class="tabular-nums truncate">{{ netIn }}</span>
        </div>
      </div>
      <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" style="padding: 6px 8px;">
        <div class="text-[11px] text-muted-foreground flex items-center gap-1">
          <Upload :size="11" />
          <span class="tabular-nums truncate">{{ totalUp }}</span>
        </div>
        <div class="text-[11px] text-muted-foreground flex items-center gap-1">
          <Download :size="11" />
          <span class="tabular-nums truncate">{{ totalDown }}</span>
        </div>
      </div>
      <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" style="padding: 6px 8px;">
        <template v-if="expireDays != null">
          <div class="text-[11px] text-muted-foreground flex items-center gap-0.5 truncate">
            <span class="truncate">{{ t('card.remainingDays', { n: expireDays }) }}</span>
          </div>
        </template>
        <template v-else>
          <div class="text-[11px] text-muted-foreground tabular-nums">
            {{ t('card.load') }}: {{ agent.load1 != null ? agent.load1.toFixed(2) : '—' }}
          </div>
          <div class="text-[11px] text-muted-foreground tabular-nums">
            {{ agent.load5 != null ? agent.load5.toFixed(2) : '—' }} / {{ agent.load15 != null ? agent.load15.toFixed(2) : '—' }}
          </div>
        </template>
      </div>
    </div>

    <!-- Latency + Loss panels - 对齐 Komari Glassmorphism -->
    <div class="grid grid-cols-2 gap-1.5">
      <!-- 延迟面板 -->
      <div class="group/panel relative flex flex-col rounded-lg bg-slate-500/5" style="gap: 6px; padding: 8px; height: 44px;">
        <div class="flex items-center justify-between text-[11px] leading-none">
          <span class="text-muted-foreground">{{ t('card.latency') || '延迟' }}</span>
          <span class="font-medium tabular-nums text-content">{{ avgLatency }}</span>
        </div>
        <div
          class="grid items-end gap-[1px] opacity-80 group-hover/panel:opacity-100"
          :style="{ height: '11px', gridTemplateColumns: `repeat(${latencyBars.length}, minmax(0, 1fr))`, gridTemplateRows: '11px' }"
        >
          <span
            v-for="bar in latencyBars"
            :key="bar.key"
            class="group/data-tooltip relative block h-full w-full"
          >
            <span
              :class="['block h-full w-full rounded-[1px] transition-transform duration-150 group-hover/data-tooltip:scale-y-160 group-hover/panel:opacity-60 group-hover/data-tooltip:opacity-100', bar.className]"
            ></span>
            <span v-if="bar.tooltip" class="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] opacity-0 group-hover/data-tooltip:opacity-100" style="background: rgba(0,0,0,0.85); color: #fff;">
              {{ bar.tooltip }}
            </span>
          </span>
        </div>
      </div>
      <!-- 丢包面板 -->
      <div class="group/panel relative flex flex-col rounded-lg bg-slate-500/5" style="gap: 6px; padding: 8px; height: 44px;">
        <div class="flex items-center justify-between text-[11px] leading-none">
          <span class="text-muted-foreground">{{ t('card.loss') || '丢包' }}</span>
          <span class="font-medium tabular-nums text-content">{{ avgLoss }}</span>
        </div>
        <div
          class="grid items-end gap-[1px] opacity-80 group-hover/panel:opacity-100"
          :style="{ height: '11px', gridTemplateColumns: `repeat(${lossBars.length}, minmax(0, 1fr))`, gridTemplateRows: '11px' }"
        >
          <span
            v-for="bar in lossBars"
            :key="bar.key"
            class="group/data-tooltip relative block h-full w-full"
          >
            <span
              :class="['block h-full w-full rounded-[1px] transition-transform duration-150 group-hover/data-tooltip:scale-y-160 group-hover/panel:opacity-60 group-hover/data-tooltip:opacity-100', bar.className]"
            ></span>
            <span v-if="bar.tooltip" class="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] opacity-0 group-hover/data-tooltip:opacity-100" style="background: rgba(0,0,0,0.85); color: #fff;">
              {{ bar.tooltip }}
            </span>
          </span>
        </div>
      </div>
    </div>

    <!-- Tags -->
    <div v-if="tags.length" class="flex flex-wrap gap-1">
      <span
        v-for="tagText in tags"
        :key="tagText"
        class="text-[11px] rounded-full px-2 py-0"
        style="color: var(--text-muted); border: 1px solid rgba(127,127,127,0.15);"
      >
        {{ tagText }}
      </span>
    </div>
    </div><!-- /content area -->

    <!-- Offline overlay -->
    <div v-if="!agent.online" class="absolute inset-0 flex flex-col items-center justify-center z-10 rounded-xl" style="background: rgba(0,0,0,0.2); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);">
      <div class="text-sm font-semibold" style="color: var(--danger);">{{ t('card.offline') }}</div>
    </div>
  </RouterLink>
</template>

<style scoped>
.node-card-simple {
  width: 100%;
  max-width: 330px;
  border-radius: 12px;
  position: relative;
  overflow: hidden;
}

/* 信号颜色 - 对齐 Komari */
.node-card-simple {
  --signal-1: #059669;
  --signal-2: #4ade80;
  --signal-3: #a3e635;
  --signal-4: #facc15;
  --signal-5: #f43f5e;
}

.bg-signal-1 { background-color: var(--signal-1); }
.bg-signal-2 { background-color: var(--signal-2); }
.bg-signal-3 { background-color: var(--signal-3); }
.bg-signal-4 { background-color: var(--signal-4); }
.bg-signal-5 { background-color: var(--signal-5); }

/* 信号图案 - 直接从 Komari CSS 复制 */
.ping-signal-pattern-2 {
  background-image: repeating-linear-gradient(135deg, transparent 0 2px, rgba(255,255,255,0.45) 2px 3px);
}
.ping-signal-pattern-3 {
  background-image: repeating-linear-gradient(90deg, transparent 0 2px, rgba(0,0,0,0.28) 2px 3px);
}
.ping-signal-pattern-4 {
  background-image: repeating-linear-gradient(45deg, transparent 0 1px, rgba(255,255,255,0.58) 1px 2px);
}

/* 空状态柱 */
.bg-muted-foreground\/10 {
  background-color: rgba(127, 127, 127, 0.1);
}
.bg-muted-foreground\/15 {
  background-color: rgba(127, 127, 127, 0.15);
}
</style>
