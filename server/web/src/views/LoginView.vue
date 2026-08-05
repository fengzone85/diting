<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminApi } from '../services/adminApi';

const route = useRoute();
const router = useRouter();

const token = ref('');
const totp = ref('');
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
  loading.value = true;
  error.value = '';
  try {
    const res = await adminApi.login(token.value.trim(), totp.value.trim() || undefined);
    if (res.totp && !totp.value.trim()) {
      needTotp.value = true;
      error.value = '请输入 TOTP 验证码';
      return;
    }
    router.replace((route.query.redirect as string) || '/admin');
  } catch (e) {
    error.value = (e as Error).message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-6">
    <form class="glass w-full max-w-md p-8" @submit.prevent="submit">
      <h1 class="mb-6 text-center text-2xl font-bold">管理登录</h1>
      <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
        {{ error }}
      </div>
      <div class="space-y-4">
        <div>
          <label class="mb-1 block text-sm text-slate-400">Admin Token</label>
          <input v-model="token" type="password" required class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-white outline-none focus:border-sky-500" />
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">TOTP（如启用 2FA）</label>
          <input v-model="totp" type="text" inputmode="numeric" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-white outline-none focus:border-sky-500" />
        </div>
        <button type="submit" :disabled="loading" class="w-full rounded-lg bg-sky-500 py-2 font-medium text-white hover:bg-sky-400 disabled:opacity-50">
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </div>
    </form>
  </div>
</template>
