<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from '../components/AppHeader.vue';
import Loading from '../components/ui/Loading.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorMessage from '../components/ui/ErrorMessage.vue';
import AiNodeAnalysisDialog from '../components/ai/AiNodeAnalysisDialog.vue';
import NodeDetailNav from '../components/node-detail/NodeDetailNav.vue';
import NodeBillingCards from '../components/node-detail/NodeBillingCards.vue';
import NodeHardwareCards from '../components/node-detail/NodeHardwareCards.vue';
import NodeTrendCharts from '../components/node-detail/NodeTrendCharts.vue';
import NodeOnlinePanel from '../components/node-detail/NodeOnlinePanel.vue';
import NodeProbePanel from '../components/node-detail/NodeProbePanel.vue';
import { useApp } from '../composables/useApp';
import { useNodeDetail } from '../composables/useNodeDetail';
import { t } from '../composables/useI18n';
import { formatBytes, formatDuration } from '../utils/format';

const route = useRoute();
const { state, visibleAgents } = useApp();
const agentId = computed(() => route.params.id as string);
const agent = computed(() => state.agents.find(a => a.id === agentId.value));

// AI 单节点分析（§8 T15）：按钮对访客可见，但弹窗内先探测登录态——
// 未登录只提示「需要管理员登录」并发「去登录」，不发请求（不消耗限流配额）；
// 接口本身是 adminOnly，匿名请求即便发出也会被服务端拦下（不触发模型调用、零费用）。
const showAiDialog = ref(false);

// 数据层（时序历史/轮询/延迟探测/在线时段/自定义区间）全部在 composable 内，
// 组件只负责渲染，避免巨组件与「保存即清空」类监听顺序问题。
const {
  probes, availability, online, loading, error,
  sparkRows, sparkRows30d, sparkline,
  currentRange, chartRange,
  customOpen, customStart, customEnd,
  switchChartRange, switchRange, openCustom, applyCustom,
} = useNodeDetail({ agentId, agent });

// 多物理硬盘聚合：所有盘 used/total 求和，pct 取加权平均
const diskAgg = computed(() => {
  const a = agent.value;
  if (!a) return { used: 0, total: 0, pct: 0 };
  const list = Array.isArray(a.disks) ? a.disks : [];
  let used = 0, total = 0, pct = 0;
  if (list.length > 0) {
    for (const d of list) {
      used += Number(d.used) || 0;
      total += Number(d.total) || 0;
    }
    pct = total > 0 ? (used / total) * 100 : 0;
  } else {
    used = a.disk_used || 0;
    total = a.disk_total || 0;
    pct = a.disk_pct || (total > 0 ? (used / total) * 100 : 0);
  }
  // 离线回退：agent 实时接口对离线节点不返回 disks/disk_total（实测均为 0/空数组），
  // 会导致 diskPredict 因 total=0 返回 null、磁盘卡片正文整块消失。
  // 历史时序每行都带 disk_total/disk_used，这里取最后一个有效采样点补上，
  // 使离线节点仍能显示其最后已知容量与耗尽预测。
  if (!total) {
    const src = sparkRows30d.value.length ? sparkRows30d.value : sparkRows.value;
    for (let i = src.length - 1; i >= 0; i--) {
      const r = src[i];
      if (r && Number(r.disk_total) > 0) {
        total = Number(r.disk_total) || 0;
        used = Number(r.disk_used) || 0;
        break;
      }
    }
    pct = total > 0 ? (used / total) * 100 : 0;
  }
  return { used, total, pct };
});

// 磁盘耗尽预测：基于最近 sparkline 的 disk_used 真实字节增量线性外推
// 展示层（已用/总容量/占用率）与 ETA 的剩余空间统一用 diskAgg（所有物理盘聚合），避免只统计单盘
const diskPredict = computed(() => {
  // 用固定 30d 基线（sparkRows30d）的 disk_used（B）做首末点线性外推：
  // 与图表显示范围解耦，避免切到 1h/6h 等短 range 时 ETA 剧烈抖动。
  const sl = sparkRows30d.value.length ? sparkRows30d.value : sparkline.value;
  // diskAgg 为所有物理盘聚合值（无 disks 时回退单盘），保证进度条/百分比/已用容量均为整机口径
  const agg = diskAgg.value;
  const total = agg.total;
  const used = agg.used;
  const pct = agg.pct;
  if (!total) return null;
  if (!sl || sl.length < 2) {
    return { eta: null as string | null, pct, days: null as number | null, total, used, stable: true };
  }
  const dayMs = 86400000;
  const first = sl[0], last = sl[sl.length - 1];
  const spanDays = Math.max((last.ts - first.ts) / dayMs, 0.01);
  // 历史增量取自 sparkline 单盘 disk_used 序列（metrics 仅存单盘口径），作为增速近似
  const delta = (last.disk_used ?? 0) - (first.disk_used ?? 0);
  const dailyGrowth = delta / spanDays; // 字节/天
  if (dailyGrowth <= 0) {
    return { eta: null as string | null, pct, days: null as number | null, total, used, stable: true };
  }
  // 剩余空间用整机聚合口径
  const remain = Math.max(total - used, 0);
  const days = remain / dailyGrowth;
  const eta = new Date(Date.now() + days * dayMs);
  return {
    eta: eta.toISOString().slice(0, 10),
    pct,
    days: Math.floor(days),
    total,
    used,
    stable: false,
  };
});

// 节点切换：按首页同一顺序（visibleAgents）取上一个/下一个，下拉列全部节点。
const nodeList = computed(() => (visibleAgents.value.length ? visibleAgents.value : state.agents));
const currentIndex = computed(() => nodeList.value.findIndex((a) => a.id === agentId.value));
const prevNode = computed(() => (currentIndex.value > 0 ? nodeList.value[currentIndex.value - 1] : null));
const nextNode = computed(() => (
  currentIndex.value >= 0 && currentIndex.value < nodeList.value.length - 1
    ? nodeList.value[currentIndex.value + 1]
    : null
));

function closeCustom() {
  customOpen.value = false;
}
</script>

<template>
  <div class="min-h-screen">
    <AppHeader :meta="state.meta" />
    <main class="mx-auto max-w-7xl px-6 pt-4">
      <NodeDetailNav
        :nodes="nodeList"
        :current-id="agentId"
        :prev="prevNode"
        :next="nextNode"
      />
      <ErrorMessage v-if="error" class="mb-6" :message="error" />
      <Loading v-if="loading && !agent" />
      <EmptyState v-else-if="!agent" />
      <div v-else class="space-y-6">
        <!-- 标题区（状态点 + 国旗 + 名称 + 版本） -->
        <div class="glass p-5">
          <div class="flex flex-wrap items-center gap-3">
            <img v-if="agent.country || agent.country_code" :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`" class="h-6 w-8 rounded-sm" :alt="agent.country" />
            <h1 class="text-xl font-bold lg:text-2xl">{{ agent.name }}</h1>
            <span class="status-dot" :class="agent.online ? 'status-online' : 'status-offline'" />
            <span
              class="rounded-full px-3 py-1 text-xs"
              :class="agent.online ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'"
            >{{ agent.online ? t('common.online') : t('common.offline') }}</span>
            <div class="ml-auto flex items-center gap-2">
              <span v-if="agent.version" class="rounded-full bg-surface px-3 py-1 text-xs text-secondary">v{{ agent.version }}</span>
              <button
                class="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
                @click="showAiDialog = true"
              >{{ t('ai.analyzeNode') }}</button>
            </div>
          </div>
          <p class="mt-2 text-sm text-muted">{{ agent.os }} · {{ agent.id }}</p>
        </div>

        <div class="space-y-6">
          <!-- 顶部信息条：对齐玻璃拟态节点页顶部水平指标条 -->
          <div class="flex flex-wrap gap-3">
            <div class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">
              <svg class="h-4 w-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.traffic') }}</span>
              <span class="text-sm font-semibold text-cyan-700">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) }}</span>
            </div>
            <div class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">
              <svg class="h-4 w-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.quota') }}</span>
              <span class="text-sm font-semibold text-emerald-700">{{ agent.monthly_quota_gb != null ? formatBytes(agent.monthly_quota_gb * 1024 ** 3) : '∞' }}</span>
            </div>
            <div class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">
              <svg class="h-4 w-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.uptime') }}</span>
              <span class="text-sm font-semibold text-indigo-700">{{ formatDuration(agent.uptime) }}</span>
            </div>
            <!-- 分组 / 备注：原「备注与套餐」卡取消后并入顶部指标条 -->
            <div v-if="agent.group" class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">
              <svg class="h-4 w-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              <span class="text-xs text-muted">{{ t('node.group') }}</span>
              <span class="max-w-32 truncate text-sm font-semibold text-violet-700" :title="agent.group">{{ agent.group }}</span>
            </div>
            <div v-if="agent.note" class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">
              <svg class="h-4 w-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/></svg>
              <span class="text-xs text-muted">{{ t('node.note') }}</span>
              <span class="max-w-40 truncate text-sm font-semibold text-amber-700" :title="agent.note">{{ agent.note }}</span>
            </div>
          </div>

          <!-- 顶部计费四卡 -->
          <NodeBillingCards :agent="agent" />

          <!-- 硬件 / 系统 / 存储 / 网络 -->
          <NodeHardwareCards :agent="agent" :disk-agg="diskAgg" />

          <!-- 六图时间范围切换 + CPU/内存/磁盘IO/负载/温度/swap -->
          <NodeTrendCharts
            :agent="agent"
            :rows="sparkline"
            :range="chartRange"
            :loading="loading"
            @switch-range="switchChartRange"
            @open-custom="openCustom('chart')"
          />
        </div>

        <!-- F7 在线率 + 磁盘耗尽预测 -->
        <NodeOnlinePanel :online="online" :disk-predict="diskPredict" />

        <!-- 网络质量（延迟） -->
        <NodeProbePanel
          :probes="probes"
          :availability="availability"
          :range="currentRange"
          @switch-range="switchRange"
          @open-custom="openCustom('probes')"
        />
      </div>
      <AiNodeAnalysisDialog
        v-if="showAiDialog && agent"
        :agent-id="agent.id"
        :agent-name="agent.name"
        guard-auth
        @close="showAiDialog = false"
      />

      <!-- 自定义时间范围（对齐 Glass 的自定义浮层） -->
      <div
        v-if="customOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        @click.self="closeCustom"
      >
        <div class="glass w-full max-w-md rounded-xl p-5">
          <h3 class="mb-4 text-lg font-semibold">{{ t('node.custom.title') }}</h3>
          <label class="mb-3 block text-xs text-secondary">
            {{ t('node.custom.start') }}
            <input
              v-model="customStart"
              type="datetime-local"
              class="field-control mt-1 w-full"
            />
          </label>
          <label class="mb-4 block text-xs text-secondary">
            {{ t('node.custom.end') }}
            <input
              v-model="customEnd"
              type="datetime-local"
              class="field-control mt-1 w-full"
            />
          </label>
          <div class="flex justify-end gap-2">
            <button class="rounded-lg px-3 py-1.5 text-sm text-secondary hover:text-white" @click="closeCustom">
              {{ t('common.cancel') }}
            </button>
            <button class="rounded-lg bg-sky-500 px-3 py-1.5 text-sm text-white hover:bg-sky-400" @click="applyCustom">
              {{ t('node.custom.apply') }}
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
