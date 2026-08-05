<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminApi } from '../../services/adminApi';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import type { Agent, InstallCommands, ModifyCommands } from '../../services/types';
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
  { value: 0, label: '免费' },
  { value: 30, label: '月付' },
  { value: 60, label: '双月付' },
  { value: 90, label: '季付' },
  { value: 180, label: '半年付' },
  { value: 365, label: '年付' },
  { value: 730, label: '两年付' },
  { value: 1095, label: '三年付' },
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
    error.value = (e as Error).message || '加载命令失败';
  }
}

onMounted(async () => {
  loading.value = true;
  try {
    await loadAdmin();
    await fetchCommands();
  } catch (e) {
    error.value = (e as Error).message || '加载失败';
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
    message.value = '保存成功';
    await loadAdmin();
    await fetchCommands();
  } catch (e) {
    error.value = (e as Error).message || '保存失败';
  } finally {
    saving.value = false;
  }
}

async function resetToken() {
  if (!confirm('重置 Token 会使旧 Token 立即失效，受控端需使用新 Token 重新接入。是否继续？')) return;
  error.value = '';
  message.value = '';
  try {
    const res = await adminApi.resetToken(agentId.value);
    newToken.value = res.token;
    commands.value = { ...commands.value, install: res.install };
    message.value = 'Token 已重置';
  } catch (e) {
    error.value = (e as Error).message || '重置失败';
  }
}

async function renew() {
  error.value = '';
  message.value = '';
  try {
    const res = await adminApi.renewAgent(agentId.value);
    form.value.expire_at = res.expire_at;
    await loadAdmin();
    message.value = `已续费，新到期日 ${res.expire_at}`;
  } catch (e) {
    error.value = (e as Error).message || '续费失败';
  }
}

async function remove() {
  if (!confirm('删除后该节点所有历史数据将无法恢复，是否继续？')) return;
  try {
    await adminApi.deleteAgent(agentId.value);
    await loadAdmin();
    router.push('/admin/agents');
  } catch (e) {
    error.value = (e as Error).message || '删除失败';
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    message.value = '已复制到剪贴板';
    setTimeout(() => (message.value = ''), 2000);
  });
}

function formatDate(ts?: number) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center gap-3">
      <button class="text-sm text-slate-400 hover:text-white" @click="$router.push('/admin/agents')">← 返回列表</button>
      <h1 class="text-2xl font-bold">{{ agent?.name || agentId }}</h1>
      <span
        class="rounded-full px-2 py-0.5 text-xs"
        :class="agent?.online ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'"
      >
        {{ agent?.online ? '在线' : '离线' }}
      </span>
    </div>

    <div v-if="message" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
      {{ message }}
    </div>
    <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      {{ error }}
    </div>

    <div v-if="loading" class="py-12 text-center text-slate-400">加载中...</div>

    <div v-else class="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div class="xl:col-span-2 space-y-6">
        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">基本信息</h2>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormInput v-model="form.name" label="名称" />
            <FormInput v-model="form.merchant" label="商家" />
            <FormInput v-model="form.group" label="分组" />
            <FormInput v-model="form.country" label="国家代码 (ISO 3166-1 alpha-2)" placeholder="CN" />
            <div class="md:col-span-2">
              <FormInput v-model="form.note" label="备注" type="textarea" />
            </div>
          </div>
        </div>

        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">计费</h2>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
            <FormInput v-model="form.price" label="价格" type="number" />
            <div>
              <label class="mb-1 block text-sm text-slate-400">货币</label>
              <select v-model="form.currency" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
                <option v-for="c in currencies" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-sm text-slate-400">计费周期</label>
              <select v-model="form.billing_cycle" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
                <option v-for="opt in billingCycles" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </div>
            <FormInput v-model="form.expire_at" label="到期日" placeholder="YYYY-MM-DD" />
            <FormInput v-model="form.monthly_quota_gb" label="月流量配额 (GB)" type="number" />
            <div class="flex items-end">
              <label class="flex items-center gap-2 text-sm text-slate-300">
                <input v-model="form.auto_renewal" type="checkbox" class="h-4 w-4 rounded border-slate-700 bg-slate-900/50 text-sky-500" />
                自动续费
              </label>
            </div>
          </div>
          <div class="mt-4">
            <button class="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-300 hover:bg-sky-500/20" @click="renew">
              手动续费一个周期
            </button>
          </div>
        </div>

        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">探测目标</h2>
          <FormInput v-model="form.probe_targets" label="探针目标（label:host[:port] 逗号分隔）" type="textarea" />
          <p class="mb-4 text-xs text-slate-500">保存后将更新该受控端的探测目标，已部署的受控端需使用下方的「修改探测目标命令」重新应用。</p>
          <div class="flex gap-3">
            <button :disabled="saving" class="rounded-lg bg-sky-500 px-6 py-2 text-white hover:bg-sky-400 disabled:opacity-50" @click="save">
              {{ saving ? '保存中...' : '保存' }}
            </button>
            <button class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:border-slate-500" @click="resetForm(agent)">
              重置
            </button>
            <button class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20" @click="remove">
              删除
            </button>
          </div>
        </div>
      </div>

      <div class="space-y-6">
        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">接入命令</h2>
          <div class="mb-4">
            <label class="mb-1 block text-sm text-slate-400">命令探针目标预览</label>
            <div class="flex gap-2">
              <input v-model="commandProbeTargets" class="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500" />
              <button class="rounded-lg bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600" @click="fetchCommands">刷新</button>
            </div>
          </div>

          <div class="mb-4 space-y-3">
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">Linux 原生</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.install?.native_cmd || '')">复制</button>
              </div>
              <textarea readonly rows="4" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.install?.native_cmd" />
            </div>
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">Docker</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.install?.docker_cmd || '')">复制</button>
              </div>
              <textarea readonly rows="4" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.install?.docker_cmd" />
            </div>
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">Windows</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.install?.windows_cmd || '')">复制</button>
              </div>
              <textarea readonly rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.install?.windows_cmd" />
            </div>
          </div>

          <div class="border-t border-slate-700 pt-4">
            <h3 class="mb-2 text-sm font-semibold">修改探测目标</h3>
            <div class="mb-2">
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">Linux</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.modify?.linux_cmd || '')">复制</button>
              </div>
              <textarea readonly rows="4" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.modify?.linux_cmd" />
            </div>
            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="text-xs text-slate-400">Windows</label>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(commands.modify?.windows_cmd || '')">复制</button>
              </div>
              <textarea readonly rows="4" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="commands.modify?.windows_cmd" />
            </div>
          </div>

          <div class="mt-4 border-t border-slate-700 pt-4">
            <button class="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-300 hover:bg-amber-500/20" @click="resetToken">
              重置 Agent Token
            </button>
            <div v-if="newToken" class="mt-3">
              <label class="mb-1 block text-xs text-slate-400">新 Token</label>
              <div class="flex gap-2">
                <input :type="showToken ? 'text' : 'password'" readonly class="flex-1 rounded-lg border border-slate-700 bg-slate-900/30 px-3 py-2 text-xs text-slate-300" :value="newToken" />
                <button class="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white" @click="showToken = !showToken">{{ showToken ? '隐藏' : '显示' }}</button>
                <button class="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white" @click="copy(newToken)">复制</button>
              </div>
            </div>
          </div>
        </div>

        <div class="glass p-6">
          <h2 class="mb-4 text-lg font-semibold">状态</h2>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between"><span class="text-slate-400">ID</span><span class="font-mono text-slate-200">{{ agent?.id }}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">系统</span><span class="text-slate-200">{{ agent?.os || '-' }}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">主机名</span><span class="text-slate-200">{{ agent?.hostname || '-' }}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">版本</span><span class="text-slate-200">{{ agent?.version || '-' }}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">最后在线</span><span class="text-slate-200">{{ formatDate(agent?.last_seen) }}</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
