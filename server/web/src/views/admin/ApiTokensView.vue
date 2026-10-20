<script setup lang="ts">
// S2/F5：API Token 管理。明文只在创建响应里返回一次（后端不存明文），
// 因此这里用「创建成功 → 弹出一次性展示框」的强提示，而不是列表里回显。
import { computed, onMounted, ref } from 'vue';
import { adminApi } from '../../services/adminApi';
import type { ApiToken, ApiTokenCreated } from '../../services/types';
import { useAdmin } from '../../composables/useAdmin';
import { t } from '../../composables/useI18n';
import { apiErrorMessage } from '../../utils/apiError';
import Loading from '../../components/ui/Loading.vue';
import EmptyState from '../../components/ui/EmptyState.vue';
import ErrorMessage from '../../components/ui/ErrorMessage.vue';

const { state } = useAdmin();
const agents = computed(() => state.agents);

const tokens = ref<ApiToken[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const saving = ref(false);
const revokingId = ref<string | null>(null);
const created = ref<ApiTokenCreated | null>(null);
const copied = ref(false);

const form = ref<{
  name: string;
  scope: 'readonly' | 'admin';
  agentIds: string[];
  expiresInDays: number | string;
}>({ name: '', scope: 'readonly', agentIds: [], expiresInDays: '' });

const now = Date.now();

function agentName(id: string) {
  return agents.value.find((a) => a.id === id)?.name || id;
}

function fmtDate(ts?: number) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString();
}

function statusOf(tok: ApiToken): 'revoked' | 'expired' | 'active' {
  if (tok.revoked) return 'revoked';
  if (tok.expires_at && tok.expires_at <= now) return 'expired';
  return 'active';
}

function statusLabel(tok: ApiToken) {
  const s = statusOf(tok);
  if (s === 'revoked') return t('tokens.revoked');
  if (s === 'expired') return t('tokens.expired');
  return t('tokens.active');
}

function statusClass(tok: ApiToken) {
  const s = statusOf(tok);
  if (s === 'active') return 'text-emerald-400';
  if (s === 'expired') return 'text-amber-400';
  return 'text-slate-500';
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await adminApi.listApiTokens();
    tokens.value = res.list;
  } catch (e) {
    error.value = apiErrorMessage(e, 'tokens.loadFailed');
  } finally {
    loading.value = false;
  }
}

function toggleAgent(id: string, checked: boolean) {
  const set = new Set(form.value.agentIds);
  if (checked) set.add(id);
  else set.delete(id);
  form.value.agentIds = Array.from(set);
}

function selectAllAgents() {
  form.value.agentIds = agents.value.map((a) => a.id);
}

function clearAgents() {
  form.value.agentIds = [];
}

async function submit() {
  error.value = null;
  const name = form.value.name.trim();
  if (!name) {
    error.value = t('tokens.nameRequired');
    return;
  }
  // 与后端同口径：留空 = 永不过期；否则必须是 1–3650 的整数。
  let expires: number | undefined;
  if (form.value.expiresInDays !== '' && form.value.expiresInDays !== null) {
    const n = Number(form.value.expiresInDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      error.value = t('errors.invalidExpiresInDays');
      return;
    }
    expires = n;
  }
  saving.value = true;
  try {
    const res = await adminApi.createApiToken({
      name,
      scope: form.value.scope,
      agent_ids: form.value.agentIds,
      ...(expires ? { expires_in_days: expires } : {}),
    });
    created.value = res;
    copied.value = false;
    form.value.name = '';
    form.value.expiresInDays = '';
    form.value.agentIds = [];
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e, 'tokens.createFailed');
  } finally {
    saving.value = false;
  }
}

async function revoke(tok: ApiToken) {
  if (!window.confirm(t('tokens.revokeConfirm', { name: tok.name }))) return;
  revokingId.value = tok.id;
  error.value = null;
  try {
    await adminApi.revokeApiToken(tok.id);
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e, 'tokens.revokeFailed');
  } finally {
    revokingId.value = null;
  }
}

// 内网 http 场景下 navigator.clipboard 可能不可用，退回 textarea + execCommand。
async function copyToken() {
  const text = created.value?.token;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 复制失败时用户仍可手动选中 */ }
    document.body.removeChild(ta);
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

onMounted(load);
</script>

<template>
  <div>
    <h1 class="mb-2 text-2xl font-bold">{{ t('tokens.title') }}</h1>
    <p class="mb-6 text-sm text-slate-400">{{ t('tokens.desc') }}</p>

    <ErrorMessage v-if="error" class="mb-4" :message="error" />

    <!-- 一次性明文展示：创建成功即出现，关闭后不可再查看 -->
    <div
      v-if="created"
      class="mb-6 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4"
    >
      <h2 class="mb-1 font-semibold text-emerald-200">{{ t('tokens.createdTitle') }}</h2>
      <p class="mb-3 text-xs leading-relaxed text-emerald-200/80">{{ t('tokens.createdHint') }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <code class="flex-1 break-all rounded bg-slate-900/70 px-3 py-2 text-sm text-emerald-300">{{ created.token }}</code>
        <button
          class="rounded-lg border border-emerald-500/50 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/20"
          @click="copyToken"
        >{{ copied ? t('common.copied') : t('common.copy') }}</button>
        <button
          class="rounded-lg bg-emerald-500 px-3 py-2 text-sm text-white hover:bg-emerald-400"
          @click="created = null"
        >{{ t('tokens.close') }}</button>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- 签发表单 -->
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('tokens.formTitle') }}</h2>

        <label class="mb-1 block text-sm text-slate-400">{{ t('tokens.name') }}</label>
        <input
          v-model="form.name"
          type="text"
          maxlength="64"
          :placeholder="t('tokens.namePlaceholder')"
          class="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500"
        />

        <label class="mb-1 block text-sm text-slate-400">{{ t('tokens.scope') }}</label>
        <select
          v-model="form.scope"
          class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500"
        >
          <option value="readonly">{{ t('tokens.scopeReadonly') }}</option>
          <option value="admin">{{ t('tokens.scopeAdmin') }}</option>
        </select>
        <p class="mb-4 mt-1 text-xs text-slate-500">{{ t('tokens.scopeHint') }}</p>

        <div class="mb-1 flex items-center justify-between">
          <label class="text-sm text-slate-400">{{ t('tokens.nodes') }}</label>
          <div class="flex gap-2 text-xs">
            <button class="text-sky-400 hover:underline" @click="selectAllAgents">{{ t('tokens.selectAll') }}</button>
            <button class="text-slate-400 hover:underline" @click="clearAgents">{{ t('tokens.clear') }}</button>
          </div>
        </div>
        <div class="mb-1 max-h-48 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/40 p-2">
          <label
            v-for="a in agents"
            :key="a.id"
            class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-slate-300 hover:bg-slate-800/60"
          >
            <input
              type="checkbox"
              class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500"
              :checked="form.agentIds.includes(a.id)"
              @change="toggleAgent(a.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="truncate">{{ a.name }}</span>
            <span class="ml-auto font-mono text-xs text-slate-500">{{ a.id }}</span>
          </label>
          <p v-if="!agents.length" class="px-2 py-1 text-xs text-slate-500">{{ t('common.loading') }}</p>
        </div>
        <p class="mb-4 mt-1 text-xs leading-relaxed text-slate-500">{{ t('tokens.nodesHint') }}</p>

        <label class="mb-1 block text-sm text-slate-400">{{ t('tokens.expiresInDays') }}</label>
        <input
          v-model="form.expiresInDays"
          type="number"
          min="1"
          max="3650"
          :placeholder="t('tokens.expiresPlaceholder')"
          class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500"
        />
        <p class="mb-4 mt-1 text-xs text-slate-500">{{ t('tokens.expiresHint') }}</p>

        <button
          class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400 disabled:opacity-50"
          :disabled="saving"
          @click="submit"
        >{{ t('tokens.create') }}</button>
      </div>

      <!-- 已签发列表 -->
      <div class="glass p-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ t('tokens.listTitle') }}</h2>
          <div class="flex items-center gap-3">
            <span class="text-xs text-slate-500">{{ t('tokens.count', { n: tokens.length }) }}</span>
            <button class="text-xs text-sky-400 hover:underline" @click="load">{{ t('common.refresh') }}</button>
          </div>
        </div>

        <Loading v-if="loading && !tokens.length" />
        <EmptyState v-else-if="!tokens.length">{{ t('tokens.empty') }}</EmptyState>
        <div v-else class="space-y-3">
          <div
            v-for="tok in tokens"
            :key="tok.id"
            class="rounded-lg border border-white/10 p-3 text-sm"
          >
            <div class="mb-1 flex items-center justify-between gap-2">
              <span class="font-semibold text-content">{{ tok.name }}</span>
              <span class="text-xs" :class="statusClass(tok)">{{ statusLabel(tok) }}</span>
            </div>
            <div class="space-y-0.5 text-xs text-slate-400">
              <div class="font-mono">{{ tok.id }} · {{ tok.scope }}</div>
              <div>
                {{ t('tokens.nodes') }}：
                <span v-if="!tok.agent_ids.length">{{ t('tokens.nodesAll') }}</span>
                <span v-else>{{ tok.agent_ids.map(agentName).join('、') }}</span>
              </div>
              <div>
                {{ t('tokens.lastUsed') }}：
                <span v-if="!tok.last_used_at">{{ t('tokens.neverUsed') }}</span>
                <span v-else>{{ fmtDate(tok.last_used_at) }}<span v-if="tok.last_used_ip" class="ml-1 font-mono">({{ tok.last_used_ip }})</span></span>
              </div>
              <div>
                {{ t('tokens.expiresAt') }}：
                <span v-if="!tok.expires_at">{{ t('tokens.neverExpires') }}</span>
                <span v-else>{{ fmtDate(tok.expires_at) }}</span>
              </div>
            </div>
            <button
              v-if="!tok.revoked"
              class="mt-2 rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
              :disabled="revokingId === tok.id"
              @click="revoke(tok)"
            >{{ t('tokens.revoke') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
