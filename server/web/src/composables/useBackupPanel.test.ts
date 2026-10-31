// useBackupPanel：备份列表/恢复审查/容量保险丝的加载、操作与展示函数。
// adminApi 全量 mock；t 用「未命中返回 key 本身」的真实约定，才能验证回退分支。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp, defineComponent } from 'vue';

const apiMock = vi.hoisted(() => ({
  getBackupStatus: vi.fn(),
  listBackups: vi.fn(),
  getCapacity: vi.fn(),
  cleanupCapacity: vi.fn(),
  deleteBackup: vi.fn(),
  createBackup: vi.fn(),
  requestRestore: vi.fn(),
  uploadBackup: vi.fn(),
  backupDownloadUrl: vi.fn((name: string) => `/api/admin/backups/${name}/download`),
}));

vi.mock('../services/adminApi', () => ({ adminApi: apiMock }));
vi.mock('./useI18n', () => ({
  t: (key: string, vars?: Record<string, unknown>) => {
    // 模拟「字典里有这一条」的唯一 key，用于验证命中分支；其余按真实约定原样返回 key。
    if (key === 'settings.backupIntegrity_ok') return 'OK';
    return vars ? `${key}:${Object.keys(vars).sort().join(',')}` : key;
  },
}));

import { useBackupPanel } from './useBackupPanel';

let app: ReturnType<typeof createApp> | null = null;
let panel!: ReturnType<typeof useBackupPanel>;

function mountPanel() {
  const Comp = defineComponent({
    setup() {
      panel = useBackupPanel();
      return () => null;
    },
  });
  app = createApp(Comp);
  app.mount(document.createElement('div'));
}

async function flush(times = 3) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const file = (name: string) => ({ name, size: 1024, mtime: 1700000000000, kind: 'monitor' });

describe('useBackupPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getBackupStatus.mockResolvedValue({ state: { last_status: 'ok', last_run_ts: Date.now() } });
    apiMock.listBackups.mockResolvedValue({
      dir: '/data/backups', available: true, files: [file('monitor_1.db')], restore_audit: null,
    });
    apiMock.getCapacity.mockResolvedValue({ level: 'ok', rows: 100, bytes: 1024 });
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.unstubAllGlobals();
  });

  it('挂载后加载备份状态、文件列表与容量', async () => {
    mountPanel();
    await flush();
    expect(apiMock.getBackupStatus).toHaveBeenCalledTimes(1);
    expect(apiMock.listBackups).toHaveBeenCalledTimes(1);
    expect(apiMock.getCapacity).toHaveBeenCalledTimes(1);
    expect(panel.backupState.value?.last_status).toBe('ok');
    expect(panel.backupFiles.value).toHaveLength(1);
    expect(panel.backupDir.value).toBe('/data/backups');
    expect(panel.capacityStatus.value?.level).toBe('ok');
  });

  it('加载失败时降级为空态，不抛错', async () => {
    apiMock.getBackupStatus.mockRejectedValue(new Error('boom'));
    apiMock.listBackups.mockRejectedValue(new Error('boom'));
    apiMock.getCapacity.mockRejectedValue(new Error('boom'));
    mountPanel();
    await flush();
    expect(panel.backupState.value).toBeNull();
    expect(panel.backupFiles.value).toEqual([]);
    expect(panel.backupAvailable.value).toBe(false);
    expect(panel.capacityStatus.value).toBeNull();
  });

  it('cleanupCapacity：确认后更新状态并提示清理条数', async () => {
    apiMock.cleanupCapacity.mockResolvedValue({ level: 'ok', deleted: 42, paused: false });
    mountPanel();
    await flush();

    await panel.cleanupCapacity();
    expect(panel.capacityStatus.value).toEqual({ level: 'ok', deleted: 42, paused: false });
    expect(panel.capacityMsg.value).toContain('settings.capacityCleaned');
    expect(panel.capacityMsg.value).toContain('settings.capacityCleaned');
  });

  it('cleanupCapacity：仍超限时追加提示；失败时显示错误', async () => {
    apiMock.cleanupCapacity.mockResolvedValue({ level: 'critical', deleted: 1, paused: true });
    mountPanel();
    await flush();

    await panel.cleanupCapacity();
    expect(panel.capacityMsg.value).toContain('settings.capacityStillFull');

    apiMock.cleanupCapacity.mockRejectedValue(new Error('disk full'));
    await panel.cleanupCapacity();
    expect(panel.capacityMsg.value).toBe('disk full');
  });

  it('cleanupCapacity：未确认时不发请求', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    mountPanel();
    await flush();
    await panel.cleanupCapacity();
    expect(apiMock.cleanupCapacity).not.toHaveBeenCalled();
  });

  it('removeBackup：确认后删除并刷新列表', async () => {
    apiMock.deleteBackup.mockResolvedValue({ ok: true });
    mountPanel();
    await flush();
    apiMock.listBackups.mockClear();

    await panel.removeBackup(file('monitor_1.db'));
    expect(apiMock.deleteBackup).toHaveBeenCalledWith('monitor_1.db');
    expect(panel.backupMsg.value).toContain('settings.backupDeleted');
    expect(apiMock.listBackups).toHaveBeenCalled();
  });

  it('removeBackup：未确认不发请求；失败时显示错误', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    mountPanel();
    await flush();
    await panel.removeBackup(file('a.db'));
    expect(apiMock.deleteBackup).not.toHaveBeenCalled();

    vi.stubGlobal('confirm', vi.fn(() => true));
    apiMock.deleteBackup.mockRejectedValue(new Error('denied'));
    await panel.removeBackup(file('a.db'));
    expect(panel.backupMsg.value).toBe('denied');
    expect(panel.backupBusy.value).toBe('');
  });

  it('createSnapshot：成功提示文件名并刷新；失败显示错误', async () => {
    apiMock.createBackup.mockResolvedValue({ ok: true, name: 'monitor_2.db' });
    mountPanel();
    await flush();

    await panel.createSnapshot();
    expect(panel.backupMsg.value).toContain('settings.backupCreated');

    apiMock.createBackup.mockRejectedValue(new Error('disk full'));
    await panel.createSnapshot();
    expect(panel.backupMsg.value).toBe('disk full');
    expect(panel.backupBusy.value).toBe('');
  });

  it('restoreBackup：确认后投递恢复请求；失败显示错误', async () => {
    apiMock.requestRestore.mockResolvedValue({ ok: true, queued: true });
    mountPanel();
    await flush();
    await panel.restoreBackup(file('monitor_1.db'));
    expect(apiMock.requestRestore).toHaveBeenCalledWith('monitor_1.db');
    expect(panel.backupMsg.value).toContain('settings.backupRestoreQueued');

    apiMock.requestRestore.mockRejectedValue(new Error('no trigger'));
    await panel.restoreBackup(file('x.db'));
    expect(panel.backupMsg.value).toBe('no trigger');
  });

  it('onPickBackup：无文件 / 未确认时不执行上传', async () => {
    mountPanel();
    await flush();
    const input = document.createElement('input');
    await panel.onPickBackup({ target: input } as unknown as Event);
    expect(apiMock.uploadBackup).not.toHaveBeenCalled();
  });

  it('onPickBackup：上传成功回报进度并刷新列表', async () => {
    apiMock.uploadBackup.mockImplementation(async (_f: File, onProgress?: (p: number) => void) => {
      onProgress?.(30);
      onProgress?.(100);
      return { ok: true, name: 'uploaded.db' };
    });
    mountPanel();
    await flush();

    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'b.db')] });
    await panel.onPickBackup({ target: input } as unknown as Event);

    expect(apiMock.uploadBackup).toHaveBeenCalled();
    expect(panel.backupMsg.value).toContain('settings.backupUploaded');
    expect(panel.backupUploading.value).toBe(false);
    expect(panel.backupUploadPct.value).toBe(0);
  });

  it('onPickBackup：上传失败显示错误并复位进度', async () => {
    apiMock.uploadBackup.mockRejectedValue(new Error('too large'));
    mountPanel();
    await flush();

    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'b.db')] });
    await panel.onPickBackup({ target: input } as unknown as Event);

    expect(panel.backupMsg.value).toBe('too large');
    expect(panel.backupUploading.value).toBe(false);
  });

  it('downloadBackup：用同源链接触发浏览器下载', () => {
    mountPanel();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    panel.downloadBackup(file('a.db'));
    expect(apiMock.backupDownloadUrl).toHaveBeenCalledWith('a.db');
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('fmtBytes / fmtTime：空值与单位换算', () => {
    mountPanel();
    expect(panel.fmtBytes(0)).toBe('-');
    expect(panel.fmtBytes(1024 * 1024)).toBe('1.0 MB');
    expect(panel.fmtBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
    expect(panel.fmtTime(0)).toBe('-');
    expect(panel.fmtTime(1700000000000)).not.toBe('-');
  });

  it('backupStatusText：未知状态回退到 unknown 文案', async () => {
    apiMock.getBackupStatus.mockResolvedValue({ state: { last_status: 'weird' } });
    mountPanel();
    await flush();
    expect(panel.backupStatusText.value).toBe('settings.backupState_unknown');
  });

  it('backupStale：超过 48 小时判为可能未运行', async () => {
    apiMock.getBackupStatus.mockResolvedValue({ state: { last_run_ts: Date.now() - 49 * 3600 * 1000 } });
    mountPanel();
    await flush();
    expect(panel.backupStale.value).toBe(true);
  });

  it('restoreCheckText：覆盖各类检查项的文案分支', () => {
    mountPanel();
    const cases = [
      { id: 'integrity', value: { result: 'ok' } },
      { id: 'retention', value: { expired_rows: 1, total_rows: 2, ratio: 0.5, retention_days: 7 } },
      { id: 'folding', value: { watermark_before: 'a', watermark_after: 'b', catch_up: '2' } },
      { id: 'folding', value: { reason: 'no fold' } },
      { id: 'overlap', value: { deleted: 3 } },
      { id: 'overlap', value: { reason: 'none' } },
      { id: 'traffic_gap', value: { fixed: 1, checked: 2 } },
      { id: 'orphans', value: { deleted: 4 } },
      { id: 'soft_deleted', value: { expired: 1, purged: 2 } },
      { id: 'capacity', value: { rows: 9, over: true } },
    ];
    for (const c of cases) {
      expect(panel.restoreCheckText(c as never)).not.toBe('');
    }
    expect(panel.restoreCheckText({ id: 'unknown', value: {} } as never)).toBe('');
  });

  it('restoreCheckName / restoreStatusName：未命中 key 时原样返回', () => {
    mountPanel();
    expect(panel.restoreCheckName({ id: 'integrity' } as never)).toBe('integrity');
    expect(panel.restoreStatusName({ status: 'ok' } as never)).toBe('ok');
  });

  it('restoreStatusClass / integrityClass：三档颜色', () => {
    mountPanel();
    expect(panel.restoreStatusClass('ok')).toContain('emerald');
    expect(panel.restoreStatusClass('warn')).toContain('amber');
    expect(panel.restoreStatusClass('fail')).toContain('rose');
    expect(panel.restoreStatusClass('other')).toBe('opacity-60');
    expect(panel.integrityClass('ok')).toContain('emerald');
    expect(panel.integrityClass('fail')).toContain('rose');
    expect(panel.integrityClass()).toBe('opacity-60');
  });

  it('integrityText：未知状态回退', () => {
    mountPanel();
    expect(panel.integrityText('ok')).toBe('OK');
    expect(panel.integrityText()).toBe('settings.backupIntegrity_unknown');
  });

  it('restoreRetention：没有 retention 检查时为 null，有则解析区间与分段', async () => {
    mountPanel();
    await flush();
    expect(panel.restoreRetention.value).toBeNull();

    apiMock.listBackups.mockResolvedValue({
      dir: '/data/backups',
      available: true,
      files: [],
      restore_audit: {
        checks: [{
          id: 'retention',
          status: 'warn',
          value: {
            earliest_ts: 1000, latest_ts: 2000, truncated: true,
            buckets: [{ rows: 5, from_ts: 1000, to_ts: 1500 }],
          },
        }],
      },
    });
    await panel.loadBackups();
    expect(panel.restoreRetention.value).toEqual({
      earliest: 1000,
      latest: 2000,
      buckets: [{ rows: 5, from_ts: 1000, to_ts: 1500 }],
      truncated: true,
    });
  });
});
