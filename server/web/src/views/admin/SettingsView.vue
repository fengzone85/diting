<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
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
  try {
    const list = await adminApi.listThemes();
    themes.value = [{ id: 'default', name: t('settings.builtinTheme') }, ...list];
  } catch {
    // ignore
  }
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

const providerAliasesText = computed({
  get: () => JSON.stringify(local.value.ui.provider_aliases || {}, null, 0),
  set: (v) => {
    try { local.value.ui.provider_aliases = JSON.parse(v || '{}'); } catch {}
  },
});
const customTagsText = computed({
  get: () => JSON.stringify(local.value.ui.custom_tags || {}, null, 0),
  set: (v) => {
    try { local.value.ui.custom_tags = JSON.parse(v || '{}'); } catch {}
  },
});

watch(() => state.settings, (s) => {
  if (s) local.value = cloneSettings(s);
}, { immediate: true });

async function save() {
  saving.value = true;
  message.value = '';
  try {
    await adminApi.saveSettings(local.value as Record<string, unknown>);
    message.value = t('settings.saved');
    await loadAdmin();
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

      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('settings.themeVisual') }}</h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('theme.glassPreset') }}</label>
            <select v-model="local.ui.glass_preset" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="emerald">{{ t('settings.preset.emerald') }}</option>
              <option value="soft">{{ t('settings.preset.soft') }}</option>
              <option value="high-contrast">{{ t('settings.preset.highContrast') }}</option>
              <option value="midnight">{{ t('settings.preset.midnight') }}</option>
              <option value="custom">{{ t('settings.preset.custom') }}</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('theme.colorVision') }}</label>
            <select v-model="local.ui.color_vision" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="normal">{{ t('settings.cv.normal') }}</option>
              <option value="protanopia">{{ t('settings.cv.protanopia') }}</option>
              <option value="deuteranopia">{{ t('settings.cv.deuteranopia') }}</option>
              <option value="tritanopia">{{ t('settings.cv.tritanopia') }}</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('theme.cardScheme') }}</label>
            <select v-model="local.ui.card_scheme" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="official">{{ t('settings.scheme.official') }}</option>
              <option value="basic">{{ t('settings.scheme.basic') }}</option>
              <option value="ops">{{ t('settings.scheme.ops') }}</option>
              <option value="resource">{{ t('settings.scheme.resource') }}</option>
              <option value="finance">{{ t('settings.scheme.finance') }}</option>
              <option value="traffic">{{ t('settings.scheme.traffic') }}</option>
              <option value="gpu">{{ t('settings.scheme.gpu') }}</option>
              <option value="asset">{{ t('settings.scheme.asset') }}</option>
              <option value="full">{{ t('settings.scheme.full') }}</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('theme.cardSize') }}</label>
            <select v-model="local.ui.card_size" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="mini">{{ t('settings.size.mini') }}</option>
              <option value="compact">{{ t('settings.size.compact') }}</option>
              <option value="comfortable">{{ t('settings.size.comfortable') }}</option>
              <option value="large">{{ t('settings.size.large') }}</option>
            </select>
          </div>
        </div>

        <div class="mt-4 rounded-lg bg-surface p-4">
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" v-model="local.ui.background!.enabled" class="rounded" />
            {{ t('settings.backgroundEnabled') }}
          </label>
          <div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label class="mb-1 block text-sm text-slate-400">{{ t('settings.type') }}</label>
              <select v-model="local.ui.background!.type" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
                <option value="image">{{ t('settings.image') }}</option>
                <option value="video">{{ t('settings.video') }}</option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-sm text-slate-400">{{ t('settings.url') }}</label>
              <input v-model="local.ui.background!.url" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500" placeholder="https://..." />
            </div>
            <div>
              <label class="mb-1 block text-sm text-slate-400">{{ t('settings.blur', { n: local.ui.background!.blur }) }}</label>
              <input type="range" min="0" max="30" v-model.number="local.ui.background!.blur" class="w-full" />
            </div>
          </div>
          <div class="mt-3">
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.overlay', { n: local.ui.background!.overlay }) }}</label>
            <input type="range" min="0" max="100" v-model.number="local.ui.background!.overlay" class="w-full" />
          </div>
        </div>

        <div class="mt-4 rounded-lg bg-surface p-4">
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" v-model="local.ui.announcement!.enabled" class="rounded" />
            {{ t('settings.announcementEnabled') }}
          </label>
          <FormInput v-model="local.ui.announcement!.title" :label="t('settings.announcementTitle')" class="mt-2" />
          <FormInput v-model="local.ui.announcement!.content" :label="t('settings.announcementContent')" type="textarea" />
        </div>

        <div class="mt-4 flex items-center gap-6">
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" v-model="local.ui.visitor_info" class="rounded" />
            {{ t('settings.visitorInfo') }}
          </label>
        </div>

        <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.providerAliases') }}</label>
            <textarea v-model="providerAliasesText" rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"></textarea>
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.customTags') }}</label>
            <textarea v-model="customTagsText" rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"></textarea>
          </div>
        </div>
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
