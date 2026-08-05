<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
import { formatBytes, formatDuration } from '../../utils/format';
import type { InstallCommands } from '../../services/types';

const { state } = useAdmin();
const router = useRouter();
const newName = ref('');
const error = ref('');
const created = ref<{ id: string; token: string; install: InstallCommands } | null>(null);
const showToken = ref(false);

async function add() {
  error.value = '';
  created.value = null;
  const name = newName.value.trim();
  if (!name) {
    error.value = '请输入受控端名称';
    return;
  }
  try {
    const res = await adminApi.createAgent({ name });
    newName.value = '';
    created.value = { id: res.id, token: res.token, install: res.install };
    await loadAdmin();
  } catch (e) {
    error.value = (e as Error).message || '新增失败';
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    error.value = '已复制到剪贴板';
    setTimeout(() => (error.value = ''), 2000);
  });
}

async function remove(id: string) {
  if (!confirm('确认删除该受控端？')) return;
  try {
    await adminApi.deleteAgent(id);
    await loadAdmin();
  } catch (e) {
    error.value = (e as Error).message || '删除失败';
  }
}
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">受控端</h1>
    <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      {{ error }}
    </div>
    <div class="glass mb-6 p-4">
      <div class="flex gap-3">
        <input v-model="newName" placeholder="名称" class="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-white" @keyup.enter="add" />
        <button class="rounded-lg bg-sky-500 px-4 py-2 text-white hover:bg-sky-400" @click="add">新增</button>
      </div>
      <div v-if="created" class="mt-4 space-y-3 border-t border-slate-700 pt-4">
        <div class="flex items-center gap-3">
          <span class="text-sm text-emerald-300">已创建：{{ created.id }}</span>
          <span class="text-xs text-slate-500">首次返回的 Token 仅此一次可见</span>
        </div>
        <div class="flex gap-2">
          <input :type="showToken ? 'text' : 'password'" readonly class="flex-1 rounded-lg border border-slate-700 bg-slate-900/30 px-3 py-2 text-xs text-slate-300" :value="created.token" />
          <button class="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white" @click="showToken = !showToken">{{ showToken ? '隐藏' : '显示' }}</button>
          <button class="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white" @click="copy(created.token)">复制</button>
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between">
            <label class="text-xs text-slate-400">Linux 原生</label>
            <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.native_cmd)">复制</button>
          </div>
          <textarea readonly rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="created.install.native_cmd" />
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between">
            <label class="text-xs text-slate-400">Docker</label>
            <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.docker_cmd)">复制</button>
          </div>
          <textarea readonly rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="created.install.docker_cmd" />
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between">
            <label class="text-xs text-slate-400">Windows</label>
            <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.windows_cmd)">复制</button>
          </div>
          <textarea readonly rows="2" class="w-full rounded-lg border border-slate-700 bg-slate-900/30 p-2 text-xs text-slate-300" :value="created.install.windows_cmd" />
        </div>
      </div>
    </div>
    <div class="space-y-3">
      <div v-for="agent in state.agents" :key="agent.id" class="glass flex items-center justify-between p-4">
        <div>
          <p class="font-semibold">{{ agent.name }}</p>
          <p class="text-xs text-slate-500">{{ agent.id }} · {{ formatBytes(agent.latest?.mem_used) }} / {{ formatBytes(agent.latest?.mem_total) }} · {{ formatDuration(agent.latest?.uptime) }}</p>
        </div>
        <div class="flex gap-2">
          <button class="rounded-lg px-3 py-1 text-sm text-sky-400 hover:bg-sky-500/10" @click="router.push(`/admin/agents/${agent.id}`)">详情</button>
          <button class="rounded-lg px-3 py-1 text-sm text-rose-400 hover:bg-rose-500/10" @click="remove(agent.id)">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>
