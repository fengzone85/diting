// 路由守卫的可测试实现。
//
// 从 router/index.ts 抽出来的原因：守卫里有一条「非鉴权错误不能中断导航」的规则，
// 它只在 429（应用层限流 60 次/10s 被打满）或网络抖动/5xx 时触发——这类场景
// 用 E2E 很难稳定复现，只能靠单测锁住。历史行为是：getAuthStatus() 对 429 直接
// throw，beforeEach 未捕获 → 初始导航被中断 → 后台白屏（URL 正确、#app 为空）。
import type { RouteLocationNormalized } from 'vue-router';
import { getAuthStatus, type AuthStatus } from '../services/auth';

export type AuthChecker = () => Promise<AuthStatus>;

/**
 * 生成 beforeEach 守卫。
 * - 未登录（401/403）→ 跳登录页并带上 redirect；
 * - 探活本身失败（429/5xx/网络）→ 放行：白屏比「进到后台看到错误提示」更糟，
 *   且真正的数据请求仍由服务端鉴权，越权不会因此发生。
 */
export function makeAuthGuard(check: AuthChecker = getAuthStatus) {
  return async (to: RouteLocationNormalized) => {
    if (!to.meta.requiresAuth) return true;
    try {
      const status = await check();
      if (!status.logged_in) return { path: '/login', query: { redirect: to.fullPath } };
      return true;
    } catch {
      return true;
    }
  };
}
