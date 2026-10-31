// 分组告警阈值覆盖（从 SettingsView 抽出的第四块，约 80 行）。
//
// 语义与节点覆盖一致：留空 = 继承全局（PUT 传 null 清除该字段）；DELETE = 整行回退。
// 保存结果写回父组件的 message（设置页统一的成功/失败提示条），因此由调用方注入 Ref。

import { ref, computed } from 'vue';
import type { Ref } from 'vue';
import { adminApi } from '../services/adminApi';
import { t } from './useI18n';
import type { AlertOverride, AlertThresholds } from '../services/types';

export type GroupFieldKey = 'cpu_pct' | 'mem_pct' | 'disk_pct' | 'temp_c' | 'offline_sec' | 'cooldown';

const GROUP_FIELDS: GroupFieldKey[] = ['cpu_pct', 'mem_pct', 'disk_pct', 'temp_c', 'offline_sec', 'cooldown'];

export function useGroupAlertOverrides(opts: { message: Ref<string> }) {
  const { message } = opts;

  const groupOverrides = ref<(AlertOverride & { grp: string })[]>([]);
  const globalThresholds = ref<AlertThresholds | null>(null);
  const groupBusy = ref(false);
  const groupForm = ref({
    grp: '', cpu_pct: '', mem_pct: '', disk_pct: '', temp_c: '', offline_sec: '', cooldown: '', muted: false,
  });

  const groupFieldRows = computed(() => [
    { key: 'cpu_pct' as GroupFieldKey, label: t('agents.cpuThreshold') },
    { key: 'mem_pct' as GroupFieldKey, label: t('agents.memThreshold') },
    { key: 'disk_pct' as GroupFieldKey, label: t('agents.diskThreshold') },
    { key: 'temp_c' as GroupFieldKey, label: t('agents.tempThreshold') },
    { key: 'offline_sec' as GroupFieldKey, label: t('agents.offlineThreshold') },
    { key: 'cooldown' as GroupFieldKey, label: t('agents.cooldownThreshold') },
  ]);

  async function loadAlertRules() {
    try {
      const rules = await adminApi.listAlertRules();
      groupOverrides.value = rules.groups;
      globalThresholds.value = rules.global;
      if (groupForm.value.grp) applyGroupForm(groupForm.value.grp);
    } catch {
      // 只读 Token / 网络异常：静默，不影响设置页其余表单
    }
  }

  function applyGroupForm(grp: string) {
    const ov = groupOverrides.value.find((g) => g.grp === grp);
    groupForm.value = {
      grp, cpu_pct: '', mem_pct: '', disk_pct: '', temp_c: '', offline_sec: '', cooldown: '',
      muted: !!ov?.muted,
    };
    if (ov) {
      for (const k of GROUP_FIELDS) {
        const v = ov[k];
        if (v !== null && v !== undefined) groupForm.value[k] = String(v);
      }
    }
  }

  function groupPlaceholder(key: GroupFieldKey): string {
    const v = globalThresholds.value?.[key];
    return v === undefined || v === null ? '' : String(v);
  }

  async function saveGroupAlert() {
    groupBusy.value = true;
    message.value = '';
    try {
      const payload: Record<string, unknown> = { muted: groupForm.value.muted };
      for (const k of GROUP_FIELDS) {
        const raw = String(groupForm.value[k] ?? '').trim();
        payload[k] = raw === '' ? null : Number(raw);
      }
      await adminApi.setGroupAlertRule(groupForm.value.grp.trim(), payload);
      message.value = t('settings.saved');
      await loadAlertRules();
    } catch (e) {
      message.value = (e as Error).message || t('settings.saveFailed');
    } finally {
      groupBusy.value = false;
    }
  }

  async function resetGroupAlert() {
    const grp = groupForm.value.grp.trim();
    if (!confirm(t('agents.alertResetConfirm'))) return;
    groupBusy.value = true;
    try {
      await adminApi.resetGroupAlertRule(grp);
      applyGroupForm(grp);
      await loadAlertRules();
      message.value = t('settings.saved');
    } catch (e) {
      message.value = (e as Error).message || t('settings.saveFailed');
    } finally {
      groupBusy.value = false;
    }
  }

  return {
    groupOverrides, groupBusy, groupForm, groupFieldRows,
    loadAlertRules, applyGroupForm, groupPlaceholder, saveGroupAlert, resetGroupAlert,
  };
}
