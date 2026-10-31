// 备份监控 / 备份文件管理 / 恢复审查 / 容量保险丝——从 SettingsView 抽出的展示与操作逻辑。
//
// 为什么抽 composable 而不是拆子组件：这段模板大量直接 v-model 深层字段（local.ui.backup_*），
// 拆组件要把每个绑定改写成 props + emit，且没有 UI 回归测试兜底；抽成 composable 后
// 模板一行不用改，View 只负责「解构同名变量」，逻辑仍单一持有。
//
// 依赖面很窄：只用 adminApi 与 i18n，不碰 SettingsView 的 local/dirty/saving。

import { ref, computed, onMounted } from 'vue';
import { adminApi } from '../services/adminApi';
import { t } from './useI18n';
import type {
  BackupFile, BackupState, CapacityStatus, RestoreAuditCheck, RestoreAuditReport,
} from '../services/types';

interface RestoreRetentionBucket {
  rows: number;
  from_ts: number;
  to_ts: number;
}

export function useBackupPanel() {
  // ---- 备份监控：宿主侧 diting.sh 执行后回写服务端，本页只读展示 ----
  const backupState = ref<BackupState | null>(null);

  async function loadBackupState() {
    try {
      const r = await adminApi.getBackupStatus();
      backupState.value = (r.state || {}) as BackupState;
    } catch {
      // 备份监控是增强信息，失败不打扰用户（可能服务端未重启 / 未开启）
      backupState.value = null;
    }
  }

  // ---- 备份文件列表：下载 / 删除 / 恢复 ----
  const backupFiles = ref<BackupFile[]>([]);
  const backupDir = ref('');
  const backupAvailable = ref(true);
  const backupBusy = ref('');
  const backupMsg = ref('');
  // F8.6：最近一次恢复审查（恢复后由服务端启动流程写入，这里只读展示）
  const restoreAudit = ref<RestoreAuditReport | null>(null);
  // F12：容量保险丝状态与一键清理
  const capacityStatus = ref<CapacityStatus | null>(null);
  const capacityBusy = ref(false);
  const capacityMsg = ref('');

  async function loadCapacity() {
    try { capacityStatus.value = await adminApi.getCapacity(); } catch { capacityStatus.value = null; }
  }

  async function cleanupCapacity() {
    if (!confirm(t('settings.capacityCleanupConfirm'))) return;
    capacityBusy.value = true;
    capacityMsg.value = '';
    try {
      const r = await adminApi.cleanupCapacity();
      capacityStatus.value = r;
      capacityMsg.value = t('settings.capacityCleaned').replace('{n}', String(r.deleted || 0));
      if (r.paused) capacityMsg.value = `${capacityMsg.value} ${t('settings.capacityStillFull')}`;
    } catch (e) {
      capacityMsg.value = (e as Error).message || t('settings.backupOpFailed');
    } finally {
      capacityBusy.value = false;
    }
  }

  async function loadBackups() {
    try {
      const r = await adminApi.listBackups();
      backupFiles.value = r.files || [];
      backupDir.value = r.dir || '';
      backupAvailable.value = r.available !== false;
      restoreAudit.value = r.restore_audit || null;
    } catch {
      backupFiles.value = [];
      backupAvailable.value = false;
    }
  }

  function downloadBackup(f: BackupFile) {
    // 同源 GET + download 属性，交给浏览器流式下载，避免把整份备份读进内存
    const a = document.createElement('a');
    a.href = adminApi.backupDownloadUrl(f.name);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function removeBackup(f: BackupFile) {
    if (!confirm(t('settings.backupDeleteConfirm').replace('{name}', f.name))) return;
    backupBusy.value = f.name;
    backupMsg.value = '';
    try {
      await adminApi.deleteBackup(f.name);
      backupMsg.value = t('settings.backupDeleted');
      await Promise.all([loadBackups(), loadBackupState()]);
    } catch (e) {
      backupMsg.value = (e as Error).message || t('settings.backupOpFailed');
    } finally {
      backupBusy.value = '';
    }
  }

  const backupFileInput = ref<HTMLInputElement | null>(null);
  const backupUploading = ref(false);
  const backupUploadPct = ref(0);

  async function onPickBackup(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // 清空以便重复选择同一个文件
    if (!file) return;
    if (!confirm(t('settings.backupUploadConfirm').replace('{name}', file.name))) return;
    backupUploading.value = true;
    backupUploadPct.value = 0;
    backupMsg.value = '';
    try {
      const r = await adminApi.uploadBackup(file, (p) => { backupUploadPct.value = p; });
      backupMsg.value = t('settings.backupUploaded').replace('{name}', r.name);
      await loadBackups();
    } catch (e) {
      backupMsg.value = (e as Error).message || t('settings.backupOpFailed');
    } finally {
      backupUploading.value = false;
      backupUploadPct.value = 0;
    }
  }

  // F8.1：应用内一致性快照（better-sqlite3 在线备份，不需要停服）
  async function createSnapshot() {
    backupBusy.value = 'create';
    backupMsg.value = '';
    try {
      const r = await adminApi.createBackup();
      backupMsg.value = t('settings.backupCreated').replace('{name}', r.name);
      await Promise.all([loadBackups(), loadBackupState()]);
    } catch (e) {
      backupMsg.value = (e as Error).message || t('settings.backupOpFailed');
    } finally {
      backupBusy.value = '';
    }
  }

  async function restoreBackup(f: BackupFile) {
    if (!confirm(t('settings.backupRestoreConfirm').replace('{name}', f.name))) return;
    backupBusy.value = f.name;
    backupMsg.value = '';
    try {
      await adminApi.requestRestore(f.name);
      backupMsg.value = t('settings.backupRestoreQueued');
      await loadBackups();
    } catch (e) {
      backupMsg.value = (e as Error).message || t('settings.backupOpFailed');
    } finally {
      backupBusy.value = '';
    }
  }

  onMounted(() => { loadBackupState(); loadBackups(); loadCapacity(); });

  function fmtBytes(n?: number): string {
    const v = Number(n || 0);
    if (!v) return '-';
    const mb = v / 1048576;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  function fmtTime(ts?: number): string {
    const v = Number(ts || 0);
    if (!v) return '-';
    return new Date(v).toLocaleString();
  }
  const backupStatusText = computed(() => {
    const s = backupState.value?.last_status || 'unknown';
    const key = `settings.backupState_${s}`;
    const out = t(key);
    // 未命中的 key，t() 会原样返回 key（形如 settings.backupState_xxx），据此回退
    return out === key ? t('settings.backupState_unknown') : out;
  });
  const backupStale = computed(() => {
    const ts = Number(backupState.value?.last_run_ts || 0);
    if (!ts) return false;
    // 超过 48 小时没成功备份即视为「可能未运行」
    return Date.now() - ts > 48 * 3600 * 1000;
  });

  // ---- F8.6：恢复审查展示 ----
  function restoreCheckName(c: RestoreAuditCheck): string {
    const key = `settings.restoreAuditCheck_${c.id}`;
    const out = t(key);
    return out === key ? c.id : out;
  }
  function restoreStatusName(c: RestoreAuditCheck): string {
    const key = `settings.restoreAuditStatus_${c.status}`;
    const out = t(key);
    return out === key ? c.status : out;
  }
  function restoreStatusClass(status: string): string {
    if (status === 'ok') return 'text-emerald-400';
    if (status === 'warn') return 'text-amber-400';
    if (status === 'fail') return 'text-rose-400';
    return 'opacity-60';
  }
  function restoreCheckText(c: RestoreAuditCheck): string {
    const v = (c.value || {}) as Record<string, unknown>;
    const num = (k: string) => Number(v[k] || 0);
    switch (c.id) {
      case 'integrity':
        return String(v.result ?? '');
      case 'retention':
        return t('settings.restoreAuditRetentionValue', {
          expired: num('expired_rows'),
          total: num('total_rows'),
          pct: Math.round(Number(v.ratio || 0) * 100),
          days: num('retention_days'),
        });
      case 'folding':
        return v.reason
          ? String(v.reason)
          : t('settings.restoreAuditFoldingValue', {
              before: String(v.watermark_before ?? '-'),
              after: String(v.watermark_after ?? '-'),
              catchUp: String(v.catch_up || '-'),
            });
      case 'overlap':
        return v.reason ? String(v.reason) : t('settings.restoreAuditDeletedValue', { n: num('deleted') });
      case 'traffic_gap':
        return v.reason
          ? String(v.reason)
          : t('settings.restoreAuditGapValue', { fixed: num('fixed'), checked: num('checked') });
      case 'orphans':
        return t('settings.restoreAuditDeletedValue', { n: num('deleted') });
      case 'soft_deleted':
        return v.reason
          ? String(v.reason)
          : t('settings.restoreAuditPurgedValue', { expired: num('expired'), purged: num('purged') });
      case 'capacity':
        return v.reason
          ? String(v.reason)
          : t('settings.restoreAuditCapacityValue', { rows: num('rows'), over: v.over ? 'yes' : 'no' });
      default:
        return '';
    }
  }

  // 过期数据的范围与批次（按保留周期分段），让「将删多少」落到具体时间段。
  const restoreRetention = computed(() => {
    const c = (restoreAudit.value?.checks || []).find((x) => x.id === 'retention');
    if (!c) return null;
    const v = (c.value || {}) as {
      earliest_ts?: number;
      latest_ts?: number;
      buckets?: RestoreRetentionBucket[];
      truncated?: boolean;
    };
    if (!v.earliest_ts) return null;
    return {
      earliest: v.earliest_ts,
      latest: v.latest_ts || 0,
      buckets: v.buckets || [],
      truncated: !!v.truncated,
    };
  });

  // F8.3：备份完整性徽标（未知 = 尚未抽查 / gzip 需解压后校验）
  function integrityClass(status?: string): string {
    if (status === 'ok') return 'text-emerald-400';
    if (status === 'fail') return 'text-rose-400';
    return 'opacity-60';
  }
  function integrityText(status?: string): string {
    const key = `settings.backupIntegrity_${status || 'unknown'}`;
    const out = t(key);
    return out === key ? t('settings.backupIntegrity_unknown') : out;
  }

  return {
    backupState, backupFiles, backupDir, backupAvailable, backupBusy, backupMsg,
    restoreAudit, capacityStatus, capacityBusy, capacityMsg,
    backupFileInput, backupUploading, backupUploadPct,
    loadBackupState, loadBackups, loadCapacity, cleanupCapacity,
    downloadBackup, removeBackup, onPickBackup, createSnapshot, restoreBackup,
    fmtBytes, fmtTime, backupStatusText, backupStale,
    restoreCheckName, restoreStatusName, restoreStatusClass, restoreCheckText, restoreRetention,
    integrityClass, integrityText,
  };
}
