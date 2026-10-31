// adminApi 的两个 XHR 上传方法（artifact / 备份）走原始 body，不走 fetch 封装：
// 进度回调、非 2xx 解析、网关错误页（非 JSON）都是容易静默出错的分支，单独锁住。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { adminApi } from './adminApi';

class FakeXHR {
  static instances: FakeXHR[] = [];

  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  status = 200;
  responseText = '{}';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  withCredentials = false;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();

  constructor() {
    FakeXHR.instances.push(this);
  }
}

function installXhr() {
  FakeXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
  return FakeXHR;
}

function file() {
  return new File(['abc'], 'agent.bin', { type: 'application/octet-stream' });
}

describe('adminApi XHR 上传', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploadAgentArtifact：query 带平台/备注，成功后回报进度', async () => {
    const XHR = installXhr();
    const progress: number[] = [];
    const p = adminApi.uploadAgentArtifact(file(), 'linux', 'build 42', (pct) => progress.push(pct));
    const xhr = XHR.instances[0];

    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/admin/agent-artifacts?platform=linux&source_note=build+42');
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    expect(xhr.withCredentials).toBe(true);

    xhr.upload.onprogress!({ lengthComputable: true, loaded: 25, total: 100 } as ProgressEvent);
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ ok: true, artifact_id: 'art_1', sha256: 'abc' });
    xhr.onload!();

    await expect(p).resolves.toMatchObject({ artifact_id: 'art_1' });
    expect(progress).toEqual([25]);
  });

  it('uploadAgentArtifact：lengthComputable=false 时不回报进度', async () => {
    const XHR = installXhr();
    const progress: number[] = [];
    adminApi.uploadAgentArtifact(file(), 'windows', '', (pct) => progress.push(pct)).catch(() => {});
    const xhr = XHR.instances[0];
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 25, total: 0 } as ProgressEvent);
    expect(progress).toEqual([]);
  });

  it('uploadAgentArtifact：非 2xx 带 error 字段时 reject 并附 status', async () => {
    const XHR = installXhr();
    const p = adminApi.uploadAgentArtifact(file(), 'linux', '');
    const assertion = p.catch((e: Error & { status?: number }) => e);
    const xhr = XHR.instances[0];
    xhr.status = 413;
    xhr.responseText = JSON.stringify({ error: 'too large' });
    xhr.onload!();

    const err = await assertion;
    expect(err.message).toBe('too large');
    expect(err.status).toBe(413);
  });

  it('uploadAgentArtifact：网关返回非 JSON 时以状态码作为消息', async () => {
    const XHR = installXhr();
    const p = adminApi.uploadAgentArtifact(file(), 'linux', '');
    const assertion = p.catch((e: Error) => e);
    const xhr = XHR.instances[0];
    xhr.status = 502;
    xhr.responseText = '<html>bad gateway</html>';
    xhr.onload!();

    await expect(assertion).resolves.toMatchObject({ message: '502' });
  });

  it('uploadAgentArtifact：网络错误 reject network error', async () => {
    const XHR = installXhr();
    const p = adminApi.uploadAgentArtifact(file(), 'linux', '');
    const assertion = p.catch((e: Error) => e);
    XHR.instances[0].onerror!();
    await expect(assertion).resolves.toMatchObject({ message: 'network error' });
  });

  it('uploadBackup：成功解析 JSON 并回传文件名/大小', async () => {
    const XHR = installXhr();
    const progress: number[] = [];
    const p = adminApi.uploadBackup(file(), (pct) => progress.push(pct));
    const xhr = XHR.instances[0];
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/admin/backups/upload');

    xhr.upload.onprogress!({ lengthComputable: true, loaded: 7, total: 10 } as ProgressEvent);
    xhr.status = 201;
    xhr.responseText = JSON.stringify({ ok: true, name: 'monitor_1.db', size_bytes: 3 });
    xhr.onload!();

    await expect(p).resolves.toMatchObject({ name: 'monitor_1.db' });
    expect(progress).toEqual([70]);
  });

  it('uploadBackup：优先使用 message，其次 error', async () => {
    const XHR = installXhr();
    const p = adminApi.uploadBackup(file());
    const assertion = p.catch((e: Error) => e);
    XHR.instances[0].status = 400;
    XHR.instances[0].responseText = JSON.stringify({ message: 'm1', error: 'e1' });
    XHR.instances[0].onload!();
    await expect(assertion).resolves.toMatchObject({ message: 'm1' });

    const XHR2 = installXhr();
    const p2 = adminApi.uploadBackup(file());
    const assertion2 = p2.catch((e: Error) => e);
    XHR2.instances[0].status = 400;
    XHR2.instances[0].responseText = JSON.stringify({ error: 'e1' });
    XHR2.instances[0].onload!();
    await expect(assertion2).resolves.toMatchObject({ message: 'e1' });
  });

  it('uploadBackup：非 JSON 与空错误字段回退到状态码', async () => {
    const XHR = installXhr();
    const p = adminApi.uploadBackup(file());
    const assertion = p.catch((e: Error) => e);
    XHR.instances[0].status = 500;
    XHR.instances[0].responseText = 'not-json';
    XHR.instances[0].onload!();
    await expect(assertion).resolves.toMatchObject({ message: '500' });
  });

  it('uploadBackup：网络错误 reject network error', async () => {
    const XHR = installXhr();
    const p = adminApi.uploadBackup(file());
    const assertion = p.catch((e: Error) => e);
    XHR.instances[0].onerror!();
    await expect(assertion).resolves.toMatchObject({ message: 'network error' });
  });
});
