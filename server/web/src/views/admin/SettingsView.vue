<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useAdmin, loadAdmin, setAutoRefreshPaused } from '../../composables/useAdmin';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import type { Settings } from '../../services/types';
import { useBackupPanel } from '../../composables/useBackupPanel';
import { useGroupAlertOverrides } from '../../composables/useGroupAlertOverrides';
import FormInput from '../../components/ui/FormInput.vue';
import TwoFactorPanel from '../../components/admin/TwoFactorPanel.vue';
import NotifyPanel from '../../components/admin/NotifyPanel.vue';
import ThemePanel from '../../components/admin/ThemePanel.vue';

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
  // 公开接口是否透出业务字段（商家/到期/备注/配额/套餐）
  public_show_business?: boolean;
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
      backup_schedule: 'off',
      backup_hour: 3,
      backup_keep_days: 14,
      backup_keep_count: 10,
      backup_compress: true,
      capacity_enabled: true,
      capacity_max_rows: 2000000,
      capacity_max_mb: 2048,
      // 与服务端默认值一致（db.js getUiSettings 的 alert 默认 90/90/60）。
      // 必须在这里给默认值：模板 v-model="local.ui.alert!.cpu_pct" 会被立即求值，
      // 若 settings 尚未到达（冷加载）或拉取失败（429/5xx），alert 为 undefined
      // 会让整个设置页渲染抛 TypeError、只剩残缺 DOM。
      alert: { cpu_pct: 90, mem_pct: 90, offline_sec: 60 },
    },
    notify: {},
  };
}
resetLocal();
const themes = ref<ThemeOption[]>([{ id: 'default', name: t('settings.builtinTheme') }]);

// ---- 受控端自助注册令牌（SETUP_TOKEN）：以库为权威，明文只在生成/设置时回显一次 ----
interface SetupTokenState { configured: boolean; source: string; weak: boolean }
const setupToken = ref<SetupTokenState>({ configured: false, source: 'none', weak: false });
const setupTokenPlain = ref('');          // 生成/设置后的明文（仅一次，刷新即消失）
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

// 服务端实际识别到的客户端来源 IP（配合 IP 白名单 / TRUST_PROXY 排障）
const clientIp = ref<{ ip: string; trust_proxy: string | number | string[]; x_forwarded_for: string } | null>(null);
const isLoopbackTrust = computed(() => String(clientIp.value?.trust_proxy) === 'loopback');
// 识别到的是内网/回环地址，而你显然是从外部访问后台 → 大概率是 trust proxy 未配置
const isPrivateSeenIp = computed(() => {
  const ip = clientIp.value?.ip || '';
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1$|::ffff:127\.)/.test(ip);
});

async function loadThemes() {
  try {
    const list = await adminApi.listThemes();
    themes.value = [{ id: 'default', name: t('settings.builtinTheme') }, ...list];
  } catch {
    // 忽略：主题市场面板会单独展示错误
  }
}

onMounted(async () => {
  // 进入设置页暂停全局 10s 自动刷新（paused 标志，避免被父组件 start 覆盖），
  // 防止轮询重写表单清空未保存输入
  setAutoRefreshPaused(true);
  // S1/F1：分组告警覆盖（失败静默，不阻塞其余设置项）
  loadAlertRules();
  void loadThemes();
  void loadSetupToken();
  try {
    clientIp.value = await adminApi.clientIp();
  } catch {
    // 只读 Token 或无权限时忽略，不影响其它设置
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


watch(() => state.settings, (s) => {
  // 用户有未保存的编辑时，不覆盖输入框（10s 自动刷新会触发本 watch）
  if (dirty.value) return;
  if (s) local.value = cloneSettings(s);
}, { immediate: true });

// ⚠ 顺序要求：dirty 的监听必须在上面「回填 local」的 watch 之后注册。
// 否则上面的 resetLocal() 会先触发本 watcher（flush:'pre' 延迟到 setup 结束后执行），
// 使 dirty 在服务端设置到达前就变 true → 回填被 `if (dirty.value) return` 拦掉，
// 结果是冷加载（刷新 /admin/settings）时表单显示默认值，且此时点保存会用残缺的
// local 覆盖服务端已存配置（site_title、logo、SMTP 等被清空）。
watch(local, () => { dirty.value = true; }, { deep: true });

// ---- 备份 / 恢复审查 / 容量：逻辑集中在 useBackupPanel，模板变量名保持不变 ----
// 不拆子组件的原因：这段模板大量 v-model 深层字段，拆组件要改写全部绑定且无 UI 回归测试。
const {
  backupState, backupFiles, backupDir, backupAvailable, backupBusy, backupMsg,
  restoreAudit, capacityStatus, capacityBusy, capacityMsg,
  backupFileInput, backupUploading, backupUploadPct,
  loadBackups, cleanupCapacity, downloadBackup, removeBackup, onPickBackup, createSnapshot, restoreBackup,
  fmtBytes, fmtTime, backupStatusText, backupStale,
  restoreCheckName, restoreStatusName, restoreStatusClass, restoreCheckText, restoreRetention,
  integrityClass, integrityText,
} = useBackupPanel();

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

// ---- 分组告警阈值覆盖：逻辑在 useGroupAlertOverrides ----
const {
  groupOverrides, groupBusy, groupForm, groupFieldRows,
  loadAlertRules, applyGroupForm, groupPlaceholder, saveGroupAlert, resetGroupAlert,
} = useGroupAlertOverrides({ message });
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
        <FormInput
          v-model="local.ui.admin_allow_ips"
          :label="t('settings.adminAllowIps')"
          :hint="t('settings.adminAllowIpsHint')"
        />
        <p v-if="clientIp" class="mb-4 text-xs text-slate-400">
          {{ t('settings.clientIpSeen') }}：<span class="font-mono text-slate-200">{{ clientIp.ip }}</span>
          <span v-if="clientIp.x_forwarded_for && clientIp.x_forwarded_for !== clientIp.ip">
            （{{ t('settings.clientIpHintXff', { xff: clientIp.x_forwarded_for }) }}）
          </span>
          <span v-if="!isLoopbackTrust"> · {{ t('settings.trustProxyValue', { value: String(clientIp.trust_proxy) }) }}</span>
        </p>
        <p v-if="clientIp && isPrivateSeenIp" class="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-relaxed text-amber-200">
          {{ t('settings.clientIpWarn') }}
        </p>
        <FormInput v-model="local.ui.retention_days" :label="t('settings.retentionDays')" type="number" />
        <FormInput v-model="local.ui.public_enabled" :label="t('settings.publicEnabled')" type="checkbox" />
        <FormInput v-model="local.ui.public_show_business" :label="t('settings.publicShowBusiness')" type="checkbox" />
        <FormInput v-model="local.ui.custom_css" :label="t('settings.customCss')" type="textarea" />
      </div>
      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('settings.alertThresholds') }}</h2>
        <FormInput v-model="local.ui.alert!.cpu_pct" :label="t('settings.cpuThreshold')" type="number" />
        <FormInput v-model="local.ui.alert!.mem_pct" :label="t('settings.memThreshold')" type="number" />
        <FormInput v-model="local.ui.alert!.offline_sec" :label="t('settings.offlineSec')" type="number" />
        <FormInput
          v-model="local.ui.probe_targets"
          :label="t('settings.probeTargets')"
          type="textarea"
          :hint="t('settings.probeTargetsHint')"
        />

        <!-- S1/F1：分组告警覆盖（留空 = 继承全局） -->
        <h2 class="mb-1 mt-8 text-lg font-semibold">{{ t('settings.groupAlertRules') }}</h2>
        <p class="mb-3 text-xs text-slate-500">{{ t('settings.groupAlertHint') }}</p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="text-xs text-slate-400">
            {{ t('settings.groupName') }}
            <input
              v-model="groupForm.grp"
              list="diting-alert-groups"
              class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white"
              @change="applyGroupForm(groupForm.grp)"
            />
            <datalist id="diting-alert-groups">
              <option v-for="g in groupOverrides" :key="g.grp" :value="g.grp" />
            </datalist>
          </label>
          <label v-for="f in groupFieldRows" :key="f.key" class="text-xs text-slate-400">
            {{ f.label }}
            <input
              v-model="groupForm[f.key]"
              type="number"
              :placeholder="groupPlaceholder(f.key)"
              class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white"
            />
          </label>
        </div>
        <label class="mt-3 flex cursor-pointer items-center gap-2 text-sm text-slate-300">
          <input v-model="groupForm.muted" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-rose-500" />
          {{ t('agents.alertMuted') }}
        </label>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400 disabled:opacity-50"
            :disabled="groupBusy"
            @click="saveGroupAlert"
          >{{ t('common.save') }}</button>
          <button
            type="button"
            class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            :disabled="groupBusy"
            @click="resetGroupAlert"
          >{{ t('agents.alertReset') }}</button>
          <span v-if="groupOverrides.length" class="text-xs text-slate-500">
            {{ t('settings.existingGroupRules') }}:
            {{ groupOverrides.map((g) => (g.grp === '' ? t('settings.defaultGroup') : g.grp)).join(' / ') }}
          </span>
        </div>

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

        <!-- 受控端自助注册令牌：库为权威（SETUP_TOKEN），明文只在生成/设置时回显一次 -->
        <div class="mt-8 rounded-xl border border-slate-700/60 bg-slate-900/40 p-4 lg:col-span-2">
          <div class="mb-1 flex items-center justify-between">
            <h3 class="font-semibold">{{ t('settings.setupToken') }}</h3>
            <span class="rounded-full px-2 py-0.5 text-xs"
              :class="setupToken.configured ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-400'">
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
            <button type="button" class="btn-secondary text-sm" :disabled="setupTokenBusy" @click="rotateSetupToken('generate')">
              {{ t('settings.setupTokenGenerate') }}
            </button>
            <button type="button" class="btn-secondary text-sm" :disabled="setupTokenBusy" @click="rotateSetupToken('clear')">
              {{ t('settings.setupTokenClear') }}
            </button>
          </div>
          <p v-if="setupTokenError" class="mt-2 text-xs text-rose-400">{{ setupTokenError }}</p>
        </div>

        <!-- S1/F2：通知渠道（Webhook）与通知组 -->
        <NotifyPanel />

        <h2 class="mb-4 mt-8 text-lg font-semibold">{{ t('settings.socialLinks') }}</h2>
        <FormInput v-model="local.ui.social_email" :label="t('footer.email')" />
        <FormInput v-model="local.ui.social_telegram" label="Telegram" />
        <FormInput v-model="local.ui.social_qq" label="QQ" />
        <FormInput v-model="local.ui.social_website" :label="t('footer.website')" />
      </div>

      <!-- S5/F10：主题市场（已安装 / 市场 / 来源） -->
      <ThemePanel @changed="loadThemes" />

      <!-- 数据库备份：策略由本页下发，实际执行在宿主机（diting.sh + cron） -->
      <div class="glass p-6 lg:col-span-2">
        <h2 class="mb-1 text-lg font-semibold">{{ t('settings.backup') }}</h2>
        <p class="mb-4 text-xs opacity-70">{{ t('settings.backupHint') }}</p>

        <div class="grid grid-cols-1 gap-x-6 md:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm opacity-80">{{ t('settings.backupSchedule') }}</label>
            <select
              v-model="local.ui.backup_schedule"
              class="mb-3 w-full rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
            >
              <option value="off">{{ t('settings.backupScheduleOff') }}</option>
              <option value="daily">{{ t('settings.backupScheduleDaily') }}</option>
              <option value="weekly">{{ t('settings.backupScheduleWeekly') }}</option>
            </select>

            <FormInput
              v-model="local.ui.backup_hour"
              :label="t('settings.backupHour')"
              type="number"
              :hint="t('settings.backupHourHint')"
            />
            <FormInput
              v-model="local.ui.backup_keep_days"
              :label="t('settings.backupKeepDays')"
              type="number"
              :hint="t('settings.backupKeepDaysHint')"
            />
            <FormInput
              v-model="local.ui.backup_keep_count"
              :label="t('settings.backupKeepCount')"
              type="number"
              :hint="t('settings.backupKeepCountHint')"
            />
            <FormInput
              v-model="local.ui.backup_compress"
              :label="t('settings.backupCompress')"
              type="checkbox"
              :hint="t('settings.backupCompressHint')"
            />
          </div>

          <div class="rounded-lg border border-white/10 p-4 text-sm">
            <h3 class="mb-3 font-semibold">{{ t('settings.backupMonitor') }}</h3>
            <div v-if="!backupState" class="opacity-60">{{ t('settings.backupNoState') }}</div>
            <dl v-else class="space-y-2">
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.backupLastRun') }}</dt>
                <dd class="text-right">{{ fmtTime(backupState.last_run_ts) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.backupResult') }}</dt>
                <dd class="text-right">
                  <span :class="backupState.last_status === 'ok' ? 'text-emerald-400' : 'text-amber-400'">
                    {{ backupStatusText }}
                  </span>
                  <span v-if="backupStale" class="ml-2 text-amber-400">{{ t('settings.backupStale') }}</span>
                </dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.backupFile') }}</dt>
                <dd class="break-all text-right">{{ backupState.last_file || '-' }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.backupSize') }}</dt>
                <dd class="text-right">{{ fmtBytes(backupState.last_size_bytes) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.backupTotal') }}</dt>
                <dd class="text-right">
                  {{ fmtBytes(backupState.total_bytes) }}
                  <span class="opacity-70">({{ backupState.backup_count ?? 0 }})</span>
                </dd>
              </div>
              <div v-if="backupState.last_error" class="text-amber-400">
                {{ backupState.last_error }}
              </div>
            </dl>
          </div>
        </div>

        <!-- F8.6：最近一次恢复审查（恢复后服务端启动时生成，只读） -->
        <div class="mt-6 border-t border-white/10 pt-4">
          <h3 class="mb-1 font-semibold">{{ t('settings.restoreAuditTitle') }}</h3>
          <p class="mb-3 text-xs opacity-60">{{ t('settings.restoreAuditHint') }}</p>
          <div v-if="!restoreAudit" class="text-sm opacity-60">{{ t('settings.restoreAuditNone') }}</div>
          <template v-else>
            <dl class="mb-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.restoreAuditTime') }}</dt>
                <dd class="text-right">{{ fmtTime(restoreAudit.ts) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.restoreAuditFrom') }}</dt>
                <dd class="break-all text-right">{{ restoreAudit.backup?.name || '-' }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.restoreAuditBy') }}</dt>
                <dd class="break-all text-right">{{ restoreAudit.backup?.by || '-' }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="opacity-70">{{ t('settings.restoreAuditDuration') }}</dt>
                <dd class="text-right">{{ restoreAudit.duration_ms }} ms</dd>
              </div>
            </dl>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <thead class="text-xs opacity-60">
                  <tr>
                    <th class="py-2 pr-4">{{ t('settings.restoreAuditCheck') }}</th>
                    <th class="py-2 pr-4">{{ t('settings.restoreAuditStatus') }}</th>
                    <th class="py-2">{{ t('settings.restoreAuditDetail') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in restoreAudit.checks || []" :key="c.id" class="border-t border-white/10">
                    <td class="py-2 pr-4 whitespace-nowrap">{{ restoreCheckName(c) }}</td>
                    <td class="py-2 pr-4 whitespace-nowrap" :class="restoreStatusClass(c.status)">
                      {{ restoreStatusName(c) }}
                    </td>
                    <td class="py-2 break-all opacity-80">{{ restoreCheckText(c) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="restoreRetention" class="mt-3 rounded border border-white/10 p-2 text-xs">
              <div class="opacity-70">
                {{ t('settings.restoreAuditExpiredRange', {
                  from: fmtTime(restoreRetention.earliest),
                  to: fmtTime(restoreRetention.latest),
                }) }}
              </div>
              <div v-for="(b, i) in restoreRetention.buckets" :key="i" class="mt-1 opacity-70">
                {{ t('settings.restoreAuditBatch', {
                  n: i + 1,
                  from: fmtTime(b.from_ts),
                  to: fmtTime(b.to_ts),
                  rows: b.rows,
                }) }}
              </div>
              <div v-if="restoreRetention.truncated" class="mt-1 opacity-50">
                {{ t('settings.restoreAuditBatchTruncated') }}
              </div>
            </div>
            <p class="mt-3 text-xs opacity-60">
              {{ t('settings.restoreAuditSummary', {
                expired: restoreAudit.summary?.expired_rows ?? 0,
                total: restoreAudit.summary?.total_rows ?? 0,
                orphans: restoreAudit.summary?.orphan_deleted ?? 0,
                purged: restoreAudit.summary?.purged_agents ?? 0,
              }) }}
            </p>
          </template>
        </div>

        <!-- 备份文件列表：下载 / 恢复 / 删除 -->
        <div class="mt-6 border-t border-white/10 pt-4">
          <div class="mb-3 flex flex-wrap items-center gap-3">
            <h3 class="font-semibold">{{ t('settings.backupFiles') }}</h3>
            <span v-if="backupDir" class="text-xs opacity-60">{{ backupDir }}</span>
            <button
              class="rounded border border-white/20 px-3 py-1 text-xs hover:bg-white/10"
              @click="loadBackups"
            >
              {{ t('common.refresh') }}
            </button>
          </div>

          <!-- F8.1：应用内快照（在线备份，不需要停服） -->
          <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <button
              :disabled="!!backupBusy || backupUploading"
              class="rounded border border-emerald-400/40 px-3 py-1 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
              @click="createSnapshot"
            >
              {{ backupBusy === 'create' ? t('settings.backupCreating') : t('settings.backupCreateNow') }}
            </button>
            <span class="opacity-60">{{ t('settings.backupCreateHint') }}</span>
          </div>

          <!-- 上传外部备份：服务端只认 SQLite / gzip，文件名由服务端生成 -->
          <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <input ref="backupFileInput" type="file" accept=".db,.gz" class="hidden" @change="onPickBackup" />
            <button
              :disabled="backupUploading"
              class="rounded border border-white/20 px-3 py-1 hover:bg-white/10 disabled:opacity-50"
              @click="backupFileInput?.click()"
            >
              {{ backupUploading ? `${t('settings.backupUploading')} ${backupUploadPct}%` : t('settings.backupUpload') }}
            </button>
            <span class="opacity-60">{{ t('settings.backupUploadHint') }}</span>
          </div>

          <div v-if="backupMsg" class="mb-3 rounded border border-sky-500/30 bg-sky-500/10 p-2 text-xs text-sky-200">
            {{ backupMsg }}
          </div>

          <div v-if="!backupAvailable" class="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            {{ t('settings.backupDirUnavailable') }}
          </div>
          <div v-else-if="!backupFiles.length" class="p-3 text-sm opacity-60">
            {{ t('settings.backupNoFiles') }}
          </div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="text-xs opacity-60">
                <tr>
                  <th class="py-2 pr-4">{{ t('settings.backupFile') }}</th>
                  <th class="py-2 pr-4">{{ t('settings.backupTime') }}</th>
                  <th class="py-2 pr-4">{{ t('settings.backupSize') }}</th>
                  <th class="py-2 pr-4">{{ t('settings.backupIntegrity') }}</th>
                  <th class="py-2 text-right">{{ t('common.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in backupFiles" :key="f.name" class="border-t border-white/10">
                  <td class="py-2 pr-4 break-all">
                    {{ f.name }}
                    <span v-if="f.kind === 'pre_restore'" class="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-300">
                      {{ t('settings.backupKindPreRestore') }}
                    </span>
                  </td>
                  <td class="py-2 pr-4 whitespace-nowrap">{{ fmtTime(f.mtime) }}</td>
                  <td class="py-2 pr-4 whitespace-nowrap">{{ fmtBytes(f.size_bytes) }}</td>
                  <td class="py-2 pr-4 whitespace-nowrap" :class="integrityClass(f.integrity)" :title="f.integrity_reason || ''">
                    {{ integrityText(f.integrity) }}
                  </td>
                  <td class="py-2 text-right whitespace-nowrap">
                    <button
                      class="mr-2 rounded border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
                      @click="downloadBackup(f)"
                    >
                      {{ t('settings.backupDownload') }}
                    </button>
                    <button
                      :disabled="backupBusy === f.name"
                      class="mr-2 rounded border border-sky-500/40 px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
                      @click="restoreBackup(f)"
                    >
                      {{ t('settings.backupRestore') }}
                    </button>
                    <button
                      :disabled="backupBusy === f.name"
                      class="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                      @click="removeBackup(f)"
                    >
                      {{ t('settings.backupDelete') }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="mt-3 text-xs opacity-60">{{ t('settings.backupRestoreHint') }}</p>
          </div>
        </div>
      </div>

      <!-- F12：容量保险丝（metrics 行数 + 库文件双水位） -->
      <div class="glass p-6 lg:col-span-2">
        <h2 class="mb-1 text-lg font-semibold">{{ t('settings.capacityTitle') }}</h2>
        <p class="mb-4 text-xs opacity-70">{{ t('settings.capacityHint') }}</p>

        <div v-if="capacityStatus" class="mb-4 rounded-lg border border-white/10 p-3 text-sm">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span
              class="rounded px-2 py-0.5 text-xs"
              :class="capacityStatus.level === 'full'
                ? 'bg-rose-500/20 text-rose-300'
                : capacityStatus.level === 'warn'
                  ? 'bg-amber-500/20 text-amber-300'
                  : 'bg-emerald-500/20 text-emerald-300'"
            >
              {{ t(`settings.capacityLevel_${capacityStatus.level}`) }}
            </span>
            <span v-if="capacityStatus.paused" class="text-xs text-rose-300">{{ t('settings.capacityPaused') }}</span>
          </div>
          <div class="grid grid-cols-1 gap-1 text-xs opacity-80 sm:grid-cols-2">
            <div>
              {{ t('settings.capacityRowsValue', {
                rows: capacityStatus.rows,
                max: capacityStatus.max_rows,
                pct: Math.round(capacityStatus.row_pct * 100),
              }) }}
            </div>
            <div>
              {{ t('settings.capacityBytesValue', {
                cur: fmtBytes(capacityStatus.bytes),
                max: fmtBytes(capacityStatus.max_bytes),
                pct: Math.round(capacityStatus.byte_pct * 100),
              }) }}
            </div>
          </div>
          <div v-if="capacityStatus.skipped" class="mt-1 text-xs text-amber-300">
            {{ t('settings.capacitySkipped', { n: capacityStatus.skipped }) }}
          </div>
        </div>

        <div class="grid grid-cols-1 gap-x-6 md:grid-cols-2">
          <div>
            <FormInput v-model="local.ui.capacity_enabled" :label="t('settings.capacityEnabled')" type="checkbox" />
            <FormInput
              v-model="local.ui.capacity_max_rows"
              :label="t('settings.capacityMaxRows')"
              type="number"
              :hint="t('settings.capacityMaxRowsHint')"
            />
            <FormInput
              v-model="local.ui.capacity_max_mb"
              :label="t('settings.capacityMaxMb')"
              type="number"
              :hint="t('settings.capacityMaxMbHint')"
            />
          </div>
          <div class="flex flex-col justify-end gap-2">
            <button
              :disabled="capacityBusy"
              class="self-start rounded border border-amber-400/40 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
              @click="cleanupCapacity"
            >
              {{ capacityBusy ? t('settings.capacityCleaning') : t('settings.capacityCleanup') }}
            </button>
            <p class="text-xs opacity-60">{{ t('settings.capacityCleanupHint') }}</p>
            <p v-if="capacityMsg" class="text-xs text-sky-300">{{ capacityMsg }}</p>
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
