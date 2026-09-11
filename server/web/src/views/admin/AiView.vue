<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import type { AiConfig, AiStatus, AiReport } from '../../services/types';
import Loading from '../../components/ui/Loading.vue';
import ErrorMessage from '../../components/ui/ErrorMessage.vue';
import FormInput from '../../components/ui/FormInput.vue';

const config = ref<Partial<AiConfig>>({});
const status = ref<AiStatus | null>(null);
const reports = ref<AiReport[]>([]);
const reportTotal = ref(0);
const offset = ref(0);
const limit = 20;
const loading = ref(true);
const saving = ref(false);
const running = ref(false);
const message = ref('');
const error = ref('');

// 手动触发是【异步任务】：后端立即返回（202），这里轮询 running 直至结束。
// 上限 360s（单次 LLM 超时 180s + 全量统计 + 投递）；超时不报「失败」——任务可能仍在跑。
const POLL_MS = 3000;
const POLL_MAX = 120;
let pollTimer: number | null = null;
let pollCount = 0;

function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  pollCount = 0;
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    pollCount += 1;
    try {
      const s = await adminApi.aiStatus();
      status.value = s;
      if (!s.running) {
        stopPolling();
        running.value = false;
        await load();
        message.value = s.last_status === 'degraded' ? t('ai.runDegraded') : t('ai.runDone');
        return;
      }
    } catch {
      // 轮询偶发失败（网络抖动）不中断，等下一轮
    }
    if (pollCount >= POLL_MAX) {
      stopPolling();
      running.value = false;
      message.value = t('ai.runTimeout');
      await load();
    }
  }, POLL_MS);
}

onMounted(async () => {
  await load();
});

// 离开页面时清掉轮询定时器，避免组件卸载后继续打接口
onUnmounted(stopPolling);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [c, s, r] = await Promise.all([
      adminApi.aiConfig(),
      adminApi.aiStatus(),
      adminApi.aiReports(limit, offset.value)
    ]);
    config.value = { ...c.config };
    status.value = s;
    reports.value = r.list;
    reportTotal.value = r.total;
  } catch (e) {
    error.value = (e as Error).message || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  message.value = '';
  error.value = '';
  try {
    await adminApi.saveAiConfig(config.value);
    message.value = t('ai.saved');
    await load();
  } catch (e) {
    error.value = (e as Error).message || t('ai.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function run(force = false) {
  running.value = true;
  message.value = '';
  error.value = '';
  try {
    await adminApi.runAi({ force });
    message.value = t('ai.runTriggered');
    startPolling();
  } catch (e) {
    // 未被受理（400 未启用 / 409 执行中 / 429 冷却）：立即恢复按钮并给出可读原因。
    // 冷却秒数由后端 retry_after_s 提供，前端按当前语言渲染，避免后端硬编码语言。
    const err = e as Error & { detail?: string; body?: { status?: string; retry_after_s?: number } | null };
    if (err.body?.status === 'cooldown' && err.body.retry_after_s) {
      error.value = t('ai.cooldown', { s: err.body.retry_after_s });
    } else {
      error.value = err.detail || err.message || t('ai.runFailed');
    }
    running.value = false;
  }
}

function formatTime(ts?: number) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN');
}

function formatDuration(ms?: number) {
  if (!ms) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// ---- 报告详情（后端 /api/ai/reports/:id 已返回解析好的 report_json_parsed）----
// 老报告可能缺 highlights / 是 _parse_error 形态 / 没有 usage 字段，全部按可选渲染。
const detail = ref<AiReport | null>(null);
const detailLoading = ref(false);
const detailHighlights = ref<Array<Record<string, string>>>([]);
const detailSummary = ref('');
const detailDegradeReason = ref('');
const detailRaw = ref('');
const detailRiskRaw = ref('');
const showAllHighlights = ref(false);
const HIGHLIGHT_PREVIEW = 10;

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
  } catch (e) {
    error.value = (e as Error).message || t('common.error');
  } finally {
    detailLoading.value = false;
  }
}

function shownHighlights() {
  return showAllHighlights.value ? detailHighlights.value : detailHighlights.value.slice(0, HIGHLIGHT_PREVIEW);
}

function closeDetail() {
  detail.value = null;
  detailHighlights.value = [];
  detailSummary.value = '';
  detailDegradeReason.value = '';
  detailRaw.value = '';
}

function changePage(delta: number) {
  const next = offset.value + delta * limit;
  if (next < 0 || next >= reportTotal.value) return;
  offset.value = next;
  load();
}
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">{{ t('ai.title') }}</h1>
    <div v-if="message" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{{ message }}</div>
    <ErrorMessage v-if="error" :message="error" />
    <Loading v-if="loading" />
    <div v-else class="grid gap-6 lg:grid-cols-2">
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('ai.config') }}</h2>
        <div class="space-y-4">
          <label class="flex items-center gap-2">
            <input v-model="config.enabled" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500" />
            <span>{{ t('ai.enabled') }}</span>
          </label>
          <FormInput v-model="config.provider" :label="t('ai.provider')" placeholder="openai" />
          <FormInput v-model="config.base_url" label="Base URL" placeholder="https://api.openai.com/v1" />
          <FormInput v-model="config.model" :label="t('ai.model')" placeholder="gpt-4o-mini" />
          <FormInput v-model="config.api_key" :label="t('ai.apiKey')" type="password" :placeholder="config.has_key ? t('ai.apiKeyPlaceholder') : t('ai.apiKeyInput')" />
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="mb-1 block text-sm text-slate-400">{{ t('ai.scheduleFreq') }}</label>
              <select v-model="config.schedule_freq" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
                <option value="daily">{{ t('ai.daily') }}</option>
                <option value="weekly">{{ t('ai.weekly') }}</option>
              </select>
            </div>
            <FormInput v-model="config.schedule_time" :label="t('ai.scheduleTime')" placeholder="09:00" />
          </div>
          <FormInput v-model.number="config.tz_offset_hours" :label="t('ai.tzOffset')" placeholder="8" />
          <FormInput v-model.number="config.silent_days" :label="t('ai.silentDays')" placeholder="3" />
          <div class="flex flex-wrap gap-3 pt-2">
            <button :disabled="saving" @click="save" class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">{{ t('ai.saveConfig') }}</button>
            <button :disabled="running || status?.running" @click="run(false)" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{{ (running || status?.running) ? t('ai.running') : t('ai.run') }}</button>
            <button :disabled="running || status?.running" @click="run(true)" class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50">{{ t('ai.forceRun') }}</button>
          </div>
        </div>
      </div>

      <div class="space-y-6">
        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">{{ t('ai.status') }}</h2>
          <dl v-if="status" class="space-y-2 text-sm">
            <div class="flex justify-between"><dt class="text-slate-400">{{ t('ai.state') }}</dt><dd>{{ status.enabled ? t('ai.enabledState') : t('ai.disabledState') }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">{{ t('ai.provider') }}</dt><dd>{{ status.provider || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">{{ t('ai.model') }}</dt><dd>{{ status.model || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">{{ t('ai.schedule') }}</dt><dd>{{ status.schedule || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">{{ t('ai.lastRun') }}</dt><dd>{{ formatTime(status.last_run_ts) }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">{{ t('ai.duration') }}</dt><dd>{{ formatDuration(status.last_duration_ms) }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">{{ t('ai.lastStatus') }}</dt><dd :class="status.last_status === 'ok' ? 'text-emerald-400' : status.last_status ? 'text-rose-400' : ''">{{ status.last_status || '—' }}</dd></div>
            <div v-if="status.last_error" class="flex justify-between"><dt class="text-slate-400">{{ t('ai.error') }}</dt><dd class="max-w-xs truncate text-rose-400">{{ status.last_error }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">{{ t('ai.reportCount') }}</dt><dd>{{ status.report_count }}</dd></div>
          </dl>
        </div>

        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">{{ t('ai.reports') }}</h2>
          <div v-if="!reports.length" class="py-8 text-center text-sm text-slate-500">{{ t('ai.noReports') }}</div>
          <div v-else class="space-y-3">
            <div
              v-for="r in reports"
              :key="r.id"
              class="cursor-pointer rounded-lg border p-4 transition-colors"
              :class="detail?.id === r.id ? 'border-sky-500/60 bg-sky-500/5' : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'"
              @click="loadDetail(r.id)"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium">{{ r.period || formatTime(r.created_at) }}</span>
                <span class="text-xs" :class="r.risk_level === 'high' ? 'text-rose-400' : r.risk_level === 'medium' ? 'text-amber-400' : 'text-emerald-400'">{{ r.risk_level || 'info' }}</span>
              </div>
              <p class="mt-2 line-clamp-2 text-sm text-slate-300">{{ r.summary || t('ai.noSummary') }}</p>
              <p v-if="r.suggestion" class="mt-1 line-clamp-2 text-xs text-slate-500">{{ r.suggestion }}</p>
            </div>
            <div class="flex items-center justify-between pt-2">
              <button :disabled="offset <= 0" @click="changePage(-1)" class="rounded-lg border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800 disabled:opacity-40">{{ t('ai.prevPage') }}</button>
              <span class="text-xs text-slate-500">{{ offset + 1 }} - {{ Math.min(offset + limit, reportTotal) }} / {{ reportTotal }}</span>
              <button :disabled="offset + limit >= reportTotal" @click="changePage(1)" class="rounded-lg border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800 disabled:opacity-40">{{ t('ai.nextPage') }}</button>
            </div>
          </div>
        </div>

        <div v-if="detail || detailLoading" class="glass p-6">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold">{{ t('ai.detail') }}</h2>
            <button class="text-sm text-slate-400 hover:text-slate-200" @click="closeDetail">{{ t('ai.close') }}</button>
          </div>
          <Loading v-if="detailLoading" />
          <div v-else-if="detail" class="space-y-4 text-sm">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              <span>{{ t('ai.analyzed') }}: {{ formatTime(detail.created_at) }}</span>
              <span>{{ detail.period || '24h' }} · v{{ detail.prompt_version || '—' }}</span>
              <span v-if="detail.total_tokens">{{ t('ai.tokens') }}: {{ detail.prompt_tokens || 0 }} / {{ detail.completion_tokens || 0 }} / {{ detail.total_tokens }}</span>
              <span v-if="detail.duration_ms">{{ t('ai.duration') }}: {{ formatDuration(detail.duration_ms) }}</span>
              <span v-if="detailRiskRaw && detailRiskRaw !== detail.risk_level" class="text-amber-300">{{ t('ai.riskRaw') }}: {{ detailRiskRaw }} → {{ detail.risk_level }}（{{ t('ai.riskClamped') }}）</span>
              <span v-if="detail.degraded" class="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300">{{ t('ai.degraded') }}</span>
            </div>
            <p v-if="detailSummary" class="whitespace-pre-wrap text-slate-200">{{ detailSummary }}</p>
            <p v-if="detailDegradeReason" class="whitespace-pre-wrap text-amber-300">{{ t('ai.degradeReason') }}: {{ detailDegradeReason }}</p>
            <table v-if="detailHighlights.length" class="w-full table-fixed border-collapse text-left text-xs">
              <thead class="text-slate-400">
                <tr>
                  <th class="w-1/4 border-b border-slate-800 py-2 pr-2">{{ t('ai.node') }}</th>
                  <th class="w-1/4 border-b border-slate-800 py-2 pr-2">{{ t('ai.issue') }}</th>
                  <th class="w-1/4 border-b border-slate-800 py-2 pr-2">{{ t('ai.reason') }}</th>
                  <th class="w-1/4 border-b border-slate-800 py-2">{{ t('ai.suggestion') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(h, i) in shownHighlights()" :key="i" class="align-top">
                  <td class="border-b border-slate-900 py-2 pr-2 text-slate-300">{{ h.agent_name }}</td>
                  <td class="border-b border-slate-900 py-2 pr-2 text-slate-300">{{ h.issue }}</td>
                  <td class="border-b border-slate-900 py-2 pr-2 text-slate-500">{{ h.reason }}</td>
                  <td class="border-b border-slate-900 py-2 text-slate-500">{{ h.suggestion }}</td>
                </tr>
              </tbody>
            </table>
            <button
              v-if="!showAllHighlights && detailHighlights.length > 10"
              class="rounded-lg border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800"
              @click="showAllHighlights = true"
            >{{ t('ai.showAll') }} ({{ detailHighlights.length }})</button>
            <details v-if="detailRaw" class="text-xs text-slate-500">
              <summary class="cursor-pointer">{{ t('ai.rawResponse') }}</summary>
              <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-3">{{ detailRaw }}</pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>