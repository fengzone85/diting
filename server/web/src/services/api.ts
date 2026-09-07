const BASE = '';

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
  if (!res.ok) {
    // 透传服务端业务错误：优先取响应体的 error / message，否则退回 HTTP 文本形态。
    // 网关错误页是 HTML（如 Nginx 502），故 JSON.parse 失败必须静默降级而不是抛出。
    let detail = '';
    try {
      const raw = await res.text();
      if (raw) {
        try {
          const body = JSON.parse(raw);
          detail = typeof body?.error === 'string'
            ? body.error
            : (typeof body?.message === 'string' ? body.message : '');
        } catch {
          // 非 JSON 响应体：忽略，走 HTTP 文本 fallback
        }
      }
    } catch {
      // 响应体读取失败：忽略，走 HTTP 文本 fallback
    }

    const err = new Error(detail ? `${detail} (HTTP ${res.status})` : `${res.status} ${res.statusText}`);
    const e = err as Error & { status: number; detail: string };
    e.status = res.status; // 保持原有字段：多处逻辑依赖 status 判断（如 401 → 跳登录）
    e.detail = detail;     // 机器可读错误码，便于按 error 码分支（如 server_url_not_configured）
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => request<T>(url, { method: 'GET' }),
  post: <T>(url: string, body?: unknown) => request<T>(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(url: string, body?: unknown) => request<T>(url, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
};
