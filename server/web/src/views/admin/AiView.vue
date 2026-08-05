<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { adminApi } from '../../services/adminApi';
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

onMounted(async () => {
  await load();
});

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
    error.value = (e as Error).message || '加载失败';
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
    message.value = '配置已保存';
    await load();
  } catch (e) {
    error.value = (e as Error).message || '保存失败';
  } finally {
    saving.value = false;
  }
}

async function run() {
  running.value = true;
  message.value = '';
  error.value = '';
  try {
    await adminApi.runAi();
    message.value = 'AI 分析任务已触发，稍后刷新查看报告';
    await load();
  } catch (e) {
    error.value = (e as Error).message || '运行失败';
  } finally {
    running.value = false;
  }
}

function formatTime(ts?: number) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN');
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
    <h1 class="mb-6 text-2xl font-bold">AI 运维分析</h1>
    <div v-if="message" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{{ message }}</div>
    <ErrorMessage v-if="error" :message="error" />
    <Loading v-if="loading" />
    <div v-else class="grid gap-6 lg:grid-cols-2">
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">配置</h2>
        <div class="space-y-4">
          <label class="flex items-center gap-2">
            <input v-model="config.enabled" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500" />
            <span>启用 AI 运维分析</span>
          </label>
          <FormInput v-model="config.provider" label="提供商" placeholder="openai" />
          <FormInput v-model="config.base_url" label="Base URL" placeholder="https://api.openai.com/v1" />
          <FormInput v-model="config.model" label="模型" placeholder="gpt-4o-mini" />
          <FormInput v-model="config.api_key" label="API Key" type="password" :placeholder="config.has_key ? '已配置，留空保持不变' : '请输入 API Key'" />
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="mb-1 block text-sm text-slate-400">调度频率</label>
              <select v-model="config.schedule_freq" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
              </select>
            </div>
            <FormInput v-model="config.schedule_time" label="运行时间 (HH:MM)" placeholder="09:00" />
          </div>
          <FormInput v-model.number="config.tz_offset_hours" label="时区偏移 (小时)" placeholder="8" />
          <label class="flex items-center gap-2">
            <input v-model="config.batch_mode" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500" />
            <span>批量模式</span>
          </label>
          <div class="flex gap-3 pt-2">
            <button :disabled="saving" @click="save" class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">保存配置</button>
            <button :disabled="running" @click="run" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">立即运行</button>
          </div>
        </div>
      </div>

      <div class="space-y-6">
        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">运行状态</h2>
          <dl v-if="status" class="space-y-2 text-sm">
            <div class="flex justify-between"><dt class="text-slate-400">状态</dt><dd>{{ status.enabled ? '已启用' : '已禁用' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">提供商</dt><dd>{{ status.provider || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">模型</dt><dd>{{ status.model || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">调度</dt><dd>{{ status.schedule || '—' }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">最近运行</dt><dd>{{ formatTime(status.last_run_ts) }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">最近状态</dt><dd :class="status.last_status === 'ok' ? 'text-emerald-400' : status.last_status ? 'text-rose-400' : ''">{{ status.last_status || '—' }}</dd></div>
            <div v-if="status.last_error" class="flex justify-between"><dt class="text-slate-400">错误</dt><dd class="max-w-xs truncate text-rose-400">{{ status.last_error }}</dd></div>
            <div class="flex justify-between"><dt class="text-slate-400">报告数量</dt><dd>{{ status.report_count }}</dd></div>
          </dl>
        </div>

        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">历史报告</h2>
          <div v-if="!reports.length" class="py-8 text-center text-sm text-slate-500">暂无报告</div>
          <div v-else class="space-y-3">
            <div v-for="r in reports" :key="r.id" class="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium">{{ r.period || formatTime(r.created_at) }}</span>
                <span class="text-xs" :class="r.risk_level === 'high' ? 'text-rose-400' : r.risk_level === 'medium' ? 'text-amber-400' : 'text-emerald-400'">{{ r.risk_level || 'info' }}</span>
              </div>
              <p class="mt-2 line-clamp-2 text-sm text-slate-300">{{ r.summary || '无摘要' }}</p>
              <p v-if="r.suggestion" class="mt-1 line-clamp-2 text-xs text-slate-500">{{ r.suggestion }}</p>
            </div>
            <div class="flex items-center justify-between pt-2">
              <button :disabled="offset <= 0" @click="changePage(-1)" class="rounded-lg border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800 disabled:opacity-40">上一页</button>
              <span class="text-xs text-slate-500">{{ offset + 1 }} - {{ Math.min(offset + limit, reportTotal) }} / {{ reportTotal }}</span>
              <button :disabled="offset + limit >= reportTotal" @click="changePage(1)" class="rounded-lg border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800 disabled:opacity-40">下一页</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>