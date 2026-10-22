<script setup lang="ts">
// 安装向导（复刻 komari 安装向导 UX，适配 diting 单管理员 Token 模型）。
// 流程：探测 /api/install/status → required 表单 / 已初始化锁定 → 单步提交
// （站点名称 + 描述 + Token 自动生成或自定义）→ 一次性展示 Token → 前往登录。
// 服务端未安装时会把所有页面 307 到这里，本页是全站唯一入口。
import { ref, computed, onMounted } from 'vue';
import { getInstallStatus, completeInstall, type InstallStatus } from '../services/install';
import { isAcceptableUrl, agentUrlWarning, checkCustomToken, warnI18nKey } from '../utils/installForm';
import { useI18n } from '../composables/useI18n';

const { t } = useI18n();

type Phase = 'loading' | 'form' | 'locked' | 'done';
const phase = ref<Phase>('loading');
const loadFailed = ref(false);

const sitename = ref('');
const description = ref('');
const siteUrl = ref('');
const agentServerUrl = ref('');
const listenPort = ref<number | null>(null);
const mode = ref<'generate' | 'custom'>('generate');
const customToken = ref('');
const submitting = ref(false);
const error = ref('');
const generatedToken = ref('');
const doneWarnings = ref<string[]>([]);
const copied = ref(false);

// 地址校验、软告警、Token 强度判定都在 utils/installForm.ts（纯函数、可单测），
// 这里只做响应式包装与展示。
const siteUrlOk = computed(() => isAcceptableUrl(siteUrl.value, false));
const agentServerUrlOk = computed(() => isAcceptableUrl(agentServerUrl.value, true));
const agentWarn = computed(() => agentUrlWarning(agentServerUrl.value, listenPort.value));
const customTokenCheck = computed(() => checkCustomToken(customToken.value));

function warnLabel(code: string): string {
  const key = warnI18nKey(code);
  return key ? t(key) : '';
}

const canSubmit = computed(() => {
  const name = sitename.value.trim();
  if (!name || name.length > 100) return false;
  if (description.value.trim().length > 1000) return false;
  if (!siteUrlOk.value || !agentServerUrlOk.value) return false;
  if (mode.value === 'custom' && !customTokenCheck.value.ok) return false;
  return true;
});

async function load() {
  phase.value = 'loading';
  loadFailed.value = false;
  try {
    const s: InstallStatus = await getInstallStatus();
    listenPort.value = typeof s.port === 'number' ? s.port : null;
    phase.value = s.required ? 'form' : 'locked';
    if (s.required) {
      // 浏览器侧预填（管理员确认后才入库）。服务端仍不信任 Host / X-Forwarded-Host，
      // 见 api.js getPublicBaseUrl 的纵深防御说明。
      const origin = window.location.origin;
      if (!siteUrl.value) siteUrl.value = origin;
      if (!agentServerUrl.value) agentServerUrl.value = origin;
    }
  } catch {
    loadFailed.value = true;
  }
}

async function submit() {
  const name = sitename.value.trim();
  if (!name || name.length > 100) {
    error.value = t('install.sitenameRequired');
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    const res = await completeInstall({
      sitename: name,
      description: description.value.trim(),
      site_url: siteUrl.value.trim() || undefined,
      agent_server_url: agentServerUrl.value.trim(),
      token_mode: mode.value,
      token: mode.value === 'custom' ? customToken.value.trim() : undefined,
    });
    generatedToken.value = res.token || '';
    doneWarnings.value = Array.isArray(res.warnings) ? res.warnings : [];
    phase.value = 'done';
  } catch (e) {
    error.value = (e as Error).message || t('common.error');
  } finally {
    submitting.value = false;
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(generatedToken.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch { /* 剪贴板不可用（非安全上下文）时静默，Token 本就展示在框内 */ }
}

onMounted(load);
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-6">
    <!-- 探测中 -->
    <div v-if="phase === 'loading'" class="text-sm text-slate-400">{{ t('common.loading') }}</div>

    <!-- 探测失败 -->
    <div v-else-if="loadFailed" class="glass w-full max-w-md p-8 text-center">
      <div class="mb-4 text-4xl">⚠️</div>
      <p class="mb-6 text-sm text-slate-300">{{ t('install.loadFailed') }}</p>
      <button type="button" class="w-full rounded-lg bg-sky-500 py-2 font-medium text-white hover:bg-sky-400" @click="load">
        {{ t('install.retry') }}
      </button>
    </div>

    <!-- 已初始化：向导锁定（对应 komari 安装完成后向导永久禁用） -->
    <div v-else-if="phase === 'locked'" class="glass w-full max-w-md p-8 text-center">
      <div class="mb-4 text-4xl">🔒</div>
      <h1 class="mb-2 text-2xl font-bold">{{ t('install.lockedTitle') }}</h1>
      <p class="mb-4 text-sm text-slate-400">{{ t('install.lockedDesc') }}</p>
      <div class="mb-6 rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-left text-xs text-slate-300">
        {{ t('install.lockedReset') }}<br>
        <code class="mt-1 block rounded bg-black/40 p-2 font-mono break-all">sudo bash diting.sh --reset-admin-token</code>
      </div>
      <router-link to="/login" class="block w-full rounded-lg bg-sky-500 py-2 text-center font-medium text-white no-underline hover:bg-sky-400">
        {{ t('install.goLogin') }}
      </router-link>
    </div>

    <!-- 安装表单（单步，对齐 komari complete：sitename/description/凭据） -->
    <form v-else-if="phase === 'form'" class="glass w-full max-w-md p-8" @submit.prevent="submit">
      <h1 class="mb-1 text-center text-2xl font-bold">{{ t('install.title') }}</h1>
      <p class="mb-6 text-center text-sm text-slate-400">{{ t('install.subtitle') }}</p>

      <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
        {{ error }}
      </div>

      <div class="space-y-4">
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('install.sitename') }}</label>
          <input v-model="sitename" type="text" maxlength="100" :placeholder="t('install.sitenamePh')" required
            class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-white outline-none focus:border-sky-500" />
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('install.description') }}</label>
          <textarea v-model="description" rows="2" maxlength="1000" :placeholder="t('install.descriptionPh')"
            class="w-full resize-none rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-white outline-none focus:border-sky-500"></textarea>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('install.siteUrl') }}</label>
          <input v-model="siteUrl" type="url" maxlength="200" :placeholder="t('install.siteUrlPh')"
            class="w-full rounded-lg border bg-slate-900/50 px-4 py-2 text-white outline-none"
            :class="siteUrlOk ? 'border-slate-700 focus:border-sky-500' : 'border-rose-500/60 focus:border-rose-400'" />
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('install.agentServerUrl') }}</label>
          <input v-model="agentServerUrl" type="url" maxlength="200" required :placeholder="t('install.agentServerUrlPh')"
            class="w-full rounded-lg border bg-slate-900/50 px-4 py-2 text-white outline-none"
            :class="agentServerUrlOk ? 'border-slate-700 focus:border-sky-500' : 'border-rose-500/60 focus:border-rose-400'" />
          <p class="mt-1 text-xs text-slate-500">{{ t('install.agentServerUrlHint') }}</p>
          <p v-if="!agentServerUrlOk" class="mt-1 text-xs text-rose-400">{{ t('install.agentServerUrlRequired') }}</p>
          <p v-else-if="agentWarn" class="mt-1 text-xs text-amber-400">⚠️ {{ t(agentWarn) }}</p>
        </div>
        <div class="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2">
          <span class="text-xs text-slate-400">{{ t('install.listenPort') }}</span>
          <code class="rounded bg-black/40 px-2 py-0.5 font-mono text-xs text-slate-200">{{ listenPort ?? '—' }}</code>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('install.tokenMode') }}</label>
          <div class="grid grid-cols-2 gap-2">
            <button type="button" @click="mode = 'generate'"
              class="rounded-lg border p-3 text-left transition-colors"
              :class="mode === 'generate' ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'">
              <div class="text-sm font-medium" :class="mode === 'generate' ? 'text-sky-300' : 'text-slate-300'">{{ t('install.tokenGenerate') }}</div>
              <div class="mt-1 text-xs text-slate-500">{{ t('install.tokenGenerateHint') }}</div>
            </button>
            <button type="button" @click="mode = 'custom'"
              class="rounded-lg border p-3 text-left transition-colors"
              :class="mode === 'custom' ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'">
              <div class="text-sm font-medium" :class="mode === 'custom' ? 'text-sky-300' : 'text-slate-300'">{{ t('install.tokenCustom') }}</div>
              <div class="mt-1 text-xs text-slate-500">{{ t('install.tokenCustomHint') }}</div>
            </button>
          </div>
          <div v-if="mode === 'custom'" class="mt-2">
            <input v-model="customToken" type="text" autocomplete="off" spellcheck="false" :placeholder="t('install.tokenCustomPh')"
              class="w-full rounded-lg border bg-slate-900/50 px-4 py-2 font-mono text-white outline-none"
              :class="customToken.trim() ? (customTokenCheck.ok ? 'border-emerald-500/60 focus:border-emerald-400' : 'border-rose-500/60 focus:border-rose-400') : 'border-slate-700 focus:border-sky-500'" />
            <p v-if="customToken.trim()" class="mt-1 text-xs"
              :class="customTokenCheck.ok ? 'text-emerald-400' : 'text-rose-400'">
              {{ customTokenCheck.ok ? '✓ ' : '✕ ' }}{{ t(customTokenCheck.key) }}
            </p>
          </div>
        </div>
        <button type="submit" :disabled="submitting || !canSubmit"
          class="w-full rounded-lg bg-sky-500 py-2 font-medium text-white hover:bg-sky-400 disabled:opacity-50">
          {{ submitting ? t('install.submitting') : t('install.submit') }}
        </button>
      </div>
    </form>

    <!-- 完成：一次性展示 Token（generate 模式），对齐旧向导的「仅显示一次」警示 -->
    <div v-else class="glass w-full max-w-md p-8">
      <div class="mb-4 text-center text-4xl">🚀</div>
      <h1 class="mb-4 text-center text-2xl font-bold">{{ t('install.doneTitle') }}</h1>

      <template v-if="generatedToken">
        <div class="mb-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-center font-mono text-sm break-all text-emerald-200">
          {{ generatedToken }}
        </div>
        <div class="mb-4 flex gap-2">
          <button type="button" @click="copyToken"
            class="flex-1 rounded-lg border border-slate-600 py-2 text-sm text-slate-200 hover:border-slate-400">
            {{ copied ? t('install.copied') : t('install.copy') }}
          </button>
        </div>
        <p class="mb-2 text-sm font-bold text-rose-300">⚠️ {{ t('install.doneTokenHint') }}</p>
      </template>
      <p v-else class="mb-2 text-sm text-slate-300">{{ t('install.doneCustomHint') }}</p>

      <ul v-if="doneWarnings.length" class="mb-2 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
        <li v-for="w in doneWarnings" :key="w">⚠️ {{ warnLabel(w) }}</li>
      </ul>
      <p class="mb-2 text-xs text-slate-400">{{ t('install.doneWarning') }}</p>
      <p class="mb-6 text-xs text-slate-400">{{ t('install.doneNote') }}</p>

      <router-link to="/login" class="block w-full rounded-lg bg-sky-500 py-2 text-center font-medium text-white no-underline hover:bg-sky-400">
        {{ t('install.goLogin') }}
      </router-link>
    </div>
  </div>
</template>
