<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useAdmin, loadAdmin, setAutoRefreshPaused } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import type { Settings } from '../../services/types';
import FormInput from '../../components/ui/FormInput.vue';
import TwoFactorPanel from '../../components/admin/TwoFactorPanel.vue';

interface ThemeOption {
  id: string;
  name: string;
}

interface UiSettings {
  site_title?: string;
  site_description?: string;
  site_url?: string;
  logo_url?: string;
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
  home_layout?: 'grid' | 'list' | 'compact';
  public_theme?: string;
  probe_targets?: string;
  retention_days?: number;
  social_email?: string;
  social_telegram?: string;
  social_qq?: string;
  social_website?: string;
  // 主题可视化配置（对齐 komari-theme-Glassmorphism）
  glass_preset?: string;
  glass_custom?: Record<string, unknown>;
  color_vision?: string;
  card_scheme?: string;
  card_size?: string;
  background?: { enabled: boolean; type: 'image' | 'video'; url: string; blur: number; overlay: number };
  announcement?: { enabled: boolean; title: string; content: string };
  provider_aliases?: Record<string, string>;
  custom_tags?: Record<string, string>;
  visitor_info?: boolean;
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
// 用户是否已修改但未保存；编辑期间禁止自动刷新覆盖输入（避免 10s 轮询清空）
const dirty = ref(false);
watch(local, () => { dirty.value = true; }, { deep: true });

function resetLocal() {
  local.value = {
    ui: {
      background: { enabled: false, type: 'image', url: '', blur: 8, overlay: 50 },
      announcement: { enabled: false, title: '', content: '' },
      provider_aliases: {},
      custom_tags: {},
      glass_preset: 'emerald',
      color_vision: 'normal',
      card_scheme: 'official',
      card_size: 'comfortable',
      visitor_info: false,
    },
    notify: {},
  };
}
resetLocal();
const themes = ref<ThemeOption[]>([{ id: 'default', name: t('settings.builtinTheme') }]);

onMounted(async () => {
  // 进入设置页暂停全局 10s 自动刷新（paused 标志，避免被父组件 start 覆盖），
  // 防止轮询重写表单清空未保存输入
  setAutoRefreshPaused(true);
  try {
    const list = await adminApi.listThemes();
    themes.value = [{ id: 'default', name: t('settings.builtinTheme') }, ...list];
  } catch {
    // ignore
  }
});

onUnmounted(() => {
  // 离开设置页恢复自动刷新
  setAutoRefreshPaused(false);
});

function cloneSettings(src: Settings): SettingsForm {
  const ui = (src.ui || {}) as UiSettings;
  const notify = (src.notify || {}) as NotifySettings;
  return {
    ui: {
      ...ui,
      alert: { ...(ui.alert || {}) },
      background: { enabled: false, type: 'image', url: '', blur: 8, overlay: 50, ...(ui.background || {}) },
      announcement: { enabled: false, title: '', content: '', ...(ui.announcement || {}) },
      provider_aliases: { ...(ui.provider_aliases || {}) },
      custom_tags: { ...(ui.custom_tags || {}) },
      glass_preset: ui.glass_preset || 'emerald',
      color_vision: ui.color_vision || 'normal',
      card_scheme: ui.card_scheme || 'official',
      card_size: ui.card_size || 'comfortable',
      visitor_info: !!ui.visitor_info,
    },
    notify: { ...notify },
  };
}


watch(() => state.settings, (s) => {
  // 用户有未保存的编辑时，不覆盖输入框（10s 自动刷新会触发本 watch）
  if (dirty.value) return;
  if (s) local.value = cloneSettings(s);
}, { immediate: true });

async function save() {
  saving.value = true;
  message.value = '';
  try {
    await adminApi.saveSettings(local.value as Record<string, unknown>);
    message.value = t('settings.saved');
    await loadAdmin();
    dirty.value = false;
  } catch (e) {
    message.value = (e as Error).message || t('settings.saveFailed');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">{{ t('settings.title') }}</h1>
    <div v-if="message" class="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-200">
      {{ message }}
    </div>
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('settings.siteUi') }}</h2>
        <FormInput v-model="local.ui.site_title" :label="t('settings.siteTitle')" />
        <FormInput v-model="local.ui.site_description" :label="t('settings.siteDescription')" />
        <FormInput v-model="local.ui.site_url" :label="t('settings.siteUrl')" />
        <FormInput v-model="local.ui.logo_url" :label="t('settings.logoUrl')" />
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('settings.defaultTheme') }}</label>
          <div class="flex gap-2">
            <select v-model="local.ui.public_theme" class="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option v-for="t2 in themes" :key="t2.id" :value="t2.id">{{ t2.name }}</option>
            </select>
            <a
              v-if="local.ui.public_theme && local.ui.public_theme !== 'default'"
              :href="`/?theme=${local.ui.public_theme}`"
              target="_blank"
              class="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm text-sky-400 hover:border-sky-500"
            >{{ t('settings.preview') }}</a>
          </div>
          <p class="mt-1 text-xs text-slate-500">{{ t('settings.themeHint') }}</p>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('settings.homeLayout') }}</label>
          <select v-model="local.ui.home_layout" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
            <option value="grid">{{ t('public.grid') }}</option>
            <option value="list">{{ t('public.list') }}</option>
            <option value="compact">{{ t('public.compact') }}</option>
          </select>
        </div>
        <FormInput v-model="local.ui.default_sort" :label="t('settings.defaultSort')" />
        <FormInput v-model="local.ui.agent_server_url" :label="t('settings.agentServerUrl')" />
        <FormInput v-model="local.ui.admin_allow_ips" :label="t('settings.adminAllowIps')" />
        <FormInput v-model="local.ui.retention_days" :label="t('settings.retentionDays')" type="number" />
        <FormInput v-model="local.ui.public_enabled" :label="t('settings.publicEnabled')" type="checkbox" />
        <FormInput v-model="local.ui.custom_css" :label="t('settings.customCss')" type="textarea" />
      </div>
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('settings.alertThresholds') }}</h2>
        <FormInput v-model="local.ui.alert!.cpu_pct" :label="t('settings.cpuThreshold')" type="number" />
        <FormInput v-model="local.ui.alert!.mem_pct" :label="t('settings.memThreshold')" type="number" />
        <FormInput v-model="local.ui.alert!.offline_sec" :label="t('settings.offlineSec')" type="number" />
        <FormInput v-model="local.ui.probe_targets" :label="t('settings.probeTargets')" type="textarea" />

        <h2 class="mb-4 mt-8 text-lg font-semibold">{{ t('settings.notify') }}</h2>
        <FormInput v-model="local.notify.smtp_host" :label="t('settings.smtpHost')" />
        <FormInput v-model="local.notify.smtp_port" :label="t('settings.smtpPort')" type="number" />
        <FormInput v-model="local.notify.smtp_secure" :label="t('settings.smtpSsl')" type="checkbox" />
        <FormInput v-model="local.notify.smtp_user" :label="t('settings.smtpUser')" />
        <FormInput v-model="local.notify.smtp_pass" :label="t('settings.smtpPass')" type="password" />
        <FormInput v-model="local.notify.alert_from" :label="t('settings.alertFrom')" />
        <FormInput v-model="local.notify.alert_to" :label="t('settings.alertTo')" />
        <FormInput v-model="local.notify.telegram_bot_token" label="Telegram Bot Token" />
        <FormInput v-model="local.notify.telegram_chat_id" label="Telegram Chat ID" />

        <h2 class="mb-4 mt-8 text-lg font-semibold">{{ t('settings.socialLinks') }}</h2>
        <FormInput v-model="local.ui.social_email" :label="t('footer.email')" />
        <FormInput v-model="local.ui.social_telegram" label="Telegram" />
        <FormInput v-model="local.ui.social_qq" label="QQ" />
        <FormInput v-model="local.ui.social_website" :label="t('footer.website')" />
      </div>

    </div>
    <div class="mt-6">
      <button :disabled="saving" class="rounded-lg bg-sky-500 px-6 py-2 text-white hover:bg-sky-400 disabled:opacity-50" @click="save">
        {{ saving ? t('settings.saving') : t('common.save') }}
      </button>
    </div>

    <TwoFactorPanel class="mt-6" />
  </div>
</template>
