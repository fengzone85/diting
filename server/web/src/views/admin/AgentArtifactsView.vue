<script setup lang="ts">
// D 阶段：受控端自定义二进制 artifact 管理（上传 / 列表 / 删除）
//
// 定位：这是「一键批量分发」的上游物料库。
// 服务端按内容寻址存储（文件名 = <sha256>.bin|.exe，由服务端生成），同内容天然去重；
// 本页只负责上传与挑选，**不做任何执行动作**（执行始终由管理员在节点上发起）。
import { ref, onMounted, computed } from 'vue';
import { adminApi } from '../../services/adminApi';
import { apiErrorMessage } from '../../utils/apiError';
import { useI18n } from '../../composables/useI18n';
import type { AgentArtifact } from '../../services/types';
import { Delete, Refresh, Upload } from '@icon-park/vue-next';

const { t } = useI18n();

const list = ref<AgentArtifact[]>([]);
const loading = ref(false);
const error = ref('');
const message = ref('');

// 上传表单
const PLATFORMS = ['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-amd64', 'darwin-arm64'];
const platform = ref('linux-amd64');
const sourceNote = ref('');
const file = ref<File | null>(null);
const uploading = ref(false);
const uploadPct = ref(0);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await adminApi.listAgentArtifacts();
    list.value = r.list || [];
  } catch (e) {
    error.value = apiErrorMessage(e, 'artifacts.loadFailed');
  } finally {
    loading.value = false;
  }
}

function pickFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  file.value = input.files && input.files[0] ? input.files[0] : null;
  uploadPct.value = 0;
}

async function upload() {
  if (!file.value) {
    error.value = t('artifacts.noFile');
    return;
  }
  uploading.value = true;
  error.value = '';
  message.value = '';
  try {
    const r = await adminApi.uploadAgentArtifact(file.value, platform.value, sourceNote.value.trim(), (p) => {
      uploadPct.value = p;
    });
    message.value = r.deduped
      ? t('artifacts.deduped', { sha: r.sha256.slice(0, 12) })
      : t('artifacts.uploaded', { sha: r.sha256.slice(0, 12) });
    file.value = null;
    sourceNote.value = '';
    const input = document.querySelector('#artifact-file-input') as HTMLInputElement | null;
    if (input) input.value = '';
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e, 'artifacts.uploadFailed');
  } finally {
    uploading.value = false;
  }
}

async function remove(a: AgentArtifact) {
  if (!confirm(t('artifacts.deleteConfirm', { sha: a.sha256.slice(0, 12) }))) return;
  error.value = '';
  try {
    await adminApi.deleteAgentArtifact(a.id);
    message.value = t('artifacts.deleted');
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e, 'artifacts.deleteFailed');
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    message.value = t('common.copied');
    setTimeout(() => (message.value = ''), 2000);
  });
}

const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};
const fmtTime = (ms: number) => (ms ? new Date(ms).toLocaleString() : '-');

const grouped = computed(() => {
  const m = new Map<string, AgentArtifact[]>();
  for (const a of list.value) {
    if (!m.has(a.platform)) m.set(a.platform, []);
    m.get(a.platform)!.push(a);
  }
  return [...m.entries()];
});

onMounted(load);
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">{{ t('artifacts.title') }}</h1>
      <button class="flex items-center gap-1 rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800" :disabled="loading" @click="load">
        <Refresh :size="14" /> {{ t('common.refresh') }}
      </button>
    </div>

    <p class="mb-4 text-sm text-slate-400">{{ t('artifacts.hint') }}</p>

    <div v-if="error" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{{ error }}</div>
    <div v-if="message" class="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">{{ message }}</div>

    <!-- 上传 -->
    <div class="glass mb-6 p-4">
      <h2 class="mb-3 text-lg font-semibold text-white">{{ t('artifacts.uploadTitle') }}</h2>
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-xs text-slate-400">
          {{ t('artifacts.platform') }}
          <select v-model="platform" class="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white">
            <option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-slate-400">
          {{ t('artifacts.note') }}
          <input v-model="sourceNote" :placeholder="t('artifacts.notePlaceholder')" class="w-56 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-slate-400">
          {{ t('artifacts.file') }}
          <input id="artifact-file-input" type="file" class="text-sm text-slate-300" @change="pickFile" />
        </label>
        <button class="flex items-center gap-1 rounded-lg bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-50" :disabled="uploading || !file" @click="upload">
          <Upload :size="14" /> {{ uploading ? `${uploadPct}%` : t('artifacts.upload') }}
        </button>
      </div>
      <p v-if="file" class="mt-2 text-xs text-slate-500">{{ file.name }} · {{ fmtSize(file.size) }}</p>
    </div>

    <!-- 列表 -->
    <div class="glass p-4">
      <h2 class="mb-3 text-lg font-semibold text-white">{{ t('artifacts.listTitle') }} ({{ list.length }})</h2>
      <div v-if="!list.length && !loading" class="py-8 text-center text-sm text-slate-500">{{ t('artifacts.empty') }}</div>

      <div v-for="[plat, items] in grouped" :key="plat" class="mb-4">
        <div class="mb-2 text-xs uppercase tracking-wide text-slate-500">{{ plat }}</div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-500">
                <th class="px-3 py-2">{{ t('artifacts.sha256') }}</th>
                <th class="px-3 py-2">{{ t('artifacts.size') }}</th>
                <th class="px-3 py-2">{{ t('artifacts.note') }}</th>
                <th class="px-3 py-2">{{ t('artifacts.uploadedAt') }}</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in items" :key="a.id" class="border-b border-slate-800">
                <td class="px-3 py-2">
                  <span class="flex items-center gap-2">
                    <code class="font-mono text-xs text-slate-300">{{ a.sha256.slice(0, 16) }}…</code>
                    <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(a.sha256)">{{ t('common.copy') }}</button>
                  </span>
                </td>
                <td class="px-3 py-2 text-slate-400">{{ fmtSize(a.size) }}</td>
                <td class="px-3 py-2 text-slate-400">{{ a.source_note || '—' }}</td>
                <td class="px-3 py-2 text-slate-400">{{ fmtTime(a.created_at) }}</td>
                <td class="px-3 py-2 text-right">
                  <button class="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10" @click="remove(a)">
                    <Delete :size="12" /> {{ t('common.delete') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
