// 设置表单骨架：后台「站点设置 / 告警与通知 / 系统维护 / 登录与安全」共用。
//
// ⚠ 后端 PUT /api/settings 对 ui / notify 是**整体覆盖**写（api.js router.put('/settings')）：
//   每个页面必须 clone 完整 settings 再提交，绝不能只带本页字段，否则会清空其它页面的配置。
//   这也是这里坚持「一个完整 local + 一次整体 save」而不是按页裁剪 payload 的原因。
//
// ⚠ watch 注册顺序不可调换：先注册「回填 local」，再注册「标记 dirty」。
//   否则冷加载时 resetLocal 触发的 dirty 会在 setup 结束后先变真，回填被 `if (dirty) return`
//   拦掉，表单显示默认值，此时保存会用残缺表单覆盖服务端已存配置（真实 bug，2026-09-12）。
import { computed, getCurrentInstance, onMounted, onUnmounted, ref, watch } from 'vue';
import { adminApi } from '../services/adminApi';
import { t } from './useI18n';
import { loadAdmin, setAutoRefreshPaused, useAdmin } from './useAdmin';
import type { Settings } from '../services/types';

export interface UiSettings {
  site_title?: string;
  site_description?: string;
  site_url?: string;
  logo_url?: string;
  custom_css?: string;
  custom_head?: string;
  custom_body?: string;
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
  // 公开接口是否透出业务字段（商家/到期/备注/配额/套餐）
  public_show_business?: boolean;
  // 公开接口是否透出硬件档案（管理员手工录入；关闭 = 一键隐藏全部）
  public_show_hardware?: boolean;
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
  // 数据库备份策略（由宿主侧 diting.sh 执行，这里只下发策略）
  backup_schedule?: 'off' | 'daily' | 'weekly';
  backup_hour?: number;
  backup_keep_days?: number;
  backup_keep_count?: number;
  backup_compress?: boolean;
  // F12 容量保险丝（行数 + 库文件双水位；100% 只暂停历史明细）
  capacity_enabled?: boolean;
  capacity_max_rows?: number;
  capacity_max_mb?: number;
  // 资产汇率（管理员手工录入，不联网、不自动抓汇率）：
  // base_currency = 标准货币；rates[c] = 1 单位 c 折合多少标准货币，缺项表示不折算。
  billing?: { base_currency: string; rates: Record<string, number>; updated_at: number };
}

export interface NotifySettings {
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

export interface SettingsForm {
  ui: UiSettings;
  notify: NotifySettings;
}

// 与服务端 db.js 默认值对齐：模板里的 v-model 会立即求值，
// 冷加载（settings 尚未到达）时若 alert 等嵌套对象为 undefined 会抛 TypeError 导致整页空白。
export function emptySettingsForm(): SettingsForm {
  return {
    ui: {
      custom_head: '',
      custom_body: '',
      background: { enabled: false, type: 'image', url: '', blur: 8, overlay: 50 },
      announcement: { enabled: false, title: '', content: '' },
      provider_aliases: {},
      custom_tags: {},
      glass_preset: 'emerald',
      color_vision: 'normal',
      card_scheme: 'official',
      card_size: 'comfortable',
      visitor_info: false,
      backup_schedule: 'off',
      backup_hour: 3,
      backup_keep_days: 14,
      backup_keep_count: 10,
      backup_compress: true,
      capacity_enabled: true,
      capacity_max_rows: 2000000,
      capacity_max_mb: 2048,
      // 硬件档案全局开关：默认公开（与 db.js getUiSettings 默认 true 一致）
      public_show_hardware: true,
      // 与服务端默认值一致（db.js getUiSettings 的 alert 默认 90/90/60）
      alert: { cpu_pct: 90, mem_pct: 90, offline_sec: 60 },
      // 资产汇率：必须与 db.js 默认值一致，否则保存设置会把该键写成 undefined
      billing: { base_currency: 'CNY', rates: {}, updated_at: 0 },
    },
    notify: {},
  };
}

// 深拷贝服务端设置到表单：嵌套对象必须逐层复制，浅拷贝会让后续编辑原地改到 state.settings 上。
export function cloneSettings(src?: Settings | null): SettingsForm {
  const ui = ((src && src.ui) || {}) as UiSettings;
  const notify = ((src && src.notify) || {}) as NotifySettings;
  return {
    ui: {
      ...ui,
      custom_head: ui.custom_head || '',
      custom_body: ui.custom_body || '',
      alert: { ...(ui.alert || {}) },
      billing: {
        base_currency: ui.billing?.base_currency || 'CNY',
        rates: { ...(ui.billing?.rates || {}) },
        updated_at: ui.billing?.updated_at || 0,
      },
      background: { enabled: false, type: 'image', url: '', blur: 8, overlay: 50, ...(ui.background || {}) },
      announcement: { enabled: false, title: '', content: '', ...(ui.announcement || {}) },
      provider_aliases: { ...(ui.provider_aliases || {}) },
      custom_tags: { ...(ui.custom_tags || {}) },
      glass_preset: ui.glass_preset || 'emerald',
      color_vision: ui.color_vision || 'normal',
      card_scheme: ui.card_scheme || 'official',
      card_size: ui.card_size || 'comfortable',
      visitor_info: !!ui.visitor_info,
      backup_schedule: ui.backup_schedule || 'off',
      backup_hour: Number.isFinite(Number(ui.backup_hour)) ? Number(ui.backup_hour) : 3,
      backup_keep_days: Number.isFinite(Number(ui.backup_keep_days)) ? Number(ui.backup_keep_days) : 14,
      backup_keep_count: Number.isFinite(Number(ui.backup_keep_count)) ? Number(ui.backup_keep_count) : 10,
      // 注意：后端默认 true，未配置时也应显示开启，故用 !== false 判断
      backup_compress: ui.backup_compress !== false,
      capacity_enabled: ui.capacity_enabled !== false,
      capacity_max_rows: Number.isFinite(Number(ui.capacity_max_rows)) ? Number(ui.capacity_max_rows) : 2000000,
      capacity_max_mb: Number.isFinite(Number(ui.capacity_max_mb)) ? Number(ui.capacity_max_mb) : 2048,
    },
    notify: { ...notify },
  };
}

export function useSettingsForm() {
  const { state } = useAdmin();
  const local = ref<SettingsForm>(emptySettingsForm());
  const dirty = ref(false);
  const saving = ref(false);
  const message = ref('');
  // 服务端设置是否已就绪：未就绪时保存会用默认值覆盖服务端配置，按钮应禁用。
  const ready = computed(() => !!(state.settings && state.settings.ui));

  watch(
    () => state.settings,
    (s) => {
      // 用户有未保存的编辑时，不覆盖输入框（10s 自动刷新会触发本 watch）
      if (dirty.value) return;
      if (s) local.value = cloneSettings(s);
    },
    { immediate: true },
  );

  // ⚠ 必须在上面「回填 local」的 watch 之后注册，理由见文件头。
  watch(local, () => { dirty.value = true; }, { deep: true });

  if (getCurrentInstance()) {
    onMounted(() => {
      // 进入设置类页面暂停全局 10s 自动刷新（paused 标志，避免被父组件 start 覆盖），
      // 防止轮询重写表单清空未保存输入。
      setAutoRefreshPaused(true);
      if (!state.settings) void loadAdmin();
    });
    onUnmounted(() => {
      // 离开页面恢复自动刷新（不影响其他页面）
      setAutoRefreshPaused(false);
    });
  }

  async function save() {
    saving.value = true;
    message.value = '';
    try {
      await adminApi.saveSettings(local.value as unknown as Settings);
      message.value = t('settings.saved');
      await loadAdmin();
      dirty.value = false;
    } catch (e) {
      message.value = (e as Error).message || t('settings.saveFailed');
    } finally {
      saving.value = false;
    }
  }

  return { local, dirty, saving, message, ready, save };
}
