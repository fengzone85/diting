#!/usr/bin/env bash
# =============================================================================
# 源码分片 → 根 diting.sh 拼接构建
#   对外仍只发布单个 diting.sh（curl 下载即用）；可维护源码在 scripts/diting-src/。
#   用法：bash scripts/build-diting.sh
#   注意：不要手改根 diting.sh —— CI 会重建后用 `git diff --exit-code` 拦截漂移。
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export LC_ALL=C

SRC_DIR="scripts/diting-src"
OUT="diting.sh"
HEADER="00-header.sh"
MARKER_1='# ⚠ 本文件由 scripts/build-diting.sh 从 scripts/diting-src/*.sh 拼接生成，请勿直接编辑。'
MARKER_2='#   修改请改对应分片，然后运行 bash scripts/build-diting.sh 重新生成。'

[[ -f "$SRC_DIR/$HEADER" ]] || { echo "错误：缺少分片 $SRC_DIR/$HEADER" >&2; exit 1; }
[[ "$(head -n 1 "$SRC_DIR/$HEADER")" == '#!/usr/bin/env bash' ]] || {
    echo "错误：$SRC_DIR/$HEADER 首行必须是 shebang" >&2
    exit 1
}

tmp="$(mktemp "$(pwd)/.diting-build.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

{
    # shebang 保留在首行，生成标记紧随其后（分片本身不含这 2 行）
    head -n 1 "$SRC_DIR/$HEADER"
    printf '%s\n' "$MARKER_1" "$MARKER_2"
    tail -n +2 "$SRC_DIR/$HEADER"
    # 文件名前缀即拼接顺序（00/10/20/...），保证与手写版逐字节等价。
    # 注意：编号必须限两位数字 —— C 字典序下 100-x.sh 会排到 90-main.sh 之前。
    for f in "$SRC_DIR"/*.sh; do
        [[ "$(basename "$f")" == "$HEADER" ]] && continue
        cat "$f"
    done
} > "$tmp"

bash -n "$tmp"
mv "$tmp" "$OUT"
trap - EXIT
chmod +x "$OUT"
echo "已生成 $OUT（$(wc -l < "$OUT") 行，源分片 $(ls "$SRC_DIR"/*.sh | wc -l) 个）"
