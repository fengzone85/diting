<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
import { formatBytes, formatDuration } from '../../utils/format';
import { apiErrorMessage } from '../../utils/apiError';
import { useI18n } from '../../composables/useI18n';
import AgentBillingCard from '../../components/admin/AgentBillingCard.vue';
import { Delete, FileText, Refresh, Remind, Time } from '@icon-park/vue-next';
import type { InstallCommands, Agent, DeletedAgent } from '../../services/types';
import { publicApi } from '../../services/publicApi';

const { state } = useAdmin();
const router = useRouter();
const { t, locale } = useI18n();

// 列表行附加信息：分组（group/grp 两种字段名兼容）、agent 版本
const agentGroup = (a: Agent) => a.group || a.grp || '';
const agentVersion = (a: Agent) => (a.version ? `v${String(a.version).replace(/^v/i, '')}` : '');

// S5.3-4 版本差：受控端最新 Release tag（服务端 6h 缓存）。未知时为空 → 不渲染「可升级」徽标，
// 绝不把「查不到最新版」误显示成「已是最新」。
const agentLatest = ref('');
const normVer = (v: string) => String(v || '').replace(/^v/i, '').trim();
const isOutdated = (a: Agent) => {
  const latest = normVer(agentLatest.value);
  const cur = normVer(a.version || '');
  return !!latest && !!cur && latest !== cur;
};
onMounted(() => {
  publicApi.version()
    .then((info) => { agentLatest.value = info.agent_latest || info.data?.agent_latest || ''; })
    .catch(() => { agentLatest.value = ''; });
});

// 「位置」列：库里只存 ISO 3166-1 alpha-2 国家码，用 Intl.DisplayNames 反查当前语言下的地区名
const regionName = (code?: string) => {
  const cc = (code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  try {
    return new Intl.DisplayNames([locale.value], { type: 'region' }).of(cc) || cc;
  } catch {
    return cc;
  }
};

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
    if (showDeleted.value) await loadDeleted();
  } catch (e) {
    error.value = (e as Error).message || t('agents.deleteFailed');
  }
}

// F11：最近删除（软删节点，7 天缓冲期内可恢复）
const showDeleted = ref(false);
const deletedAgents = ref<DeletedAgent[]>([]);

async function loadDeleted() {
  try {
    deletedAgents.value = (await adminApi.listDeletedAgents()).items;
  } catch (e) {
    error.value = (e as Error).message || t('agents.deleteFailed');
  }
}

async function toggleDeleted() {
  showDeleted.value = !showDeleted.value;
  if (showDeleted.value) await loadDeleted();
}

async function restore(id: string) {
  if (!confirm(t('agents.restoreConfirm'))) return;
  try {
    await adminApi.restoreAgent(id);
    await Promise.all([loadDeleted(), loadAdmin()]);
    error.value = t('agents.restored');
    setTimeout(() => (error.value = ''), 2500);
  } catch (e) {
    error.value = (e as Error).message || t('agents.restoreFailed');
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

    <!-- F11: 最近删除（7 天缓冲期内可恢复） -->
    <div class="mb-4 flex items-center justify-between">
      <button class="text-xs text-slate-400 hover:text-sky-300" @click="toggleDeleted">
        {{ showDeleted ? t('agents.deletedHide') : t('agents.deletedToggle') }}
      </button>
      <span v-if="showDeleted" class="text-xs text-slate-500">{{ t('agents.deletedHint') }}</span>
    </div>
    <div v-if="showDeleted" class="glass mb-4 p-4">
      <div v-if="!deletedAgents.length" class="text-xs text-slate-500">{{ t('agents.deletedEmpty') }}</div>
      <ul v-else class="space-y-2">
        <li v-for="d in deletedAgents" :key="d.id" class="flex items-center justify-between gap-3 text-sm">
          <span class="truncate text-slate-300">
            {{ d.name }}<span class="ml-2 text-xs text-slate-500">{{ d.id }}</span>
          </span>
          <span class="flex shrink-0 items-center gap-3">
            <span class="text-xs text-amber-300">{{ t('agents.daysLeft', { n: d.days_left }) }}</span>
            <button class="rounded-lg bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500" @click="restore(d.id)">
              {{ t('agents.restore') }}
            </button>
          </span>
        </li>
      </ul>
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
    <!-- 表格形态（对齐 Komari 后台服务器列表的列）：
         显示名称 / 国旗 / 客户端版本 / 分组 / 私有备注 / 账单 + 操作 -->
    <div v-else class="glass overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[900px] text-sm">
          <thead>
            <tr class="border-b border-slate-700 text-left text-xs text-slate-500">
              <th class="w-10 px-4 py-3"></th>
              <th class="px-3 py-3 font-medium">{{ t('agents.colName') }}</th>
              <th class="w-32 px-3 py-3 font-medium">{{ t('agents.colLocation') }}</th>
              <th class="w-28 px-3 py-3 font-medium">{{ t('agents.colVersion') }}</th>
              <th class="w-28 px-3 py-3 font-medium">{{ t('agents.colGroup') }}</th>
              <th class="px-3 py-3 font-medium">{{ t('agents.colNote') }}</th>
              <th class="w-16 px-3 py-3 font-medium">{{ t('agents.colBilling') }}</th>
              <th class="px-4 py-3 text-right font-medium">{{ t('agents.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="agent in filtered"
              :key="agent.id"
              class="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/40"
              :class="selected.has(agent.id) ? 'bg-sky-500/5' : ''"
            >
              <td class="px-4 py-3 align-middle">
                <input type="checkbox" :checked="selected.has(agent.id)" @change="toggleOne(agent.id)" class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500" />
              </td>
              <td class="px-3 py-3 align-middle">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate font-semibold">{{ agent.name }}</span>
                  <span v-if="agent.alert?.muted" class="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-normal text-rose-300">{{ t('common.muted') }}</span>
                  <span v-else-if="agent.alert?.overridden" class="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-normal text-violet-300">{{ t('common.custom') }}</span>
                </div>
                <p class="truncate text-xs text-slate-500">{{ agent.id }} · {{ formatBytes(agent.latest?.mem_used) }} / {{ formatBytes(agent.latest?.mem_total) }} · {{ formatDuration(agent.latest?.uptime) }}</p>
              </td>
              <td class="px-3 py-3 align-middle">
                <div v-if="agent.country" class="flex items-center gap-2">
                  <img
                    :src="`/flags/${agent.country.toLowerCase()}.svg`"
                    :alt="agent.country"
                    :title="agent.country.toUpperCase()"
                    class="h-4 w-6 flex-shrink-0 rounded-sm object-cover"
                    @error="(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')"
                  />
                  <span class="truncate text-xs text-slate-400">{{ regionName(agent.country) }}</span>
                </div>
                <span v-else class="text-slate-500">—</span>
              </td>
              <td class="px-3 py-3 align-middle">
                <span v-if="agentVersion(agent)" class="rounded bg-slate-700/50 px-1.5 py-0.5 text-[11px] text-slate-300">{{ agentVersion(agent) }}</span>
                <span v-else class="text-slate-500">—</span>
                <!-- 落后于最新 Release：整卡描边 + 徽标（比颜色更易读，色弱友好） -->
                <span
                  v-if="isOutdated(agent)"
                  class="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-400/40"
                  :title="t('agent.upgradeAvailable') + ' ' + agentLatest"
                >{{ t('agent.upgradeBadge') }}</span>
              </td>
              <td class="px-3 py-3 align-middle">
                <span v-if="agentGroup(agent)" class="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300">{{ agentGroup(agent) }}</span>
                <span v-else class="text-slate-500">—</span>
              </td>
              <td class="max-w-[220px] px-3 py-3 align-middle">
                <span v-if="agent.note" class="block truncate text-xs text-slate-400" :title="agent.note">{{ agent.note }}</span>
                <span v-else class="text-slate-500">—</span>
              </td>
              <td class="px-3 py-3 align-middle">
                <!-- 账单：图标 + 弹出账单卡片（价格/货币/周期/到期时间含「长期」/自动续费） -->
                <AgentBillingCard :agent="agent" @saved="loadAdmin" />
              </td>
              <td class="px-4 py-3 align-middle">
                <div class="flex items-center justify-end gap-1">
                  <button class="flex h-7 w-7 items-center justify-center rounded-lg text-violet-400 hover:bg-violet-500/10" :title="t('agents.alert')" :aria-label="t('agents.alert')" @click="openAlert(agent)">
                    <Remind :size="16" theme="outline" />
                  </button>
                  <button class="flex h-7 w-7 items-center justify-center rounded-lg text-sky-400 hover:bg-sky-500/10" :title="t('common.detail')" :aria-label="t('common.detail')" @click="router.push(`/admin/agents/${agent.id}`)">
                    <FileText :size="16" theme="outline" />
                  </button>
                  <button class="flex h-7 w-7 items-center justify-center rounded-lg text-amber-400 hover:bg-amber-500/10" :title="t('common.reset')" :aria-label="t('common.reset')" @click="resetToken(agent.id)">
                    <Refresh :size="16" theme="outline" />
                  </button>
                  <button class="flex h-7 w-7 items-center justify-center rounded-lg text-emerald-400 hover:bg-emerald-500/10" :title="t('common.renew')" :aria-label="t('common.renew')" @click="renew(agent.id)">
                    <Time :size="16" theme="outline" />
                  </button>
                  <button class="flex h-7 w-7 items-center justify-center rounded-lg text-rose-400 hover:bg-rose-500/10" :title="t('common.delete')" :aria-label="t('common.delete')" @click="remove(agent.id)">
                    <Delete :size="16" theme="outline" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
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
