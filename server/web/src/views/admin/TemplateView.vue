<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useAdmin, loadAdmin } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import { refreshGlass } from '../../composables/useTheme';

interface BgCfg {
  enabled: boolean;
  type: 'image' | 'video';
  url: string;
  blur: number;
  overlay: number;
}
interface Announcement {
  enabled: boolean;
  title: string;
  content: string;
}
interface UiSettings {
  glass_preset?: string;
  glass_custom?: { dark?: string[]; light?: string[] };
  background_dark?: BgCfg;
  background_light?: BgCfg;
  background?: any; // 旧版单背景字段兼容
  color_vision?: string;
  card_scheme?: string;
  card_size?: string;
  visitor_info?: boolean;
  announcement?: Announcement;
  provider_aliases?: Record<string, string>;
  custom_tags?: Record<string, string[]>;
}

const { state } = useAdmin();
const saving = ref(false);
const message = ref('');
// 用户是否已修改但未保存；编辑期间禁止自动刷新覆盖输入（避免 10s 轮询清空）
const dirty = ref(false);

// 暗/亮各自的 5 色调色板（对齐 useTheme 的 glass_custom 顺序）：
// [0] tint(卡片底色 rgba) [1] saturate [2] blur [3] border [4] shadow
// 默认卡片透明度 80%（#..cc）= 仅透出 20% 背景，配合内置背景保证字体清晰
const defaultDark = ['#0a0e16cc', '145%', '14px', '#ffffff2e', '0 8px 30px #0000007a'];
const defaultLight = ['#f1f5f9cc', '145%', '14px', '#e2e8f0ad', '0 8px 28px #0f172a2e'];

// 内置默认背景：暗色深蓝黑径向渐变、亮色柔和浅蓝对角渐变。
// 均为 SVG data URI（isSafeImageUrl 白名单允许），配合 80% 不透明卡片可在透明态下清晰阅读。
const BG_DARK =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'>" +
    "<defs><radialGradient id='g' cx='30%' cy='20%' r='120%'>" +
    "<stop offset='0' stop-color='#16243a'/>" +
    "<stop offset='55%' stop-color='#0b1220'/>" +
    "<stop offset='100%' stop-color='#05080f'/>" +
    "</radialGradient></defs><rect width='1920' height='1080' fill='url(#g)'/></svg>"
  );
const BG_LIGHT =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'>" +
    "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
    "<stop offset='0' stop-color='#f4f8fc'/>" +
    "<stop offset='55%' stop-color='#e6eef6'/>" +
    "<stop offset='100%' stop-color='#d7e3ef'/>" +
    "</linearGradient></defs><rect width='1920' height='1080' fill='url(#g)'/></svg>"
  );

// 把 rgba / #rrggbbaa 字符串解析为 {hex, alpha}
function parseColor(c: string) {
  c = (c || '').trim();
  if (c.startsWith('#')) {
    if (c.length === 9) {
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      const a = parseInt(c.slice(7, 9), 16) / 255;
      return { hex: rgbToHex(r, g, b), alpha: Math.round(a * 100) };
    }
    if (c.length === 7) return { hex: c, alpha: 100 };
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map(s => s.trim());
    const r = Number(p[0]), g = Number(p[1]), b = Number(p[2]);
    const a = p[3] !== undefined ? parseFloat(p[3]) : 1;
    return { hex: rgbToHex(r, g, b), alpha: Math.round(a * 100) };
  }
  return { hex: '#0a0e16', alpha: 5 };
}
function rgbToHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
}
function toRgba(hex: string, alpha: number) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(alpha / 100).toFixed(3)})`;
}

const form = ref<UiSettings>({
  glass_preset: 'custom',
  glass_custom: { dark: [...defaultDark], light: [...defaultLight] },
  // 内置默认背景：暗色深蓝黑渐变、亮色柔和浅蓝渐变，overlay 适中以衬托 80% 不透明卡片
  background_dark: { enabled: true, type: 'image', url: BG_DARK, blur: 8, overlay: 35 },
  background_light: { enabled: true, type: 'image', url: BG_LIGHT, blur: 8, overlay: 45 },
  color_vision: 'normal',
  card_scheme: 'official',
  card_size: 'comfortable',
  visitor_info: false,
  announcement: { enabled: false, title: '', content: '' },
  provider_aliases: {},
  custom_tags: {},
});

// 暗/亮透明度滑杆（基于 custom 数组第 0 项的 alpha）
const darkAlpha = computed({
  get: () => parseColor(form.value.glass_custom?.dark?.[0] || defaultDark[0]).alpha,
  set: (v) => {
    const cur = parseColor(form.value.glass_custom?.dark?.[0] || defaultDark[0]);
    form.value.glass_custom!.dark![0] = toRgba(cur.hex, v);
  },
});
const lightAlpha = computed({
  get: () => parseColor(form.value.glass_custom?.light?.[0] || defaultLight[0]).alpha,
  set: (v) => {
    const cur = parseColor(form.value.glass_custom?.light?.[0] || defaultLight[0]);
    form.value.glass_custom!.light![0] = toRgba(cur.hex, v);
  },
});
// 暗/亮 tint 颜色选择器（不含 alpha）
const darkTintHex = computed({
  get: () => parseColor(form.value.glass_custom?.dark?.[0] || defaultDark[0]).hex,
  set: (v) => {
    const cur = parseColor(form.value.glass_custom?.dark?.[0] || defaultDark[0]);
    form.value.glass_custom!.dark![0] = toRgba(v, cur.alpha);
  },
});
const lightTintHex = computed({
  get: () => parseColor(form.value.glass_custom?.light?.[0] || defaultLight[0]).hex,
  set: (v) => {
    const cur = parseColor(form.value.glass_custom?.light?.[0] || defaultLight[0]);
    form.value.glass_custom!.light![0] = toRgba(v, cur.alpha);
  },
});

const presetOptions = [
  { value: 'emerald', label: t('settings.preset.emerald') },
  { value: 'soft', label: t('settings.preset.soft') },
  { value: 'high-contrast', label: t('settings.preset.highContrast') },
  { value: 'midnight', label: t('settings.preset.midnight') },
  { value: 'custom', label: t('settings.preset.custom') },
];
const cvOptions = [
  { value: 'normal', label: t('settings.cv.normal') },
  { value: 'protanopia', label: t('settings.cv.protanopia') },
  { value: 'deuteranopia', label: t('settings.cv.deuteranopia') },
  { value: 'tritanopia', label: t('settings.cv.tritanopia') },
];
const schemeOptions = [
  { value: 'official', label: t('settings.scheme.official') },
  { value: 'basic', label: t('settings.scheme.basic') },
  { value: 'ops', label: t('settings.scheme.ops') },
  { value: 'resource', label: t('settings.scheme.resource') },
  { value: 'finance', label: t('settings.scheme.finance') },
  { value: 'traffic', label: t('settings.scheme.traffic') },
  { value: 'gpu', label: t('settings.scheme.gpu') },
  { value: 'asset', label: t('settings.scheme.asset') },
  { value: 'full', label: t('settings.scheme.full') },
];
const sizeOptions = [
  { value: 'mini', label: t('settings.size.mini') },
  { value: 'compact', label: t('settings.size.compact') },
  { value: 'comfortable', label: t('settings.size.comfortable') },
  { value: 'large', label: t('settings.size.large') },
];

// 厂商别名 / 自定义标签以 JSON 文本编辑
const aliasesText = computed({
  get: () => JSON.stringify(form.value.provider_aliases || {}, null, 2),
  set: (v) => {
    try { form.value.provider_aliases = JSON.parse(v || '{}'); message.value = ''; }
    catch { message.value = t('settings.jsonError'); }
  },
});
const tagsText = computed({
  get: () => JSON.stringify(form.value.custom_tags || {}, null, 2),
  set: (v) => {
    try { form.value.custom_tags = JSON.parse(v || '{}'); message.value = ''; }
    catch { message.value = t('settings.jsonError'); }
  },
});

function normalizeBg(b: any): BgCfg {
  return {
    enabled: !!(b && b.enabled),
    type: (b && b.type === 'video') ? 'video' : 'image',
    url: (b && b.url) || '',
    blur: Number((b && b.blur) ?? 8),
    overlay: Number((b && b.overlay) ?? 50),
  };
}

watch(() => state.settings, (s) => {
  if (!s || !s.ui) return;
  // 用户有未保存的编辑时，不覆盖输入框（10s 自动刷新会触发本 watch）
  if (dirty.value) return;
  const ui = s.ui as UiSettings;
  form.value = {
    glass_preset: ui.glass_preset || 'custom',
    glass_custom: {
      dark: (ui.glass_custom?.dark && ui.glass_custom.dark.length >= 5) ? [...ui.glass_custom.dark] : [...defaultDark],
      light: (ui.glass_custom?.light && ui.glass_custom.light.length >= 5) ? [...ui.glass_custom.light] : [...defaultLight],
    },
    background_dark: normalizeBg(ui.background_dark || ui.background),
    background_light: normalizeBg(ui.background_light),
    color_vision: ui.color_vision || 'normal',
    card_scheme: ui.card_scheme || 'official',
    card_size: ui.card_size || 'comfortable',
    visitor_info: !!ui.visitor_info,
    announcement: {
      enabled: !!(ui.announcement && ui.announcement.enabled),
      title: (ui.announcement && ui.announcement.title) || '',
      content: (ui.announcement && ui.announcement.content) || '',
    },
    provider_aliases: ui.provider_aliases || {},
    custom_tags: ui.custom_tags || {},
  };
}, { immediate: true });

// 监听表单任意改动，标记未保存（编辑期间禁止自动刷新覆盖）
watch(form, () => { dirty.value = true; }, { deep: true });

onMounted(() => {
  if (!state.settings) loadAdmin();
});

async function save() {
  saving.value = true;
  message.value = '';
  try {
    // 模板设置强制使用 custom 预设，以便暗/亮透明度独立生效
    const next: UiSettings = { ...form.value, glass_preset: 'custom' };
    // 合并进完整 ui 设置，避免覆盖其他设置项（setUiSettings 为整体覆盖）
    const current = (state.settings && state.settings.ui) || {};
    const merged = { ...current, ...next };
    await adminApi.saveSettings({ ui: merged } as Record<string, unknown>);
    message.value = t('settings.saved');
    await loadAdmin();
    dirty.value = false;
    refreshGlass();
  } catch (e) {
    message.value = (e as Error).message || t('settings.saveFailed');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <h1 class="mb-2 text-2xl font-bold">{{ t('template.title') }}</h1>
    <p class="mb-6 text-sm text-slate-400">{{ t('template.desc') }}</p>

    <div v-if="message" class="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-200">
      {{ message }}
    </div>

    <!-- 暗色配色 -->
    <div class="glass mb-6 p-6">
      <h2 class="mb-4 text-lg font-semibold text-slate-100">{{ t('template.darkSection') }}</h2>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('template.cardColor') }}</label>
          <div class="flex items-center gap-2">
            <input type="color" v-model="darkTintHex" class="h-9 w-12 rounded border border-slate-700 bg-transparent" />
            <input type="range" min="0" max="100" v-model.number="darkAlpha" class="flex-1" />
            <span class="w-12 text-right text-xs text-slate-400">{{ darkAlpha }}%</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">{{ t('template.alphaHint') }}</p>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('template.blur') }}</label>
          <div class="flex items-center gap-2">
            <input type="range" min="0" max="30" :value="parseInt(form.glass_custom?.dark?.[2] || '14')" @input="(e:any)=>form.glass_custom!.dark![2] = e.target.value + 'px'" class="flex-1" />
            <span class="w-12 text-right text-xs text-slate-400">{{ form.glass_custom?.dark?.[2] }}</span>
          </div>
        </div>
      </div>

      <h3 class="mb-3 mt-6 text-sm font-medium text-slate-300">{{ t('template.background') }}</h3>
      <div class="rounded-lg bg-surface p-4">
        <label class="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" v-model="form.background_dark!.enabled" class="rounded" />
          {{ t('settings.backgroundEnabled') }}
        </label>
        <div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.type') }}</label>
            <select v-model="form.background_dark!.type" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="image">{{ t('settings.image') }}</option>
              <option value="video">{{ t('settings.video') }}</option>
            </select>
          </div>
          <div class="sm:col-span-2">
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.url') }}</label>
            <input v-model="form.background_dark!.url" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500" placeholder="https://..." />
          </div>
        </div>
        <div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.blur', { n: form.background_dark!.blur }) }}</label>
            <input type="range" min="0" max="30" v-model.number="form.background_dark!.blur" class="w-full" />
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.overlay', { n: form.background_dark!.overlay }) }}</label>
            <input type="range" min="0" max="100" v-model.number="form.background_dark!.overlay" class="w-full" />
          </div>
        </div>
      </div>
    </div>

    <!-- 亮色配色 -->
    <div class="glass mb-6 p-6">
      <h2 class="mb-4 text-lg font-semibold text-slate-100">{{ t('template.lightSection') }}</h2>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('template.cardColor') }}</label>
          <div class="flex items-center gap-2">
            <input type="color" v-model="lightTintHex" class="h-9 w-12 rounded border border-slate-700 bg-transparent" />
            <input type="range" min="0" max="100" v-model.number="lightAlpha" class="flex-1" />
            <span class="w-12 text-right text-xs text-slate-400">{{ lightAlpha }}%</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">{{ t('template.alphaHint') }}</p>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('template.blur') }}</label>
          <div class="flex items-center gap-2">
            <input type="range" min="0" max="30" :value="parseInt(form.glass_custom?.light?.[2] || '14')" @input="(e:any)=>form.glass_custom!.light![2] = e.target.value + 'px'" class="flex-1" />
            <span class="w-12 text-right text-xs text-slate-400">{{ form.glass_custom?.light?.[2] }}</span>
          </div>
        </div>
      </div>

      <h3 class="mb-3 mt-6 text-sm font-medium text-slate-300">{{ t('template.background') }}</h3>
      <div class="rounded-lg bg-surface p-4">
        <label class="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" v-model="form.background_light!.enabled" class="rounded" />
          {{ t('settings.backgroundEnabled') }}
        </label>
        <div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.type') }}</label>
            <select v-model="form.background_light!.type" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
              <option value="image">{{ t('settings.image') }}</option>
              <option value="video">{{ t('settings.video') }}</option>
            </select>
          </div>
          <div class="sm:col-span-2">
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.url') }}</label>
            <input v-model="form.background_light!.url" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500" placeholder="https://..." />
          </div>
        </div>
        <div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.blur', { n: form.background_light!.blur }) }}</label>
            <input type="range" min="0" max="30" v-model.number="form.background_light!.blur" class="w-full" />
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.overlay', { n: form.background_light!.overlay }) }}</label>
            <input type="range" min="0" max="100" v-model.number="form.background_light!.overlay" class="w-full" />
          </div>
        </div>
      </div>
    </div>

    <!-- 外观与展示 -->
    <div class="glass mb-6 p-6">
      <h2 class="mb-4 text-lg font-semibold text-slate-100">{{ t('template.appearance') }}</h2>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('settings.glassPreset') }}</label>
          <select v-model="form.glass_preset" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
            <option v-for="o in presetOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('settings.colorVision') }}</label>
          <select v-model="form.color_vision" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
            <option v-for="o in cvOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('settings.cardScheme') }}</label>
          <select v-model="form.card_scheme" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
            <option v-for="o in schemeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-sm text-slate-400">{{ t('settings.cardSize') }}</label>
          <select v-model="form.card_size" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500">
            <option v-for="o in sizeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>

      <label class="mt-4 flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" v-model="form.visitor_info" class="rounded" />
        {{ t('settings.visitorInfo') }}
      </label>

      <!-- 公告 -->
      <h3 class="mb-3 mt-6 text-sm font-medium text-slate-300">{{ t('settings.announcement') }}</h3>
      <div class="rounded-lg bg-surface p-4">
        <label class="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" v-model="form.announcement!.enabled" class="rounded" />
          {{ t('settings.announcementEnabled') }}
        </label>
        <div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.announcementTitle') }}</label>
            <input v-model="form.announcement!.title" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500" />
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-400">{{ t('settings.announcementContent') }}</label>
            <input v-model="form.announcement!.content" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500" />
          </div>
        </div>
      </div>

      <!-- 厂商别名 / 自定义标签 -->
      <h3 class="mb-3 mt-6 text-sm font-medium text-slate-300">{{ t('settings.providerAliases') }}</h3>
      <textarea v-model="aliasesText" rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 font-mono text-xs text-white outline-none focus:border-sky-500"></textarea>

      <h3 class="mb-3 mt-6 text-sm font-medium text-slate-300">{{ t('settings.customTags') }}</h3>
      <textarea v-model="tagsText" rows="3" class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 font-mono text-xs text-white outline-none focus:border-sky-500"></textarea>
    </div>

    <div class="mt-6">
      <button :disabled="saving" class="rounded-lg bg-sky-500 px-6 py-2 text-white hover:bg-sky-400 disabled:opacity-50" @click="save">
        {{ saving ? t('settings.saving') : t('common.save') }}
      </button>
    </div>
  </div>
</template>
