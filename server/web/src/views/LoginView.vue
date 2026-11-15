<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminApi } from '../services/adminApi';
import { useI18n } from '../composables/useI18n';
import { apiErrorMessage } from '../utils/apiError';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

// 固定双 tab（r1/P1-3 防枚举）：不按「是否设密码」动态显隐，未设密码时服务端统一 401。
// r3/P2-1：默认 Token tab（未设密码的老用户首屏不困惑），并记住上次选择。
const TAB_KEY = 'diting.admin.loginTab';
const tab = ref<'password' | 'token'>(localStorage.getItem(TAB_KEY) === 'password' ? 'password' : 'token');
function switchTab(t: 'password' | 'token') {
  tab.value = t;
  try { localStorage.setItem(TAB_KEY, t); } catch { /* 存储不可用时忽略 */ }
}
const token = ref('');
const password = ref('');
const totp = ref('');
const remember = ref(false);
const needTotp = ref(false);
const error = ref('');
const loading = ref(false);

onMounted(async () => {
  try {
    const s = await adminApi.status();
    needTotp.value = s.enabled;
  } catch {
    // 未登录时 401，忽略
  }
});

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    if (tab.value === 'password') {
      // r3/P2-2：密码不做 trim——首尾空格是合法密码字符，trim 会导致「设得进、登不进」。
      const pw = password.value;
      if (!pw) {
        error.value = t('login.passwordRequired');
        return;
      }
      // remember 仅 password 通道有效（服务端对恢复码/totp 通道另有强制 12h 规则）。
      const res = await adminApi.login({
        password: pw,
        totp: totp.value.trim() || undefined,
        remember: remember.value,
      });
      if (res.totp && !totp.value.trim()) {
        needTotp.value = true;
        error.value = t('login.twofaRequired');
        return;
      }
    } else {
      const tk = token.value.trim();
      if (!tk) {
        error.value = t('login.tokenRequired');
        return;
      }
      const res = await adminApi.login({ token: tk, totp: totp.value.trim() || undefined });
      if (res.totp && !totp.value.trim()) {
        needTotp.value = true;
        error.value = t('login.twofaRequired');
        return;
      }
    }
    router.replace((route.query.redirect as string) || '/admin');
  } catch (e) {
    // 走统一错误码映射（apiErrorMessage）：登录失败/限流/封禁等服务端 error 码本地化，
    // 避免把 "login_blocked (HTTP 429)" 这类原始串直接甩给用户。
    error.value = apiErrorMessage(e, 'login.failed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-6">
    <form class="glass w-full max-w-md p-8" @submit.prevent="submit">
      <h1 class="mb-6 text-center text-2xl font-bold">{{ t('login.title') }}</h1>
      <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
        {{ error }}
      </div>

      <!-- 双 tab：密码（人用）/ Token（机器凭据） -->
      <div class="mb-4 grid grid-cols-2 gap-2 rounded-lg border border-slate-700 bg-slate-900/40 p-1">
        <button
          type="button"
          class="rounded-md py-1.5 text-sm transition"
          :class="tab === 'password' ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-200'"
          @click="switchTab('password')"
        >{{ t('login.tabPassword') }}</button>
        <button
          type="button"
          class="rounded-md py-1.5 text-sm transition"
          :class="tab === 'token' ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-200'"
          @click="switchTab('token')"
        >{{ t('login.tabToken') }}</button>
      </div>

      <div class="space-y-4">
        <template v-if="tab === 'password'">
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('login.password') }}</label>
            <input v-model="password" type="password" :placeholder="t('login.password')" required class="field-control w-full" />
          </div>
        </template>
        <template v-else>
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('login.token') }}</label>
            <input v-model="token" type="password" :placeholder="t('login.token')" required class="field-control w-full" />
          </div>
        </template>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('login.totp') }}</label>
          <input v-model="totp" type="text" inputmode="numeric" :placeholder="t('login.totpPlaceholder')" class="field-control w-full" />
          <p class="mt-1 text-xs text-slate-500">{{ t('login.totpHint') }}</p>
        </div>
        <label v-if="tab === 'password'" class="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
          <input v-model="remember" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-900/50" />
          <span>{{ t('login.remember') }}</span>
        </label>
        <button type="submit" :disabled="loading" class="w-full rounded-lg bg-sky-500 py-2 font-medium text-white hover:bg-sky-400 disabled:opacity-50">
          {{ loading ? '…' : t('login.submit') }}
        </button>
      </div>
    </form>
  </div>
</template>
