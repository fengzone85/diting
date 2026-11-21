<script setup lang="ts">
// V 阶段：版本分布汇总展示 + 期望版本设置（一键对照基准）。
// 判定口径由服务端给出（server/src/agent-versions.js），前端只渲染状态点，不自行重算。
// 汇总数据的轮询留在父组件（表格的状态点也依赖它），本组件只负责展示与设置交互。
import { ref } from 'vue';
import { adminApi } from '../../../services/adminApi';
import { useI18n } from '../../../composables/useI18n';
import { apiErrorMessage } from '../../../utils/apiError';
import type { AgentVersionSummary } from '../../../services/types';

const props = defineProps<{ summary: AgentVersionSummary | null }>();

const emit = defineEmits<{
  (e: 'error', message: string): void;
  (e: 'refresh'): void;
}>();

const { t } = useI18n();

// ---- 期望版本设置（一键对照基准）----
const expectedOpen = ref(false);
const expectedVersion = ref('');
const expectedSha = ref('');
const expectedBusy = ref(false);

function openExpected() {
  expectedVersion.value = props.summary?.expected.version || '';
  expectedSha.value = props.summary?.expected.sha || '';
  expectedOpen.value = true;
}

async function saveExpected() {
  expectedBusy.value = true;
  try {
    await adminApi.setExpectedAgentVersion({
      version: expectedVersion.value.trim(),
      sha: expectedSha.value.trim(),
    });
    emit('refresh');
    expectedOpen.value = false;
  } catch (e) {
    emit('error', apiErrorMessage(e, 'agents.versionSaveFailed'));
  } finally {
    expectedBusy.value = false;
  }
}

async function clearExpected() {
  expectedBusy.value = true;
  try {
    await adminApi.setExpectedAgentVersion({ version: '', sha: '' });
    emit('refresh');
    expectedOpen.value = false;
  } catch (e) {
    emit('error', apiErrorMessage(e, 'agents.versionSaveFailed'));
  } finally {
    expectedBusy.value = false;
  }
}
</script>

<template>
  <!-- V 阶段：版本分布汇总条（期望版本对照） -->
  <div v-if="summary" class="glass mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-sm">
    <span class="text-secondary">{{ t('agents.versionSummary', { n: summary.counts.total }) }}</span>
    <span class="text-emerald-300">{{ t('agents.versionUpToDate') }}: {{ summary.counts.up_to_date }}</span>
    <span class="text-amber-300">{{ t('agents.versionOutdated') }}: {{ summary.counts.outdated }}</span>
    <span class="text-violet-300">{{ t('agents.versionCustom') }}: {{ summary.counts.custom }}</span>
    <span class="text-muted">{{ t('agents.versionUnknown') }}: {{ summary.counts.unknown }}</span>
    <span class="text-secondary">
      {{ t('agents.versionExpected') }}: {{ summary.expected.version || t('agents.versionNotSet') }}
    </span>
    <button class="btn-ghost px-3 py-1 text-xs" @click="openExpected">
      {{ t('agents.versionSetExpected') }}
    </button>
  </div>

  <!-- 期望版本设置：版本号可留空只填 sha；两者皆空 = 清除对照 -->
  <div v-if="expectedOpen" class="glass mb-4 flex flex-wrap items-center gap-3 p-3">
    <input
      v-model="expectedVersion"
      :placeholder="t('agents.versionExpectedPlaceholder')"
      class="field-control w-40"
    />
    <input
      v-model="expectedSha"
      :placeholder="t('agents.versionExpectedShaPlaceholder')"
      class="field-control w-52"
    />
    <button class="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-50" :disabled="expectedBusy" @click="saveExpected">
      {{ t('common.save') }}
    </button>
    <button class="btn-ghost px-3 py-2 text-sm" :disabled="expectedBusy" @click="clearExpected">
      {{ t('agents.versionClearExpected') }}
    </button>
    <button class="rounded-lg px-3 py-2 text-sm text-secondary hover:text-content" @click="expectedOpen = false">{{ t('common.cancel') }}</button>
    <p class="w-full text-xs text-muted">{{ t('agents.versionExpectedHint') }}</p>
  </div>
</template>
