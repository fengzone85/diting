import { api } from './api';

export interface InstallStatus {
  state: 'ready' | 'completing' | 'completed';
  // required=false 表示已完成安装：前端据此渲染「已初始化」锁定视图
  required: boolean;
  // 内网监听端口（宿主侧参数，由安装器写入 .env；向导只读展示）
  port?: number;
  // 抢占防护（§6.7）：当前来源不是"私网 + 零代理头"时为 true，
  // 前端据此渲染 install_token 输入框（口令 = 安装器打印的 SETUP_TOKEN）
  install_token_required?: boolean;
}

export interface InstallPayload {
  sitename: string;
  description?: string;
  // 站点网址（选填）与上报地址（必填）：上报地址是受控端安装命令的前置依赖
  // （服务端 getPublicBaseUrl 优先级 agent_server_url > site_url > PUBLIC_URL）
  site_url?: string;
  agent_server_url: string;
  token_mode: 'generate' | 'custom';
  token?: string;
  // 远程来源完成安装所需的口令（install_token_required=true 时必填）
  install_token?: string;
}

export interface InstallResult {
  status: string;
  // 仅 token_mode=generate 时回显一次性 Token；custom 模式为空串
  token: string;
  // 软告警（不阻断）：地址指向回环/内网、显式端口与监听端口不一致
  warnings?: string[];
}

export function getInstallStatus(): Promise<InstallStatus> {
  return api.get<InstallStatus>('/api/install/status');
}

export function completeInstall(p: InstallPayload): Promise<InstallResult> {
  return api.post<InstallResult>('/api/install/complete', p);
}
