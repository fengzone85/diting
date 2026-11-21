<script setup lang="ts">
// D 阶段：一键批量分发抽屉。
// 服务端只**生成分发物**（脚本 + 二进制 + 校验和 + manifest）与一条一次性下载命令；
// **不主动连接节点、不下发任何指令**——命令需管理员在目标节点上以 root/管理员权限执行。
import { computed, ref, watch } from 'vue';
import { adminApi } from '../../../services/adminApi';
import { useI18n } from '../../../composables/useI18n';
import { apiErrorMessage } from '../../../utils/apiError';
import type { AgentArtifact, AgentDistributionResult } from '../../../services/types';

const props = defineProps<{
  open: boolean;
  agentIds: string[];
}>();

defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();

const distBusy = ref(false);
const distError = ref('');
const distResult = ref<AgentDistributionResult | null>(null);
const distPlatform = ref('linux-amd64');
const distSourceKind = ref<'official' | 'artifact' | 'release_url'>('official');
const distArtifactId = ref('');
const distUrl = ref('');
const distSha = ref('');
const distTtl = ref(30);
const artifacts = ref<AgentArtifact[]>([]);

const distOs = computed(() => (distPlatform.value.startsWith('windows') ? 'windows' : 'linux'));
const distArch = computed(() => (distPlatform.value.endsWith('arm64') ? 'arm64' : 'amd64'));

const distArtifacts = computed(() => artifacts.value.filter((a) => a.platform === distPlatform.value));

watch(() => props.open, (open) => {
  if (!open) return;
  distError.value = '';
  if (!distResult.value) loadArtifacts();
});

async function loadArtifacts() {
  try {
    const r = await adminApi.listAgentArtifacts();
    artifacts.value = r.list || [];
    if (!distArtifactId.value && distArtifacts.value.length) distArtifactId.value = distArtifacts.value[0].id;
  } catch {
    // 物料库拿不到不阻断（official / release_url 来源不需要它）
  }
}

async function generateDist() {
  distBusy.value = true;
  distError.value = '';
  distResult.value = null;
  try {
    const source: { kind: string; artifact_id?: string; release_url?: string; release_sha256?: string } =
      { kind: distSourceKind.value };
    if (distSourceKind.value === 'artifact') {
      if (!distArtifactId.value) throw new Error(t('dist.noArtifact'));
      source.artifact_id = distArtifactId.value;
    } else if (distSourceKind.value === 'release_url') {
      source.release_url = distUrl.value.trim();
      if (distSha.value.trim()) source.release_sha256 = distSha.value.trim();
    }
    distResult.value = await adminApi.createAgentDistribution({
      agent_ids: [...props.agentIds],
      target: { os: distOs.value, arch: distArch.value },
      source,
      expires_in_minutes: Number(distTtl.value) || 30
    });
  } catch (e) {
    distError.value = apiErrorMessage(e, 'dist.generateFailed');
  } finally {
    distBusy.value = false;
  }
}

const distCopied = ref('');
function copyDist(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    distCopied.value = t('common.copied');
    setTimeout(() => (distCopied.value = ''), 2000);
  });
}
</script>

<template>
  <!-- D 阶段：一键批量分发抽屉 -->
  <div v-if="open" class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4" @click.self="$emit('close')">
    <div class="glass my-8 w-full max-w-2xl p-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ t('dist.title') }}</h2>
        <button class="text-secondary hover:text-content" @click="$emit('close')">{{ t('common.close') }}</button>
      </div>

      <p class="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-200">{{ t('dist.safetyHint') }}</p>

      <div v-if="distError" class="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{{ distError }}</div>
      <div v-if="distCopied" class="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">{{ distCopied }}</div>

      <div class="mb-4 grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs text-secondary">
          {{ t('dist.targetPlatform') }}
          <select v-model="distPlatform" class="field-control" @change="distArtifactId = ''">
            <option value="linux-amd64">linux-amd64</option>
            <option value="linux-arm64">linux-arm64</option>
            <option value="windows-amd64">windows-amd64</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-secondary">
          {{ t('dist.ttl') }}
          <input v-model.number="distTtl" type="number" min="1" max="1440" class="field-control" />
        </label>
      </div>

      <div class="mb-4">
        <div class="mb-2 text-xs text-secondary">{{ t('dist.source') }}</div>
        <div class="flex flex-wrap gap-2">
          <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300" :class="distSourceKind === 'official' ? 'border-sky-500 bg-sky-500/10 text-sky-200' : ''">
            <input v-model="distSourceKind" type="radio" value="official" class="h-3 w-3" /> {{ t('dist.sourceOfficial') }}
          </label>
          <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300" :class="distSourceKind === 'artifact' ? 'border-sky-500 bg-sky-500/10 text-sky-200' : ''">
            <input v-model="distSourceKind" type="radio" value="artifact" class="h-3 w-3" /> {{ t('dist.sourceArtifact') }}
          </label>
          <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300" :class="distSourceKind === 'release_url' ? 'border-sky-500 bg-sky-500/10 text-sky-200' : ''">
            <input v-model="distSourceKind" type="radio" value="release_url" class="h-3 w-3" /> {{ t('dist.sourceUrl') }}
          </label>
        </div>
      </div>

      <div v-if="distSourceKind === 'artifact'" class="mb-4">
        <label class="flex flex-col gap-1 text-xs text-secondary">
          {{ t('dist.artifact') }}
          <select v-model="distArtifactId" class="field-control">
            <option v-if="!distArtifacts.length" value="">{{ t('dist.noArtifact') }}</option>
            <option v-for="a in distArtifacts" :key="a.id" :value="a.id">
              {{ a.sha256.slice(0, 16) }}… · {{ a.source_note || a.platform }}
            </option>
          </select>
        </label>
      </div>

      <div v-if="distSourceKind === 'release_url'" class="mb-4 grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs text-secondary">
          {{ t('dist.url') }}
          <input v-model="distUrl" placeholder="https://…/diting-agent-linux-amd64" class="field-control" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-secondary">
          {{ t('dist.sha256') }}
          <input v-model="distSha" placeholder="64 位 hex（强烈建议填写）" class="field-control" />
        </label>
      </div>

      <button class="w-full rounded-lg bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-50" :disabled="distBusy" @click="generateDist">
        {{ distBusy ? t('dist.generating') : t('dist.generate') }}
      </button>

      <div v-if="distResult" class="mt-4 space-y-3">
        <div class="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
          {{ t('dist.resultHint', { n: agentIds.length }) }}
          <div class="mt-1">{{ t('dist.expiresAt', { at: new Date(distResult.expires_at).toLocaleString() }) }}</div>
        </div>
        <div class="rounded-lg border border-slate-700 p-3">
          <div class="mb-1 flex items-center justify-between text-xs text-secondary">
            <span>Linux</span>
            <button class="text-sky-400 hover:text-sky-300" @click="copyDist(distResult.commands.linux)">{{ t('common.copy') }}</button>
          </div>
          <pre class="overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-slate-300">{{ distResult.commands.linux }}</pre>
        </div>
        <div class="rounded-lg border border-slate-700 p-3">
          <div class="mb-1 flex items-center justify-between text-xs text-secondary">
            <span>Windows</span>
            <button class="text-sky-400 hover:text-sky-300" @click="copyDist(distResult.commands.windows)">{{ t('common.copy') }}</button>
          </div>
          <pre class="overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-slate-300">{{ distResult.commands.windows }}</pre>
        </div>
        <div class="rounded-lg border border-slate-700 p-3">
          <div class="mb-1 flex items-center justify-between text-xs text-secondary">
            <span>{{ t('dist.downloadUrl') }}</span>
            <button class="text-sky-400 hover:text-sky-300" @click="copyDist(distResult.download_url)">{{ t('common.copy') }}</button>
          </div>
          <p class="break-all font-mono text-[11px] text-secondary">{{ distResult.download_url }}</p>
          <p class="mt-2 text-[11px] text-amber-300">{{ t('dist.oneTimeWarn') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
