<script setup lang="ts">
// S1/F1：节点告警阈值覆盖弹窗（留空 = 继承上层）。
import { computed, ref, watch } from 'vue';
import { adminApi } from '../../../services/adminApi';
import { loadAdmin } from '../../../composables/useAdmin';
import { useI18n } from '../../../composables/useI18n';
import { apiErrorMessage } from '../../../utils/apiError';
import type { Agent } from '../../../services/types';

const props = defineProps<{ agent: Agent | null }>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'error', message: string): void;
}>();

const { t } = useI18n();

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
  const v = props.agent?.alert?.effective?.[key];
  return v === undefined || v === null ? '' : String(v);
}

// 打开时：清空输入（留空 = 继承），再拉取该节点已保存的覆盖值回填。
// 语义：输入留空 = 继承上层（分组 → 全局），占位符展示当前生效值；
// 保存只提交已填写的字段（空 → null），不会把全局值固化到节点。
watch(() => props.agent, async (a) => {
  if (!a) return;
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
    emit('error', apiErrorMessage(e, 'agents.alertLoadFailed'));
  }
}, { immediate: true });

async function saveAlert() {
  if (!props.agent) return;
  alertBusy.value = true;
  try {
    const payload: Record<string, unknown> = { muted: alertForm.value.muted };
    for (const k of ALERT_FIELDS) {
      const raw = String(alertForm.value[k] ?? '').trim();
      payload[k] = raw === '' ? null : Number(raw);
    }
    await adminApi.setAgentAlertRule(props.agent.id, payload);
    await loadAdmin();
    emit('close');
  } catch (e) {
    emit('error', apiErrorMessage(e, 'agents.alertSaveFailed'));
  } finally {
    alertBusy.value = false;
  }
}

async function resetAlert() {
  if (!props.agent) return;
  if (!confirm(t('agents.alertResetConfirm'))) return;
  alertBusy.value = true;
  try {
    await adminApi.resetAgentAlertRule(props.agent.id);
    await loadAdmin();
    emit('close');
  } catch (e) {
    emit('error', apiErrorMessage(e, 'agents.alertSaveFailed'));
  } finally {
    alertBusy.value = false;
  }
}
</script>

<template>
  <!-- S1/F1：告警阈值覆盖弹窗（留空 = 继承） -->
  <div
    v-if="agent"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    @click.self="$emit('close')"
  >
    <div class="glass w-full max-w-lg p-5">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ t('agents.alertTitle', { name: agent.name }) }}</h2>
        <button class="text-secondary hover:text-content" @click="$emit('close')">✕</button>
      </div>
      <p class="mb-4 text-xs text-muted">{{ t('agents.alertInheritHint') }}</p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label v-for="f in alertFieldRows" :key="f.key" class="text-xs text-secondary">
          {{ f.label }}
          <input
            v-model="alertForm[f.key]"
            type="number"
            :placeholder="effectiveAlert(f.key)"
            class="field-control mt-1 w-full"
          />
        </label>
      </div>
      <label class="mt-4 flex cursor-pointer items-center gap-2 text-sm text-slate-300">
        <input v-model="alertForm.muted" type="checkbox" class="switch switch-danger" />
        {{ t('agents.alertMuted') }}
      </label>
      <div class="mt-5 flex justify-end gap-2">
        <button class="btn-ghost px-4 py-2 text-sm" @click="$emit('close')">{{ t('common.cancel') }}</button>
        <button class="rounded-lg bg-amber-600 px-4 py-2 text-sm text-white hover:bg-amber-500 disabled:opacity-50" :disabled="alertBusy" @click="resetAlert">{{ t('agents.alertReset') }}</button>
        <button class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400 disabled:opacity-50" :disabled="alertBusy" @click="saveAlert">{{ t('agents.alertSave') }}</button>
      </div>
    </div>
  </div>
</template>
