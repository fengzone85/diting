<script setup lang="ts">
// 站点设置：站点信息 / 公开页开关 / 自定义代码 / 默认主题 / 社交链接 / 受控端注册令牌。
// 从原 864 行「设置」万物桶中拆出（后台信息架构重组）。
// 排版：A + D —— PageShell（吸顶保存 + 左目录锚点）+ 一卡一节的限宽内容列。
import { computed, onMounted, ref } from 'vue';
import { t } from '../../composables/useI18n';
import { adminApi } from '../../services/adminApi';
import { useSettingsForm } from '../../composables/useSettingsForm';
import FormInput from '../../components/ui/FormInput.vue';
import PageShell from '../../components/admin/PageShell.vue';
import BillingFxSettings from '../../components/admin/BillingFxSettings.vue';

interface ThemeOption {
  id: string;
  name: string;
}

const { local, saving, message, ready, save } = useSettingsForm();

const themes = ref<ThemeOption[]>([{ id: 'default', name: t('settings.builtinTheme') }]);

async function loadThemes() {
  try {
    const list = await adminApi.listThemes();
    themes.value = [{ id: 'default', name: t('settings.builtinTheme') }, ...list];
  } catch {
    // 忽略：主题市场面板会单独展示错误
  }
}

// ---- 受控端自助注册令牌（SETUP_TOKEN）：以库为权威，明文只在生成/设置时回显一次 ----
interface SetupTokenState { configured: boolean; source: string; weak: boolean }
const setupToken = ref<SetupTokenState>({ configured: false, source: 'none', weak: false });
const setupTokenPlain = ref('');
const setupTokenBusy = ref(false);
const setupTokenError = ref('');

async function loadSetupToken() {
  try { setupToken.value = await adminApi.setupTokenStatus(); } catch { /* 忽略：区块仍可用 */ }
}

async function rotateSetupToken(action: 'generate' | 'set' | 'clear') {
  setupTokenBusy.value = true;
  setupTokenError.value = '';
  try {
    const r = await adminApi.setupTokenRotate(action);
    setupTokenPlain.value = r.token || '';
    await loadSetupToken();
  } catch (e) {
    setupTokenError.value = e instanceof Error ? e.message : String(e);
  } finally {
    setupTokenBusy.value = false;
  }
}

const setupTokenSourceLabel = computed(() => {
  const map: Record<string, string> = {
    db: t('settings.setupTokenSourceDb'),
    'env-migrated': t('settings.setupTokenSourceEnv'),
    'env-weak': t('settings.setupTokenSourceEnvWeak'),
    cleared: t('settings.setupTokenSourceCleared'),
    none: t('settings.setupTokenSourceNone'),
  };
  return map[setupToken.value.source] || setupToken.value.source;
});

const sections = computed(() => [
  { id: 'sec-basic', label: t('site.basic') },
  { id: 'sec-display', label: t('site.display') },
  { id: 'sec-public', label: t('site.public') },
  { id: 'sec-custom', label: t('site.custom') },
  { id: 'sec-social', label: t('settings.socialLinks') },
  { id: 'sec-token', label: t('settings.setupToken') },
  { id: 'sec-billing', label: t('settings.billingTitle') },
]);

onMounted(() => {
  void loadThemes();
  void loadSetupToken();
});
</script>

<template>
  <PageShell :title="t('site.title')" :sections="sections">
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
      <!-- 基础信息 -->
      <section id="sec-basic" class="glass scroll-mt-28 rounded-xl p-5">
        <h2 class="mb-4 text-lg font-semibold">{{ t('site.basic') }}</h2>
        <div class="grid gap-x-6 sm:grid-cols-2">
          <FormInput v-model="local.ui.site_title" :label="t('settings.siteTitle')" />
          <FormInput v-model="local.ui.site_url" :label="t('settings.siteUrl')" />
        </div>
        <FormInput v-model="local.ui.site_description" :label="t('settings.siteDescription')" />
        <FormInput v-model="local.ui.logo_url" :label="t('settings.logoUrl')" />
      </section>

      <!-- 展示与布局 -->
      <section id="sec-display" class="glass scroll-mt-28 rounded-xl p-5">
        <h2 class="mb-4 text-lg font-semibold">{{ t('site.display') }}</h2>
        <div class="grid gap-x-6 sm:grid-cols-2">
          <div class="mb-4">
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.defaultTheme') }}</label>
            <div class="flex gap-2">
              <select
                v-model="local.ui.public_theme"
                class="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500"
              >
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
          <div class="mb-4">
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.homeLayout') }}</label>
            <select
              v-model="local.ui.home_layout"
              class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500"
            >
              <option value="grid">{{ t('public.grid') }}</option>
              <option value="list">{{ t('public.list') }}</option>
              <option value="compact">{{ t('public.compact') }}</option>
            </select>
          </div>
          <FormInput v-model="local.ui.default_sort" :label="t('settings.defaultSort')" />
          <FormInput v-model="local.ui.agent_server_url" :label="t('settings.agentServerUrl')" />
        </div>
      </section>

      <!-- 公开页开关 -->
      <section id="sec-public" class="glass scroll-mt-28 rounded-xl p-5">
        <h2 class="mb-4 text-lg font-semibold">{{ t('site.public') }}</h2>
        <FormInput v-model="local.ui.public_enabled" :label="t('settings.publicEnabled')" type="checkbox" />
        <FormInput v-model="local.ui.public_show_business" :label="t('settings.publicShowBusiness')" type="checkbox" />
        <FormInput
          v-model="local.ui.public_show_hardware"
          :label="t('settings.publicShowHardware')"
          :hint="t('settings.publicShowHardwareHint')"
          type="checkbox"
        />
      </section>

      <!-- 自定义代码 -->
      <section id="sec-custom" class="glass scroll-mt-28 rounded-xl p-5">
        <h2 class="mb-4 text-lg font-semibold">{{ t('site.custom') }}</h2>
        <FormInput v-model="local.ui.custom_css" :label="t('settings.customCss')" type="textarea" />
        <FormInput v-model="local.ui.custom_head" :label="t('settings.customHead')" type="textarea" />
        <FormInput v-model="local.ui.custom_body" :label="t('settings.customBody')" type="textarea" />
      </section>

      <!-- 社交链接 -->
      <section id="sec-social" class="glass scroll-mt-28 rounded-xl p-5">
        <h2 class="mb-4 text-lg font-semibold">{{ t('settings.socialLinks') }}</h2>
        <div class="grid gap-x-6 sm:grid-cols-2">
          <FormInput v-model="local.ui.social_email" :label="t('footer.email')" />
          <FormInput v-model="local.ui.social_telegram" label="Telegram" />
          <FormInput v-model="local.ui.social_qq" label="QQ" />
          <FormInput v-model="local.ui.social_website" :label="t('footer.website')" />
        </div>
      </section>

      <!-- 受控端自助注册令牌 -->
      <section id="sec-token" class="glass scroll-mt-28 rounded-xl p-5">
        <div class="mb-1 flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ t('settings.setupToken') }}</h2>
          <span
            class="rounded-full px-2 py-0.5 text-xs"
            :class="setupToken.configured ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-400'"
          >
            {{ setupToken.configured ? t('settings.setupTokenConfigured') : t('settings.setupTokenNotConfigured') }}
          </span>
        </div>
        <p class="mb-3 text-xs text-slate-400">{{ t('settings.setupTokenHint') }}</p>
        <div class="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>{{ t('settings.setupTokenSource') }}：<code class="text-slate-300">{{ setupTokenSourceLabel }}</code></span>
          <span v-if="setupToken.weak" class="text-amber-300">⚠️ {{ t('settings.setupTokenWeak') }}</span>
        </div>
        <div v-if="setupTokenPlain" class="mb-3">
          <div class="mb-1 text-xs text-amber-300">{{ t('settings.setupTokenOnce') }}</div>
          <code class="block break-all rounded-lg bg-black/40 p-2 font-mono text-xs text-slate-200">{{ setupTokenPlain }}</code>
        </div>
        <div class="flex gap-2">
          <button type="button" class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700/30 disabled:opacity-50" :disabled="setupTokenBusy" @click="rotateSetupToken('generate')">
            {{ t('settings.setupTokenGenerate') }}
          </button>
          <button type="button" class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700/30 disabled:opacity-50" :disabled="setupTokenBusy" @click="rotateSetupToken('clear')">
            {{ t('settings.setupTokenClear') }}
          </button>
        </div>
        <p v-if="setupTokenError" class="mt-2 text-xs text-rose-400">{{ setupTokenError }}</p>
      </section>

      <!-- 资产与汇率：剩余价值 / 总价值按标准货币汇总（手工汇率或服务端每日自动拉取） -->
      <section id="sec-billing" class="glass scroll-mt-28 rounded-xl p-5">
        <BillingFxSettings v-if="local.ui.billing" :billing="local.ui.billing" />
      </section>
    </div>
  </PageShell>
</template>
