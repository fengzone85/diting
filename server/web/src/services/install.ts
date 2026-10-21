import { api } from './api';

export interface InstallStatus {
  state: 'ready' | 'completing' | 'completed';
  // required=false 表示已完成安装：前端据此渲染「已初始化」锁定视图
  required: boolean;
}

export interface InstallPayload {
  sitename: string;
  description?: string;
  token_mode: 'generate' | 'custom';
  token?: string;
}

export interface InstallResult {
  status: string;
  // 仅 token_mode=generate 时回显一次性 Token；custom 模式为空串
  token: string;
}

export function getInstallStatus(): Promise<InstallStatus> {
  return api.get<InstallStatus>('/api/install/status');
}

export function completeInstall(p: InstallPayload): Promise<InstallResult> {
  return api.post<InstallResult>('/api/install/complete', p);
}
