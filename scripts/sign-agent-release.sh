#!/usr/bin/env bash
# ============================================================
# S5：受控端 Release 产物的 ed25519 签名工具
#
# 用途：对 agent-go/dist 下的三平台产物逐个生成 `.sig`（raw 64 字节签名，
# 与 Node crypto.verify(null, data, key, sig) 直接兼容）。
#
# 私钥来源（按优先级）：
#   1. 环境变量 AGENT_RELEASE_SIGN_KEY —— PEM 内容本身（CI secret 用这种，避免落盘）
#   2. 环境变量 AGENT_RELEASE_SIGN_KEY_FILE —— PEM 路径（本地开发用这种）
#
# 公钥：`--print-pubkey` 打印 base64(raw 32B)，抄进 server/src/agent-relay.js 的
# PUBLIC_KEY_B64（编译期常量，**不允许** env 覆盖——公钥可被环境变量替换等于验签形同虚设）。
#
# 生成新密钥对（私钥只进 CI secret，绝不入库）：
#   openssl genpkey -algorithm ed25519 -out agent-release.key
#   bash scripts/sign-agent-release.sh --print-pubkey agent-release.key
#
# 签名（CI 里对 dist/ 全量）：
#   AGENT_RELEASE_SIGN_KEY="$(cat agent-release.key)" \
#     bash scripts/sign-agent-release.sh agent-go/dist
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'

KEY_FILE=""
TARGET=""

print_pubkey() {
    local key="$1"
    [[ -f "$key" ]] || { echo -e "${RED}[error] key not found: $key${NC}" >&2; exit 1; }
    openssl pkey -in "$key" -pubout -outform DER 2>/dev/null | tail -c 32 | base64 -w0
    echo
}

# ---- 参数解析 ----
while [[ $# -gt 0 ]]; do
    case "$1" in
        --print-pubkey)
            # --print-pubkey <keyfile>：只打印公钥后退出
            KEY_FILE="$2"; shift 2
            print_pubkey "$KEY_FILE"
            exit 0
            ;;
        *) TARGET="$1"; shift ;;
    esac
done

[[ -n "$TARGET" ]] || { echo "usage: $0 [--print-pubkey <key>] <dist-dir>" >&2; exit 1; }
[[ -d "$TARGET" ]] || { echo -e "${RED}[error] not a directory: $TARGET${NC}" >&2; exit 1; }

# ---- 取私钥（优先 inline secret，其次文件）----
TMP_KEY=""
cleanup() { [[ -n "$TMP_KEY" ]] && rm -f "$TMP_KEY"; }
trap cleanup EXIT

if [[ -n "${AGENT_RELEASE_SIGN_KEY:-}" ]]; then
    TMP_KEY="$(mktemp)"
    printf '%s\n' "$AGENT_RELEASE_SIGN_KEY" > "$TMP_KEY"
    chmod 600 "$TMP_KEY"
    KEY_PATH="$TMP_KEY"
elif [[ -n "${AGENT_RELEASE_SIGN_KEY_FILE:-}" ]]; then
    KEY_PATH="$AGENT_RELEASE_SIGN_KEY_FILE"
else
    echo -e "${RED}[error] 需要 AGENT_RELEASE_SIGN_KEY（PEM 内容）或 AGENT_RELEASE_SIGN_KEY_FILE（PEM 路径）${NC}" >&2
    exit 1
fi

[[ -f "$KEY_PATH" ]] || { echo -e "${RED}[error] key file not found: $KEY_PATH${NC}" >&2; exit 1; }

# ---- 逐个签名（跳过 .sha256/.sig 等非产物文件）----
signed=0
for f in "$TARGET"/diting-agent-*; do
    [[ -f "$f" ]] || continue
    case "$f" in
        *.sha256|*.sig) continue ;;
    esac
    out="${f}.sig"
    # -rawin：ed25519 是纯算法（不对输入做哈希），必须用 rawin 而非默认的 DigestSign
    openssl pkeyutl -sign -inkey "$KEY_PATH" -rawin -in "$f" -out "$out"
    size=$(stat -c%s "$out" 2>/dev/null || stat -f%z "$out")
    if [[ "$size" != "64" ]]; then
        echo -e "${RED}[error] $out 大小 $size ≠ 64，签名异常${NC}" >&2
        exit 1
    fi
    echo -e "${GREEN}[signed]${NC} $(basename "$f") → $(basename "$out") (64B)"
    signed=$((signed + 1))
done

[[ $signed -gt 0 ]] || { echo -e "${RED}[error] 没有找到可签名的产物（$TARGET/diting-agent-*）${NC}" >&2; exit 1; }
echo -e "${GREEN}[ok]${NC} 共签名 $signed 个产物"
