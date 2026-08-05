<script setup lang="ts">
import { ref, onMounted } from 'vue';
import QRCode from 'qrcode';
import { adminApi } from '../../services/adminApi';
import FormInput from '../ui/FormInput.vue';

const loading = ref(false);
const enabled = ref(false);
const secret = ref('');
const otpauthUri = ref('');
const qrDataUrl = ref('');
const code = ref('');
const message = ref('');
const error = ref('');

onMounted(async () => {
  await refreshStatus();
});

async function refreshStatus() {
  loading.value = true;
  try {
    const s = await adminApi.twoFAStatus();
    enabled.value = s.enabled;
  } catch (e) {
    error.value = (e as Error).message || '获取状态失败';
  } finally {
    loading.value = false;
  }
}

async function setup() {
  message.value = '';
  error.value = '';
  secret.value = '';
  otpauthUri.value = '';
  qrDataUrl.value = '';
  try {
    const res = await adminApi.setup2FA();
    secret.value = res.secret;
    otpauthUri.value = res.otpauth_uri;
    qrDataUrl.value = await QRCode.toDataURL(res.otpauth_uri);
  } catch (e) {
    error.value = (e as Error).message || '生成密钥失败';
  }
}

async function enable() {
  message.value = '';
  error.value = '';
  if (!code.value) {
    error.value = '请输入验证码';
    return;
  }
  try {
    const res = await adminApi.enable2FA(code.value);
    enabled.value = res.enabled;
    message.value = '2FA 已开启';
    code.value = '';
    secret.value = '';
    otpauthUri.value = '';
    qrDataUrl.value = '';
  } catch (e) {
    error.value = (e as Error).message || '验证码错误';
  }
}

async function disable() {
  message.value = '';
  error.value = '';
  if (!code.value) {
    error.value = '请输入验证码';
    return;
  }
  try {
    const res = await adminApi.disable2FA(code.value);
    enabled.value = res.enabled;
    message.value = '2FA 已关闭';
    code.value = '';
    secret.value = '';
    otpauthUri.value = '';
    qrDataUrl.value = '';
  } catch (e) {
    error.value = (e as Error).message || '验证码错误';
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    message.value = '已复制';
    setTimeout(() => (message.value = ''), 2000);
  });
}
</script>

<template>
  <div class="glass p-6">
    <h2 class="mb-4 text-lg font-semibold">双因素认证（TOTP）</h2>

    <div v-if="message" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
      {{ message }}
    </div>
    <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      {{ error }}
    </div>

    <div v-if="loading" class="py-4 text-center text-slate-400">加载中...</div>

    <div v-else>
      <div class="mb-4 flex items-center gap-3">
        <span class="text-sm text-slate-400">状态</span>
        <span
          class="rounded-full px-2 py-0.5 text-xs"
          :class="enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-400'"
        >
          {{ enabled ? '已开启' : '未开启' }}
        </span>
      </div>

      <div v-if="!enabled && !secret" class="space-y-4">
        <p class="text-sm text-slate-400">开启 2FA 后，登录管理后台时除 Admin Token 外还需输入动态验证码。</p>
        <button class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400" @click="setup">
          生成密钥
        </button>
      </div>

      <div v-else-if="secret" class="space-y-4">
        <p class="text-sm text-slate-400">请使用 Authenticator 扫描下方二维码，或手动输入密钥。</p>
        <div v-if="qrDataUrl" class="inline-block rounded-lg bg-white p-2">
          <img :src="qrDataUrl" alt="TOTP QR Code" class="h-40 w-40" />
        </div>
        <div class="flex items-center gap-2">
          <code class="rounded bg-slate-900/50 px-3 py-2 text-sm text-slate-300">{{ secret }}</code>
          <button class="text-sm text-sky-400 hover:text-sky-300" @click="copy(secret)">复制</button>
        </div>
        <FormInput v-model="code" label="请输入 Authenticator 生成的 6 位验证码" maxlength="6" />
        <button class="rounded-lg bg-emerald-500 px-4 py-2 text-sm text-white hover:bg-emerald-400" @click="enable">
          确认开启
        </button>
      </div>

      <div v-else-if="enabled" class="space-y-4">
        <p class="text-sm text-slate-400">2FA 已启用。如需关闭，请输入当前验证码。</p>
        <FormInput v-model="code" label="请输入当前 6 位验证码" maxlength="6" />
        <button class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20" @click="disable">
          关闭 2FA
        </button>
      </div>
    </div>
  </div>
</template>
