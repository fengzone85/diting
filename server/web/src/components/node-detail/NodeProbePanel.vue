<script setup lang="ts">
// 网络质量：延迟范围切换 + 探测目标精简卡（hover 展开完整统计）+ 多目标延迟图。
import { computed } from 'vue';
import ChartLatencyMulti from '../ChartLatencyMulti.vue';
import { t } from '../../composables/useI18n';
import { RANGES } from '../../composables/useNodeDetail';
import { formatNumber } from '../../utils/format';
import type { ProbeAvailability, Probes, ProbePoint, ChartPoint } from '../../services/types';

const props = defineProps<{
  probes: Probes;
  availability: Record<string, ProbeAvailability>;
  range: string;
}>();

defineEmits<{
  (e: 'switch-range', range: string): void;
  (e: 'open-custom'): void;
}>();

function avgProbe(points: ProbePoint[]) {
  if (!points || !points.length) return null;
  // 三态：无采样（ok=null）不计入均值
  const ok = points.filter(p => p.ok === true && p.ms != null);
  if (!ok.length) return null;
  return ok.reduce((s, p) => s + (p.ms as number), 0) / ok.length;
}

function lossPercent(points: ProbePoint[]) {
  // 分母只算有采样条目；无采样既不是成功也不是失败，不能把丢包率抬到 100%
  const sampled = (points || []).filter(p => p.loss != null);
  if (!sampled.length) return 0;
  return sampled.filter(p => p.ok === false).length / sampled.length * 100;
}

function p95Probe(points: ProbePoint[]) {
  const ok = (points || []).filter(p => p.ok === true && p.ms != null).map(p => p.ms as number).sort((a, b) => a - b);
  if (!ok.length) return null;
  const idx = Math.min(ok.length - 1, Math.ceil(ok.length * 0.95) - 1);
  return ok[Math.max(0, idx)];
}

// ---- F4：可用率 / 证书倒计时 ----------------------------------------------
// 可用率文案：全失败显示「不可达」而非 0%——运营商 DNS 等目标对 TCP 全拒，
// 显示 0% 会被误读成探测链路故障。
function probeUpLabel(target: string): string {
  const av = props.availability[target];
  if (!av) return '—';
  if (av.unreachable) return t('node.probeUnreachable');
  return av.up_pct == null ? '—' : `${av.up_pct.toFixed(1)}%`;
}

// 详情浮层是固定深底：颜色一律返回内联色值，不用 Tailwind 语义色类
//（亮色主题会改写这些类，在深底上可能变得看不清）。
function probeUpColor(target: string): string {
  const av = props.availability[target];
  if (!av || av.unreachable) return '#fca5a5';
  const pct = av.up_pct ?? 0;
  if (pct >= 99) return '#6ee7b7';
  if (pct >= 95) return '#fbbf24';
  return '#fca5a5';
}

// 证书剩余天数 = 上报时刻的 cert_days − 距上报经过的天数。
// 必须做这个衰减：快照可能几天没更新（节点离线/历史停写），直接展示 cert_days
// 会让倒计时停在过去。
function probeCertLeft(target: string): number | null {
  const av = props.availability[target];
  if (!av || av.cert_days == null) return null;
  const age = av.cert_ts ? Math.max(0, Math.floor((Date.now() - av.cert_ts) / 86400000)) : 0;
  return Math.max(0, av.cert_days - age);
}

function probeCertColor(target: string): string {
  const left = probeCertLeft(target);
  if (left == null) return '#cbd5e1';
  if (left <= 14) return '#fca5a5';
  if (left <= 30) return '#fbbf24';
  return '#6ee7b7';
}

// 探测三态（master 的 V1.2 改造）：ok 可为 null（解析超时 = 无采样），ms 同理
function probeSeries(points: ProbePoint[]): ChartPoint[] {
  if (!points) return [];
  return points
    .filter(p => p.ok === true && p.ms != null)
    .map(p => ({ t: p.ts, v: p.ms as number })) // metrics.ts 已是毫秒，勿再 *1000
    .sort((a, b) => a.t - b.t);
}

const PALETTE = ['#f472b6', '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'];

const probeSeriesList = computed(() =>
  Object.entries(props.probes).map(([target, points], i) => ({
    name: target,
    color: PALETTE[i % PALETTE.length],
    data: probeSeries(points),
  }))
);
</script>

<template>
  <div class="glass p-4">
    <h3 class="mb-3 text-lg font-semibold">{{ t('node.netQuality') }}</h3>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <button
        v-for="r in RANGES"
        :key="r"
        type="button"
        @click="$emit('switch-range', r)"
        class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"
        :class="{ 'is-active': range === r }"
      >{{ t('node.range.' + r) }}</button>
      <button
        type="button"
        @click="$emit('open-custom')"
        class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"
        :class="{ 'is-active': range === 'custom' }"
      >{{ t('node.range.custom') }}</button>
    </div>
    <!-- 探测目标横排精简卡：只保留「名称 + 平均延迟」，hover / 键盘聚焦展开完整统计 -->
    <div class="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div
        v-for="(points, target, i) in probes"
        :key="`stat-${target}`"
        class="probe-chip relative cursor-default rounded-lg bg-surface px-2.5 py-1.5 text-xs"
        tabindex="0"
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="inline-block h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: PALETTE[i % PALETTE.length] }"></span>
          <span class="truncate" :style="{ color: PALETTE[i % PALETTE.length] }">{{ target }}</span>
          <span class="ml-auto shrink-0 font-medium tabular-nums" :class="avgProbe(points) != null ? 'text-emerald-400' : 'text-rose-400'">
            {{ avgProbe(points) != null ? `${avgProbe(points)?.toFixed(1)} ms` : t('card.timeout') }}
          </span>
        </div>
        <!-- 固定深底浮层：亮色主题会覆盖 text-white 类，故颜色一律内联写死 -->
        <div
          class="probe-tip pointer-events-none absolute top-full z-30 mt-1 w-52 rounded-lg p-2.5 opacity-0 shadow-xl transition-opacity"
          :class="i >= 2 ? 'right-0' : 'left-0'"
          style="background: rgba(15, 23, 42, 0.96); color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.28);"
        >
          <div class="mb-1.5 flex items-center gap-1.5 border-b border-slate-600/50 pb-1.5">
            <span class="inline-block h-2 w-2 rounded-full" :style="{ backgroundColor: PALETTE[i % PALETTE.length] }"></span>
            <span class="font-medium" style="color: #f8fafc;">{{ target }}</span>
          </div>
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span style="color: #94a3b8;">{{ t('node.probeAvg') }}</span>
            <span class="text-right" style="color: #6ee7b7;">{{ avgProbe(points) != null ? `${avgProbe(points)?.toFixed(1)} ms` : '—' }}</span>
            <span style="color: #94a3b8;">{{ t('node.probeP95') }}</span>
            <span class="text-right" style="color: #7dd3fc;">{{ p95Probe(points) != null ? `${p95Probe(points)?.toFixed(1)} ms` : '—' }}</span>
            <span style="color: #94a3b8;">{{ t('node.lossRate') }}</span>
            <span class="text-right" style="color: #f8fafc;">{{ formatNumber(lossPercent(points), 1) }}%</span>
            <!-- F4：窗口可用率；全失败显示「不可达」而不是 0% -->
            <!-- P0-3：悬停显示统计基础（采样点数），标明该值按窗口内采样聚合 -->
            <span style="color: #94a3b8;" :title="availability[target]?.samples != null ? t('node.availabilitySamples', { n: availability[target].samples }) : undefined">{{ t('node.availability') }}</span>
            <span class="text-right" :style="{ color: probeUpColor(target) }" :title="availability[target]?.samples != null ? t('node.availabilitySamples', { n: availability[target].samples }) : undefined">{{ probeUpLabel(target) }}</span>
            <!-- F4：证书倒计时（仅 https 目标有 cert_days） -->
            <template v-if="probeCertLeft(target) != null">
              <span style="color: #94a3b8;">{{ t('node.cert') }}</span>
              <span class="text-right" :style="{ color: probeCertColor(target) }">
                {{ probeCertLeft(target) === 0 ? t('node.certExpired') : t('node.certDays', { days: probeCertLeft(target) ?? 0 }) }}
              </span>
            </template>
            <template v-else-if="availability[target]?.type === 'http'">
              <span style="color: #94a3b8;">HTTP</span>
              <span class="text-right" style="color: #7dd3fc;">{{ availability[target]?.code ?? '—' }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>
    <ChartLatencyMulti :title="t('node.chart.latency')" :series="probeSeriesList" />
  </div>
</template>
