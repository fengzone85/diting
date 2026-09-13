<script setup lang="ts">
// 单节点 AI 分析弹窗（§8 T14/T16）。
// - 后台节点页与公开节点页共用本组件；公开页传 guardAuth=true（未登录只提示、不发请求）。
// - 窗口 24h / 7d / 30d 对应 ?hours=24/168/720，服务端按「节点+窗口」缓存 30 分钟。
// - 全部内容走 Vue 插值渲染，不使用 v-html（守 CSP）。
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { useI18n } from '../../composables/useI18n';
import { adminApi } from '../../services/adminApi';
import { getAuthStatus } from '../../services/auth';
import { apiErrorMessage } from '../../utils/apiError';
import type { AiNodeAnalysis } from '../../services/types';

const props = defineProps<{
  agentId: string;
  agentName?: string;
  // 公开页传 true：先探测登录态，未登录时只展示提示（省掉一次必然 401 的请求）
  guardAuth?: boolean;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();
const route = useRoute();

const WINDOWS = [24, 168, 720] as const;
const hours = ref<number>(24);
const loading = ref(false);
const checking = ref(false);
const needLogin = ref(false);
const result = ref<AiNodeAnalysis | null>(null);
const errorMsg = ref('');
const panel = ref<HTMLElement | null>(null);

let prevOverflow = '';

function windowKey(h: number): string {
  if (h === 168) return 'ai.win7d';
  if (h === 720) return 'ai.win30d';
  if (h === 24) return 'ai.win24h';
  return '';
}
function windowLabel(h: number): string {
  const k = windowKey(h);
  return k ? t(k) : `${h}h`;
}
function riskClass(level?: string): string {
  if (level === 'high') return 'text-rose-400';
  if (level === 'medium') return 'text-amber-400';
  return 'text-emerald-400';
}

async function run() {
  loading.value = true;
  errorMsg.value = '';
  try {
    result.value = await adminApi.aiAnalyzeNode(props.agentId, hours.value);
  } catch (e) {
    result.value = null;
    // 401/403 等按服务端错误码本地化（unauthorized / admin required / ip not allowed / totp required）
    errorMsg.value = apiErrorMessage(e, 'ai.runFailed');
  } finally {
    loading.value = false;
  }
}

async function init() {
  if (props.guardAuth) {
    checking.value = true;
    try {
      const s = await getAuthStatus();
      needLogin.value = !s.logged_in;
    } catch {
      // 探测失败不拦住用户：交给实际请求的 401/403 分支兜底
      needLogin.value = false;
    } finally {
      checking.value = false;
    }
    if (needLogin.value) return;
  }
  await run();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

watch(hours, () => {
  if (!needLogin.value) run();
});

onMounted(async () => {
  document.addEventListener('keydown', onKey);
  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  await nextTick();
  panel.value?.focus();
  await init();
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = prevOverflow;
});
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm sm:items-center"
      role="presentation"
      @click.self="emit('close')"
    >
      <div
        ref="panel"
        class="glass w-full max-w-3xl p-6 outline-none"
        role="dialog"
        aria-modal="true"
        :aria-label="t('ai.analyzeNode')"
        tabindex="-1"
      >
        <div class="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold">{{ t('ai.analyzeNode') }}</h2>
            <p class="mt-1 text-xs text-slate-400">
              <span v-if="agentName">{{ agentName }}</span>
              <span v-else class="font-mono">{{ agentId }}</span>
            </p>
          </div>
          <button class="rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700" @click="emit('close')">
            {{ t('ai.close') }}
          </button>
        </div>

        <div v-if="!needLogin" class="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span class="text-slate-400">{{ t('ai.window') }}</span>
          <button
            v-for="h in WINDOWS"
            :key="h"
            :class="hours === h ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-400'"
            class="rounded px-2 py-1 hover:opacity-80"
            @click="hours = h"
          >{{ windowLabel(h) }}</button>
        </div>

        <p v-if="checking || loading" class="py-6 text-center text-sm text-slate-400">{{ t('ai.analyzing') }}</p>

        <div v-else-if="needLogin" class="space-y-3 py-4 text-sm">
          <p class="text-amber-300">{{ t('ai.needLogin') }}</p>
          <RouterLink
            :to="{ path: '/login', query: { redirect: route.fullPath } }"
            class="inline-block rounded-lg bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-500"
          >{{ t('ai.gotoLogin') }}</RouterLink>
        </div>

        <div v-else-if="errorMsg" class="space-y-3 py-4 text-sm">
          <p class="text-rose-300">{{ errorMsg }}</p>
          <button class="rounded-lg bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-500" @click="run">
            {{ t('ai.reanalyze') }}
          </button>
        </div>

        <div v-else-if="result" class="space-y-3 text-sm">
          <div class="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <span v-if="result.analysis?.risk_level" :class="riskClass(result.analysis.risk_level)">
              {{ result.analysis.risk_level }}
            </span>
            <span v-if="result.cached">{{ t('ai.nodeCached') }}</span>
            <span v-if="result.period_hours">{{ t('ai.window') }}: {{ windowLabel(result.period_hours) }}</span>
            <span v-if="result.duration_ms">{{ t('ai.duration') }}: {{ (result.duration_ms / 1000).toFixed(1) }} s</span>
            <span v-if="result.usage?.total_tokens">{{ t('ai.tokens') }}: {{ result.usage.total_tokens }}</span>
          </div>
          <p v-if="result.message" class="text-amber-300">{{ result.message }}</p>
          <p class="text-xs text-slate-500">{{ t('ai.analyzeNodeHint') }}</p>
          <p v-if="result.analysis?.summary" class="whitespace-pre-wrap text-slate-200">{{ result.analysis.summary }}</p>
          <table v-if="result.analysis?.findings?.length" class="w-full table-fixed border-collapse text-left text-xs">
            <thead class="text-slate-400">
              <tr>
                <th class="w-1/6 border-b border-slate-800 py-2 pr-2">{{ t('ai.metric') }}</th>
                <th class="w-1/4 border-b border-slate-800 py-2 pr-2">{{ t('ai.issue') }}</th>
                <th class="w-1/4 border-b border-slate-800 py-2 pr-2">{{ t('ai.reason') }}</th>
                <th class="w-1/4 border-b border-slate-800 py-2">{{ t('ai.suggestion') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(f, i) in result.analysis.findings" :key="i" class="align-top">
                <td class="border-b border-slate-900 py-2 pr-2 text-slate-300">{{ f.metric }}</td>
                <td class="border-b border-slate-900 py-2 pr-2 text-slate-300">{{ f.detail }}</td>
                <td class="border-b border-slate-900 py-2 pr-2 text-slate-500">{{ f.reason }}</td>
                <td class="border-b border-slate-900 py-2 text-slate-500">{{ f.suggestion }}</td>
              </tr>
            </tbody>
          </table>
          <pre
            v-if="result.analysis?.raw"
            class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-3 text-xs text-slate-500"
          >{{ result.analysis.raw }}</pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>
