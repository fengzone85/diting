<script setup lang="ts">
import { ref, onMounted } from 'vue';
import QRCode from 'qrcode';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
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
    error.value = (e as Error).message || t('twofa.fetchFailed');
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
    error.value = (e as Error).message || t('twofa.genFailed');
  }
}

async function enable() {
  message.value = '';
  error.value = '';
  if (!code.value) {
    error.value = t('twofa.codeRequired');
    return;
  }
  try {
    const res = await adminApi.enable2FA(code.value);
    enabled.value = res.enabled;
    message.value = t('twofa.enabledMsg');
    code.value = '';
    secret.value = '';
    otpauthUri.value = '';
    qrDataUrl.value = '';
  } catch (e) {
    error.value = (e as Error).message || t('twofa.codeWrong');
  }
}

async function disable() {
  message.value = '';
  error.value = '';
  if (!code.value) {
    error.value = t('twofa.codeRequired');
    return;
  }
  try {
    const res = await adminApi.disable2FA(code.value);
    enabled.value = res.enabled;
    message.value = t('twofa.disabledMsg');
    code.value = '';
    secret.value = '';
    otpauthUri.value = '';
    qrDataUrl.value = '';
  } catch (e) {
    error.value = (e as Error).message || t('twofa.codeWrong');
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    message.value = t('common.copied');
    setTimeout(() => (message.value = ''), 2000);
  });
}
</script>

<template>
  <div class="glass p-6">
    <h2 class="mb-4 text-lg font-semibold">{{ t('twofa.title') }}</h2>

    <div v-if="message" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
      {{ message }}
    </div>
    <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      {{ error }}
    </div>

    <div v-if="loading" class="py-4 text-center text-slate-400">{{ t('common.loading') }}</div>

    <div v-else>
      <div class="mb-4 flex items-center gap-3">
        <span class="text-sm text-slate-400">{{ t('twofa.status') }}</span>
        <span
          class="rounded-full px-2 py-0.5 text-xs"
          :class="enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-400'"
        >
          {{ enabled ? t('twofa.enabled') : t('twofa.disabled') }}
        </span>
      </div>

      <div v-if="!enabled && !secret" class="space-y-4">
        <p class="text-sm text-slate-400">{{ t('twofa.intro') }}</p>
        <button class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400" @click="setup">
          {{ t('twofa.generate') }}
        </button>
      </div>

      <div v-else-if="secret" class="space-y-4">
        <p class="text-sm text-slate-400">{{ t('twofa.scanTip') }}</p>
        <div v-if="qrDataUrl" class="inline-block rounded-lg bg-white p-2">
          <img :src="qrDataUrl" :alt="t('twofa.qrAlt')" class="h-40 w-40" />
        </div>
        <div class="flex items-center gap-2">
          <code class="rounded bg-slate-900/50 px-3 py-2 text-sm text-slate-300">{{ secret }}</code>
          <button class="text-sm text-sky-400 hover:text-sky-300" @click="copy(secret)">{{ t('common.copy') }}</button>
        </div>
        <FormInput v-model="code" :label="t('twofa.enterCode')" maxlength="6" />
        <button class="rounded-lg bg-emerald-500 px-4 py-2 text-sm text-white hover:bg-emerald-400" @click="enable">
          {{ t('twofa.confirmEnable') }}
        </button>
      </div>

      <div v-else-if="enabled" class="space-y-4">
        <p class="text-sm text-slate-400">{{ t('twofa.disableTip') }}</p>
        <FormInput v-model="code" :label="t('twofa.enterCurrentCode')" maxlength="6" />
        <button class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20" @click="disable">
          {{ t('twofa.disable') }}
        </button>
      </div>
    </div>
  </div>
</template>
