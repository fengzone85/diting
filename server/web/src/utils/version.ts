// 版本号比较（受控端版本差提示用）
//
// 为什么需要它：早先的实现是 `latest !== cur` —— 只要不相等就提示「可升级」。
// 但本地/自建构建的版本号可能**高于**线上最新 tag（例如线上最新是 agent-go-v1.1.3，
// 而节点跑的是本地构建的 1.1.4）⇒ 不相等会把「比线上还新」误报成「可升级」。
//
// 比较口径：按 `.` 与 `-` 切段取数字段逐位比较；`v` 前缀忽略；缺失段按 0 处理；
// 分段内出现非数字（如 `1.1.4-rc1` 的 `rc1`）按 0 处理 —— 对「是否落后于发布版」
// 这个判断足够，且不会因为后缀导致误报「落后」。
export function normalizeVer(v: string | null | undefined): string {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return '';
  // 提取版本号本体：服务端返回的是**完整 release tag**（如 `agent-go-v1.1.3`），
  // 早先只剥离开头的 `v` ⇒ `agent-go-v1.1.3` 原样进入比较，被解析成 [0,0,0,1,3]，
  // 与节点的 `1.1.4` 比较必然「不相等」，导致三台节点全部误报「可升级」。
  const m = raw.match(/\d+(?:\.\d+)*/);
  return m ? m[0] : '';
}

export function compareVer(a: string, b: string): number {
  const pa = normalizeVer(a).split(/[.-]/);
  const pb = normalizeVer(b).split(/[.-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i] || '0', 10) || 0;
    const y = parseInt(pb[i] || '0', 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 当前版本是否**确实低于**最新发布版（只有这时才提示「可升级」）。 */
export function isOlderVersion(cur: string | null | undefined, latest: string | null | undefined): boolean {
  const c = normalizeVer(cur);
  const l = normalizeVer(latest);
  if (!c || !l) return false; // 任一侧未知 → 不提示（不把「未知」说成「可升级」）
  return compareVer(c, l) < 0;
}
