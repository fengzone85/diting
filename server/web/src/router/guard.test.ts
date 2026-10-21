// 路由守卫回归：探活失败不得把用户丢在白屏。
// 触发场景：应用层限流（60 次/10s 打满 → 429）或网络抖动/5xx。
import { describe, it, expect } from 'vitest';
import { makeAuthGuard } from './guard';

const route = (requiresAuth: boolean, fullPath = '/admin') =>
  ({ meta: requiresAuth ? { requiresAuth: true } : {}, fullPath }) as never;

describe('makeAuthGuard', () => {
  it('已登录 → 放行', async () => {
    const guard = makeAuthGuard(async () => ({ logged_in: true, role: 'admin' }));
    expect(await guard(route(true))).toBe(true);
  });

  it('未登录（401/403 判定为 logged_in:false）→ 跳登录页并带 redirect', async () => {
    const guard = makeAuthGuard(async () => ({ logged_in: false }));
    expect(await guard(route(true, '/admin/agents'))).toEqual({
      path: '/login',
      query: { redirect: '/admin/agents' },
    });
  });

  it('探活抛错（429 限流 / 5xx / 网络）→ 放行，避免白屏', async () => {
    const guard = makeAuthGuard(async () => {
      throw Object.assign(new Error('too many requests (HTTP 429)'), { status: 429 });
    });
    expect(await guard(route(true))).toBe(true);
  });

  it('无需鉴权的路由不触发探活', async () => {
    let called = 0;
    const guard = makeAuthGuard(async () => {
      called++;
      return { logged_in: false };
    });
    expect(await guard(route(false))).toBe(true);
    expect(called).toBe(0);
  });
});
