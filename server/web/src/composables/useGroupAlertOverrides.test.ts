// useGroupAlertOverrides：分组告警覆盖的表单装载、空值语义（null = 继承全局）与保存/回退。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ref } from 'vue';

const apiMock = vi.hoisted(() => ({
  listAlertRules: vi.fn(),
  setGroupAlertRule: vi.fn(),
  resetGroupAlertRule: vi.fn(),
}));

vi.mock('../services/adminApi', () => ({ adminApi: apiMock }));
vi.mock('./useI18n', () => ({
  t: (key: string) => key,
}));

import { useGroupAlertOverrides } from './useGroupAlertOverrides';

function setup() {
  const message = ref('');
  const api = useGroupAlertOverrides({ message });
  return { api, message };
}

describe('useGroupAlertOverrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listAlertRules.mockResolvedValue({
      global: { cpu_pct: 90, mem_pct: 85, offline_sec: 60 },
      groups: [
        { grp: 'g1', cpu_pct: 80, mem_pct: null, muted: true },
        { grp: '', cpu_pct: 70, muted: false },
      ],
    });
    apiMock.setGroupAlertRule.mockResolvedValue({ ok: true });
    apiMock.resetGroupAlertRule.mockResolvedValue({ ok: true });
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loadAlertRules：填充覆盖列表与全局阈值', async () => {
    const { api } = setup();
    await api.loadAlertRules();
    expect(api.groupOverrides.value).toHaveLength(2);
    expect(api.groupFieldRows.value).toHaveLength(6);
  });

  it('loadAlertRules：接口异常时静默，不清空既有状态', async () => {
    apiMock.listAlertRules.mockRejectedValue(new Error('forbidden'));
    const { api } = setup();
    await expect(api.loadAlertRules()).resolves.toBeUndefined();
    expect(api.groupOverrides.value).toEqual([]);
  });

  it('applyGroupForm：覆盖值为 null 的字段留空（继承全局）', async () => {
    const { api } = setup();
    await api.loadAlertRules();
    api.applyGroupForm('g1');
    expect(api.groupForm.value.grp).toBe('g1');
    expect(api.groupForm.value.cpu_pct).toBe('80');
    expect(api.groupForm.value.mem_pct).toBe('');
    expect(api.groupForm.value.muted).toBe(true);
  });

  it('applyGroupForm：无覆盖时全部清空', async () => {
    const { api } = setup();
    await api.loadAlertRules();
    api.applyGroupForm('missing');
    expect(api.groupForm.value).toMatchObject({
      grp: 'missing', cpu_pct: '', mem_pct: '', muted: false,
    });
  });

  it('groupPlaceholder：返回对应全局阈值，缺失为空串', async () => {
    const { api } = setup();
    expect(api.groupPlaceholder('cpu_pct')).toBe('');
    await api.loadAlertRules();
    expect(api.groupPlaceholder('cpu_pct')).toBe('90');
    expect(api.groupPlaceholder('temp_c')).toBe('');
  });

  it('saveGroupAlert：空串转 null、数字转 Number，成功后刷新并提示', async () => {
    const { api, message } = setup();
    await api.loadAlertRules();
    api.groupForm.value = {
      grp: ' g1 ', cpu_pct: '80', mem_pct: '', disk_pct: '  ', temp_c: '55', offline_sec: '', cooldown: '10', muted: true,
    };

    await api.saveGroupAlert();

    expect(apiMock.setGroupAlertRule).toHaveBeenCalledWith('g1', {
      muted: true, cpu_pct: 80, mem_pct: null, disk_pct: null, temp_c: 55, offline_sec: null, cooldown: 10,
    });
    expect(message.value).toBe('settings.saved');
    expect(apiMock.listAlertRules).toHaveBeenCalledTimes(2);
    expect(api.groupBusy.value).toBe(false);
  });

  it('saveGroupAlert：失败时写入错误消息并复位 busy', async () => {
    apiMock.setGroupAlertRule.mockRejectedValue(new Error('invalid'));
    const { api, message } = setup();
    await api.saveGroupAlert();
    expect(message.value).toBe('invalid');
    expect(api.groupBusy.value).toBe(false);
  });

  it('resetGroupAlert：确认后回退并刷新', async () => {
    const { api, message } = setup();
    await api.loadAlertRules();
    api.groupForm.value.grp = 'g1';
    await api.resetGroupAlert();
    expect(apiMock.resetGroupAlertRule).toHaveBeenCalledWith('g1');
    expect(message.value).toBe('settings.saved');
  });

  it('resetGroupAlert：未确认时不发请求', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const { api } = setup();
    await api.resetGroupAlert();
    expect(apiMock.resetGroupAlertRule).not.toHaveBeenCalled();
  });

  it('resetGroupAlert：失败时写入错误消息', async () => {
    apiMock.resetGroupAlertRule.mockRejectedValue(new Error('nope'));
    const { api, message } = setup();
    await api.resetGroupAlert();
    expect(message.value).toBe('nope');
  });
});
