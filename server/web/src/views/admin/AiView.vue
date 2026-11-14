<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import type { AiConfig, AiStatus } from '../../services/types';
import Loading from '../../components/ui/Loading.vue';
import ErrorMessage from '../../components/ui/ErrorMessage.vue';
import FormInput from '../../components/ui/FormInput.vue';
import PageShell from '../../components/admin/PageShell.vue';
import AiReportCalendar from '../../components/admin/AiReportCalendar.vue';

const config = ref<Partial<AiConfig>>({});
const status = ref<AiStatus | null>(null);
const loading = ref(true);
const saving = ref(false);
const running = ref(false);
const message = ref('');
const error = ref('');
// 近 7 天 token 消耗（按 UTC 日聚合；加列前的老报告 token 记为 0）
const usage7d = ref<{ total_tokens: number; list: Array<{ day: string; reports: number; total_tokens: number }> } | null>(null);

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
    const [c, s, u] = await Promise.all([
      adminApi.aiConfig(),
      adminApi.aiStatus(),
      adminApi.aiUsage(7)
    ]);
    config.value = { ...c.config };
    status.value = s;
    usage7d.value = u;
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
</script>

<template>
  <PageShell :title="t('ai.title')">
    <div v-if="message" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{{ message }}</div>
    <ErrorMessage v-if="error" :message="error" />
    <Loading v-if="loading" />
    <div v-else class="grid gap-6 lg:grid-cols-2">
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('ai.config') }}</h2>
        <div class="space-y-4">
          <label class="flex items-center gap-2">
            <input v-model="config.enabled" type="checkbox" class="switch" />
            <span>{{ t('ai.enabled') }}</span>
          </label>
          <FormInput v-model="config.provider" :label="t('ai.provider')" placeholder="openai" />
          <FormInput v-model="config.base_url" label="Base URL" placeholder="https://api.openai.com/v1" />
          <FormInput v-model="config.model" :label="t('ai.model')" placeholder="gpt-4o-mini" />
          <FormInput
            v-model="config.api_key"
            :label="t('ai.apiKey')"
            type="password"
            :disabled="config.key_from_env"
            :hint="config.key_from_env ? t('ai.apiKeyFromEnv') : undefined"
            :placeholder="config.key_from_env ? '' : (config.has_key ? t('ai.apiKeyPlaceholder') : t('ai.apiKeyInput'))"
          />
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="mb-1 block text-sm text-secondary">{{ t('ai.scheduleFreq') }}</label>
              <select v-model="config.schedule_freq" class="field-control w-full">
                <option value="daily">{{ t('ai.daily') }}</option>
                <option value="weekly">{{ t('ai.weekly') }}</option>
                <option value="every6h">{{ t('ai.every6h') }}</option>
                <option value="every12h">{{ t('ai.every12h') }}</option>
              </select>
            </div>
            <FormInput v-model="config.schedule_time" :label="t('ai.scheduleTime')" placeholder="09:00" />
          </div>
          <FormInput v-model.number="config.tz_offset_hours" :label="t('ai.tzOffset')" placeholder="8" />
          <FormInput v-model.number="config.silent_days" :label="t('ai.silentDays')" placeholder="3" />
          <FormInput v-model.number="config.node_cache_ttl_minutes" :label="t('ai.nodeCacheTtl')" placeholder="30" />
          <FormInput v-model.number="config.period_hours" :label="t('ai.periodHours')" placeholder="24" />
          <div class="flex flex-wrap gap-3 pt-2">
            <button :disabled="saving" @click="save" class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">{{ t('ai.saveConfig') }}</button>
            <button :disabled="running || status?.running" @click="run(false)" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{{ (running || status?.running) ? t('ai.running') : t('ai.run') }}</button>
            <button :disabled="running || status?.running" @click="run(true)" class="btn-ghost px-4 py-2 text-sm font-medium">{{ t('ai.forceRun') }}</button>
          </div>
        </div>
      </div>

      <div class="space-y-6">
        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">{{ t('ai.status') }}</h2>
          <dl v-if="status" class="space-y-2 text-sm">
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.state') }}</dt><dd>{{ status.enabled ? t('ai.enabledState') : t('ai.disabledState') }}</dd></div>
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.provider') }}</dt><dd>{{ status.provider || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.model') }}</dt><dd>{{ status.model || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.schedule') }}</dt><dd>{{ status.schedule || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.lastRun') }}</dt><dd>{{ formatTime(status.last_run_ts) }}</dd></div>
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.duration') }}</dt><dd>{{ formatDuration(status.last_duration_ms) }}</dd></div>
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.lastStatus') }}</dt><dd :class="status.last_status === 'ok' ? 'text-emerald-400' : status.last_status ? 'text-rose-400' : ''">{{ status.last_status || '—' }}</dd></div>
            <div v-if="status.last_error" class="flex justify-between"><dt class="text-secondary">{{ t('ai.error') }}</dt><dd class="max-w-xs truncate text-rose-400">{{ status.last_error }}</dd></div>
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.reportCount') }}</dt><dd>{{ status.report_count }}</dd></div>
            <div class="flex justify-between"><dt class="text-secondary">{{ t('ai.usage7d') }}</dt><dd>{{ usage7d ? usage7d.total_tokens : '—' }}</dd></div>
          </dl>
        </div>

        <AiReportCalendar :version="status?.report_count ?? 0" />
      </div>
    </div>
  </PageShell>
</template>