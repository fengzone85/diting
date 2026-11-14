<script setup lang="ts">
// 告警与通知：全局告警阈值 / 分组告警覆盖 / 探测目标 / 通知凭据 / 通知渠道与通知组。
// 从原 864 行「设置」万物桶中拆出（后台信息架构重组）。
// 二级导航对齐参考面板：五个分节是 /admin/alerting/* 子路由，侧栏父子菜单承载；
// 同一组件实例跨子路由复用（useSettingsForm 状态不丢），props.section 选定渲染分节。
import { t } from '../../composables/useI18n';
import { useSettingsForm } from '../../composables/useSettingsForm';
import { useGroupAlertOverrides } from '../../composables/useGroupAlertOverrides';
import FormInput from '../../components/ui/FormInput.vue';
import NotifyPanel from '../../components/admin/NotifyPanel.vue';
import PageShell from '../../components/admin/PageShell.vue';

defineProps<{ section: string }>();

const { local, saving, message, ready, save } = useSettingsForm();

// ---- 分组告警阈值覆盖：逻辑在 useGroupAlertOverrides（与告警页共用同一条 message） ----
const {
  groupOverrides, groupBusy, groupForm, groupFieldRows,
  applyGroupForm, groupPlaceholder, saveGroupAlert, resetGroupAlert,
} = useGroupAlertOverrides({ message });
</script>

<template>
  <PageShell :title="t('alerting.title')">
    <template #actions>
      <button
        :disabled="saving || !ready"
        class="rounded-lg bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50"
        @click="save"
      >
        {{ saving ? t('settings.saving') : t('common.save') }}
      </button>
    </template>

    <template v-if="message" #banner>
      <div class="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5 text-sm text-sky-200">
        {{ message }}
      </div>
    </template>

    <div class="space-y-4">
      <!-- 告警阈值 -->
      <section v-show="section === 'sec-thresholds'" id="sec-thresholds" class="glass rounded-xl p-5">
        <h2 class="mb-1 text-lg font-semibold">{{ t('settings.alertThresholds') }}</h2>
        <p class="mb-4 text-xs text-muted">{{ t('settings.alertThresholdsHint') }}</p>
        <div class="grid gap-x-6 sm:grid-cols-3">
          <FormInput v-model="local.ui.alert!.cpu_pct" :label="t('settings.cpuThreshold')" type="number" />
          <FormInput v-model="local.ui.alert!.mem_pct" :label="t('settings.memThreshold')" type="number" />
          <FormInput v-model="local.ui.alert!.offline_sec" :label="t('settings.offlineSec')" type="number" />
        </div>
      </section>

      <!-- 分组告警覆盖 -->
      <section v-show="section === 'sec-group'" id="sec-group" class="glass rounded-xl p-5">
        <h2 class="mb-1 text-lg font-semibold">{{ t('settings.groupAlertRules') }}</h2>
        <p class="mb-4 text-xs text-muted">{{ t('settings.groupAlertHint') }}</p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="text-sm text-secondary">
            {{ t('settings.groupName') }}
            <input
              v-model="groupForm.grp"
              list="diting-alert-groups"
              class="field-control mt-1 w-full"
              @change="applyGroupForm(groupForm.grp)"
            />
            <datalist id="diting-alert-groups">
              <option v-for="g in groupOverrides" :key="g.grp" :value="g.grp" />
            </datalist>
          </label>
          <label v-for="f in groupFieldRows" :key="f.key" class="text-sm text-secondary">
            {{ f.label }}
            <input
              v-model="groupForm[f.key]"
              type="number"
              :placeholder="groupPlaceholder(f.key)"
              class="field-control mt-1 w-full"
            />
          </label>
        </div>
        <label class="mt-3 flex cursor-pointer items-center gap-2 text-sm text-slate-300">
          <input v-model="groupForm.muted" type="checkbox" class="switch switch-danger" />
          {{ t('agents.alertMuted') }}
        </label>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400 disabled:opacity-50"
            :disabled="groupBusy"
            @click="saveGroupAlert"
          >{{ t('settings.groupAlertSave') }}</button>
          <button
            type="button"
            class="btn-ghost px-4 py-2 text-sm"
            :disabled="groupBusy"
            @click="resetGroupAlert"
          >{{ t('agents.alertReset') }}</button>
          <span v-if="groupOverrides.length" class="text-xs text-muted">
            {{ t('settings.existingGroupRules') }}:
            {{ groupOverrides.map((g) => (g.grp === '' ? t('settings.defaultGroup') : g.grp)).join(' / ') }}
          </span>
        </div>
      </section>

      <!-- 探测目标 -->
      <section v-show="section === 'sec-probe'" id="sec-probe" class="glass rounded-xl p-5">
        <h2 class="mb-1 text-lg font-semibold">{{ t('settings.probeTargets') }}</h2>
        <p class="mb-4 text-xs text-muted">{{ t('settings.probeTargetsHint') }}</p>
        <FormInput
          v-model="local.ui.probe_targets"
          :label="t('settings.probeTargets')"
          type="textarea"
          :hint="t('settings.probeTargetsHint')"
        />
      </section>

      <!-- 通知凭据 -->
      <section v-show="section === 'sec-notify'" id="sec-notify" class="glass rounded-xl p-5">
        <h2 class="mb-1 text-lg font-semibold">{{ t('settings.notify') }}</h2>
        <p class="mb-4 text-xs text-muted">{{ t('settings.notifyHint') }}</p>
        <div class="grid gap-x-6 sm:grid-cols-2">
          <FormInput v-model="local.notify.smtp_host" :label="t('settings.smtpHost')" />
          <FormInput v-model="local.notify.smtp_port" :label="t('settings.smtpPort')" type="number" />
          <FormInput v-model="local.notify.smtp_user" :label="t('settings.smtpUser')" />
          <FormInput v-model="local.notify.smtp_pass" :label="t('settings.smtpPass')" type="password" />
          <FormInput v-model="local.notify.alert_from" :label="t('settings.alertFrom')" />
          <FormInput v-model="local.notify.alert_to" :label="t('settings.alertTo')" />
          <FormInput v-model="local.notify.telegram_bot_token" label="Telegram Bot Token" />
          <FormInput v-model="local.notify.telegram_chat_id" label="Telegram Chat ID" />
          <FormInput v-model="local.notify.smtp_secure" :label="t('settings.smtpSsl')" type="checkbox" />
        </div>
      </section>

      <!-- 通知渠道与通知组 -->
      <section v-show="section === 'sec-channels'" id="sec-channels" class="glass rounded-xl p-5">
        <h2 class="mb-4 text-lg font-semibold">{{ t('settings.groupChannels') }}</h2>
        <NotifyPanel />
      </section>
    </div>
  </PageShell>
</template>
