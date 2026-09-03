import { api } from './api';

export interface AuthStatus {
  logged_in: boolean;
  role?: 'admin' | 'readonly';
  twofa_required?: boolean;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  try {
    await api.get<{ enabled: boolean }>('/api/admin/2fa/status');
    // 该端点受 adminOrReadonly 保护，能访问即说明已登录；
    // 当前系统仅有 admin 角色，readonly token 不会访问后台管理路由。
    return { logged_in: true, role: 'admin' };
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 401 || status === 403) {
      return { logged_in: false };
    }
    throw err;
  }
}

export async function logout(): Promise<void> {
  await api.post('/api/logout');
}
