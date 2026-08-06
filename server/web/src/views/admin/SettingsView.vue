<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
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
const themes = ref<ThemeOption[]>([{ id: 'default', name: '内置默认 (Vue SPA)' }]);

onMounted(async () => {
  try {
    const list = await adminApi.listThemes();
    themes.value = [{ id: 'default', name: '内置默认 (Vue SPA)' }, ...list];
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
        <FormInput v-model="local.ui.site_description" label="站点描述" />
        <FormInput v-model="local.ui.site_url" label="站点 URL" />
        <FormInput v-model="local.ui.logo_url" label="Logo URL" />
        <div>
          <label class="mb-1 block text-sm text-slate-400">默认公开主题</label>
          <div class="flex gap-2">
            <select v-model="local.ui.public_theme" class="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option v-for="t in themes" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
            <a
              v-if="local.ui.public_theme && local.ui.public_theme !== 'default'"
              :href="`/?theme=${local.ui.public_theme}`"
              target="_blank"
              class="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm text-sky-400 hover:border-sky-500"
            >预览</a>
          </div>
          <p class="mt-1 text-xs text-slate-500">选择第三方主题后，访客访问首页将看到主题皮肤；选择「内置默认」则继续使用本 SPA。</p>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">首页默认布局</label>
          <select v-model="local.ui.home_layout" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
            <option value="grid">网格</option>
            <option value="list">列表</option>
            <option value="compact">紧凑</option>
          </select>
        </div>
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

      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">主题可视化（对齐 Glassmorphism）</h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm text-slate-400">毛玻璃预设</label>
            <select v-model="local.ui.glass_preset" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="emerald">翡翠 Emerald</option>
              <option value="soft">柔和 Soft</option>
              <option value="high-contrast">高对比 High Contrast</option>
              <option value="midnight">午夜 Midnight</option>
              <option value="custom">自定义 Custom</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">色觉辅助</label>
            <select v-model="local.ui.color_vision" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="normal">标准</option>
              <option value="protanopia">红色盲 Protanopia</option>
              <option value="deuteranopia">绿色盲 Deuteranopia</option>
              <option value="tritanopia">蓝色盲 Tritanopia</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">首页总览卡片方案</label>
            <select v-model="local.ui.card_scheme" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="official">官方</option>
              <option value="basic">基础</option>
              <option value="ops">运维</option>
              <option value="resource">资源</option>
              <option value="finance">财务</option>
              <option value="traffic">流量</option>
              <option value="gpu">GPU</option>
              <option value="asset">资产</option>
              <option value="full">完整</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">节点卡片尺寸</label>
            <select v-model="local.ui.card_size" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="mini">迷你</option>
              <option value="compact">紧凑</option>
              <option value="comfortable">舒适</option>
              <option value="large">大</option>
            </select>
          </div>
        </div>

        <div class="mt-4 rounded-lg bg-surface p-4">
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" v-model="local.ui.background!.enabled" class="rounded" />
            启用自定义背景（图片/视频）
          </label>
          <div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label class="mb-1 block text-sm text-slate-400">类型</label>
              <select v-model="local.ui.background!.type" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
                <option value="image">图片</option>
                <option value="video">视频</option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-sm text-slate-400">URL</label>
              <input v-model="local.ui.background!.url" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500" placeholder="https://..." />
            </div>
            <div>
              <label class="mb-1 block text-sm text-slate-400">模糊 {{ local.ui.background!.blur }}px</label>
              <input type="range" min="0" max="30" v-model.number="local.ui.background!.blur" class="w-full" />
            </div>
          </div>
          <div class="mt-3">
            <label class="mb-1 block text-sm text-slate-400">遮罩强度 {{ local.ui.background!.overlay }}%</label>
            <input type="range" min="0" max="100" v-model.number="local.ui.background!.overlay" class="w-full" />
          </div>
        </div>

        <div class="mt-4 rounded-lg bg-surface p-4">
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" v-model="local.ui.announcement!.enabled" class="rounded" />
            启用公告
          </label>
          <FormInput v-model="local.ui.announcement!.title" label="公告标题" class="mt-2" />
          <FormInput v-model="local.ui.announcement!.content" label="公告内容" type="textarea" />
        </div>

        <div class="mt-4 flex items-center gap-6">
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" v-model="local.ui.visitor_info" class="rounded" />
            显示访客信息条（底部 IP）
          </label>
        </div>

        <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm text-slate-400">厂商别名（JSON，如 {"阿里云":"Aliyun"}）</label>
            <textarea v-model="providerAliasesText" rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"></textarea>
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">节点自定义标签（JSON，如 {"agent_id":"国内"}）</label>
            <textarea v-model="customTagsText" rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"></textarea>
          </div>
        </div>
      </div>
    </div>
    <div class="mt-6">
      <button :disabled="saving" class="rounded-lg bg-sky-500 px-6 py-2 text-white hover:bg-sky-400 disabled:opacity-50" @click="save">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>

    <TwoFactorPanel class="mt-6" />
  </div>
</template>
