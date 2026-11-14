<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import type { AiReport } from '../../services/types';
import Loading from '../ui/Loading.vue';

// 历史报告改为「月历 + 弹层详情」：长列表折叠为按日聚合的日历，
// 点有报告的日期 → 弹层列出当日报告 → 点单条 → 完整详情（复用原详情渲染）。
const props = defineProps<{ version: number }>();

const LIMIT = 100;
const MAX_PAGES = 20;
const loaded = ref<AiReport[]>([]);
const total = ref(0);
const busy = ref(false);
const now = new Date();
const viewY = ref(now.getFullYear());
const viewM = ref(now.getMonth());

const detail = ref<AiReport | null>(null);
const detailLoading = ref(false);
const dialogDay = ref<string | null>(null);
const detailHighlights = ref<Array<Record<string, string>>>([]);
const detailSummary = ref('');
const detailDegradeReason = ref('');
const detailRaw = ref('');
const detailRiskRaw = ref('');
const showAllHighlights = ref(false);
const HIGHLIGHT_PREVIEW = 10;

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 列表按 created_at 倒序分页；为覆盖目标月，向后翻页直到最旧一条 <= 月初。
// generation 防并发：挂载加载与 version 变化刷新可能重叠，旧请求返回后不得再追加。
let generation = 0;
async function ensureMonth(y: number, m: number) {
  const gen = ++generation;
  busy.value = true;
  try {
    const monthStart = new Date(y, m, 1).getTime();
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      if (loaded.value.length && loaded.value.length >= total.value) break;
      const oldest = loaded.value.length ? loaded.value[loaded.value.length - 1].created_at : Infinity;
      if (loaded.value.length && oldest <= monthStart) break;
      const r = await adminApi.aiReports(LIMIT, loaded.value.length);
      if (gen !== generation) return;
      total.value = r.total;
      if (!r.list.length) break;
      loaded.value = loaded.value.concat(r.list);
    }
  } finally {
    if (gen === generation) busy.value = false;
  }
}

async function changeMonth(delta: number) {
  const d = new Date(viewY.value, viewM.value + delta, 1);
  viewY.value = d.getFullYear();
  viewM.value = d.getMonth();
  await ensureMonth(viewY.value, viewM.value);
}

async function goToday() {
  const d = new Date();
  viewY.value = d.getFullYear();
  viewM.value = d.getMonth();
  await ensureMonth(viewY.value, viewM.value);
}

const byDay = computed(() => {
  const map = new Map<string, AiReport[]>();
  for (const r of loaded.value) {
    const k = dayKey(r.created_at);
    const arr = map.get(k) || [];
    arr.push(r);
    map.set(k, arr);
  }
  return map;
});

const RISK_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
function maxRisk(list: AiReport[]) {
  let best = '';
  let rank = -1;
  for (const r of list) {
    const k = r.risk_level || 'info';
    const v = RISK_RANK[k] ?? 0;
    if (v > rank) { rank = v; best = k; }
  }
  return best || 'info';
}
function riskDot(k: string) {
  // 用 -500 系：浅色主题把 -400 系背景覆盖成淡色芯片底，圆点会看不见
  return k === 'high' ? 'bg-rose-500' : k === 'medium' ? 'bg-amber-500' : 'bg-emerald-500';
}
function riskText(k: string) {
  return k === 'high' ? 'text-rose-400' : k === 'medium' ? 'text-amber-400' : 'text-emerald-400';
}

interface Cell { key: string; day: number; inMonth: boolean; isToday: boolean; reports: AiReport[]; risk: string }
const cells = computed<Cell[]>(() => {
  const first = new Date(viewY.value, viewM.value, 1);
  const lead = (first.getDay() + 6) % 7; // 周一开头
  const start = new Date(viewY.value, viewM.value, 1 - lead);
  const todayK = dayKey(Date.now());
  const out: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const k = dayKey(d.getTime());
    const reports = byDay.value.get(k) || [];
    out.push({ key: k, day: d.getDate(), inMonth: d.getMonth() === viewM.value, isToday: k === todayK, reports, risk: maxRisk(reports) });
  }
  return out;
});

const monthLabel = computed(() => `${viewY.value}-${String(viewM.value + 1).padStart(2, '0')}`);
const dayReports = computed(() => (dialogDay.value ? byDay.value.get(dialogDay.value) || [] : []));

function openDay(c: Cell) {
  if (!c.reports.length) return;
  dialogDay.value = c.key;
  detail.value = null;
}
function closeDialog() {
  dialogDay.value = null;
  detail.value = null;
}
function backToDay() {
  detail.value = null;
  detailHighlights.value = [];
}

async function loadDetail(id: number) {
  detailLoading.value = true;
  showAllHighlights.value = false;
  try {
    const r = await adminApi.aiReport(id);
    const parsed = (r.report_json_parsed || {}) as Record<string, unknown>;
    const a = (parsed.analysis || {}) as Record<string, unknown>;
    detail.value = r;
    detailHighlights.value = Array.isArray(a.highlights) ? (a.highlights as Array<Record<string, string>>) : [];
    detailSummary.value = String(a.summary || r.summary || '');
    detailRiskRaw.value = String(a.risk_level_raw || '');
    detailDegradeReason.value = String(parsed.degrade_reason || '');
    detailRaw.value = String(a.raw || (a._parse_error ? (r.report_json || '') : ''));
  } finally {
    detailLoading.value = false;
  }
}
function shownHighlights() {
  return showAllHighlights.value ? detailHighlights.value : detailHighlights.value.slice(0, HIGHLIGHT_PREVIEW);
}
function formatTime(ts?: number) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN');
}
function formatDuration(ms?: number) {
  if (!ms) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

onMounted(() => ensureMonth(viewY.value, viewM.value));
// 运行完成 / 报告数变化时刷新当前月
watch(() => props.version, async () => {
  loaded.value = [];
  total.value = 0;
  await ensureMonth(viewY.value, viewM.value);
});
</script>

<template>
  <div class="glass p-6">
    <div class="mb-4 flex items-center justify-between">
      <h2 class="text-lg font-semibold">{{ t('ai.reports') }}</h2>
      <div class="flex items-center gap-1">
        <button class="btn-ghost px-2 py-1 text-sm" :aria-label="t('ai.prevMonth')" @click="changeMonth(-1)">‹</button>
        <span class="min-w-[5.5rem] text-center text-sm font-medium">{{ monthLabel }}</span>
        <button class="btn-ghost px-2 py-1 text-sm" :aria-label="t('ai.nextMonth')" @click="changeMonth(1)">›</button>
        <button class="btn-ghost ml-1 px-2 py-1 text-xs" @click="goToday">{{ t('ai.today') }}</button>
      </div>
    </div>

    <Loading v-if="busy && !loaded.length" />
    <div v-else>
      <div class="grid grid-cols-7 gap-1 text-center text-xs text-muted">
        <div v-for="w in 7" :key="w" class="py-1">{{ t('ai.wk' + w) }}</div>
      </div>
      <div class="mt-1 grid grid-cols-7 gap-1">
        <button
          v-for="c in cells"
          :key="c.key"
          class="relative flex h-14 flex-col items-center justify-center rounded-lg border text-sm transition-colors"
          :class="[
            c.inMonth ? 'border-divider' : 'border-transparent opacity-40',
            c.reports.length ? 'cursor-pointer hover-inner' : 'cursor-default',
            c.isToday ? 'ring-1 ring-sky-400' : '',
            dialogDay === c.key ? 'bg-sky-500/10' : '',
          ]"
          @click="openDay(c)"
        >
          <span :class="c.inMonth ? 'text-content' : 'text-muted'">{{ c.day }}</span>
          <span v-if="c.reports.length" class="mt-1 flex items-center gap-1">
            <span class="h-1.5 w-1.5 rounded-full" :class="riskDot(c.risk)"></span>
            <span class="text-[10px] text-muted">{{ c.reports.length }}</span>
          </span>
        </button>
      </div>
      <p v-if="!loaded.length" class="py-6 text-center text-sm text-muted">{{ t('ai.noReports') }}</p>
      <div class="mt-3 flex items-center gap-4 text-xs text-muted">
        <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>{{ t('ai.riskLow') }}</span>
        <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>{{ t('ai.riskMedium') }}</span>
        <span class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span>{{ t('ai.riskHigh') }}</span>
      </div>
    </div>

    <!-- 弹层：当日报告列表 → 单条详情 -->
    <div v-if="dialogDay" class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" @click.self="closeDialog">
      <div class="glass my-8 w-full max-w-2xl rounded-xl p-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ detail ? t('ai.detail') : dialogDay }}</h2>
          <div class="flex items-center gap-2">
            <button v-if="detail" class="btn-ghost px-3 py-1 text-sm" @click="backToDay">{{ t('ai.back') }}</button>
            <button class="btn-ghost px-3 py-1 text-sm" @click="closeDialog">{{ t('ai.close') }}</button>
          </div>
        </div>

        <Loading v-if="detailLoading" />
        <div v-else-if="detail" class="space-y-4 text-sm">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
            <span>{{ t('ai.analyzed') }}: {{ formatTime(detail.created_at) }}</span>
            <span>{{ detail.period || '24h' }} · v{{ detail.prompt_version || '—' }}</span>
            <span v-if="detail.total_tokens">{{ t('ai.tokens') }}: {{ detail.prompt_tokens || 0 }} / {{ detail.completion_tokens || 0 }} / {{ detail.total_tokens }}</span>
            <span v-if="detail.duration_ms">{{ t('ai.duration') }}: {{ formatDuration(detail.duration_ms) }}</span>
            <span v-if="detailRiskRaw && detailRiskRaw !== detail.risk_level" class="text-amber-300">{{ t('ai.riskRaw') }}: {{ detailRiskRaw }} → {{ detail.risk_level }}（{{ t('ai.riskClamped') }}）</span>
            <span v-if="detail.degraded" class="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300">{{ t('ai.degraded') }}</span>
          </div>
          <p v-if="detailSummary" class="whitespace-pre-wrap text-content">{{ detailSummary }}</p>
          <p v-if="detailDegradeReason" class="whitespace-pre-wrap text-amber-300">{{ t('ai.degradeReason') }}: {{ detailDegradeReason }}</p>
          <table v-if="detailHighlights.length" class="w-full table-fixed border-collapse text-left text-xs">
            <thead class="text-secondary">
              <tr>
                <th class="w-1/4 border-b border-divider py-2 pr-2">{{ t('ai.node') }}</th>
                <th class="w-1/4 border-b border-divider py-2 pr-2">{{ t('ai.issue') }}</th>
                <th class="w-1/4 border-b border-divider py-2 pr-2">{{ t('ai.reason') }}</th>
                <th class="w-1/4 border-b border-divider py-2">{{ t('ai.suggestion') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(h, i) in shownHighlights()" :key="i" class="align-top">
                <td class="border-b border-divider py-2 pr-2 text-secondary">{{ h.agent_name }}</td>
                <td class="border-b border-divider py-2 pr-2 text-secondary">{{ h.issue }}</td>
                <td class="border-b border-divider py-2 pr-2 text-muted">{{ h.reason }}</td>
                <td class="border-b border-divider py-2 text-muted">{{ h.suggestion }}</td>
              </tr>
            </tbody>
          </table>
          <button v-if="!showAllHighlights && detailHighlights.length > 10" class="btn-ghost px-3 py-1 text-xs" @click="showAllHighlights = true">{{ t('ai.showAll') }} ({{ detailHighlights.length }})</button>
          <details v-if="detailRaw" class="text-xs text-muted">
            <summary class="cursor-pointer">{{ t('ai.rawResponse') }}</summary>
            <pre class="inner-panel mt-2 max-h-64 overflow-auto whitespace-pre-wrap p-3">{{ detailRaw }}</pre>
          </details>
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="r in dayReports"
            :key="r.id"
            class="cursor-pointer rounded-lg border border-divider p-4 transition-colors hover-inner"
            @click="loadDetail(r.id)"
          >
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">{{ formatTime(r.created_at) }}</span>
              <span class="text-xs" :class="riskText(r.risk_level || 'info')">{{ r.risk_level || 'info' }}</span>
            </div>
            <p class="mt-2 line-clamp-2 text-sm text-secondary">{{ r.summary || t('ai.noSummary') }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>