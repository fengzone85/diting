<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminApi } from '../../services/adminApi';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { t } from '../../composables/useI18n';
import type { Agent, InstallCommands, ModifyCommands, ChartPoint } from '../../services/types';
import ChartLatency from '../../components/ChartLatency.vue';
import FormInput from '../../components/ui/FormInput.vue';

const route = useRoute();
const router = useRouter();
const { state } = useAdmin();

const agentId = computed(() => String(route.params.id));
const agent = computed<Agent | undefined>(() =>
  state.agents.find((a) => a.id === agentId.value)
);

const loading = ref(false);
const saving = ref(false);
const message = ref('');
const error = ref('');

const form = ref<Partial<Agent>>({});
const commands = ref<{ install?: InstallCommands; modify?: ModifyCommands }>({});
const commandProbeTargets = ref('');
const newToken = ref('');
const showToken = ref(false);

const billingCycles = [
  { value: 0, key: 'free' },
  { value: 30, key: 'monthly' },
  { value: 60, key: 'biMonthly' },
  { value: 90, key: 'quarterly' },
  { value: 180, key: 'halfYear' },
  { value: 365, key: 'yearly' },
  { value: 730, key: 'twoYear' },
  { value: 1095, key: 'threeYear' },
];

const currencies = ['¥', '$', '€', '£'];

function resetForm(src?: Agent) {
  if (!src) {
    form.value = {};
    return;
  }
  form.value = {
    name: src.name,
    merchant: src.merchant,
    note: src.note,
    expire_at: src.expire_at,
    monthly_quota_gb: src.monthly_quota_gb,
    price: src.price,
    billing_cycle: src.billing_cycle ?? 30,
    currency: src.currency || '¥',
    auto_renewal: src.auto_renewal ?? false,
    group: src.group || src.grp || '',
    country: src.country || '',
    probe_targets: src.probe_targets || '',
  };
  commandProbeTargets.value = src.probe_targets || '';
}

watch(agent, (a) => resetForm(a), { immediate: true });

async function fetchCommands() {
  try {
    const res = await adminApi.getCommands(agentId.value, commandProbeTargets.value || undefined);
    commands.value = { install: res.install, modify: res.modify };
  } catch (e) {
    error.value = (e as Error).message || t('agent.loadCmdsFailed');
  }
}

onMounted(async () => {
  loading.value = true;
  try {
    await loadAdmin();
    await fetchCommands();
  } catch (e) {
    error.value = (e as Error).message || t('common.error');
  } finally {
    loading.value = false;
  }
});

async function save() {
  saving.value = true;
  message.value = '';
  error.value = '';
  try {
    await adminApi.updateAgent(agentId.value, form.value);
    message.value = t('agent.saved');
    await loadAdmin();
    await fetchCommands();
  } catch (e) {
    error.value = (e as Error).message || t('agent.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function resetToken() {
  if (!confirm(t('agent.resetConfirm'))) return;
  error.value = '';
  message.value = '';
  try {
    const res = await adminApi.resetToken(agentId.value);
    newToken.value = res.token;
    commands.value = { ...commands.value, install: res.install };
    message.value = t('agent.tokenReset');
  } catch (e) {
    error.value = (e as Error).message || t('agent.resetFailed');
  }
}

async function renew() {
  error.value = '';
  message.value = '';
  try {
    const res = await adminApi.renewAgent(agentId.value);
    form.value.expire_at = res.expire_at;
    await loadAdmin();
    message.value = t('agent.renewed', { date: res.expire_at });
  } catch (e) {
    error.value = (e as Error).message || t('agent.renewFailed');
  }
}

async function remove() {
  if (!confirm(t('agent.deleteConfirm'))) return;
  try {
    await adminApi.deleteAgent(agentId.value);
    await loadAdmin();
    router.push('/admin/agents');
  } catch (e) {
    error.value = (e as Error).message || t('agent.deleteFailed');
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    message.value = t('common.copied');
    setTimeout(() => (message.value = ''), 2000);
  });
}

// B7: 单 agent 历史趋势图
const chartRange = ref<'1h' | '6h' | '24h' | '7d' | '30d'>('6h');
const cpuTrend = ref<ChartPoint[]>([]);
const memTrend = ref<ChartPoint[]>([]);
const netTrend = ref<ChartPoint[]>([]);
const chartError = ref('');

function toPoints(rows: { ts: number; cpu?: number; mem_pct?: number; net_rx_rate?: number; net_tx_rate?: number }[]): void {
  cpuTrend.value = rows.map((r) => ({ t: r.ts * 1000, v: r.cpu ?? 0 }));
  memTrend.value = rows.map((r) => ({ t: r.ts * 1000, v: r.mem_pct ?? 0 }));
  netTrend.value = rows.map((r) => ({ t: r.ts * 1000, v: ((r.net_rx_rate || 0) + (r.net_tx_rate || 0)) / 1024 / 1024 }));
}

async function loadMetrics() {
  chartError.value = '';
  try {
    const rows = await adminApi.metrics(agentId.value, chartRange.value);
    toPoints(rows as { ts: number; cpu?: number; mem_pct?: number; net_rx_rate?: number; net_tx_rate?: number }[]);
  } catch (e) {
    chartError.value = t('agent.trendFailed', { msg: (e as Error).message || t('common.unknownError') });
  }
}

async function changeRange(r: '1h' | '6h' | '24h' | '7d' | '30d') {
  chartRange.value = r;
  await loadMetrics();
}

onMounted(async () => {
  loading.value = true;
  try {
    await loadAdmin();
    await fetchCommands();
    await loadMetrics();
  } catch (e) {
    error.value = (e as Error).message || t('common.error');
  } finally {
    loading.value = false;
  }
});

function formatDate(ts?: number) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center gap-3">
      <button class="text-sm text-slate-400 hover:text-white" @click="$router.push('/admin/agents')">← {{ t('agent.back') }}</button>
      <h1 class="text-2xl font-bold">{{ agent?.name || agentId }}</h1>
      <span
        class="rounded-full px-2 py-0.5 text-xs"
        :class="agent?.online ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'"
      >
        {{ agent?.online ? t('common.online') : t('common.offline') }}
      </span>
    </div>

    <div v-if="message" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
      {{ message }}
    </div>
    <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      {{ error }}
    </div>

    <div v-if="loading" class="py-12 text-center text-slate-400">{{ t('common.loading') }}</div>

    <div v-else class="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div class="xl:col-span-2 space-y-6">
        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">{{ t('agent.basicInfo') }}</h2>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormInput v-model="form.name" :label="t('common.name')" />
            <FormInput v-model="form.merchant" :label="t('agent.merchant')" />
            <FormInput v-model="form.group" :label="t('agent.group')" />
            <FormInput v-model="form.country" :label="t('agent.country')" placeholder="CN" />
            <div class="md:col-span-2">
              <FormInput v-model="form.note" :label="t('agent.note')" type="textarea" />
            </div>
          </div>
        </div>

        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">{{ t('agent.billing') }}</h2>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
            <FormInput v-model="form.price" :label="t('agent.price')" type="number" />
            <div>
              <label class="mb-1 block text-sm text-slate-400">{{ t('agent.currency') }}</label>
              <select v-model="form.currency" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
                <option v-for="c in currencies" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-sm text-slate-400">{{ t('agent.billingCycle') }}</label>
              <select v-model="form.billing_cycle" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
                <option v-for="opt in billingCycles" :key="opt.value" :value="opt.value">{{ t('agent.cycle.' + opt.key) }}</option>
              </select>
            </div>
            <FormInput v-model="form.expire_at" :label="t('agent.expireDate')" placeholder="YYYY-MM-DD" />
            <FormInput v-model="form.monthly_quota_gb" :label="t('agent.monthlyQuota')" type="number" />
            <div class="flex items-end">
              <label class="flex items-center gap-2 text-sm text-slate-300">
                <input v-model="form.auto_renewal" type="checkbox" class="h-4 w-4 rounded border-slate-700 bg-slate-900/50 text-sky-500" />
                {{ t('agent.autoRenew') }}
              </label>
            </div>
          </div>
          <div class="mt-4">
            <button class="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-300 hover:bg-sky-500/20" @click="renew">
              {{ t('agent.renewCycle') }}
            </button>
          </div>
        </div>

        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">{{ t('agent.probeTargets') }}</h2>
          <FormInput v-model="form.probe_targets" :label="t('agent.probeTargetsLabel')" type="textarea" />
          <p class="mb-4 text-xs text-slate-500">{{ t('agent.probeHint') }}</p>
          <div class="flex gap-3">
            <button :disabled="saving" class="rounded-lg bg-sky-500 px-6 py-2 text-white hover:bg-sky-400 disabled:opacity-50" @click="save">
              {{ saving ? t('agent.saving') : t('common.save') }}
            </button>
            <button class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:border-slate-500" @click="resetForm(agent)">
              {{ t('common.reset') }}
            </button>
            <button class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20" @click="remove">
              {{ t('common.delete') }}
            </button>
          </div>
        </div>
      </div>

      <div class="space-y-6">
        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">{{ t('agent.installCmds') }}</h2>
          <div class="mb-4">
            <label class="mb-1 block text-sm text-slate-400">{{ t('agent.cmdProbePreview') }}</label>
            <div class="flex gap-2">
              <input v-model="commandProbeTargets" class="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500" />
              <button class="rounded-lg bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600" @click="fetchCommands">{{ t('agent.refresh') }}</button>
            </div>
          </div>

          <div class="mb-4 space-y-3">
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">{{ t('agents.linux') }}</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.install?.native_cmd || '')">{{ t('common.copy') }}</button>
              </div>
              <textarea readonly rows="4" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.install?.native_cmd" />
            </div>
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">{{ t('agents.docker') }}</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.install?.docker_cmd || '')">{{ t('common.copy') }}</button>
              </div>
              <textarea readonly rows="4" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.install?.docker_cmd" />
            </div>
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">{{ t('agents.windows') }}</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.install?.windows_cmd || '')">{{ t('common.copy') }}</button>
              </div>
              <textarea readonly rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.install?.windows_cmd" />
            </div>
          </div>

          <div class="border-t border-slate-700 pt-4">
            <h3 class="mb-2 text-sm font-semibold">{{ t('agent.modifyProbeTargets') }}</h3>
            <div class="mb-2">
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">Linux</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.modify?.linux_cmd || '')">{{ t('common.copy') }}</button>
              </div>
              <textarea readonly rows="4" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.modify?.linux_cmd" />
            </div>
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">Windows</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.modify?.windows_cmd || '')">{{ t('common.copy') }}</button>
              </div>
              <textarea readonly rows="4" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.modify?.windows_cmd" />
            </div>
          </div>

          <div class="mt-4 border-t border-slate-700 pt-4">
            <button class="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-300 hover:bg-amber-500/20" @click="resetToken">
              {{ t('agent.resetTokenBtn') }}
            </button>
            <div v-if="newToken" class="mt-3">
              <label class="mb-1 block text-xs text-slate-400">{{ t('agent.newToken') }}</label>
              <div class="flex gap-2">
                <input :type="showToken ? 'text' : 'password'" readonly class="flex-1 rounded-lg border border-slate-700 bg-slate-900/30 px-3 py-2 text-xs text-slate-300" :value="newToken" />
                <button class="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white" @click="showToken = !showToken">{{ showToken ? t('common.hide') : t('common.show') }}</button>
                <button class="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white" @click="copy(newToken)">{{ t('common.copy') }}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="glass p-6">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-semibold">{{ t('agent.resourceTrend') }}</h2>
            <div class="flex gap-1 text-xs">
              <button v-for="r in (['1h','6h','24h','7d','30d'] as const)" :key="r" :class="chartRange === r ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-400'" class="rounded px-2 py-1 hover:opacity-80" @click="changeRange(r)">{{ r }}</button>
            </div>
          </div>
          <div v-if="chartError" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{{ chartError }}</div>
          <div class="grid grid-cols-1 gap-4">
            <ChartLatency :title="t('agent.chartCpu')" :data="cpuTrend" color="#38bdf8" />
            <ChartLatency :title="t('agent.chartMem')" :data="memTrend" color="#a78bfa" />
            <ChartLatency :title="t('agent.chartNet')" :data="netTrend" color="#34d399" />
          </div>
        </div>

        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">{{ t('agent.status') }}</h2>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between"><span class="text-slate-400">ID</span><span class="font-mono text-slate-200">{{ agent?.id }}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">{{ t('agent.os') }}</span><span class="text-slate-200">{{ agent?.os || '-' }}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">{{ t('node.hostname') }}</span><span class="text-slate-200">{{ agent?.hostname || '-' }}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">{{ t('agent.version') }}</span><span class="text-slate-200">{{ agent?.version || '-' }}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">{{ t('agent.lastSeen') }}</span><span class="text-slate-200">{{ formatDate(agent?.last_seen) }}</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
