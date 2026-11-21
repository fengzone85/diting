<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
import { publicApi } from '../../services/publicApi';
import { useI18n } from '../../composables/useI18n';
import PageShell from '../../components/admin/PageShell.vue';
import AgentCreatePanel from '../../components/admin/agents/AgentCreatePanel.vue';
import AgentVersionPanel from '../../components/admin/agents/AgentVersionPanel.vue';
import AgentFilterBar from '../../components/admin/agents/AgentFilterBar.vue';
import AgentDeletedList from '../../components/admin/agents/AgentDeletedList.vue';
import AgentBatchBar from '../../components/admin/agents/AgentBatchBar.vue';
import AgentTable from '../../components/admin/agents/AgentTable.vue';
import AgentAlertDialog from '../../components/admin/agents/AgentAlertDialog.vue';
import AgentDistributionDrawer from '../../components/admin/agents/AgentDistributionDrawer.vue';
import type { AgentSortKey } from '../../components/admin/agents/types';
import type { Agent, AgentVersionSummary, DeletedAgent } from '../../services/types';

const { state } = useAdmin();
const { t } = useI18n();

const error = ref('');
// P2-5：成功提示走独立 info 通道（绿色），不再借用 error 通道显示「已复制」
const info = ref('');

function setError(message: string) {
  error.value = message;
}

function showInfo(message: string, ms = 2000) {
  info.value = message;
  setTimeout(() => (info.value = ''), ms);
}

// S5.3-4 版本差：受控端最新 Release tag（服务端 6h 缓存）。未知时为空 → 不渲染「可升级」徽标，
// 绝不把「查不到最新版」误显示成「已是最新」。
const agentLatest = ref('');
// 版本汇总（表格状态点 + 汇总条共用；10s 刷新与列表同频）
const versionSummary = ref<AgentVersionSummary | null>(null);
let versionTimer: ReturnType<typeof setInterval> | null = null;

async function loadVersions() {
  try {
    versionSummary.value = await adminApi.getAgentVersions();
  } catch {
    // 汇总失败不影响列表主体（老服务端无此端点时静默降级为「无状态点」）
  }
}

onMounted(() => {
  publicApi.version()
    .then((info) => { agentLatest.value = info.agent_latest || info.data?.agent_latest || ''; })
    .catch(() => { agentLatest.value = ''; });
  loadVersions();
  versionTimer = setInterval(loadVersions, 10000);
});

onUnmounted(() => {
  if (versionTimer) {
    clearInterval(versionTimer);
    versionTimer = null;
  }
});

// B3: 搜索 / 排序 / 批量
const search = ref('');
const sortKey = ref<AgentSortKey>('name');
const selected = ref<Set<string>>(new Set());
const selectedIds = computed(() => [...selected.value]);

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
    showInfo(t('agents.restored'), 2500);
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
// 表单与拉取逻辑在 AgentAlertDialog 内；这里只维护「当前打开的节点」。
const alertTarget = ref<Agent | null>(null);

function openAlert(a: Agent) {
  alertTarget.value = a;
}

function closeAlert() {
  alertTarget.value = null;
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

// ---- D 阶段：一键批量分发抽屉 ----
// 服务端只**生成分发物**（脚本 + 二进制 + 校验和 + manifest）与一条一次性下载命令；
// **不主动连接节点、不下发任何指令**——命令需管理员在目标节点上以 root/管理员权限执行。
const distOpen = ref(false);

function openDist() {
  distOpen.value = true;
}
</script>

<template>
  <PageShell :title="t('agents.title')">
    <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      {{ error }}
    </div>
    <div v-if="info" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
      {{ info }}
    </div>

    <AgentCreatePanel @error="setError" @info="showInfo" />

    <AgentVersionPanel
      :summary="versionSummary"
      @error="setError"
      @refresh="loadVersions"
    />

    <AgentFilterBar
      v-model:search="search"
      v-model:sort-key="sortKey"
      :all-selected="allSelected"
      @toggle-all="toggleAll"
    />

    <AgentDeletedList
      :open="showDeleted"
      :agents="deletedAgents"
      @toggle="toggleDeleted"
      @restore="restore"
    />

    <AgentBatchBar
      :count="selected.size"
      @delete="batchRemove"
      @reset="batchResetToken"
      @renew="batchRenew"
      @distribute="openDist"
      @clear="selected = new Set()"
    />

    <AgentTable
      :agents="filtered"
      :selected="selected"
      :search="search"
      :agent-latest="agentLatest"
      :version-summary="versionSummary"
      @toggle-one="toggleOne"
      @alert="openAlert"
      @reset="resetToken"
      @renew="renew"
      @remove="remove"
      @refresh="loadAdmin"
    />

    <AgentAlertDialog
      :agent="alertTarget"
      @close="closeAlert"
      @error="setError"
    />
  </PageShell>

  <AgentDistributionDrawer
    :open="distOpen"
    :agent-ids="selectedIds"
    @close="distOpen = false"
  />
</template>
