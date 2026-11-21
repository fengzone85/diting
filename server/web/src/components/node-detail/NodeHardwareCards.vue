<script setup lang="ts">
// 四张信息卡：硬件 / 系统 / 存储 / 网络。
import { computed } from 'vue';
import type { Component } from 'vue';
import {
  Cpu,
  Computer,
  Code,
  Timer,
  Server,
  Memory,
  Switch,
  HardDisk,
  TransferData,
  DashboardOne,
  ApplicationTwo,
  VideoOne,
} from '@icon-park/vue-next';
import { t } from '../../composables/useI18n';
import { formatBytes, formatBitsPerSecond, formatDuration, formatPercent } from '../../utils/format';
import type { Agent } from '../../services/types';

const props = defineProps<{
  agent: Agent;
  diskAgg: { used: number; total: number; pct: number };
}>();

// 硬件卡动态条目：架构/虚拟化/GPU（无字段则显示 -；不对指纹字段扩展采集）。
// 核心数已并入上方 CPU 型号行，不再单独占一项。
const hwDynamic = computed(() => {
  const a = props.agent;
  const items: { label: string; value: string; icon: Component }[] = [];
  // 核心数不再单独占一项：并入 CPU 型号行（`型号 (N vCPU)`），与玻璃拟态设计对齐。
  // 架构（管理员手填优先；未填时服务端按受控端构建平台派生）
  items.push({ label: t('node.arch'), value: a.arch || '—', icon: ApplicationTwo });
  // 虚拟化（管理员手填）
  items.push({ label: t('node.virtualization'), value: a.virtualization || '—', icon: Server });
  // GPU（仅当管理员填写时渲染；空 / 'None' = 无或不公开）
  const gpu = String(a.gpu_name || '').trim();
  if (gpu && gpu.toLowerCase() !== 'none') {
    items.push({ label: t('node.gpu'), value: gpu, icon: VideoOne });
  }
  return items;
});

// 网络卡背景进度层宽度：月流量已用 / 配额占用率
const netUsagePct = computed(() => {
  const a = props.agent;
  if (a.monthly_quota_gb == null || a.monthly_quota_gb <= 0) return 0;
  const used = (a.net_rx_month || 0) + (a.net_tx_month || 0);
  const quota = a.monthly_quota_gb * 1024 ** 3;
  return Math.min((used / quota) * 100, 100);
});
</script>

<template>
  <!-- 顶部四卡：严格对齐参考面板玻璃拟态设计节点详情页（lg 以上 2 列，不强制等高） -->
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <!-- 硬件信息：glass 毛玻璃卡 + 纵向条目 -->
    <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
      <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.hardware') }}</h3>
      <!-- CPU 型号块（对齐参考面板硬件卡顶部大块） -->
      <div class="mb-3 flex flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
        <div class="flex items-center gap-1 text-xs text-muted-foreground">
          <Cpu :size="14" />
          <span>{{ t('node.cpuModel') }}</span>
        </div>
        <span class="text-xs sm:text-sm text-content">
          {{ agent.cpu_name || t('node.unknown') }}<template v-if="(agent.cores || 0) > 0"> ({{ agent.cores }} vCPU)</template>
        </span>
      </div>
      <!-- 架构/虚拟化/GPU 三项并排；无 GPU 数据只有两项时铺满两列 -->
      <div class="grid gap-1" :class="hwDynamic.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'">
        <div v-for="item in hwDynamic" :key="item.label" class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 px-2 py-1.5">
          <span class="flex items-center gap-1 text-xs text-muted-foreground">
            <component :is="item.icon" :size="14" class="shrink-0" />
            <span class="truncate">{{ item.label }}</span>
          </span>
          <span class="truncate text-xs sm:text-sm text-content" :title="item.value">{{ item.value }}</span>
        </div>
      </div>
    </div>

    <!-- 系统信息 -->
    <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
      <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.system') }}</h3>
      <div class="grid grid-cols-2 gap-1">
        <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
          <span class="flex gap-1 items-center text-xs text-muted-foreground"><Computer :size="14" /><span>{{ t('node.os') }}</span></span>
          <span class="truncate text-xs sm:text-sm text-content">{{ agent.os || '—' }}</span>
        </div>
        <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
          <span class="flex gap-1 items-center text-xs text-muted-foreground"><Code :size="14" /><span>{{ t('node.kernel') }}</span></span>
          <span class="truncate text-xs sm:text-sm text-content">{{ agent.kernel_version || '—' }}</span>
        </div>
        <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
          <span class="flex gap-1 items-center text-xs text-muted-foreground"><Timer :size="14" /><span>{{ t('node.metric.uptime') }}</span></span>
          <span class="truncate text-xs sm:text-sm text-content">{{ formatDuration(agent.uptime) || '—' }}</span>
        </div>
        <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
          <span class="flex gap-1 items-center text-xs text-muted-foreground"><Server :size="14" /><span>{{ t('node.merchant') }}</span></span>
          <span class="truncate text-xs sm:text-sm text-content">{{ agent.merchant || '—' }}</span>
        </div>
      </div>
    </div>

    <!-- 存储信息：glass 毛玻璃卡 + 纵向紧凑条目 -->
    <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
      <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.storage') }}</h3>
      <div class="grid grid-cols-3 gap-1">
        <!-- 内存 -->
        <div class="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-sm bg-slate-500/5 p-2">
          <div
            v-if="agent.mem_pct != null && agent.mem_pct > 0"
            class="pointer-events-none absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-300 ease-out"
            :class="agent.mem_pct >= 80 ? 'bg-red-500/28' : agent.mem_pct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
            :style="{ width: Math.min(agent.mem_pct, 100) + '%' }"
          ></div>
          <span class="relative z-10 flex gap-1 items-center text-xs text-muted-foreground"><Memory :size="14" /><span>{{ t('node.storage.mem') }}</span></span>
          <span class="relative z-10 truncate text-xs sm:text-sm text-content">{{ formatBytes(agent.mem_total, 1) }} <span class="text-muted">{{ formatPercent(agent.mem_pct) }}</span></span>
        </div>
        <!-- 交换 -->
        <div class="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-sm bg-slate-500/5 p-2">
          <div
            v-if="agent.swap_pct != null && agent.swap_pct > 0"
            class="pointer-events-none absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-300 ease-out"
            :class="agent.swap_pct >= 80 ? 'bg-red-500/28' : agent.swap_pct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
            :style="{ width: Math.min(agent.swap_pct, 100) + '%' }"
          ></div>
          <span class="relative z-10 flex gap-1 items-center text-xs text-muted-foreground"><Switch :size="14" /><span>{{ t('node.storage.swap') }}</span></span>
          <span class="relative z-10 truncate text-xs sm:text-sm text-content">{{ formatPercent(agent.swap_pct) }}</span>
        </div>
        <!-- 硬盘（所有物理盘总和） -->
        <div class="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-sm bg-slate-500/5 p-2">
          <div
            v-if="diskAgg.pct > 0"
            class="pointer-events-none absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-300 ease-out"
            :class="diskAgg.pct >= 80 ? 'bg-red-500/28' : diskAgg.pct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
            :style="{ width: Math.min(diskAgg.pct, 100) + '%' }"
          ></div>
          <span class="relative z-10 flex gap-1 items-center text-xs text-muted-foreground"><HardDisk :size="14" /><span>{{ t('node.storage.disk') }}</span></span>
          <span class="relative z-10 truncate text-xs sm:text-sm text-content">{{ formatBytes(diskAgg.total, 1) }} <span class="text-muted">{{ formatPercent(diskAgg.pct) }}</span></span>
        </div>
      </div>
    </div>

    <!-- 网络信息：glass 毛玻璃卡 + 横排两块 -->
    <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
      <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.network') }}</h3>
      <div class="grid grid-cols-2 gap-1">
        <!-- 总流量块（进度条铺在本块内部背景） -->
        <div class="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-sm bg-slate-500/5 p-2">
          <div
            v-if="agent.monthly_quota_gb != null && netUsagePct > 0"
            class="pointer-events-none absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-300 ease-out"
            :class="netUsagePct >= 80 ? 'bg-red-500/28' : netUsagePct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
            :style="{ width: Math.min(netUsagePct, 100) + '%' }"
          ></div>
          <span class="relative z-10 flex gap-1 items-center text-xs text-muted-foreground"><TransferData :size="14" /><span>{{ t('node.netTotal') }}</span></span>
          <span v-if="agent.monthly_quota_gb != null" class="relative z-10 truncate text-xs sm:text-sm text-content">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0), 1) }} / {{ formatBytes(agent.monthly_quota_gb * 1024 ** 3, 1) }} <span class="text-muted">{{ formatPercent(netUsagePct) }}</span></span>
          <span v-else class="relative z-10 truncate text-xs sm:text-sm text-content">{{ t('node.unlimitedTraffic') }}</span>
        </div>
        <!-- 网络速率块 -->
        <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
          <span class="flex gap-1 items-center text-xs text-muted-foreground"><DashboardOne :size="14" /><span>{{ t('node.netRate') }}</span></span>
          <span class="truncate whitespace-nowrap text-xs sm:text-sm text-content">↑ {{ formatBitsPerSecond(agent.net_tx_rate) }} ↓ {{ formatBitsPerSecond(agent.net_rx_rate) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
