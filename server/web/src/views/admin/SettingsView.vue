<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
import FormInput from '../../components/ui/FormInput.vue';

interface UiSettings {
  site_title?: string;
  site_url?: string;
  custom_css?: string;
  default_sort?: string;
  group_order?: string[];
  agent_server_url?: string;
  admin_allow_ips?: string;
  alert?: {
    cpu_pct?: number;
    mem_pct?: number;
    offline_sec?: number;
  };
  public_enabled?: boolean;
  home_layout?: string;
  public_theme?: string;
  probe_targets?: string;
  retention_days?: number;
  social_email?: string;
  social_telegram?: string;
  social_qq?: string;
  social_website?: string;
}

interface NotifySettings {
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  smtp_user?: string;
  smtp_pass?: string;
  alert_from?: string;
  alert_to?: string;
  telegram_bot_token?: string;
  telegram_chat_id?: string;
}

interface SettingsForm {
  ui: UiSettings;
  notify: NotifySettings;
}

const { state } = useAdmin();
const saving = ref(false);
const message = ref('');
const local = ref<SettingsForm>({ ui: {}, notify: {} });

function cloneSettings(src: Record<string, unknown>): SettingsForm {
  const ui = (src.ui || {}) as UiSettings;
  const notify = (src.notify || {}) as NotifySettings;
  return {
    ui: { ...ui, alert: { ...(ui.alert || {}) } },
    notify: { ...notify },
  };
}

watch(() => state.settings, (s) => {
  if (s) local.value = cloneSettings(s);
}, { immediate: true });

async function save() {
  saving.value = true;
  message.value = '';
  try {
    await adminApi.saveSettings(local.value as Record<string, unknown>);
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
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">站点 UI</h2>
        <FormInput v-model="local.ui.site_title" label="站点标题" />
        <FormInput v-model="local.ui.site_url" label="站点 URL" />
        <FormInput v-model="local.ui.public_theme" label="默认公开主题" />
        <FormInput v-model="local.ui.home_layout" label="首页布局" />
        <FormInput v-model="local.ui.default_sort" label="默认排序" />
        <FormInput v-model="local.ui.agent_server_url" label="Agent 上报地址" />
        <FormInput v-model="local.ui.admin_allow_ips" label="管理端 IP 白名单" />
        <FormInput v-model="local.ui.retention_days" label="数据保留天数" type="number" />
        <FormInput v-model="local.ui.public_enabled" label="公开页启用" type="checkbox" />
        <FormInput v-model="local.ui.custom_css" label="自定义 CSS" type="textarea" />
      </div>
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">告警阈值</h2>
        <FormInput v-model="local.ui.alert!.cpu_pct" label="CPU 阈值 %" type="number" />
        <FormInput v-model="local.ui.alert!.mem_pct" label="内存阈值 %" type="number" />
        <FormInput v-model="local.ui.alert!.offline_sec" label="离线判定秒数" type="number" />
        <FormInput v-model="local.ui.probe_targets" label="探针目标" type="textarea" />

        <h2 class="mb-4 mt-8 text-lg font-semibold">通知</h2>
        <FormInput v-model="local.notify.smtp_host" label="SMTP 主机" />
        <FormInput v-model="local.notify.smtp_port" label="SMTP 端口" type="number" />
        <FormInput v-model="local.notify.smtp_secure" label="SMTP SSL" type="checkbox" />
        <FormInput v-model="local.notify.smtp_user" label="SMTP 用户名" />
        <FormInput v-model="local.notify.smtp_pass" label="SMTP 密码" type="password" />
        <FormInput v-model="local.notify.alert_from" label="告警发件人" />
        <FormInput v-model="local.notify.alert_to" label="告警收件人" />
        <FormInput v-model="local.notify.telegram_bot_token" label="Telegram Bot Token" />
        <FormInput v-model="local.notify.telegram_chat_id" label="Telegram Chat ID" />

        <h2 class="mb-4 mt-8 text-lg font-semibold">社交链接</h2>
        <FormInput v-model="local.ui.social_email" label="邮箱" />
        <FormInput v-model="local.ui.social_telegram" label="Telegram" />
        <FormInput v-model="local.ui.social_qq" label="QQ" />
        <FormInput v-model="local.ui.social_website" label="网站" />
      </div>
    </div>
    <div class="mt-6">
      <button :disabled="saving" class="rounded-lg bg-sky-500 px-6 py-2 text-white hover:bg-sky-400 disabled:opacity-50" @click="save">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>
  </div>
</template>
