// 安装向导的表单校验与软告警。
//
// 抽成纯函数而不是留在 SFC 里：项目既有测试只覆盖 utils / services / composables，
// 不挂载组件；逻辑留在模板里就只能靠肉眼保证，覆盖率门禁也会被拖垮。
// 口径与后端 server/src/install.js 的 normalizeBaseUrl / urlWarnings / validateInstall
// 保持一致；前端只做即时反馈，最终以后端校验为准。

export const MIN_TOKEN_LEN = 16;
export const URL_MAX = 200;

// 回环 / 内网主机：公网受控端很可能连不上，作为软告警提示
const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|::1|\[::1\])$/i;

export function parseUrl(v: string): URL | null {
  try {
    return new URL(String(v == null ? '' : v).trim());
  } catch {
    return null;
  }
}

// 空值：required=false 视为合法（选填），true 视为非法
export function isAcceptableUrl(v: string, required: boolean): boolean {
  const s = String(v == null ? '' : v).trim();
  if (!s) return !required;
  if (s.length > URL_MAX) return false;
  const u = parseUrl(s);
  return !!u
    && (u.protocol === 'http:' || u.protocol === 'https:')
    && !u.username
    && !u.password
    && !!u.hostname;
}

// 返回 i18n key；'' 表示无告警。两条判定互斥（先报更严重的"连不上"）。
export function agentUrlWarning(v: string, listenPort: number | null): string {
  const u = parseUrl(v);
  if (!u) return '';
  if (PRIVATE_HOST_RE.test(u.hostname)) return 'install.warnPrivate';
  if (u.port && listenPort && Number(u.port) !== listenPort) return 'install.warnPortMismatch';
  return '';
}

export interface TokenCheck {
  ok: boolean;
  key: string;
}

// 与后端 validateInstall 的 custom 分支同口径：非空、非占位符、≥16 位、
// 非纯数字/字符种类过少、无连续序列。
export function checkCustomToken(v: string): TokenCheck {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { ok: false, key: 'install.tokenEmpty' };
  if (s === 'change-me-admin-token') return { ok: false, key: 'install.tokenPlaceholder' };
  if (s.length < MIN_TOKEN_LEN) return { ok: false, key: 'install.tokenTooShort' };
  if (/^\d+$/.test(s) || new Set(s).size <= 4) return { ok: false, key: 'install.tokenWeak' };
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf)/i.test(s)) {
    return { ok: false, key: 'install.tokenSeq' };
  }
  return { ok: true, key: 'install.tokenOk' };
}

// 服务端返回的告警码 → 前端 i18n key
export function warnI18nKey(code: string): string {
  if (code === 'agent_server_url_private') return 'install.warnPrivate';
  if (code === 'agent_server_url_port_mismatch') return 'install.warnPortMismatch';
  return '';
}
