import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { adminApi } from '../services/adminApi';

// useAdmin 是模块级单例（state / refreshTimer / pauseDepth 都在模块顶层）。
// 通过 vi.hoisted 让 mock factory 返回同一实例：无论 resetModules 后模块重载多少次，
// 测试断言用的 adminApi 与被测模块内部拿到的是同一个 mock。
const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
  overview: vi.fn(async () => ({})),
}));
vi.mock('../services/adminApi', () => ({ adminApi: mocks }));

// 每个用例独立模块实例，避免 pauseDepth / refreshTimer 互相污染
async function fresh() {
  vi.resetModules();
  return await import('./useAdmin');
}

describe('useAdmin 自动刷新与暂停计数（pauseDepth）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listAgents.mockClear();
    mocks.listAgents.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常轮询：每 10s 拉一次数据', async () => {
    const m = await fresh();
    m.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.listAgents).toHaveBeenCalledTimes(3);
    m.stopAutoRefresh();
  });

  it('暂停后 tick 不再拉数据，恢复后继续', async () => {
    const m = await fresh();
    m.startAutoRefresh();
    m.setAutoRefreshPaused(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.listAgents).not.toHaveBeenCalled();
    m.setAutoRefreshPaused(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.listAgents).toHaveBeenCalledTimes(1);
    m.stopAutoRefresh();
  });

  it('计数嵌套：两次暂停需两次恢复才真正恢复轮询（防一方提前恢复）', async () => {
    const m = await fresh();
    m.setAutoRefreshPaused(true);
    m.setAutoRefreshPaused(true);
    m.setAutoRefreshPaused(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.listAgents).not.toHaveBeenCalled(); // depth 仍为 1，保持暂停
    m.setAutoRefreshPaused(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.listAgents).toHaveBeenCalledTimes(1); // depth 归 0 才恢复
    m.stopAutoRefresh();
  });

  it('深度下限 0：多余 false 不越界、不叠加多个 timer', async () => {
    const m = await fresh();
    m.setAutoRefreshPaused(false);
    m.setAutoRefreshPaused(false);
    m.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.listAgents).toHaveBeenCalledTimes(2); // 若叠加成多个 timer 会远超 2 次
    m.stopAutoRefresh();
  });

  it('单例保护：paused 期间 startAutoRefresh 早退，恢复后仍是单 timer', async () => {
    const m = await fresh();
    m.setAutoRefreshPaused(true);
    m.startAutoRefresh(); // 必须早退，否则 resume 后会叠加双倍轮询
    m.setAutoRefreshPaused(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.listAgents).toHaveBeenCalledTimes(1);
    m.stopAutoRefresh();
  });

  it('loadAdmin 失败不终止轮询：错误在失败窗口内可见，成功后清除', async () => {
    const m = await fresh();
    const { state } = m.useAdmin();
    mocks.listAgents.mockRejectedValueOnce(new Error('boom'));
    m.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(10000); // 第一次 tick：失败
    expect(state.error).toBe('boom'); // 错误落到 state.error 供 UI 展示
    await vi.advanceTimersByTimeAsync(10000); // 第二次 tick：成功
    expect(mocks.listAgents).toHaveBeenCalledTimes(2); // 轮询未因异常终止
    expect(state.error).toBeNull(); // loadAdmin 开头会清 error，成功后恢复 null
    m.stopAutoRefresh();
  });
});
