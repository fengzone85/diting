<script setup lang="ts">
// S2/F6：登录会话管理。
// 每条会话 = 一台已登录设备（sid 存服务端表，cookie 里只带 sid 签名）。
// 踢出后该设备的 cookie 立即失效（服务端吊销时同步清校验缓存，不等 TTL）。
import { onMounted, ref } from 'vue';
import { adminApi } from '../../services/adminApi';
import type { AdminSession } from '../../services/types';
import { t } from '../../composables/useI18n';
import { apiErrorMessage } from '../../utils/apiError';
import Loading from '../../components/ui/Loading.vue';
import EmptyState from '../../components/ui/EmptyState.vue';
import ErrorMessage from '../../components/ui/ErrorMessage.vue';

const sessions = ref<AdminSession[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const busyId = ref<string | null>(null);
const bulkBusy = ref(false);

function fmtDateTime(ts?: number) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

// UA 只展示可读部分：去掉版本号噪音，截断避免撑破布局。
function shortUa(ua?: string) {
  const s = String(ua || '').trim();
  if (!s) return t('sessions.unknownAgent');
  return s.length > 72 ? `${s.slice(0, 72)}…` : s;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await adminApi.listSessions();
    sessions.value = res.list;
  } catch (e) {
    error.value = apiErrorMessage(e, 'sessions.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function kick(s: AdminSession) {
  if (!window.confirm(t('sessions.kickConfirm', { ip: s.ip || '-' }))) return;
  busyId.value = s.id;
  error.value = null;
  try {
    await adminApi.revokeSession(s.id);
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e, 'sessions.kickFailed');
  } finally {
    busyId.value = null;
  }
}

// 踢出其它设备：保留当前会话（否则管理员会把自己也踢下线）。
async function kickOthers() {
  if (!window.confirm(t('sessions.kickOthersConfirm'))) return;
  bulkBusy.value = true;
  error.value = null;
  try {
    await adminApi.revokeAllSessions(true);
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e, 'sessions.kickFailed');
  } finally {
    bulkBusy.value = false;
  }
}

// 全部注销：含当前会话（等价全局吊销），执行后本页也会被登出。
async function revokeAll() {
  if (!window.confirm(t('sessions.revokeAllConfirm'))) return;
  bulkBusy.value = true;
  error.value = null;
  try {
    await adminApi.revokeAllSessions(false);
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e, 'sessions.revokeFailed');
  } finally {
    bulkBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h1 class="mb-2 text-2xl font-bold">{{ t('sessions.title') }}</h1>
    <p class="mb-6 text-sm text-slate-400">{{ t('sessions.desc') }}</p>

    <ErrorMessage v-if="error" class="mb-4" :message="error" />

    <div class="glass mb-6 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <button
          class="rounded-lg border border-amber-500/40 px-3 py-2 text-sm text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
          :disabled="bulkBusy || sessions.length < 2"
          @click="kickOthers"
        >{{ t('sessions.kickOthers') }}</button>
        <button
          class="rounded-lg border border-rose-500/40 px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
          :disabled="bulkBusy"
          @click="revokeAll"
        >{{ t('sessions.revokeAll') }}</button>
        <span class="text-xs text-slate-500">{{ t('sessions.count', { n: sessions.length }) }}</span>
        <button class="text-xs text-sky-400 hover:underline" @click="load">{{ t('common.refresh') }}</button>
      </div>
      <p class="mt-3 text-xs leading-relaxed text-slate-500">{{ t('sessions.hint') }}</p>
    </div>

    <Loading v-if="loading && !sessions.length" />
    <EmptyState v-else-if="!sessions.length">{{ t('sessions.empty') }}</EmptyState>
    <div v-else class="space-y-3">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="rounded-lg border p-3 text-sm"
        :class="s.current ? 'border-sky-500/40 bg-sky-500/5' : 'border-white/10'"
      >
        <div class="mb-1 flex items-center justify-between gap-2">
          <span class="font-semibold text-content">{{ s.ip || t('sessions.unknownIp') }}</span>
          <span v-if="s.current" class="rounded bg-sky-500/20 px-1.5 py-0.5 text-[11px] text-sky-300">
            {{ t('sessions.current') }}
          </span>
        </div>
        <div class="space-y-0.5 text-xs text-slate-400">
          <div class="break-all">{{ shortUa(s.ua) }}</div>
          <div>{{ t('sessions.createdAt') }}：{{ fmtDateTime(s.created_at) }}</div>
          <div>{{ t('sessions.lastSeen') }}：{{ fmtDateTime(s.last_seen) }}</div>
          <div class="font-mono text-[11px] text-slate-600">{{ s.id }}</div>
        </div>
        <button
          class="mt-2 rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
          :disabled="busyId === s.id"
          @click="kick(s)"
        >{{ t('sessions.kick') }}</button>
      </div>
    </div>
  </div>
</template>
