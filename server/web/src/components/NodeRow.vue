<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Agent } from '../services/types';
import { formatDuration, formatBitsPerSecond, formatBytes } from '../utils/format';
import { providerAlias, customTag } from '../composables/useApp';

const props = defineProps<{ agent: Agent }>();
const cpu = computed(() => props.agent.cpu ?? props.agent.cpu_percent ?? 0);
const memPct = computed(() => props.agent.mem_pct ?? 0);
const merchantName = computed(() => providerAlias(props.agent.id, props.agent.merchant));
const tag = computed(() => customTag(props.agent.id));

// OS 字段 -> 图标 key（diting 原生 public/os-<key>.svg，如 "Debian GNU/Linux 13" -> debian）
function normalizeOs(os?: string): string {
  if (!os) return '';
  const s = os.toLowerCase();
  if (s.includes('debian')) return 'debian';
  if (s.includes('ubuntu')) return 'ubuntu';
  if (s.includes('centos')) return 'centos';
  if (s.includes('almalinux') || s.includes('alma')) return 'alma';
  if (s.includes('rocky')) return 'rocky';
  if (s.includes('alpine')) return 'alpine';
  if (s.includes('arch')) return 'arch';
  if (s.includes('fedora')) return 'fedora';
  if (s.includes('freebsd')) return 'freebsd';
  if (s.includes('macos') || s.includes('darwin')) return 'macos';
  if (s.includes('windows')) return 'windows';
  if (s.includes('linux')) return 'linux';
  return '';
}
const osIcon = computed(() => {
  const key = normalizeOs(props.agent.os);
  return key ? `/os-${key}.svg` : '';
});

// 多物理硬盘聚合：所有盘求和，pct 加权；无 disks 时回退单盘
const diskAgg = computed(() => {
  const a = props.agent;
  const list = Array.isArray(a.disks) ? a.disks : [];
  if (list.length === 0) return { used: a.disk_used || 0, total: a.disk_total || 0, pct: a.disk_pct || 0 };
  let used = 0, total = 0;
  for (const d of list) { used += Number(d.used) || 0; total += Number(d.total) || 0; }
  return { used, total, pct: total > 0 ? (used / total) * 100 : 0 };
});

// 探针解析（延迟/丢包柱状图，复用 NodeCardSimple 逻辑）
const BAR_COUNT = 20;
function parseProbes(): Record<string, { ts?: number; ms?: number; ok?: boolean; loss?: number }> {
  const p = props.agent.probes;
  if (!p) return {};
  if (typeof p === 'string') {
    try { return JSON.parse(p); } catch { return {}; }
  }
  return (p as Record<string, { ts?: number; ms?: number; ok?: boolean; loss?: number }>) || {};
}
function latencyColorClass(ms: number): string {
  if (ms <= 60) return 'bg-signal-1';
  if (ms <= 100) return 'bg-signal-2';
  if (ms <= 160) return 'bg-signal-3 ping-signal-pattern-2';
  if (ms <= 200) return 'bg-signal-4 ping-signal-pattern-3';
  return 'bg-signal-5 ping-signal-pattern-4';
}
function lossColorClass(loss: number): string {
  if (loss <= 1) return 'bg-signal-1';
  if (loss <= 3) return 'bg-signal-2';
  if (loss <= 6) return 'bg-signal-3 ping-signal-pattern-2';
  if (loss <= 9) return 'bg-signal-4 ping-signal-pattern-3';
  return 'bg-signal-5 ping-signal-pattern-4';
}
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

// 延迟迷你柱（对齐 Komari NodePingListCell：grid h-1 即 4px）
const latencyBars = computed(() => {
  const probes = parseProbes();
  const entries = Object.entries(probes);
  if (entries.length === 0) {
    return Array.from({ length: BAR_COUNT }, (_, i) => ({ key: `empty-${i}`, className: 'bg-muted-foreground/10', tooltip: '' }));
  }
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const [target, v] = entries[i % entries.length];
    const ms = v.ms ?? 0;
    const ok = v.ok !== false;
    return { key: `${target}-${i}`, className: !ok ? 'bg-signal-5' : latencyColorClass(ms), tooltip: `${target}: ${ok ? ms.toFixed(0) + 'ms' : 'timeout'}` };
  });
});
const lossBars = computed(() => {
  const probes = parseProbes();
  const entries = Object.entries(probes);
  if (entries.length === 0) {
    return Array.from({ length: BAR_COUNT }, (_, i) => ({ key: `empty-${i}`, className: 'bg-muted-foreground/10', tooltip: '' }));
  }
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const [target, v] = entries[i % entries.length];
    const loss = v.loss ?? 0;
    const ok = v.ok !== false;
    return { key: `${target}-${i}`, className: !ok ? 'bg-signal-5 ping-signal-pattern-4' : lossColorClass(loss), tooltip: `${target}: ${ok ? loss.toFixed(1) + '%' : 'timeout'}` };
  });
});

const avgLatency = computed(() => {
  const probes = parseProbes();
  const entries = Object.entries(probes).filter(([, v]) => v.ok !== false && v.ms != null);
  if (entries.length === 0) return '—';
  return (entries.reduce((s, [, v]) => s + (v.ms || 0), 0) / entries.length).toFixed(0) + 'ms';
});
const avgLoss = computed(() => {
  const probes = parseProbes();
  const entries = Object.entries(probes);
  if (entries.length === 0) return '0%';
  const failed = entries.filter(([, v]) => v.ok === false).length;
  return ((failed / entries.length) * 100).toFixed(1) + '%';
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

// 列定义 - 对齐 Komari NodeList grid-template-columns
const columns = '40px 44px minmax(180px,0.85fr) minmax(240px,1.1fr) 116px 100px 100px 100px 104px 88px';
</script>

<template>
  <RouterLink
    :to="`/node/${agent.id}`"
    class="block"
  >
    <div
      class="grid items-center gap-2 px-2.5 py-2 rounded-lg bg-background/40 backdrop-blur-sm shadow-[0_0_0_2px] shadow-transparent hover:shadow-slate-500/10 hover:bg-background/70 transition-all"
      :style="{ gridTemplateColumns: columns, minHeight: '64px' }"
      :class="[!agent.online && 'shadow-red-600/10']"
    >
      <!-- 状态 -->
      <div class="flex justify-center">
        <span class="size-2 rounded-full relative" :style="{ background: agent.online ? 'var(--success)' : 'var(--danger)' }">
          <span class="animate-ping absolute inset-0 rounded-full opacity-50" :style="{ background: agent.online ? 'var(--success)' : 'var(--danger)' }"></span>
        </span>
      </div>

      <!-- 系统 -->
      <div class="flex justify-center">
        <img v-if="osIcon" :src="osIcon" :alt="agent.os" class="h-4.5 w-auto" onerror="this.style.display='none'" />
      </div>

      <!-- 节点名 -->
      <div class="flex items-center gap-2 min-w-0" :class="[!agent.online && 'opacity-30 blur-sm']">
        <span v-if="agent.country" class="size-5 rounded-sm shrink-0 overflow-hidden">
          <img :src="`/flags/${(agent.country || '').toLowerCase()}.svg`" class="h-full w-full object-cover" :alt="agent.country" onerror="this.style.visibility='hidden'" />
        </span>
        <span class="text-[13px] font-semibold text-foreground truncate">{{ agent.name }}</span>
        <span v-if="merchantName" class="text-[11px] font-medium text-foreground/60 truncate shrink-0">{{ merchantName }}</span>
        <span v-if="tag" class="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] text-sky-300 shrink-0">{{ tag }}</span>
      </div>

      <!-- 信息：uptime + 群组/系统副标题 -->
      <div class="flex flex-col gap-0.5 min-w-0">
        <div class="text-[11px] font-medium text-foreground/70 truncate">{{ formatDuration(agent.uptime) }}</div>
        <div class="text-[11px] font-medium text-foreground/60 truncate">
          {{ agent.group || agent.grp || '' }}{{ (agent.group || agent.grp) && agent.hostname ? ' · ' : '' }}{{ agent.hostname || agent.os || '' }}
        </div>
      </div>

      <!-- CPU -->
      <div class="group min-w-0">
        <div class="space-y-1">
          <div class="text-[11px] font-medium text-foreground/75 truncate">
            <span class="inline group-hover:hidden">{{ cpu.toFixed(1) }}%</span>
            <span class="hidden group-hover:inline">{{ (agent.load1 ?? 0).toFixed(2) }}, {{ (agent.load5 ?? 0).toFixed(2) }}, {{ (agent.load15 ?? 0).toFixed(2) }}</span>
          </div>
          <div class="relative w-full overflow-hidden rounded-full" style="height: 4px; background: var(--bg-surface);">
            <div class="h-full rounded-full transition-[width] duration-300 ease-out" :style="{ width: `${Math.min(cpu, 100)}%`, background: barBg(barStatus(cpu)) }"></div>
          </div>
        </div>
      </div>

      <!-- 内存 -->
      <div class="group min-w-0">
        <div class="space-y-1">
          <div class="text-[11px] font-medium text-foreground/75 truncate">
            <span class="inline group-hover:hidden">{{ memPct.toFixed(1) }}%</span>
            <span class="hidden group-hover:inline">{{ formatBytes(agent.mem_used || 0) }} / {{ formatBytes(agent.mem_total || 0) }}</span>
          </div>
          <div class="relative w-full overflow-hidden rounded-full" style="height: 4px; background: var(--bg-surface);">
            <div class="h-full rounded-full transition-[width] duration-300 ease-out" :style="{ width: `${Math.min(memPct, 100)}%`, background: barBg(barStatus(memPct)) }"></div>
          </div>
        </div>
      </div>

      <!-- 硬盘 -->
      <div class="group min-w-0">
        <div class="space-y-1">
          <div class="text-[11px] font-medium text-foreground/75 truncate">
            <span class="inline group-hover:hidden">{{ diskAgg.pct.toFixed(1) }}%</span>
            <span class="hidden group-hover:inline">{{ formatBytes(diskAgg.used) }} / {{ formatBytes(diskAgg.total) }}</span>
          </div>
          <div class="relative w-full overflow-hidden rounded-full" style="height: 4px; background: var(--bg-surface);">
            <div class="h-full rounded-full transition-[width] duration-300 ease-out" :style="{ width: `${Math.min(diskAgg.pct, 100)}%`, background: barBg(barStatus(diskAgg.pct)) }"></div>
          </div>
        </div>
      </div>

      <!-- 流量 -->
      <div class="group min-w-0" :title="`↑ ${formatBytes(trafficUsed.used)} ↓ ${formatBytes(trafficUsed.used)}`">
        <div class="space-y-1 w-full">
          <div class="text-[11px] font-medium text-foreground/75 truncate">
            <span class="inline group-hover:hidden">{{ trafficPct > 0 ? trafficPct.toFixed(1) + '%' : '∞' }}</span>
            <span class="hidden group-hover:inline">{{ formatBytes(trafficUsed.used) }}<span v-if="trafficUsed.limit"> / {{ formatBytes(trafficUsed.limit) }}</span></span>
          </div>
          <div class="relative w-full overflow-hidden rounded-full" style="height: 4px; background: var(--bg-surface);">
            <div v-if="trafficPct > 0" class="h-full rounded-full transition-[width] duration-300 ease-out" :style="{ width: `${trafficPct}%`, background: barBg(barStatus(trafficPct)) }"></div>
          </div>
        </div>
      </div>

      <!-- 速率 + 延迟/丢包迷你柱 -->
      <div class="flex flex-col gap-1 min-w-0">
        <div class="text-[11px] font-medium flex flex-col">
          <span class="text-success flex flex-row gap-1 items-center truncate">
            ↓ {{ formatBitsPerSecond(agent.net_rx_rate) }}
          </span>
          <span class="text-blue-600 dark:text-blue-400 flex flex-row gap-1 items-center truncate">
            ↑ {{ formatBitsPerSecond(agent.net_tx_rate) }}
          </span>
        </div>
        <!-- 延迟/丢包迷你柱（对齐 Komari NodePingListCell grid h-1） -->
        <div class="flex items-center gap-1 opacity-80 hover:opacity-100">
          <div class="grid h-1 cursor-auto items-end gap-[1px] transition-all hover:h-2.5 flex-1" :title="`延迟 ${avgLatency}`" :style="{ gridTemplateColumns: `repeat(${latencyBars.length}, minmax(0, 1fr))` }">
            <span v-for="bar in latencyBars" :key="bar.key" :title="bar.tooltip" class="h-full w-full">
              <span :class="['block h-full w-full rounded-[1px] transition-all group-hover:opacity-50 hover:scale-y-160 hover:opacity-100', bar.className]"></span>
            </span>
          </div>
          <div class="grid h-1 cursor-auto items-end gap-[1px] transition-all hover:h-2.5 flex-1" :title="`丢包 ${avgLoss}`" :style="{ gridTemplateColumns: `repeat(${lossBars.length}, minmax(0, 1fr))` }">
            <span v-for="bar in lossBars" :key="bar.key" :title="bar.tooltip" class="h-full w-full">
              <span :class="['block h-full w-full rounded-[1px] transition-all group-hover:opacity-50 hover:scale-y-160 hover:opacity-100', bar.className]"></span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
/* 信号颜色 - 对齐 Komari（与 NodeCardSimple 一致） */
.node-card-simple,
:deep(.bg-signal-1) { background-color: var(--signal-1, #059669); }
:deep(.bg-signal-2) { background-color: var(--signal-2, #4ade80); }
:deep(.bg-signal-3) { background-color: var(--signal-3, #a3e635); }
:deep(.bg-signal-4) { background-color: var(--signal-4, #facc15); }
:deep(.bg-signal-5) { background-color: var(--signal-5, #f43f5e); }

:deep(.ping-signal-pattern-2) {
  background-image: repeating-linear-gradient(135deg, transparent 0 2px, rgba(255,255,255,0.45) 2px 3px);
}
:deep(.ping-signal-pattern-3) {
  background-image: repeating-linear-gradient(90deg, transparent 0 2px, rgba(0,0,0,0.28) 2px 3px);
}
:deep(.ping-signal-pattern-4) {
  background-image: repeating-linear-gradient(45deg, transparent 0 1px, rgba(255,255,255,0.58) 1px 2px);
}
:deep(.bg-muted-foreground\/10) {
  background-color: rgba(127, 127, 127, 0.1);
}
</style>
