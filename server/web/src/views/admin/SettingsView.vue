<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';

const { state } = useAdmin();
const saving = ref(false);
const message = ref('');
const local = ref<Record<string, string>>({});

watch(() => state.settings, (s) => {
  if (s) {
    const copy: Record<string, string> = {};
    for (const [k, v] of Object.entries(s)) {
      copy[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    local.value = copy;
  }
}, { immediate: true });

async function save() {
  saving.value = true;
  message.value = '';
  try {
    await adminApi.saveSettings(local.value);
    message.value = '保存成功';
    await loadAdmin();
  } catch (e) {
    message.value = (e as Error).message || '保存失败';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">设置</h1>
    <div v-if="message" class="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-200">
      {{ message }}
    </div>
    <div class="glass p-6">
      <label class="mb-2 block text-sm text-slate-400">站点标题</label>
      <input v-model="local.site_title" class="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-white" />
      <label class="mb-2 block text-sm text-slate-400">自定义 CSS</label>
      <textarea v-model="local.custom_css" rows="6" class="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 font-mono text-sm text-white" />
      <button :disabled="saving" class="rounded-lg bg-sky-500 px-6 py-2 text-white hover:bg-sky-400 disabled:opacity-50" @click="save">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>
  </div>
</template>
