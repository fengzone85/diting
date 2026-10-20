<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
import { formatBytes, formatDuration } from '../../utils/format';
import { apiErrorMessage } from '../../utils/apiError';
import { useI18n } from '../../composables/useI18n';
import type { InstallCommands, Agent } from '../../services/types';

const { state } = useAdmin();
const router = useRouter();
const { t } = useI18n();

const newName = ref('');
const error = ref('');
const created = ref<{ id: string; token: string; install: InstallCommands } | null>(null);
const showToken = ref(false);

// B3: 搜索 / 排序 / 批量
const search = ref('');
const sortKey = ref<'name' | 'cpu' | 'mem' | 'status'>('name');
const selected = ref<Set<string>>(new Set());

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = state.agents;
  if (q) {
    list = list.filter(
      (a) => a.name?.toLowerCase().includes(q) || a.id?.toLowerCase().includes(q)
    );
  }
  const arr = [...list];
  switch (sortKey.value) {
    case 'cpu':
      arr.sort((a, b) => (b.latest?.cpu ?? -1) - (a.latest?.cpu ?? -1));
      break;
    case 'mem':
      arr.sort((a, b) => (b.latest?.mem_pct ?? -1) - (a.latest?.mem_pct ?? -1));
      break;
    case 'status':
      arr.sort((a, b) => Number(b.online ?? false) - Number(a.online ?? false));
      break;
    case 'name':
    default:
      arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      break;
  }
  return arr;
});

const allSelected = computed(
  () => filtered.value.length > 0 && filtered.value.every((a) => selected.value.has(a.id))
);

function toggleAll() {
  if (allSelected.value) {
    selected.value = new Set();
  } else {
    selected.value = new Set(filtered.value.map((a) => a.id));
  }
}

function toggleOne(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

async function add() {
  error.value = '';
  created.value = null;
  const name = newName.value.trim();
  if (!name) {
    error.value = t('agents.nameRequired');
    return;
  }
  try {
    const res = await adminApi.createAgent({ name });
    newName.value = '';
    created.value = { id: res.id, token: res.token, install: res.install };
    await loadAdmin();
  } catch (e) {
    error.value = apiErrorMessage(e, 'agents.addFailed');
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    error.value = t('common.copied');
    setTimeout(() => (error.value = ''), 2000);
  });
}

async function remove(id: string) {
  if (!confirm(t('agents.deleteConfirm'))) return;
  try {
    await adminApi.deleteAgent(id);
    selected.value.delete(id);
    await loadAdmin();
  } catch (e) {
    error.value = (e as Error).message || t('agents.deleteFailed');
  }
}

async function resetToken(id: string) {
  if (!confirm(t('agents.resetConfirm'))) return;
  try {
    await adminApi.resetToken(id);
    await loadAdmin();
  } catch (e) {
    error.value = (e as Error).message || t('agents.resetFailed');
  }
}

async function renew(id: string) {
  try {
    await adminApi.renewAgent(id);
    await loadAdmin();
  } catch (e) {
    error.value = (e as Error).message || t('agents.renewFailed');
  }
}

// ---- S1/F1：节点告警阈值覆盖 ----
// 语义：输入留空 = 继承上层（分组 → 全局），占位符展示当前生效值；
// 保存只提交已填写的字段（空 → null），不会把全局值固化到节点。
const alertTarget = ref<Agent | null>(null);
const alertBusy = ref(false);
const alertForm = ref({
  cpu_pct: '', mem_pct: '', disk_pct: '', temp_c: '', offline_sec: '', cooldown: '', muted: false
});
type AlertFieldKey = 'cpu_pct' | 'mem_pct' | 'disk_pct' | 'temp_c' | 'offline_sec' | 'cooldown';
const ALERT_FIELDS: AlertFieldKey[] = ['cpu_pct', 'mem_pct', 'disk_pct', 'temp_c', 'offline_sec', 'cooldown'];
const alertFieldRows = computed(() => [
  { key: 'cpu_pct' as AlertFieldKey, label: t('agents.cpuThreshold') },
  { key: 'mem_pct' as AlertFieldKey, label: t('agents.memThreshold') },
  { key: 'disk_pct' as AlertFieldKey, label: t('agents.diskThreshold') },
  { key: 'temp_c' as AlertFieldKey, label: t('agents.tempThreshold') },
  { key: 'offline_sec' as AlertFieldKey, label: t('agents.offlineThreshold') },
  { key: 'cooldown' as AlertFieldKey, label: t('agents.cooldownThreshold') }
]);

function effectiveAlert(key: AlertFieldKey): string {
  const v = alertTarget.value?.alert?.effective?.[key];
  return v === undefined || v === null ? '' : String(v);
}

async function openAlert(a: Agent) {
  alertTarget.value = a;
  alertForm.value = {
    cpu_pct: '', mem_pct: '', disk_pct: '', temp_c: '', offline_sec: '', cooldown: '',
    muted: !!a.alert?.muted
  };
  try {
    const rules = await adminApi.listAlertRules();
    const ov = rules.agents.find((x) => x.agent_id === a.id);
    if (ov) {
      for (const k of ALERT_FIELDS) {
        const v = ov[k];
        if (v !== null && v !== undefined) alertForm.value[k] = String(v);
      }
      alertForm.value.muted = !!ov.muted;
    }
  } catch (e) {
    error.value = apiErrorMessage(e, 'agents.alertLoadFailed');
  }
}

async function saveAlert() {
  if (!alertTarget.value) return;
  alertBusy.value = true;
  try {
    const payload: Record<string, unknown> = { muted: alertForm.value.muted };
    for (const k of ALERT_FIELDS) {
      const raw = String(alertForm.value[k] ?? '').trim();
      payload[k] = raw === '' ? null : Number(raw);
    }
    await adminApi.setAgentAlertRule(alertTarget.value.id, payload);
    await loadAdmin();
    alertTarget.value = null;
  } catch (e) {
    error.value = apiErrorMessage(e, 'agents.alertSaveFailed');
  } finally {
    alertBusy.value = false;
  }
}

async function resetAlert() {
  if (!alertTarget.value) return;
  if (!confirm(t('agents.alertResetConfirm'))) return;
  alertBusy.value = true;
  try {
    await adminApi.resetAgentAlertRule(alertTarget.value.id);
    await loadAdmin();
    alertTarget.value = null;
  } catch (e) {
    error.value = apiErrorMessage(e, 'agents.alertSaveFailed');
  } finally {
    alertBusy.value = false;
  }
}

async function batchRemove() {
  const ids = [...selected.value];
  if (!ids.length) return;
  if (!confirm(t('agents.batchDeleteConfirm', { n: ids.length }))) return;
  let ok = 0;
  for (const id of ids) {
    try {
      await adminApi.deleteAgent(id);
      ok++;
    } catch (e) {
      error.value = t('agents.partialDeleteFailed', { msg: (e as Error).message });
    }
  }
  selected.value = new Set();
  await loadAdmin();
  if (!error.value) error.value = t('agents.batchDeleted', { n: ok });
  setTimeout(() => (error.value = ''), 2500);
}

async function batchResetToken() {
  const ids = [...selected.value];
  if (!ids.length) return;
  if (!confirm(t('agents.batchResetConfirm', { n: ids.length }))) return;
  for (const id of ids) {
    try {
      await adminApi.resetToken(id);
    } catch (e) {
      error.value = t('agents.partialResetFailed', { msg: (e as Error).message });
    }
  }
  selected.value = new Set();
  await loadAdmin();
  if (!error.value) error.value = t('agents.batchResetDone', { n: ids.length });
  setTimeout(() => (error.value = ''), 2500);
}

async function batchRenew() {
  const ids = [...selected.value];
  if (!ids.length) return;
  for (const id of ids) {
    try {
      await adminApi.renewAgent(id);
    } catch (e) {
      error.value = t('agents.partialRenewFailed', { msg: (e as Error).message });
    }
  }
  selected.value = new Set();
  await loadAdmin();
  if (!error.value) error.value = t('agents.batchRenewDone', { n: ids.length });
  setTimeout(() => (error.value = ''), 2500);
}
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">{{ t('agents.title') }}</h1>
    <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      {{ error }}
    </div>

    <div class="glass mb-6 p-4">
      <div class="flex gap-3">
        <input v-model="newName" :placeholder="t('common.name')" class="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-white" @keyup.enter="add" />
        <button class="rounded-lg bg-sky-500 px-4 py-2 text-white hover:bg-sky-400" @click="add">{{ t('agents.add') }}</button>
      </div>
      <div v-if="created" class="mt-4 space-y-3 border-t border-slate-700 pt-4">
        <div class="flex items-center gap-3">
          <span class="text-sm text-emerald-300">{{ t('agents.created', { id: created.id }) }}</span>
          <span class="text-xs text-slate-500">{{ t('agents.tokenOnce') }}</span>
        </div>
        <div class="flex gap-2">
          <input :type="showToken ? 'text' : 'password'" readonly class="flex-1 rounded-lg border border-slate-700 bg-slate-900/30 px-3 py-2 text-xs text-slate-300" :value="created.token" />
          <button class="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white" @click="showToken = !showToken">{{ showToken ? t('common.hide') : t('common.show') }}</button>
          <button class="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white" @click="copy(created.token)">{{ t('common.copy') }}</button>
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between">
            <label class="text-xs text-slate-400">{{ t('agents.linux') }}</label>
            <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.native_cmd)">{{ t('common.copy') }}</button>
          </div>
          <textarea readonly rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="created.install.native_cmd" />
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between">
            <label class="text-xs text-slate-400">{{ t('agents.docker') }}</label>
            <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.docker_cmd)">{{ t('common.copy') }}</button>
          </div>
          <textarea readonly rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="created.install.docker_cmd" />
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between">
            <label class="text-xs text-slate-400">{{ t('agents.windows') }}</label>
            <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.windows_cmd)">{{ t('common.copy') }}</button>
          </div>
          <textarea readonly rows="2" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="created.install.windows_cmd" />
        </div>
      </div>
    </div>

    <!-- B3: 工具栏 搜索 / 排序 / 批量 -->
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <input v-model="search" :placeholder="t('agents.searchPlaceholder')" class="flex-1 min-w-[160px] rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white" />
      <select v-model="sortKey" class="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
        <option value="name">{{ t('agents.sortByName') }}</option>
        <option value="cpu">{{ t('agents.sortByCpu') }}</option>
        <option value="mem">{{ t('agents.sortByMem') }}</option>
        <option value="status">{{ t('agents.sortByStatus') }}</option>
      </select>
      <label class="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
        <input type="checkbox" :checked="allSelected" @change="toggleAll" class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500" />
        {{ t('agents.selectAll') }}
      </label>
    </div>

    <div v-if="selected.size" class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
      <span class="text-sm text-sky-200">{{ t('agents.selected', { n: selected.size }) }}</span>
      <button class="rounded-lg bg-rose-600 px-3 py-1 text-xs text-white hover:bg-rose-500" @click="batchRemove">{{ t('agents.batchDelete') }}</button>
      <button class="rounded-lg bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-500" @click="batchResetToken">{{ t('agents.batchReset') }}</button>
      <button class="rounded-lg bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500" @click="batchRenew">{{ t('agents.batchRenew') }}</button>
      <button class="rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800" @click="selected = new Set()">{{ t('common.cancel') }}</button>
    </div>

    <div v-if="!filtered.length" class="glass p-8 text-center text-sm text-slate-500">
      {{ search ? t('agents.noMatch') : t('agents.empty') }}
    </div>
    <div v-else class="space-y-3">
      <div
        v-for="agent in filtered"
        :key="agent.id"
        class="glass flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
        :class="selected.has(agent.id) ? 'ring-1 ring-sky-500/50' : ''"
      >
        <div class="flex min-w-0 items-center gap-3">
          <input type="checkbox" :checked="selected.has(agent.id)" @change="toggleOne(agent.id)" class="h-4 w-4 flex-shrink-0 rounded border-slate-600 bg-slate-800 text-sky-500" />
          <div class="min-w-0">
            <p class="truncate font-semibold">
              {{ agent.name }}
              <span v-if="agent.alert?.muted" class="ml-2 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-normal text-rose-300">{{ t('common.muted') }}</span>
              <span v-else-if="agent.alert?.overridden" class="ml-2 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-normal text-violet-300">{{ t('common.custom') }}</span>
            </p>
            <p class="truncate text-xs text-slate-500">{{ agent.id }} · {{ formatBytes(agent.latest?.mem_used) }} / {{ formatBytes(agent.latest?.mem_total) }} · {{ formatDuration(agent.latest?.uptime) }}</p>
          </div>
        </div>
        <div class="flex flex-shrink-0 gap-2">
          <button class="rounded-lg px-3 py-1 text-sm text-violet-400 hover:bg-violet-500/10" @click="openAlert(agent)">{{ t('agents.alert') }}</button>
          <button class="rounded-lg px-3 py-1 text-sm text-sky-400 hover:bg-sky-500/10" @click="router.push(`/admin/agents/${agent.id}`)">{{ t('common.detail') }}</button>
          <button class="rounded-lg px-3 py-1 text-sm text-amber-400 hover:bg-amber-500/10" @click="resetToken(agent.id)">{{ t('common.reset') }}</button>
          <button class="rounded-lg px-3 py-1 text-sm text-emerald-400 hover:bg-emerald-500/10" @click="renew(agent.id)">{{ t('common.renew') }}</button>
          <button class="rounded-lg px-3 py-1 text-sm text-rose-400 hover:bg-rose-500/10" @click="remove(agent.id)">{{ t('common.delete') }}</button>
        </div>
      </div>
    </div>

    <!-- S1/F1：告警阈值覆盖弹窗（留空 = 继承） -->
    <div
      v-if="alertTarget"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="alertTarget = null"
    >
      <div class="glass w-full max-w-lg p-5">
        <div class="mb-1 flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ t('agents.alertTitle', { name: alertTarget.name }) }}</h2>
          <button class="text-slate-400 hover:text-white" @click="alertTarget = null">✕</button>
        </div>
        <p class="mb-4 text-xs text-slate-500">{{ t('agents.alertInheritHint') }}</p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label v-for="f in alertFieldRows" :key="f.key" class="text-xs text-slate-400">
            {{ f.label }}
            <input
              v-model="alertForm[f.key]"
              type="number"
              :placeholder="effectiveAlert(f.key)"
              class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white"
            />
          </label>
        </div>
        <label class="mt-4 flex cursor-pointer items-center gap-2 text-sm text-slate-300">
          <input v-model="alertForm.muted" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-rose-500" />
          {{ t('agents.alertMuted') }}
        </label>
        <div class="mt-5 flex justify-end gap-2">
          <button class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800" @click="alertTarget = null">{{ t('common.cancel') }}</button>
          <button class="rounded-lg bg-amber-600 px-4 py-2 text-sm text-white hover:bg-amber-500 disabled:opacity-50" :disabled="alertBusy" @click="resetAlert">{{ t('agents.alertReset') }}</button>
          <button class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400 disabled:opacity-50" :disabled="alertBusy" @click="saveAlert">{{ t('agents.alertSave') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
