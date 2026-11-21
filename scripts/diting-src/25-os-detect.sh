# ── OS / 架构自检 ──────────────────────────────────────────────────────────────
detect_os() {
    if [[ -r /etc/os-release ]]; then
        . /etc/os-release 2>/dev/null
        echo "${PRETTY_NAME:-${ID:-unknown}}"
    else
        echo "unknown"
    fi
}
detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) echo "$(uname -m)" ;;
    esac
}

# SHA256 校验（L-6 供应链完整性）：下载后若提供期望哈希则比对，不符立即放弃。
# 用法：download <url> <out> [expected_sha256]
# 期望哈希可经环境变量 SP_INSTALL_SHA256（自检更新）等传入；未提供则跳过校验。
sha256_of() { local f="$1"; (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null) | awk '{print $1}'; }
verify_sha256() {
    local f="$1" exp="$2"
    [[ -z "$exp" ]] && return 0
    local got; got="$(sha256_of "$f")"
    if [[ "$got" != "$exp" ]]; then
        echo -e "${RED}[错误] 校验和不符：期望 ${exp}，实际 ${got}${NC}" >&2
        return 1
    fi
    echo -e "${GREEN}[OK]   SHA256 校验通过${NC}"
    return 0
}
download() {
    local url="$1" out="$2" exp="${3:-}"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$out"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$out" "$url"
    else
        echo -e "${RED}[错误] 需要 curl 或 wget 才能下载文件${NC}" >&2
        return 1
    fi     || return 1
    verify_sha256 "$out" "$exp"
}
# 批量下载并可选按位置校验（exps 与 files 一一对应，逗号分隔）。
download_list() {
    local base="$1" dir="$2" files=($3) exps_csv="${4:-}"
    local -a exps=()
    [[ -n "$exps_csv" ]] && IFS=',' read -ra exps <<< "$exps_csv"
    local i=0 f
    for f in "${files[@]}"; do
        if ! download "$base/$f" "$dir/$f" "${exps[$i]:-}"; then return 1; fi
        i=$((i+1))
    done
}

# ── 版本工具 ───────────────────────────────────────────────────────────────────
# 比较两个语义化版本：$1 > $2 时返回 0（真）。缺失/异常一律判否，避免误报新版。
version_gt() {
    [[ -n "$1" && -n "$2" && "$1" != "$2" ]] || return 1
    [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]
}

# 抓取远端 diting.sh 的 SCRIPT_VERSION（带短超时，静默失败返回空串，不阻塞菜单）。
remote_script_version() {
    local v=""
    if command -v curl >/dev/null 2>&1; then
        v="$(curl -fsSL --max-time 3 "$REPO_RAW/diting.sh" 2>/dev/null \
             | grep -m1 '^SCRIPT_VERSION=' | sed -E 's/^SCRIPT_VERSION="?([^"]*)"?.*/\1/')"
    elif command -v wget >/dev/null 2>&1; then
        v="$(wget -qO- --timeout=3 "$REPO_RAW/diting.sh" 2>/dev/null \
             | grep -m1 '^SCRIPT_VERSION=' | sed -E 's/^SCRIPT_VERSION="?([^"]*)"?.*/\1/')"
    fi
    printf '%s' "$v"
}

