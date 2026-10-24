#!/usr/bin/env bash
# =============================================================================
# 谛听轻量探针 — 一键部署脚本
#   借鉴 Nezha / Komari / Pulse 的「单文件下载 + 交互菜单 + 统一管理」范式
# =============================================================================
# 一条命令下载并运行（建议先下载审阅，再 sudo 执行）：
#   # 最小化镜像可能未预装 curl，先安装（仅 Debian/Ubuntu 等 apt 系统需要）
#   apt-get update && apt-get install -y curl
#   # 下载安装脚本（默认分支 master）
#   curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/diting.sh -o diting.sh
#   chmod +x diting.sh
#   sudo ./diting.sh
#
# 也可作为管理脚本重复运行（查看状态 / 卸载 / 更新）。
#
# 安全说明：
#   - 本脚本只下载本项目自有文件（agent 载荷）或 git clone 本项目源码，
#     不执行任何第三方二进制；仍建议下载后先 `cat diting.sh` 审查。
#   - 受控端注册使用服务端 SETUP_TOKEN，仅用于创建客户端记录，不建立任何
#     指令通道（agent 注册后依旧只上报指标）。
#   - 供应链完整性（L-6）：更新本脚本时可用 `SP_INSTALL_SHA256=<已知良好哈希>`
#     强制校验下载内容，防 CDN/中间人投毒；未设置则跳过校验（仍建议审阅）。
# =============================================================================

set -euo pipefail

# ── 国际化（i18n）──────────────────────────────────────────────────────────────
# 自动选语言，默认中文。
# 取值优先级需处理 sudo 的干扰：sudo 默认注入 LC_ALL=C.UTF-8 并把 LANG 重置为
# C.UTF-8（除非 sudoers 配 env_keep）。而 LC_ALL 优先级高于 LANG，若直接采用
# LC_ALL，用户显式写的 LANG=zh_CN.UTF-8 会被忽略 → 界面变英文。
# 故：LC_ALL 仅在它是「明确语言」时采用；C/POSIX 系视为未指定，回退看 LANG。
_pick_lang() {
    local l="$1"
    case "$l" in
        C|POSIX|C.UTF-8|POSIX.UTF-8) return 1 ;;   # 「未指定」语义
        "") return 1 ;;
        en*|EN*) echo "en"; return 0 ;;
        zh*|ZH*) echo "zh"; return 0 ;;
        *) echo "zh"; return 0 ;;
    esac
}
# ── 语言持久化（/etc/diting/ui.lang）───────────────────────────────────────────
# 优先级：用户显式选择（持久化文件）> LC_ALL/LANG 环境判定 > 默认中文。
# 首次交互运行会询问一次并写入；菜单内可随时切换。写失败（如非 root）静默降级
# 为环境判定，仅本次会话生效。
UI_LANG_FILE="${DITING_UI_LANG_FILE:-/etc/diting/ui.lang}"
_valid_lang() {
    case "$1" in
        zh|en) echo "$1" ;;
        *) return 1 ;;
    esac
}
load_saved_lang() {
    [[ -r "$UI_LANG_FILE" ]] || return 1
    _valid_lang "$(head -c 8 "$UI_LANG_FILE" 2>/dev/null | tr -d '[:space:]')"
}
save_lang() {
    mkdir -p "$(dirname "$UI_LANG_FILE")" 2>/dev/null || true
    printf '%s\n' "$1" > "$UI_LANG_FILE" 2>/dev/null || true
}
I18N_LANG="zh"
_saved_lang="$(load_saved_lang 2>/dev/null || true)"
if [[ -n "$_saved_lang" ]]; then
    I18N_LANG="$_saved_lang"
elif _pick_lang "${LC_ALL:-}" >/dev/null 2>&1; then
    I18N_LANG="$( _pick_lang "${LC_ALL:-}" )"
elif _pick_lang "${LANG:-}" >/dev/null 2>&1; then
    I18N_LANG="$( _pick_lang "${LANG:-}" )"
fi
unset _saved_lang
# 消息函数：msg "key" → 输出对应语言的文本
msg() {
    local key="$1"
    if [[ "$I18N_LANG" == "en" ]]; then
        echo "${I18N_EN[$key]:-$key}"
    else
        echo "${I18N_ZH[$key]:-$key}"
    fi
}

# ── 脚本版本（语义化）──────────────────────────────────────────────────────────
# 每次修改本脚本行为，请同步 +1 版本号、更新日期与「本版要点」，方便用户对比是否
# 需要更新，并在更新后直观了解改动内容。远端菜单会据此提示「发现新版」。
SCRIPT_VERSION="1.1.8"
SCRIPT_DATE="2026-10-19"
SCRIPT_NOTES="受控端安装/更新链路支持 --month-rotate（MONTH_ROTATE，0=累计，1–31=流量重置日），update_agent 会保留已存值"

# 颜色：仅当 **stdout 是终端** 时着色；管道 / CI / 重定向下一律置空。
# （附录 B 建议按 stderr 判定，但本脚本大量面向人的输出走 stdout——按 stderr 判会让
#   `diting.sh --status | cat` 里混进 ANSI 转义，因此这里按 stdout 判。）
if [[ -t 1 ]]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "$PWD")"
# ── 仓库来源（L-17：REPO_BRANCH 可钉 tag，便于可复现安装）─────────────────────
# 发布时用 `REPO_BRANCH=v1.2.0 sudo bash diting.sh --install-server` 即可锁定版本；
# 默认 master 保持「跟随最新」的行为不变。REPO_RAW/REPO_GIT 仍可被显式覆盖。
REPO_BRANCH="${REPO_BRANCH:-master}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/fengzone85/diting/${REPO_BRANCH}}"
REPO_GIT="${REPO_GIT:-https://github.com/fengzone85/diting.git}"
SRC_DIR="/opt/diting-src"

# 把 $SRC_DIR 的工作树同步到 $REPO_BRANCH（分支或 tag 均可）。
# 旧实现把 `fetch origin master` / `reset --hard origin/master` 写死，导致
# `REPO_BRANCH=v1.2.0` 只改到 raw 下载（脚本/载荷），源码仍是 master —— 与
# 注释里"可钉 tag 便于可复现安装"的承诺不符。
# `fetch <ref>` 对分支和 tag 都成立，FETCH_HEAD 指向它；仅分支能设上游。
sync_source_ref() {
    local ref="${1:-$REPO_BRANCH}"
    git -C "$SRC_DIR" fetch origin "$ref" -q || return 1
    git -C "$SRC_DIR" reset --hard FETCH_HEAD || return 1
    git -C "$SRC_DIR" branch -u "origin/$ref" 2>/dev/null || true
    return 0
}

# ── 宿主侧环境（可选）────────────────────────────────────────────────────────
# /etc/diting/host.env 里配置后台可见备份目录与恢复请求路径：
#   BACKUP_VISIBLE_DIR=/opt/diting-backups
#   RESTORE_REQUEST_FILE=/opt/diting-backups/restore.request
# cron 行里也会 source 它；这里在【任何】调用场景下都读一次，这样手动执行
# `diting.sh --backup` 产出的备份同样会同步过去（否则后台列表里看不到）。
#
# ⚠ 必须「环境变量优先」：host.env 是无条件赋值（如 BACKUP_VISIBLE_DIR=xxx），
# 直接 source 会覆盖调用方显式传入的同名变量（例如临时用
# `BACKUP_VISIBLE_DIR=/tmp/x diting.sh --backup` 会失效，且不报错、很难排查）。
# 先存下环境中已存在的值，source 之后再恢复回去。
if [[ -f /etc/diting/host.env ]]; then
    _env_keep_visible="${BACKUP_VISIBLE_DIR:-}"
    _env_keep_request="${RESTORE_REQUEST_FILE:-}"
    # shellcheck disable=SC1091
    . /etc/diting/host.env
    [[ -n "$_env_keep_visible" ]] && BACKUP_VISIBLE_DIR="$_env_keep_visible"
    [[ -n "$_env_keep_request" ]] && RESTORE_REQUEST_FILE="$_env_keep_request"
    unset _env_keep_visible _env_keep_request
fi

# 带值参数的缺值保护：脚本开头 set -u，裸 $2 在漏写值时会让 bash 直接
# 以「$2: unbound variable」中断，连用法提示都来不及打印。
# 用法：need_val_guard <选项名> <值>
need_val_guard() {
    if [[ -z "${2:-}" || "$2" == --* ]]; then
        echo -e "${RED}[错误] 参数 $1 缺少取值${NC}" >&2
        echo -e "       用法见: $0 --help" >&2
        exit 1
    fi
}

# ── 非交互参数（供 CI / 批量部署）─────────────────────────────────────────────
ACTION=""
A_SERVER=""; A_ID=""; A_TOKEN=""; A_TOKEN_FILE=""; A_SETUP=""; A_SETUP_NAME=""; A_INTERVAL=""; A_PROBE_TARGETS=""; A_MONTH_ROTATE=""
A_BACKUP_PATH=""; A_BACKUP_KEEP=""; A_BACKUP_SCHEDULE=""
# 服务端监听端口（安装时确定，写入 .env 的 PORT；空 = 交互询问 / 沿用现值）
A_SERVER_PORT=""
# --logs 的可选参数：行数或 follow
A_LOG_ARG=""
# 跳过保护性检查（当前用于：升级前备份失败仍继续）。默认 0 = 严格模式。
A_FORCE=0

show_usage() {
    cat <<EOF
谛听轻量探针 一键部署脚本

用法（交互）：
  sudo bash diting.sh                 # 显示菜单，逐项选择

用法（非交互 / 一键）：
  # 安装服务端（Docker，自动生成强随机令牌）
  sudo bash diting.sh --install-server

  # 安装受控端（需先在服务端后台「新建客户端」拿到 ID/Token）
  sudo bash diting.sh --install-agent --server https://your-server:8008 --id NODE1 --token SECRET

  # 安装受控端（一键自助注册：只需服务端地址 + SETUP_TOKEN）
  sudo bash diting.sh --install-agent --server https://your-server:8008 --setup-token <SETUP_TOKEN>

  # 更新本安装脚本（覆盖为 GitHub 最新版）
  sudo bash diting.sh --update-script

  # 更新服务端（拉取最新源码并重建容器）
  sudo bash diting.sh --update-server

  # 更新受控端（保留已注册身份，拉取最新 agent 代码）
  sudo bash diting.sh --update-agent

  # 查看状态 / 卸载
  sudo bash diting.sh --status
  sudo bash diting.sh --uninstall

  # 数据库备份 / 恢复 / 管理
  sudo bash diting.sh --backup [输出路径]         # 备份数据库（默认存到 ${DB_BACKUP_DIR:-/var/backups/diting}）
  sudo bash diting.sh --restore <备份文件路径>    # 从备份恢复（自动先备份当前状态）
  sudo bash diting.sh --backup-list               # 列出已有备份（含占用/时间跨度/定时状态）
  sudo bash diting.sh --db-stats                  # 查看数据库统计（大小/记录数/时间范围）
  sudo bash diting.sh --db-vacuum                 # 压缩数据库并启用增量回收（回收空闲页）
  sudo bash diting.sh --logs 200                  # 查看服务端最近 200 行日志（follow=持续跟踪）

  # 每日自动备份（cron，默认凌晨 3 点；默认保留 14 天并自动清理过期）
  sudo bash diting.sh --backup-schedule install      # 安装
  sudo bash diting.sh --backup-schedule status       # 查看是否已启用
  sudo bash diting.sh --backup-schedule uninstall    # 取消
  sudo bash diting.sh --backup --keep-days 30        # 单次备份并保留 30 天

  # 管理员 Token 重置（丢失 Token 时使用，需 SSH 登录服务器）
  sudo bash diting.sh --reset-admin-token         # 生成新管理员 Token（旧 Token 立即失效）

  # 版本发布（推进 server/package.json 并打 vX.Y.Z tag，页脚版本随 tag 生效）
  sudo bash diting.sh --release                    # 补丁版 +1（1.0.1 → 1.0.2）
  sudo bash diting.sh --release minor              # 次版本 +1（1.0.x → 1.1.0）
  sudo bash diting.sh --release major              # 主版本 +1（1.x → 2.0.0）
  sudo bash diting.sh --release 1.6.0              # 指定具体版本号

  # IP 白名单配错把管理员锁在门外时的救援（改库即时生效，无需重启）
  sudo bash diting.sh --clear-ip-whitelist        # 清空 admin_allow_ips，恢复全放行

选项：
  --install-server        安装服务端（Docker）
  --port N                服务端监听端口（1-65535，默认 8081；配合 --install-server）
  --install-agent         安装受控端（systemd）
  --update-script         更新本安装脚本为最新版
  --update-server         更新服务端（git pull + 重建容器；升级前自动备份数据库）
  --force                 跳过保护性检查（升级前备份失败时仍继续，谨慎使用）
  --update-agent          更新受控端（systemd，保留原连接配置）
  --status                查看服务端/受控端状态
  --logs [行数|follow]    查看服务端日志（自动识别 systemd / Docker，默认最近 100 行）
  --uninstall             卸载服务端与受控端
  --backup [路径]         备份数据库（不指定路径则存到 /var/backups/diting/）
  --keep-days N           备份保留天数（默认 14，超出自动清理；0=不清理）
  --compress / --no-compress   是否 gzip 压缩备份（默认压缩，体积约 20%）
  --restore <路径>        从备份恢复数据库（恢复前自动备份当前状态）
  --backup-list           列出已有备份
  --backup-schedule 动作  每日自动备份：install / uninstall / status
  --process-restore       消费后台「恢复」请求（由 cron 每 5 分钟调用，勿手动执行）
  --db-stats              查看数据库统计信息
  --db-vacuum             压缩数据库（VACUUM）并启用增量回收，回收历史删除留下的空闲页
  --reset-admin-token     重置管理员 Token（丢失时使用，旧 Token 立即失效）
  --release [类型]        版本发布：patch/minor/major/具体版本号（默认 patch），打 tag 并推送
  --clear-ip-whitelist    清除管理端 IP 白名单（误配锁门时救援，改库即时生效）
  --server URL            SERVER_URL
  --id / --token          节点 ID 与令牌（手动模式）
  --token-file FILE       从文件读取令牌（推荐，避免明文暴露）
  --setup-token SECRET    用服务端 SETUP_TOKEN 自助注册（免 --id/--token）
  --setup-name NAME       自助注册的节点显示名（可选）
  --interval SEC          上报间隔（秒，默认 15）
  --probe-targets LIST    网络质量自测目标（label:host[:port] 逗号分隔；覆盖默认）
  --month-rotate N        流量重置日（0=累计口径，1–31；仅 Go 受控端，默认 0）
  --repo URL              自定义 raw 仓库地址（默认本项目 master 分支）
EOF
}

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

# ── 受控端安装 ─────────────────────────────────────────────────────────────────
install_agent() {
    ensure_deps || exit 1
    local args=()
    [[ -n "$A_SERVER" ]]     && args+=(--server "$A_SERVER")
    [[ -n "$A_ID" ]]         && args+=(--id "$A_ID")
    [[ -n "$A_TOKEN" ]]      && args+=(--token "$A_TOKEN")
    [[ -n "$A_TOKEN_FILE" ]] && args+=(--token-file "$A_TOKEN_FILE")
    [[ -n "$A_SETUP" ]]      && args+=(--setup-token "$A_SETUP")
    [[ -n "$A_SETUP_NAME" ]] && args+=(--setup-name "$A_SETUP_NAME")
    [[ -n "$A_INTERVAL" ]]   && args+=(--interval "$A_INTERVAL")
    [[ -n "$A_PROBE_TARGETS" ]] && args+=(--probe-targets "$A_PROBE_TARGETS")
    [[ -n "$A_MONTH_ROTATE" ]] && args+=(--month-rotate "$A_MONTH_ROTATE")

    # 仓库内运行：直接复用本地 agent-go/install.sh（M3 起为 Go 版）
    if [[ -f "$SCRIPT_DIR/agent-go/install.sh" ]]; then
        echo -e "${GREEN}[OK]   使用本地 agent-go/install.sh${NC}"
        bash "$SCRIPT_DIR/agent-go/install.sh" "${args[@]}"
        return
    fi

    # 单文件 curl 场景：下载 agent 载荷到临时目录后运行（M3 起为 Go 版：
    # install.sh 自行从 GitHub Release 下载二进制并做 SHA256 校验）
    local tmp; tmp="$(mktemp -d)"
    echo -e "${YELLOW}[信息] 从 ${REPO_RAW}/agent-go 下载受控端载荷（Go 版）…${NC}"
    # L-6：可用 SP_AGENT_GO_SKIP_SHA256=0 且 release 附带 .sha256 时由 install.sh 强制校验
    if ! download_list "$REPO_RAW/agent-go" "$tmp" "install.sh uninstall.sh diting-agent.service"; then
        echo -e "${RED}[错误] 下载受控端载荷失败${NC}" >&2
        rm -rf "$tmp"; exit 1
    fi
    chmod +x "$tmp/install.sh"
    bash "$tmp/install.sh" "${args[@]}"
    rm -rf "$tmp"
}

# ── 基础工具保障（curl / git 等一键流程前置依赖）─────────────────────────────────
ensure_deps() {
    local missing=()
    for t in curl git; do
        command -v "$t" >/dev/null 2>&1 || missing+=("$t")
    done
    [[ ${#missing[@]} -eq 0 ]] && return 0
    echo -e "${YELLOW}[信息] 缺少基础工具 ${missing[*]}，尝试安装…${NC}"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y "${missing[@]}"
    elif command -v dnf >/dev/null 2>&1; then
        dnf -y install "${missing[@]}"
    elif command -v yum >/dev/null 2>&1; then
        yum -y install "${missing[@]}"
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache "${missing[@]}"
    else
        echo -e "${RED}[错误] 无法安装基础工具 ${missing[*]}，请手动安装后重试${NC}" >&2
        return 1
    fi
    for t in "${missing[@]}"; do
        command -v "$t" >/dev/null 2>&1 || { echo -e "${RED}[错误] ${t} 安装失败${NC}" >&2; return 1; }
    done
    return 0
}

# ── 启动并确认 Docker 守护进程真正就绪（含 containerd / socket activation 兜底）──
# 先确保容器运行时 containerd 健康：若 overlayfs snapshotter 的元数据目录缺失
# （如曾被手动清理后残留的 containerd 进程未重建），build 阶段会报
# "failed to open database file: .../io.containerd.snapshotter.v1.overlayfs/metadata.db"
start_docker_daemon() {
    local i
    # 拉起并等待 containerd 重建 snapshotter 元数据目录
    systemctl restart containerd 2>/dev/null || true
    for i in $(seq 1 8); do
        [ -d /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs ] && break
        sleep 1
    done
    systemctl enable docker 2>/dev/null || true
    systemctl start docker 2>/dev/null || true
    for i in $(seq 1 10); do
        docker info >/dev/null 2>&1 && return 0
        sleep 2
    done
    # 部分环境 docker.service 走 socket activation 会报
    # "no sockets found via socket activation"，禁用 socket 后直启 service 即可
    systemctl disable docker.socket 2>/dev/null || true
    systemctl stop docker.socket 2>/dev/null || true
    systemctl restart containerd 2>/dev/null || true
    systemctl restart docker 2>/dev/null || true
    for i in $(seq 1 10); do
        docker info >/dev/null 2>&1 && return 0
        sleep 2
    done
    return 1
}

# ── Docker 保障 ────────────────────────────────────────────────────────────────
ensure_docker() {
    # 客户端已装时，先尝试拉起守护进程，避免无谓重装
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then
        start_docker_daemon && return 0
    fi
    # 官方安装脚本依赖 curl，确保基础工具就绪
    command -v curl >/dev/null 2>&1 || ensure_deps || true
    echo -e "${YELLOW}[信息] 未检测到可用的 Docker（含 compose/buildx），开始安装…${NC}"

    if command -v apt-get >/dev/null 2>&1; then
        # 部分基础镜像（如 Debian 13 trixie）会预装与 Docker 官方包冲突的
        # docker.io / docker-buildx / containerd / runc：必须先移除，否则
        # docker-buildx-plugin 因文件冲突无法安装，最终 compose build 会报
        # 「requires buildx 0.17.0 or later」。
        apt-get remove -y docker.io docker-buildx docker-compose containerd runc 2>/dev/null || true
        curl -fsSL https://get.docker.com | sh
    elif command -v dnf >/dev/null 2>&1; then
        dnf -y install docker-ce docker-ce-cli docker-compose-plugin docker-buildx-plugin
    elif command -v yum >/dev/null 2>&1; then
        yum -y install docker-ce docker-ce-cli docker-compose-plugin docker-buildx-plugin
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache docker docker-cli-compose
    else
        echo -e "${YELLOW}[警告] 无法用包管理器安装 Docker，回退到官方安装脚本（第三方）${NC}"
        curl -fsSL https://get.docker.com | sh
    fi

    # 兜底：buildx 偶发未装上时显式补装（需先移除 Debian 自带的 docker-buildx）
    if ! docker buildx version >/dev/null 2>&1; then
        apt-get remove -y docker-buildx 2>/dev/null || true
        ( command -v apt-get >/dev/null 2>&1 && apt-get install -y docker-buildx-plugin ) \
          || ( command -v dnf     >/dev/null 2>&1 && dnf -y install docker-buildx-plugin ) \
          || ( command -v yum     >/dev/null 2>&1 && yum -y install docker-buildx-plugin ) \
          || true
    fi

    start_docker_daemon || true

    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        return 0
    fi
    echo -e "${RED}[错误] Docker 安装失败或守护进程无法启动，请手动排查后重试${NC}" >&2
    return 1
}

# ── 服务端监听端口 ─────────────────────────────────────────────────────────────
# 端口属于"宿主侧参数"：容器按创建时的 ports: 发布，容器内换端口后宿主没有对应发布，
# 外部连不上。因此端口只能由安装器决定（对齐 komari 把端口写进 systemd ExecStart），
# 而网页向导只做只读展示。
#   --port N        显式指定（CI/批量部署）
#   已有 .env     沿用现值，避免重跑安装把端口改回 8081
#   交互 TTY       提示输入，回车取 8081
#   非交互         回落 8081
resolve_server_port() {
    local input="${A_SERVER_PORT:-}"
    if [[ -z "$input" && -f "$SRC_DIR/server/.env" ]]; then
        input="$(sed -n 's/^PORT=//p' "$SRC_DIR/server/.env" 2>/dev/null | tr -d '\r\n')"
        [[ -n "$input" ]] && { echo "$input"; return 0; }
    fi
    if [[ -z "$input" ]]; then
        if [[ -t 0 ]]; then
            read -r -p "监听端口 [8081]: " input || true
            input="${input:-8081}"
        else
            input=8081
        fi
    fi
    if ! [[ "$input" =~ ^[0-9]+$ ]] || (( input < 1 || input > 65535 )); then
        echo -e "${RED}[错误] 端口需为 1-65535 的整数，收到：${input}${NC}" >&2
        return 1
    fi
    echo "$input"
}

# ── 服务端安装 ─────────────────────────────────────────────────────────────────
install_server() {
    ensure_deps || exit 1
    ensure_docker || exit 1

    if ! command -v git >/dev/null 2>&1; then
        echo -e "${YELLOW}[信息] 未检测到 git，尝试安装…${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq && apt-get install -y git
        elif command -v dnf >/dev/null 2>&1; then
            dnf -y install git
        elif command -v yum >/dev/null 2>&1; then
            yum -y install git
        elif command -v apk >/dev/null 2>&1; then
            apk add --no-cache git
        fi
    fi
    if ! command -v git >/dev/null 2>&1; then
        echo -e "${RED}[错误] 需要 git 才能拉取服务端源码（且无法自动安装）${NC}" >&2
        exit 1
    fi

    if [[ -d "$SRC_DIR/.git" ]]; then
        echo -e "${YELLOW}[信息] 更新已有源码到 ${REPO_BRANCH}…${NC}"
        sync_source_ref || { echo -e "${RED}[错误] 同步源码失败（分支/tag 不存在或无网络？）: ${REPO_BRANCH}${NC}" >&2; return 1; }
    else
        echo -e "${YELLOW}[信息] 克隆服务端源码（${REPO_BRANCH}）到 $SRC_DIR …${NC}"
        git clone --depth 1 -b "$REPO_BRANCH" "$REPO_GIT" "$SRC_DIR" \
            || { echo -e "${RED}[错误] 克隆失败：分支/tag ${REPO_BRANCH} 不存在或无网络${NC}" >&2; return 1; }
    fi

    cd "$SRC_DIR/server"

    # 存量重装/升级路径：compose 已不注入 ADMIN_TOKEN，停容器前把 .env 明文迁成哈希入库。
    # 全新安装没有库，函数自行跳过。
    migrate_env_admin_token

    # 卸载重装防坑提示：数据卷/.env 残留凭据时，本次启动即为「已安装」态，
    # 安装向导不会再出现。存量升级本就依赖该行为，但卸载重装的用户预期是
    # 全新安装——把状态显式讲出来，并给出走向导 / 换 Token 两条出路。
    if db_admin_token_exists; then
        echo -e "${YELLOW}[提示] 检测到既有管理员凭据（数据库哈希，可能来自上次部署残留或 .env 迁移）。${NC}"
        echo -e "       本次为「复用/升级」模式：安装向导不会出现，请用原 Token 登录。"
        echo -e "       需要全新安装（重新走向导）：sudo bash diting.sh --uninstall，卸载时选择清除凭据。"
        echo -e "       仅更换 Token：sudo bash diting.sh --reset-admin-token"
    fi

    local port
    port="$(resolve_server_port)" || return 1
    echo -e "${GREEN}[OK]   监听端口：${port}${NC}"

    if [[ ! -f .env ]]; then
        cp .env.example .env
        local sess setup
        sess="$(openssl rand -hex 32)"
        setup="$(openssl rand -hex 16)"
        sed -i "s#^PORT=.*#PORT=${port}#" .env
        sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=${sess}#" .env
        sed -i "s#^SETUP_TOKEN=.*#SETUP_TOKEN=${setup}#" .env
        # 管理员凭据不预生成：由浏览器 /install 向导创建（对齐 komari），库中只存 sha256 哈希，
        # 明文只在向导完成页显示一次。预生成会让"未安装"判据恒为 false，
        # 安装向导永远不会出现 —— 这正是旧版首装不弹引导的原因。
        sed -i "s#^ADMIN_TOKEN=.*#ADMIN_TOKEN=#" .env
        echo -e "${GREEN}[OK]   已生成 SESSION_SECRET / SETUP_TOKEN${NC}"
        echo -e "${YELLOW}[重要] SETUP_TOKEN = ${setup}${NC}"
        echo -e "${YELLOW}        受控端一键注册请用: --setup-token ${setup}${NC}"
        echo -e "${YELLOW}        管理员 Token 不预生成：请在浏览器打开安装向导创建（只显示一次）${NC}"
    else
        # 存量部署：既有凭据一律保留（可能已有可用的 ADMIN_TOKEN），
        # 仅在 --port 显式指定或缺失 PORT 时同步端口，绝不覆盖凭据。
        if grep -q '^PORT=' .env; then
            sed -i "s#^PORT=.*#PORT=${port}#" .env
        else
            printf 'PORT=%s\n' "$port" >> .env
        fi
        echo -e "${GREEN}[OK]   已存在 .env：凭据保持不变，PORT=${port}${NC}"
    fi

    echo -e "${YELLOW}[信息] 构建并启动服务端（首次需编译 better-sqlite3，约 1-2 分钟）…${NC}"
    # 写入构建时间与 commit hash（供页脚显示）
    date +"%Y-%m-%d %H:%M:%S (%Z)" > build_time.txt
    git rev-parse --short HEAD > git_hash.txt 2>/dev/null || echo "-" > git_hash.txt
    echo -e "${GREEN}[OK]   构建时间已写入 build_time.txt${NC}"
    # 先清理本项目旧实例，避免重跑/升级时端口或容器冲突（端口可能已被旧容器占用）
    docker compose down 2>/dev/null || true
    docker compose up -d --build

    # L-15：写入 /etc/diting/host.env 骨架，避免「备份可见目录未配」
    # 导致 --process-restore 静默退化到 /restore.request（:982 的兜底路径）。
    # 已存在则完全不覆盖（用户可能已填过真实路径），仅提示。
    local host_env="/etc/diting/host.env"
    if [[ -f "$host_env" ]]; then
        echo -e "${YELLOW}[信息] $host_env 已存在，保持原内容不变${NC}"
    else
        mkdir -p /etc/diting 2>/dev/null || true
        cat > "$host_env" <<'HOSTENV'
# Diting 宿主侧环境（由 diting.sh --install-server 生成的骨架）
# 被 diting.sh 自身与 cron 行 source；改完即时生效，无需重启服务端。
#
# 备份可见目录：宿主侧的备份存放路径。服务端容器通过 HOST_BACKUP_DIR
# 挂载同一目录，后台才能在「备份」页列出/下载/恢复备份文件。
# 留空会导致 --process-restore 退化为读取 /restore.request。
BACKUP_VISIBLE_DIR=/var/backups/diting
# 恢复请求文件：后台点「恢复」时写入，由 cron 每 5 分钟轮询消费。
RESTORE_REQUEST_FILE=/var/backups/diting/restore.request

# 让服务端容器能看到上述目录（compose 用它做 bind mount）。
HOST_BACKUP_DIR=/var/backups/diting
HOSTENV
        echo -e "${GREEN}[OK]   已生成 $host_env（请按需修改 BACKUP_VISIBLE_DIR）${NC}"
        echo -e "       如需后台可见备份，请确保 docker-compose 挂载 HOST_BACKUP_DIR"
    fi

    echo ""
    echo -e "${GREEN}✅ 服务端已启动${NC}"
    echo -e "   本机端口: 127.0.0.1:${port}（仅回环，明文测试用）"
    echo -e ""
    echo -e "${YELLOW}   ▸ 下一步：在浏览器完成安装向导${NC}"
    echo -e "     未配反代:  ssh -L ${port}:127.0.0.1:${port} <user>@<本机>  然后打开 http://127.0.0.1:${port}/install"
    echo -e "     （向导里填写站点名称/描述/上报地址，并生成管理员 Token —— 只显示一次）"
    echo -e ""
    echo -e "   生产请将 Nginx + TLS 反代到 127.0.0.1:${port}（见 README 部署章节）"
    echo -e "   Nginx upstream 需与端口一致：proxy_pass http://127.0.0.1:${port};"
}

# ── 更新：本安装脚本自身 ──────────────────────────────────────────────────────
update_script() {
    ensure_deps || return 1
    echo -e "${YELLOW}[信息] 下载最新 diting.sh…${NC}"
    local new; new="$(mktemp)"
    # L-6：若设置了 SP_INSTALL_SHA256（已知良好版本的哈希），下载后强制校验，
    # 防止 GitHub CDN / 中间人投毒。用法：SP_INSTALL_SHA256=xxxx sudo bash diting.sh --update-script
    if ! download "$REPO_RAW/diting.sh" "$new" "${SP_INSTALL_SHA256:-}"; then
        echo -e "${RED}[错误] 下载 diting.sh 失败${NC}" >&2; rm -f "$new"; return 1
    fi
    # 安全闸：下载到的脚本若语法校验不通过，绝不覆盖当前可用脚本
    if ! bash -n "$new" >/dev/null 2>&1; then
        echo -e "${RED}[错误] 下载到的 diting.sh 语法校验未通过，已放弃覆盖，当前脚本保持不变${NC}" >&2
        rm -f "$new"; return 1
    fi
    # L-17：把本次下载文件的 SHA256 打印出来，便于用户留档 / 在 Release notes 核对。
    # 未设 SP_INSTALL_SHA256 时 download() 不做校验（静默跳过），此处输出是唯一的
    # 事后可追溯点 —— 机制已备，剩余价值在于「可见可复制」。
    local _sha
    _sha="$(sha256_of "$new" 2>/dev/null || true)"
    if [[ -n "$_sha" ]]; then
        echo -e "${BLUE}[信息] 本次下载 diting.sh SHA256:${NC} ${_sha}"
        echo -e "       如需强校验，下次可执行：SP_INSTALL_SHA256=${_sha} sudo bash diting.sh --update-script"
    fi
    # 展示版本变化与新版要点，让用户直观了解本次更新内容
    local newver newnotes
    newver="$(grep -m1 '^SCRIPT_VERSION=' "$new" | sed -E 's/^SCRIPT_VERSION="?([^"]*)"?.*/\1/')"
    newnotes="$(grep -m1 '^SCRIPT_NOTES=' "$new" | sed -E 's/^SCRIPT_NOTES="?([^"]*)"?.*/\1/')"
    if [[ -n "$newver" ]]; then
        if version_gt "$newver" "$SCRIPT_VERSION"; then
            echo -e "${GREEN}[更新] v${SCRIPT_VERSION} → v${newver}${NC}"
        elif [[ "$newver" == "$SCRIPT_VERSION" ]]; then
            echo -e "${YELLOW}[信息] 远端版本与当前一致 (v${SCRIPT_VERSION})，仍将覆盖为最新文件${NC}"
        fi
        [[ -n "$newnotes" ]] && echo -e "       要点: ${newnotes}"
    fi
    # 覆盖目标：优先原地更新当前脚本；当前脚本不可写（如从只读介质/管道运行）
    # 时退到 PATH 里的安装位置。
    # 注意：这里曾写成 diting-diting.sh（simple-probe.sh → diting.sh 全局重命名
    # 留下的双重前缀），导致兜底路径不存在、cp 直接失败。
    local target
    if [[ -f "$0" && -w "$(dirname "$0")" ]]; then
        target="$(realpath "$0")"
    elif [[ -f "$SRC_DIR/diting.sh" && -w "$SRC_DIR" ]]; then
        target="$SRC_DIR/diting.sh"
    else
        target="/usr/local/bin/diting.sh"
    fi
    cp "$new" "$target"
    chmod +x "$target"
    rm -f "$new"
    echo -e "${GREEN}[OK]   已更新脚本: $target${NC}"
    echo -e "${YELLOW}[提示] 请使用更新后的脚本重新运行: sudo bash $target${NC}"
}

# ── 更新：服务端（拉取最新源码并重建容器）─────────────────────────────────────
# 升级失败（构建失败 / 容器起不来）时的回滚提示：代码与数据分别给一条可复制命令。
_upgrade_rollback_hint() {
    local old="$1" bak="$2"
    echo -e "${YELLOW}       回滚建议：${NC}" >&2
    if [[ -n "$bak" && -f "$bak" ]]; then
        echo -e "       数据: sudo bash diting.sh --restore ${bak}" >&2
    fi
    if [[ -n "$old" ]]; then
        echo -e "       代码: git -C ${SRC_DIR} reset --hard ${old} && cd ${SRC_DIR}/server && docker compose up -d --build" >&2
    else
        echo -e "       代码: 重新运行 sudo bash diting.sh --install-server（或用 --release 指定上一版本）" >&2
    fi
}

update_server() {
    ensure_docker || return 1
    if ! command -v git >/dev/null 2>&1; then
        echo -e "${YELLOW}[信息] 未检测到 git，尝试安装…${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq && apt-get install -y git
        elif command -v dnf >/dev/null 2>&1; then dnf -y install git
        elif command -v yum >/dev/null 2>&1; then yum -y install git
        elif command -v apk >/dev/null 2>&1; then apk add --no-cache git
        fi
    fi
    if ! command -v git >/dev/null 2>&1; then
        echo -e "${RED}[错误] 需要 git 才能更新服务端${NC}" >&2; return 1
    fi
    if [[ ! -d "$SRC_DIR/server" ]]; then
        echo -e "${RED}[错误] 未检测到服务端安装（缺少 $SRC_DIR/server），请先「安装服务端」${NC}" >&2
        return 1
    fi

    if [[ -d "$SRC_DIR/.git" ]]; then
        echo -e "${YELLOW}[信息] 拉取最新源码并同步到 ${REPO_BRANCH}（丢弃本地对源码的改动）…${NC}"
        local _old _new
        _old="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
        sync_source_ref || { echo -e "${RED}[错误] 同步源码失败（分支/tag 不存在或无网络？）: ${REPO_BRANCH}${NC}" >&2; return 1; }
        _new="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
        # 直观展示本次拉取了哪些提交（更新内容一目了然）
        if [[ -n "$_old" && "$_old" != "$_new" ]]; then
            echo -e "${GREEN}[更新] 源码 ${_old} → ${_new}，本次变更：${NC}"
            git -C "$SRC_DIR" --no-pager log --oneline --no-decorate "${_old}..${_new}" | sed 's/^/       · /'
        elif [[ "$_old" == "$_new" ]]; then
            echo -e "${GREEN}[信息] 源码已是最新 (${_new})，无新提交${NC}"
        fi
    else
        # 早期手动拷贝部署（无 .git）：改造为 git 跟踪，便于后续一键更新；
        # .env 等未跟踪文件不会被覆盖。
        echo -e "${YELLOW}[信息] 当前为非 git 手动部署，改造为 git 跟踪以便更新…${NC}"
        git -C "$SRC_DIR" init -q
        git -C "$SRC_DIR" remote add origin "$REPO_GIT" 2>/dev/null \
          || git -C "$SRC_DIR" remote set-url origin "$REPO_GIT"
        git -C "$SRC_DIR" fetch origin "$REPO_BRANCH" -q
        git -C "$SRC_DIR" checkout -B "$REPO_BRANCH" -f FETCH_HEAD
        git -C "$SRC_DIR" branch --set-upstream-to="origin/$REPO_BRANCH" "$REPO_BRANCH" 2>/dev/null || true
    fi

    # 关键：源码已同步到最新，但当前进程仍是「旧脚本」的内存逻辑。
    # 重新执行磁盘上的最新 diting.sh，确保后续停旧容器/重建用的是最新代码，
    # 避免「拉了新代码却跑着旧脚本」导致端口冲突等问题。用 SP_REEXECED 防自循环。
    if [[ -z "${SP_REEXECED:-}" && -f "$SRC_DIR/diting.sh" ]]; then
        echo -e "${YELLOW}[信息] 重新加载磁盘上的最新 diting.sh 以应用更新…${NC}"
        # --force 必须一并传下去：新进程若丢掉该开关，备份失败时又会中止，形成"跳过不了"的怪圈
        if [[ "${A_FORCE:-0}" == "1" ]]; then
            SP_REEXECED=1 exec bash "$SRC_DIR/diting.sh" --update-server --force
        else
            SP_REEXECED=1 exec bash "$SRC_DIR/diting.sh" --update-server
        fi
    fi

    cd "$SRC_DIR/server"

    # ── 升级前备份数据库（A5）──────────────────────────────────────────────
    # 必须在 `compose down` 之前：locate_db 的 docker 分支要靠 `docker ps` 找到携带
    # server-data 卷的容器，容器停了就定位不到库，备份会直接失败。
    # 备份失败默认中止升级（源码已 reset 但容器未重建，旧容器仍在跑，损失最小）；
    # --force 可跳过。
    _init_backup_dir
    local _bak=""
    _bak="${DB_BACKUP_DIR}/monitor_$(date +%Y%m%d_%H%M%S)_pre-upgrade.db"
    echo -e "${YELLOW}[信息] 升级前备份数据库 → ${_bak}${NC}"
    if do_backup "$_bak" 0; then
        # do_backup 压缩成功后会把 <path> 换成 <path>.gz 并删除原文件，
        # 此处必须回读真实产物名，否则后面的提示与回滚命令都指向一个不存在的路径。
        [[ -f "${_bak}.gz" && ! -f "$_bak" ]] && _bak="${_bak}.gz"
        echo -e "${GREEN}[OK]   数据库已备份 → ${_bak}${NC}"
    else
        if [[ "${A_FORCE:-0}" == "1" ]]; then
            echo -e "${YELLOW}[警告] 升级前备份失败，已按 --force 继续（风险自负）${NC}"
            _bak=""
        else
            echo -e "${RED}[错误] 升级前备份失败，已中止升级（当前容器仍在运行旧版本）${NC}" >&2
            echo -e "       排查磁盘/权限后重试；确认无需备份可加 --force 跳过" >&2
            return 1
        fi
    fi

    # 密钥迁移（D7）：compose 已不再注入 ADMIN_TOKEN，停容器前先把 .env 明文转哈希入库，
    # 否则升级后服务端读不到凭据，会误判为"未安装"。
    migrate_env_admin_token

    # 先停掉旧容器并释放端口，避免「端口已被占用」导致新容器起不来
    echo -e "${YELLOW}[信息] 停止旧容器并释放端口…${NC}"
    docker compose down --remove-orphans 2>/dev/null || true
    # 兜底：端口仍被任意容器占用（孤儿容器 / 其它 compose 项目）时强制移除。
    # 端口从 .env 的 PORT 读，避免安装时选了非 8081 导致这里漏清理。
    local port _cid
    port="$(sed -n 's/^PORT=//p' .env 2>/dev/null | tr -d '\r\n')"
    port="${port:-8081}"
    _cid="$(docker ps -q --filter "publish=${port}" 2>/dev/null | head -n1)"
    if [[ -n "$_cid" ]]; then
        echo -e "${YELLOW}[信息] 检测到 ${port} 仍被容器 $_cid 占用，强制移除…${NC}"
        docker rm -f "$_cid" 2>/dev/null || true
    fi
    echo -e "${YELLOW}[信息] 重建并重启服务端…${NC}"
    date +"%Y-%m-%d %H:%M:%S (%Z)" > build_time.txt
    git rev-parse --short HEAD > git_hash.txt 2>/dev/null || echo "-" > git_hash.txt
    if ! docker compose up -d --build; then
        echo -e "${RED}[错误] 重建失败，服务端可能未启动${NC}" >&2
        _upgrade_rollback_hint "${_old:-}" "$_bak"
        return 1
    fi
    # 对齐 komari 的 active 校验：`up -d` 返回 0 只代表容器创建成功，
    # 构建失败/启动即崩溃常在几秒后才暴露，必须再确认容器真的在运行。
    local _cid2=""
    _cid2="$(docker compose ps -q server 2>/dev/null | head -n1)"
    sleep 2
    if [[ -z "$_cid2" || "$(docker inspect -f '{{.State.Running}}' "$_cid2" 2>/dev/null)" != "true" ]]; then
        echo -e "${RED}[错误] 容器未处于运行状态，升级失败${NC}" >&2
        docker compose logs --tail 30 server 2>/dev/null | sed 's/^/       /' >&2 || true
        _upgrade_rollback_hint "${_old:-}" "$_bak"
        return 1
    fi
    echo -e "${GREEN}[OK]   服务端已更新并重启${NC}"
    [[ -n "$_bak" && -f "$_bak" ]] && echo -e "       升级前备份：${_bak}"
}

# ── 更新：受控端（保留已注册身份，拉取最新 agent 代码）──────────────────────────
update_agent() {
    ensure_deps || return 1
    local envfile="/etc/diting/agent.env"
    if [[ ! -f "$envfile" ]]; then
        echo -e "${RED}[错误] 未检测到受控端安装（缺少 $envfile），请先「安装受控端」${NC}" >&2
        return 1
    fi
    # 从已存 env 读取注册身份，用户无需重新输入令牌
    local SERVER_URL="" AGENT_ID="" AGENT_TOKEN="" INTERVAL=15 PROBE_TARGETS="" MONTH_ROTATE=0 k v
    while IFS='=' read -r k v; do
        case "$k" in
            SERVER_URL)     SERVER_URL="$v" ;;
            AGENT_ID)       AGENT_ID="$v" ;;
            AGENT_TOKEN)    AGENT_TOKEN="$v" ;;
            INTERVAL)       INTERVAL="$v" ;;
            PROBE_TARGETS)  PROBE_TARGETS="$v" ;;
            MONTH_ROTATE)   MONTH_ROTATE="$v" ;;
        esac
    done < "$envfile"
    if [[ -z "$SERVER_URL" || -z "$AGENT_ID" || -z "$AGENT_TOKEN" ]]; then
        echo -e "${RED}[错误] $envfile 缺少必要参数，请重新「安装受控端」${NC}" >&2
        return 1
    fi
    echo -e "${YELLOW}[信息] 更新受控端（保留已注册身份，拉取最新 agent 代码）…${NC}"
    echo -e "  服务端: ${GREEN}$SERVER_URL${NC}  节点: ${GREEN}$AGENT_ID${NC}"

    # 强制从 GitHub 拉取最新 agent 载荷（无论本脚本是否本地旧版），保证更新到最新
    local tmp; tmp="$(mktemp -d)"
    echo -e "${YELLOW}[信息] 从 ${REPO_RAW}/agent-go 下载最新受控端载荷（Go 版）…${NC}"
    if ! download_list "$REPO_RAW/agent-go" "$tmp" "install.sh uninstall.sh diting-agent.service"; then
        echo -e "${RED}[错误] 下载受控端载荷失败${NC}" >&2
        rm -rf "$tmp"; return 1
    fi
    chmod +x "$tmp/install.sh"
    # 复用 agent-go/install.sh，传入已存身份 → 覆盖二进制与 unit 并重启服务。
    # 必须回传 PROBE_TARGETS 与 MONTH_ROTATE：install.sh 仅在显式传参时才写这些键，
    # 否则更新后用户自定义的探测目标 / 流量重置日会被覆盖丢失。
    local -a re_args=(--server "$SERVER_URL" --id "$AGENT_ID" --token "$AGENT_TOKEN" --interval "$INTERVAL" --month-rotate "${MONTH_ROTATE:-0}")
    [[ -n "$PROBE_TARGETS" ]] && re_args+=(--probe-targets "$PROBE_TARGETS")
    bash "$tmp/install.sh" "${re_args[@]}"
    rm -rf "$tmp"
    echo -e "${GREEN}[OK]   受控端已更新并重启${NC}"
}

# ── 状态 / 卸载 ────────────────────────────────────────────────────────────────
status_all() {
    echo "$(msg "status.server_header")"
    local running=0 installed=0
    if ( cd "$SRC_DIR/server" && docker compose ps --filter status=running -q 2>/dev/null ) | grep -q .; then
        running=1
        ( cd "$SRC_DIR/server" && docker compose ps --format '  {{.Name}}  {{.Status}}' )
    fi
    [[ -d "$SRC_DIR/server" ]] && installed=1
    if [[ $running -eq 0 && $installed -eq 1 ]]; then
        echo "$(msg "status.server_not_running"), or: cd $SRC_DIR/server && docker compose up -d"
    elif [[ $running -eq 0 && $installed -eq 0 ]]; then
        echo "$(msg "status.server_not_installed")"
    fi
    echo "$(msg "status.agent_header")"
    if systemctl list-unit-files diting-agent.service >/dev/null 2>&1; then
        if systemctl is-active --quiet diting-agent; then
            echo "$(msg "status.agent_active")"
        else
            echo "$(msg "status.agent_inactive")"
        fi
    else
        echo "$(msg "status.agent_not_installed")"
    fi
}

# ── 数据库备份 / 恢复 / 管理 ─────────────────────────────────────────────────
# 服务端数据库路径：Docker 部署在命名卷 server-data 内（容器内 /data/monitor.db）；
# 原生/开发态在 $SRC_DIR/server/data/monitor.db。
# 备份原则：SQLite 单文件即全量，但必须通过 .backup 命令或停服后 cp，避免写坏。
# 备份目录：留空表示"按部署形态自动判定"，由 _init_backup_dir 在真正用到时计算
# （Docker → 宿主 /var/backups/diting；原生 → 与 server/.env 的 BACKUP_DIR 对齐）。
# 显式传 DB_BACKUP_DIR=/path 时以传入值为准。
DB_BACKUP_DIR="${DB_BACKUP_DIR:-}"
# 备份保留天数（默认 14）。超出时「自动备份」会清理最旧的 monitor_*.db；
# =0 关闭清理（永不自动删除）。可用 --keep-days N 覆盖，或环境变量 DB_BACKUP_KEEP_DAYS。
DB_BACKUP_KEEP_DAYS="${DB_BACKUP_KEEP_DAYS:-14}"
# 备份保留份数（F8.4，默认 10，0 = 不限）。与「保留天数」并存：先按天清理，
# 再按份数兜底 —— 天数管不住「一天手动点很多次」或「上传件堆积」，份数能兜住。
# 只作用于 monitor_*（含上传件：统一归一化为该前缀）；pre_restore_* 是恢复回滚点，
# 按既有约定不自动清理。
DB_BACKUP_KEEP_COUNT="${DB_BACKUP_KEEP_COUNT:-10}"
# 是否压缩备份（gzip，默认开）。SQLite 逐页拷贝会带上已删数据留下的空闲页，
# 且内容为高重复数值，实测可压到原体积约 20%（1.5G → ~300M），是控制占用最有效的手段。
# 关闭：DB_BACKUP_COMPRESS=0 或 --no-compress（环境无 gzip 时自动跳过）。
DB_BACKUP_COMPRESS="${DB_BACKUP_COMPRESS:-1}"

# 定位数据库：返回「容器名:容器内路径」或「宿主机文件路径」；找不到则返回空。
locate_db() {
    # 最高优先：.env 里的 DB_PATH —— 原生/systemd 部署（非 Docker）走这条，
    # 数据库常在仓库外（如 /data/simple-probe-data/server-data/monitor.db），
    # 仅靠下面的固定回退路径找不到。
    # 依次尝试：$SRC_DIR（部署路径，VPS 上为 /opt/diting-src）、脚本自身所在目录、
    # 当前工作目录 —— 本机直接从仓库跑脚本时 SRC_DIR 并不存在，必须靠后两者。
    local cand env_db="" selfdir
    selfdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || echo "")"
    for cand in "$SRC_DIR/server/.env" "$selfdir/server/.env" "./server/.env"; do
        [[ -n "$cand" && -f "$cand" ]] || continue
        env_db="$(sed -n 's/^[[:space:]]*DB_PATH[[:space:]]*=[[:space:]]*//p' "$cand" | tail -n1)"
        env_db="${env_db%\"}"; env_db="${env_db#\"}"; env_db="${env_db%\'}"; env_db="${env_db#\'}"
        env_db="${env_db%%[[:space:]]*}"
        if [[ -n "$env_db" && -f "$env_db" ]]; then
            echo "file:$env_db"
            return
        fi
    done
    # 其次：Docker 命名卷（server-data）
    # compose v2 会把卷命名为「<项目名>_server-data」（项目名默认取 compose 文件所在目录名，
    # 本仓库的 compose 在 server/ 下 → server_server-data）。只认裸名 server-data 会让
    # **所有 Docker 形态的库操作**（升级前备份、Token 迁移、重置、备份保留天数）全部落空，
    # 且调用点多带 `2>/dev/null || true`，故障是静默的。因此这里做三级解析：
    #   ① 裸名（早期手工 docker volume create 的部署）
    #   ② 任意项目前缀：<任意>_server-data
    local vol=""
    for cand in "server-data" "server_server-data"; do
        docker volume inspect "$cand" >/dev/null 2>&1 && { vol="$cand"; break; }
    done
    if [[ -z "$vol" ]]; then
        vol="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|_)server-data$' | head -n1)"
    fi
    if [[ -n "$vol" ]]; then
        # 找挂载该卷且当前运行中的容器（compose 项目名不确定，按卷反查容器）
        local cid
        cid="$(docker ps -q --filter "volume=$vol" 2>/dev/null | head -n1)"
        if [[ -n "$cid" ]]; then
            # 取 compose 服务名（默认 server）
            local svc
            svc="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$cid" 2>/dev/null)"
            svc="${svc:-server}"
            echo "docker:${cid}:${svc}:/data/monitor.db"
            return
        fi
        # 卷存在但容器未运行：回退到 docker run --rm 临时挂载拷贝
        echo "volume:$vol"
        return
    fi
    # 回退：宿主机本地文件
    if [[ -f "$SRC_DIR/server/data/monitor.db" ]]; then
        echo "file:$SRC_DIR/server/data/monitor.db"
        return
    fi
    echo ""
}

# 解析备份目录：脚本与服务端**必须指向同一个目录**，否则后台「备份」页看不到 CLI 产物。
#   Docker：库在命名卷里，`.env` 的 BACKUP_DIR 是容器内路径（/data/backups），宿主侧固定用它；
#   原生  ：服务端与本脚本同机，`.env` 的 BACKUP_DIR 就是宿主路径，两边必须一致。
# 本机就踩过：CLI 写 /var/backups/diting，服务端读 /opt/diting-backups（目录不存在），
# 后台接口返回 {"available":false,"files":[]}，用户以为备份丢了。
# 需要 locate_db，故不能在脚本顶层调用，只能由各入口函数触发。
_init_backup_dir() {
    [[ -n "${_BACKUP_DIR_READY:-}" ]] && return 0
    _BACKUP_DIR_READY=1
    # 显式传入的 DB_BACKUP_DIR 优先（运维覆盖 / 测试）
    [[ -n "${DB_BACKUP_DIR:-}" ]] && return 0
    local loc envf="" val cand selfdir
    loc="$(locate_db 2>/dev/null)"
    if [[ "$loc" == docker:* ]]; then
        DB_BACKUP_DIR="/var/backups/diting"
        return 0
    fi
    # 与 locate_db 同一套候选：部署路径 → 脚本所在目录 → 当前目录
    # （本机就是从仓库直跑脚本，$SRC_DIR 并不存在，只能靠后两者）
    selfdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
    for cand in "${SRC_DIR:-}/server/.env" "${selfdir}/server/.env" "./server/.env"; do
        [[ -n "$cand" && -f "$cand" ]] && { envf="$cand"; break; }
    done
    if [[ -n "$envf" ]]; then
        val="$(sed -n 's/^BACKUP_DIR=//p' "$envf" 2>/dev/null | tr -d '\r\n' | head -1)"
        [[ -n "$val" && "$val" == /* ]] && DB_BACKUP_DIR="$val"
    fi
    DB_BACKUP_DIR="${DB_BACKUP_DIR:-/var/backups/diting}"
    return 0
}

# 原生 systemd 部署下服务端的运行用户（Docker / root 跑时返回空）。
# 备份目录与备份文件都是 root 建的（0600），而服务端常以普通用户运行 →
# 后台「上传」写不进、「下载」也读不了。拿到用户后脚本会 chown 目录与产物。
server_run_user() {
    local u
    u="$(systemctl show diting-server -p User --value 2>/dev/null | tr -d '\r\n')"
    if [[ -n "$u" && "$u" != "root" ]]; then
        echo "$u"
    fi
}

# ── 管理员凭据残留检测/清除（卸载重装防坑）────────────────────────────────
# 坑的成因：安装向导的触发判据是「库中无 admin_token_hash」。卸载只删容器，
# 数据卷与 .env 都会保留；重装时 migrate_env_admin_token 又把 .env 明文迁回库，
# 结果「已安装」判据恒为真 → 安装向导永远不会出现（用户预期却是全新安装）。
# 这两个助手供 uninstall_all / install_server 显式检测与清除，把状态讲给用户。

# 库中管理员凭据哈希的三态探测：输出 HAS / ABSENT / UNKNOWN。
# 为什么不是布尔：检测本身可能失败（无库、无表、无镜像、无 node），此时既不能
# 断言"有"、也不能断言"无"——卸载场景若误报"无残留"，恰好会给用户一个与实际
# 相反的安全承诺。只把 HAS/ABSENT 当作可信结论，UNKNOWN 降级为"请手动确认"。
# 判据与服务端 hasAdminToken 对齐：只认 64 位 hex 哈希，脏值/历史明文不算
# （库中若是脏值，服务端仍判定未安装并出现向导，脚本不能谎称"已安装"）。
db_admin_token_probe() {
    local js out
    js="$(mktemp)"
    cat > "$js" <<'JS'
const db = new (require('better-sqlite3'))(process.argv[2]);
const r = db.prepare("SELECT value FROM admin_config WHERE key='admin_token_hash'").get();
const ok = !!(r && r.value && /^[0-9a-f]{64}$/.test(String(r.value)));
console.log(ok ? 'ADMIN_TOKEN_HASH_PRESENT' : 'ADMIN_TOKEN_HASH_ABSENT');
db.close();
JS
    if ! out="$(db_run_js "$js" 2>/dev/null)"; then
        rm -f "$js"
        echo 'UNKNOWN'
        return 0
    fi
    rm -f "$js"
    if [[ "$out" == *ADMIN_TOKEN_HASH_PRESENT* ]]; then echo 'HAS'; else echo 'ABSENT'; fi
}

# 布尔封装（供 install_server 的提示分支使用）：HAS 才为真，ABSENT/UNKNOWN 皆假。
db_admin_token_exists() {
    [[ "$(db_admin_token_probe)" == 'HAS' ]]
}

# 只清除「管理员凭据」（库哈希 + 历史残留键 + .env 的 ADMIN_TOKEN 行）并吊销
# 全部旧会话（与 --reset-admin-token 同口径：水位线最先写，旧 Cookie 立即失效），
# 刻意不动节点指标/配置与 SESSION_SECRET/SETUP_TOKEN——
# 清凭据 ≠ 清数据，受控端一键注册等其余凭据保持有效。
purge_admin_credentials() {
    local js out rc=0 envc
    # 无库（如用户已手动 docker compose down -v）时只清 .env，不算失败：
    # "清凭据"的目标状态是「库无哈希 + .env 无明文」，没有库时后者即达成。
    if [[ -n "$(locate_db 2>/dev/null)" ]]; then
        js="$(mktemp)"
        cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
db.pragma('busy_timeout = 5000');
const now = String(Date.now());
const tx = db.transaction(() => {
  // 水位线必须最先写：verifySession 在 sid 缓存之前调 isRevoked，且 isRevoked
  // 每次读库，因此旧 Cookie 立即失效（不依赖进程内 clearSessionCache）。
  db.prepare("INSERT OR REPLACE INTO admin_config(key,value) VALUES('session_revoked_before',?)").run(now);
  db.prepare('UPDATE sessions SET revoked=1 WHERE revoked=0').run();
  db.prepare("DELETE FROM admin_config WHERE key IN ('admin_token_hash','admin_token_raw','admin_initialized')").run();
});
tx();
// 写后校验（对齐 --reset-admin-token 的 HASH_OK 自检）：哈希必须已消失
const left = db.prepare("SELECT value FROM admin_config WHERE key='admin_token_hash'").get();
console.log('PURGED_OK=' + (left && left.value ? '0' : '1'));
db.close();
JS
        out="$(db_run_js "$js")" || rc=1
        rm -f "$js"
        if [[ $rc -eq 0 && "$out" == *'PURGED_OK=1'* ]]; then
            echo -e "${GREEN}[OK]   已清除库中的管理员凭据并吊销旧会话（节点数据保留）${NC}"
        else
            rc=1
            echo -e "${RED}[错误] 清除库中凭据失败或校验未通过，请按上方错误信息排查${NC}" >&2
        fi
    else
        echo "  未定位到数据库（可能已被手动清除），跳过库操作"
    fi
    # .env 明文一并清空：否则下次启动 initAdminToken 又会把它迁回库。
    # 路径复用 locate_server_env 的三候选口径（与 locate_db 一致），
    # 避免从仓库内直接跑脚本（selfdir/./server/.env）时漏清。
    envc="$(locate_server_env 2>/dev/null || true)"
    if [[ -n "$envc" ]]; then
        sed -i 's/^ADMIN_TOKEN=.*/ADMIN_TOKEN=/' "$envc"
        echo -e "${GREEN}[OK]   已清空 .env 的 ADMIN_TOKEN 行（$envc）${NC}"
    fi
    return $rc
}

# 把 .env 里的明文 ADMIN_TOKEN 迁进库（只存哈希）。
# 为什么安装器要做：compose 不再注入 ADMIN_TOKEN 之后，服务端启动读不到 env，
# 存量实例升级时会直接掉进"未安装"态（全站 307 到 /install）。所以在停容器之前，
# 先把明文转成哈希写库；库里已有哈希则原样跳过（幂等）。
# 明文不上命令行：哈希在 bash 侧算好，传给 node 的只有摘要。
migrate_env_admin_token() {
    local envf="$SRC_DIR/server/.env" admin hash js out
    [[ -f "$envf" ]] || return 0
    admin="$(sed -n 's/^ADMIN_TOKEN=//p' "$envf" 2>/dev/null | tr -d '\r\n' | head -1 || true)"
    [[ -n "$admin" ]] || return 0
    (( ${#admin} >= 16 )) || return 0            # 占位符/过短不迁，交给 /install 生成
    [[ -n "$(locate_db 2>/dev/null)" ]] || return 0
    hash="$(printf '%s' "$admin" | sha256sum | cut -d' ' -f1)"
    js="$(mktemp --suffix=.js)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
const hash = process.argv[3];
const cur = db.prepare("SELECT value FROM admin_config WHERE key='admin_token_hash'").get();
if (cur && cur.value) { console.log('SKIP_HAS_HASH'); db.close(); process.exit(0); }
db.prepare("INSERT OR REPLACE INTO admin_config (key,value) VALUES ('admin_token_hash', ?)").run(hash);
db.close();
console.log('MIGRATED');
JS
    out="$(db_run_js "$js" "$hash" 2>&1)"; rm -f "$js"
    if [[ "$out" == *MIGRATED* ]]; then
        echo -e "${GREEN}[OK]   已把 .env 的管理员 Token 迁入数据库（只存哈希）${NC}"
    fi
    return 0
}

# 只有数据库位于 Docker 命名卷时才要求 Docker。
# 原生（systemd）部署的库是宿主机文件，db_run_js / locate_db 都有 file 分支，
# 旧实现在 do_backup / do_restore / do_db_stats / do_clear_ip_whitelist 入口
# 无条件 ensure_docker —— 没装 Docker 的原生用户连备份、恢复、清白名单都跑不了
# （而这几条恰是出问题时最需要的命令）。
ensure_docker_if_volume() {
    local loc
    loc="$(locate_db 2>/dev/null)"
    if [[ "$loc" == docker:* ]]; then
        ensure_docker || return 1
    fi
    return 0
}

# 备份数据库：通过 docker exec 调用 sqlite3 .backup 保证一致性（WAL 检查点 +
# 事务合并到主库），不依赖停服；无 sqlite3 时回退到 cp（需先停容器防写坏）。
# 用法：do_backup [输出路径] [保留天数]
do_backup() {
    _init_backup_dir
    local out_path="${1:-}"
    local keep_days="${2:-}"
    local started; started="$(date +%s%3N 2>/dev/null || echo "$(date +%s)000")"

    # ── 后台周期策略（--force 或未指定 ACTION 的手动调用都跳过此判断）──────
    # 仅当「由 cron/自动路径调用」时才按后台配置的周期决定是否执行：
    # 手动敲 --backup 必须始终生效，否则用户会以为功能坏了。
    if [[ "${BACKUP_AUTO:-}" == "1" ]]; then
        local decision
        decision="$(backup_should_run)"
        if [[ "$decision" == "skipped" ]]; then
            echo -e "${YELLOW}[信息] 按后台配置跳过本次备份${NC}"
            return 0
        fi
        # 读到配置时，用后台的保留天数/压缩开关覆盖本地默认
        if [[ "$decision" == "yes" ]]; then
            local cfg_keep cfg_comp
            cfg_keep="$(db_ui_field_get_soft backup_keep_days || true)"
            [[ "$cfg_keep" =~ ^[0-9]+$ ]] && keep_days="$cfg_keep"
            cfg_comp="$(db_ui_field_get_soft backup_compress || true)"
            [[ "$cfg_comp" == "false" ]] && DB_BACKUP_COMPRESS=0
            [[ "$cfg_comp" == "true" ]] && DB_BACKUP_COMPRESS=1
        fi
    fi

    ensure_docker_if_volume || return 1
    local loc; loc="$(locate_db)"
    if [[ -z "$loc" ]]; then
        echo -e "${RED}[错误] 无法定位数据库，确认服务端已安装且卷/文件存在${NC}" >&2
        db_backup_state_set last_status=failed "last_error=cannot locate database" 2>/dev/null || true
        return 1
    fi

    mkdir -p "$DB_BACKUP_DIR"
    # 让服务端运行用户也能读写这个目录（后台的上传/下载走服务端进程）
    local _svc_user; _svc_user="$(server_run_user)"
    if [[ -n "$_svc_user" ]]; then
        chown "$_svc_user" "$DB_BACKUP_DIR" 2>/dev/null || true
        # 顺带修历史产物：旧版本以 root 建的文件（0600）服务端读不了，下载会失败。
        # 只动备份命名，不碰目录里的其它文件。
        find "$DB_BACKUP_DIR" -maxdepth 1 -type f \
            \( -name 'monitor_*.db' -o -name 'monitor_*.db.gz' -o -name 'pre_restore_*.db*' \) \
            -exec chown "$_svc_user" {} + 2>/dev/null || true
    fi
    local ts; ts="$(date +%Y%m%d_%H%M%S)"
    [[ -z "$out_path" ]] && out_path="$DB_BACKUP_DIR/monitor_${ts}.db"

    # ── 空间预检 + 满盘自愈（B + C）─────────────────────────────────────────
    # 先预估需求：库有多大，备份就要多大（SQLite .backup 是逐页原样拷贝，
    # 含已删除数据留下的空闲页；实测压缩后约为原体积的 20%）。
    local need_kb=0
    case "$loc" in
        docker:*) need_kb="$(timeout 180 docker exec "$(echo "$loc" | cut -d: -f2)" \
                     du -k "$(echo "$loc" | cut -d: -f4)" 2>/dev/null | cut -f1)" ;;
        volume:*) need_kb="$(docker run --rm -v "$(echo "$loc" | cut -d: -f2)":/data \
                     alpine:3.20 du -k /data/monitor.db 2>/dev/null | cut -f1)" ;;
        *)       need_kb="$(du -k "$(echo "$loc" | cut -d: -f2)" 2>/dev/null | cut -f1)" ;;
    esac
    need_kb="${need_kb:-0}"
    [[ "$need_kb" =~ ^[0-9]+$ ]] || need_kb=0
    # 压缩时按 35% 估（压缩率实测约 20%，留余量）；不压缩则按 100% 另加 5% 余量
    if [[ "$DB_BACKUP_COMPRESS" -eq 1 ]]; then
        need_kb=$(( need_kb * 35 / 100 ))
    else
        need_kb=$(( need_kb * 105 / 100 ))
    fi
    # 注意：不可写成 `[[ ... ]] && ensure_backup_space ... || return 1` ——
    # 当 need_kb=0（du 取不到大小、或极小库压缩后取整为 0）时左侧判假，
    # 会直接落到 `|| return 1` 把备份静默中止。空间未知时应当放行而不是中止。
    if [[ "$need_kb" -gt 0 ]]; then
        ensure_backup_space "$(dirname "$out_path")" "$need_kb" "${keep_days:-$DB_BACKUP_KEEP_DAYS}" || return 1
    else
        echo -e "${YELLOW}[警告] 无法确定数据库大小，跳过空间预检${NC}" >&2
    fi

    if [[ "$loc" == docker:* ]]; then
        # 格式 docker:cid:svc:path — 容器内拷贝
        local cid svc cpath
        cid="$(echo "$loc" | cut -d: -f2)"
        svc="$(echo "$loc" | cut -d: -f3)"
        cpath="$(echo "$loc" | cut -d: -f4)"
        # 优先用 sqlite3 .backup（一致性最好）；无 sqlite3 则 cp 读
        # 所有 docker 调用外裹 timeout 180：避免本机 docker exec 偶发卡 300s 导致假死
        if timeout 180 docker exec "$cid" sh -c 'command -v sqlite3 >/dev/null 2>&1' 2>/dev/null; then
            echo -e "${YELLOW}[信息] 通过 sqlite3 .backup 热备份（不中断服务）…${NC}"
            timeout 180 docker exec "$cid" sqlite3 "$cpath" ".backup '${cpath}.bak'" >/dev/null 2>&1 \
              || {
                  # 兜底：容器内 cp（若 .backup 因权限失败）
                  timeout 180 docker exec "$cid" cp "$cpath" "${cpath}.bak" 2>/dev/null || true
              }
            timeout 180 docker cp "${cid}:${cpath}.bak" "$out_path"
            timeout 180 docker exec "$cid" rm -f "${cpath}.bak" 2>/dev/null || true
        else
            echo -e "${YELLOW}[信息] 容器无 sqlite3，直接 cp 拷贝…${NC}"
            timeout 180 docker cp "${cid}:${cpath}" "$out_path"
        fi
    elif [[ "$loc" == volume:* ]]; then
        # 卷存在但容器未运行：启动临时容器挂载卷并拷贝
        local vol; vol="$(echo "$loc" | cut -d: -f2)"
        echo -e "${YELLOW}[信息] 容器未运行，通过临时容器挂载卷拷贝…${NC}"
        timeout 180 docker run --rm -v "$vol":/data -v "$DB_BACKUP_DIR":/out \
            alpine:3.20 cp /data/monitor.db "/out/$(basename "$out_path")" 2>/dev/null
    else
        # 宿主机文件（生产形态：systemd + 宿主文件）。
        # ⚠️ rollback journal 模式的提交是「写 journal → 改页 → 删 journal」，直接 cp
        # 可能落在改页窗口，拷到半提交状态的库（F8.1 审查发现；原注释写「需先
        # flush」但代码既无 flush 也无 checkpoint）。必须用一致性快照：
        #   1) 有 sqlite3 → VACUUM INTO：读事务内导出已提交内容，顺带去掉空闲页；
        #   2) 无 sqlite3 → 停服后 cp（无写入 = 安全），无论成败都恢复服务。
        local fpath; fpath="$(echo "$loc" | cut -d: -f2)"
        local svc="diting-server" stopped=0 cp_rc=0
        if command -v sqlite3 >/dev/null 2>&1; then
            echo -e "${YELLOW}[信息] 通过 sqlite3 VACUUM INTO 生成一致性快照…${NC}"
            rm -f "$out_path"
            if ! timeout 600 sqlite3 "$fpath" "VACUUM INTO '$out_path'" 2>/dev/null; then
                rm -f "$out_path"
                echo -e "${YELLOW}[警告] VACUUM INTO 失败，回退为停服拷贝${NC}" >&2
            fi
        fi
        if [[ ! -f "$out_path" ]]; then
            if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$svc" 2>/dev/null; then
                echo -e "${YELLOW}[信息] 停止 ${svc} 后拷贝（避免热拷贝半提交状态）…${NC}"
                systemctl stop "$svc" 2>/dev/null && stopped=1
            fi
            cp "$fpath" "$out_path" 2>/dev/null
            cp_rc=$?
            # 备份失败也不能把服务留在停止状态
            [[ "$stopped" -eq 1 ]] && systemctl start "$svc" 2>/dev/null
            if [[ "$cp_rc" -ne 0 ]]; then
                echo -e "${RED}[错误] 宿主库拷贝失败（服务已恢复运行）${NC}" >&2
                return 1
            fi
        fi
    fi

    if [[ ! -f "$out_path" ]]; then
        echo -e "${RED}[错误] 备份失败，请检查磁盘空间与权限${NC}" >&2
        echo -e "       $(msg "bk.space_hint")" >&2
        return 1
    fi
    # 审查 G3：备份含 2FA secret / SMTP 密码 / Telegram token / AI key 等全部凭据
    # （monitor.db 不加密），cp/docker cp 产物默认跟随 umask（常为 644，同机其他
    # 用户可读）。落盘即收紧为仅属主可读写。
    chmod 600 "$out_path" 2>/dev/null || true

    # ── 压缩（A）：SQLite 含大量空闲页且内容为高重复数值，实测压到约 20% ────
    # 压缩器选择（实测 200MB 采样 / 4 核）：pigz -6 = 2.0s/41M，gzip -6 = 7.2s/41M，
    # gzip -9 = 18.2s/40M。-9 比 -6 只小 1M 却慢 2.5 倍，故固定用 -6 并优先 pigz。
    local final_path="$out_path"
    if [[ "$DB_BACKUP_COMPRESS" -eq 1 ]]; then
        local comp_bin="" comp_tag=""
        if command -v pigz >/dev/null 2>&1; then
            comp_bin="pigz -6"; comp_tag="pigz"
        elif command -v gzip >/dev/null 2>&1; then
            comp_bin="gzip -6"; comp_tag="gzip"
        fi
        if [[ -n "$comp_bin" ]]; then
            echo -e "${YELLOW}[信息] 压缩备份中（${comp_tag}）…${NC}"
            if timeout 900 $comp_bin -c "$out_path" > "${out_path}.gz" 2>/dev/null && [[ -s "${out_path}.gz" ]]; then
                rm -f "$out_path"
                final_path="${out_path}.gz"
            else
                rm -f "${out_path}.gz"
                echo -e "${YELLOW}[警告] 压缩失败，保留未压缩备份${NC}"
            fi
        else
            echo -e "${YELLOW}[警告] 未找到 pigz/gzip，备份未压缩（安装: apt-get install -y pigz）${NC}"
        fi
    fi

    local sz; sz="$(du -h "$final_path" | cut -f1)"
    # 压缩产物（gzip -c > 重定向创建）同样收紧为 600
    chmod 600 "$final_path" 2>/dev/null || true
    echo -e "${GREEN}[OK]   备份完成: ${final_path} (${sz})${NC}"
    echo -e "${YELLOW}[提示] 备份包含全部监控数据、Agent 记录、设置；请妥善保管${NC}"
    # 同步一份到后台可见目录（供网页列表/下载），未配置则跳过
    sync_to_visible_dir "$final_path"

    # ── 轮转（含压缩产物）与状态回写 ────────────────────────────────────────
    local pruned=0
    if [[ "$(dirname "$out_path")" == "$DB_BACKUP_DIR" ]]; then
        local prune_out
        prune_out="$(prune_backups "${keep_days:-$DB_BACKUP_KEEP_DAYS}" 2>&1)"
        [[ -n "$prune_out" ]] && echo "$prune_out"
        # prune_backups 输出形如「[OK]   已清理 N 个过期备份」，提取 N
        if [[ "$prune_out" =~ ([0-9]+)[[:space:]]*(个|expired) ]]; then
            pruned="${BASH_REMATCH[1]}"
        fi
        # F8.4：份数上限（与保留天数并存）。天数管不住「一天多次手动备份」和
        # 「上传件堆积」，份数是占用兜底；源目录与可见目录都要执行。
        local keep_count=""
        keep_count="$(db_ui_field_get_soft backup_keep_count 2>/dev/null || true)"
        keep_count="${keep_count:-${DB_BACKUP_KEEP_COUNT:-10}}"
        prune_backups_count "$keep_count" || true
        # 可见目录（BACKUP_VISIBLE_DIR）的副本同样要轮转：sync_to_visible_dir 每次
        # 备份都复制一份，若不清理会与源目录一起无限增长（占用翻倍）。
        # prune_backups 以 DB_BACKUP_DIR 为目标，这里临时切换后立即还原。
        local vis="${BACKUP_VISIBLE_DIR:-}"
        if [[ -n "$vis" && -d "$vis" && "$vis" != "$DB_BACKUP_DIR" ]]; then
            local saved_dir="$DB_BACKUP_DIR"
            DB_BACKUP_DIR="$vis"
            prune_backups "${keep_days:-$DB_BACKUP_KEEP_DAYS}" 2>/dev/null || true
            prune_backups_count "$keep_count" 2>/dev/null || true
            DB_BACKUP_DIR="$saved_dir"
        fi
    fi

    # 备份文件本身也要让服务端用户可读（下载 / 上传后恢复都走它）
    [[ -n "${_svc_user:-}" && -f "${final_path:-}" ]] && chown "$_svc_user" "$final_path" 2>/dev/null || true

    local ended; ended="$(date +%s%3N 2>/dev/null || echo "$(date +%s)000")"
    local dur=$(( ended - started ))
    [[ "$dur" -lt 0 ]] && dur=0
    local total_kb cnt
    total_kb="$(du -sk "$DB_BACKUP_DIR" 2>/dev/null | cut -f1)"; total_kb="${total_kb:-0}"
    cnt="$(find "$DB_BACKUP_DIR" -maxdepth 1 -type f \( -name 'monitor_*.db' -o -name 'monitor_*.db.gz' \) 2>/dev/null | wc -l)"
    db_backup_state_set last_status=ok last_run_ts="$ended" \
        "last_file=$(basename "$final_path")" \
        last_size_bytes="$(stat -c %s "$final_path" 2>/dev/null || echo 0)" \
        last_raw_bytes=0 last_duration_ms="$dur" last_error= \
        last_pruned="$pruned" backup_count="$cnt" total_bytes="$((total_kb * 1024))" 2>/dev/null || true
}

# 取目录所在文件系统的可用空间（KiB）。查不到返回空串。
dir_avail_kb() {
    local d="$1"
    [[ -d "$d" ]] || d="$(dirname "$d")"
    df -Pk "$d" 2>/dev/null | awk 'NR==2 {print $4}'
}

# 备份前空间预检 + 满盘自愈。
# 顺序：先按保留策略清理腾空间 → 再检查够不够 → 仍不够则清理紧急备份池
# （仅当 keep>0，避免把用户唯一一份备份也删掉）。
# 返回 0=空间可用；1=仍然不足。need_kb 为预估需求（KiB）。
ensure_backup_space() {
    local dir="$1" need_kb="$2" keep="$3"
    local avail; avail="$(dir_avail_kb "$dir")"
    if [[ -z "$avail" ]]; then
        echo -e "${YELLOW}[警告] 无法读取磁盘可用空间（df 不可用），跳过预检${NC}" >&2
        return 0
    fi
    if [[ "$avail" -ge "$need_kb" ]]; then
        return 0
    fi

    echo -e "${YELLOW}[警告] 目标分区可用空间不足：需 ~$((need_kb / 1024)) MB，仅剩 $((avail / 1024)) MB${NC}" >&2
    # ① 先按保留策略清理（正常轮转路径）
    if [[ "${keep:-0}" -gt 0 ]]; then
        echo -e "${YELLOW}[信息] 尝试清理过期备份以腾出空间…${NC}" >&2
        prune_backups "$keep" >&2
        avail="$(dir_avail_kb "$dir")"
        [[ -z "$avail" ]] && return 0
        if [[ "$avail" -ge "$need_kb" ]]; then
            echo -e "${GREEN}[OK]   清理后空间充足（$((avail / 1024)) MB）${NC}" >&2
            return 0
        fi
    fi
    # ② 仍不足：清掉最旧的 monitor_*.db 直到够用（保留最新的 1 份）
    echo -e "${YELLOW}[信息] 仍不足，继续清理最旧的备份（至少保留最新 1 份）…${NC}" >&2
    local f cnt=0
    while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        if rm -f "$f" 2>/dev/null; then
            cnt=$((cnt + 1))
            echo "       - $(basename "$f")" >&2
            avail="$(dir_avail_kb "$dir")"
            [[ -z "$avail" ]] && return 0
            [[ "$avail" -ge "$need_kb" ]] && break
        fi
    done < <(find "$DB_BACKUP_DIR" -maxdepth 1 -type f -name 'monitor_*.db*' -printf '%T@\t%p\n' 2>/dev/null \
             | LC_ALL=C sort -n -k1,1 -k2,2 | cut -f2- | head -n -1)
    avail="$(dir_avail_kb "$dir")"
    if [[ -n "$avail" && "$avail" -ge "$need_kb" ]]; then
        echo -e "${GREEN}[OK]   已腾出空间（清理 ${cnt} 份，现有 $((avail / 1024)) MB）${NC}" >&2
        return 0
    fi
    echo -e "${RED}[错误] 空间仍不足（$((avail / 1024)) MB < $((need_kb / 1024)) MB）。${NC}" >&2
    echo -e "       $(msg "bk.space_hint")" >&2
    return 1
}

# 清理超过保留天数的旧备份（只动 $DB_BACKUP_DIR/monitor_*.db，
# 保留 pre_restore_*.db —— 那是恢复前的后悔药，需人工确认后再删）。
# 用法：prune_backups <保留天数>；天数 <=0 表示不清理。
prune_backups() {
    local keep="${1:-$DB_BACKUP_KEEP_DAYS}"
    [[ -z "$keep" || "$keep" =~ ^[0-9]+$ ]] || keep="$DB_BACKUP_KEEP_DAYS"
    [[ "${keep:-0}" -le 0 ]] && return 0
    [[ -d "$DB_BACKUP_DIR" ]] || return 0

    local -a old=()
    local f
    while IFS= read -r f; do
        [[ -n "$f" ]] && old+=("$f")
    # 同时匹配 .db 与 .db.gz（压缩开启后产物带 .gz 后缀）
    done < <(find "$DB_BACKUP_DIR" -maxdepth 1 -type f \( -name 'monitor_*.db' -o -name 'monitor_*.db.gz' \) -mtime "+${keep}" 2>/dev/null)

    if [[ ${#old[@]} -eq 0 ]]; then
        echo -e "  $(msg "bk.keep_tip") ${keep} $(msg "bk.keep_days")"
        return 0
    fi
    echo -e "${YELLOW}[信息] $(msg "bk.pruning")${NC}"
    local freed=0
    for f in "${old[@]}"; do
        local s; s="$(du -k "$f" 2>/dev/null | cut -f1)"; s="${s:-0}"
        if rm -f "$f" 2>/dev/null; then
            echo "       - $(basename "$f")"
            freed=$((freed + s))
        fi
    done
    echo -e "${GREEN}[OK]   $(msg "bk.pruned") ${#old[@]} $(msg "bk.pruned_unit")（~$((freed / 1024)) MB）${NC}"
}

# F8.4：按「份数」清理最旧的 monitor_*（与按天的 prune_backups 并存）。
# 保留天数管不住一天多次手动备份/上传件堆积；份数上限是最后一道占用兜底。
# keep<=0 表示不限；只统计/删除 monitor_*，pre_restore_* 是回滚点，永远不动。
prune_backups_count() {
    local keep="${1:-${DB_BACKUP_KEEP_COUNT:-10}}"
    [[ -z "$keep" || "$keep" =~ ^[0-9]+$ ]] || keep="${DB_BACKUP_KEEP_COUNT:-10}"
    [[ "${keep:-0}" -le 0 ]] && return 0
    [[ -d "$DB_BACKUP_DIR" ]] || return 0

    local -a files=()
    local f
    while IFS= read -r f; do
        [[ -n "$f" ]] && files+=("$f")
    done < <(find "$DB_BACKUP_DIR" -maxdepth 1 -type f \( -name 'monitor_*.db' -o -name 'monitor_*.db.gz' \) \
        -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2-)

    local total=${#files[@]}
    [[ "$total" -le "$keep" ]] && return 0

    local -a old=("${files[@]:0:$((total - keep))}")
    local freed=0
    echo -e "${YELLOW}[信息] $(msg "bk.pruning")${NC}"
    for f in "${old[@]}"; do
        local s; s="$(du -k "$f" 2>/dev/null | cut -f1)"; s="${s:-0}"
        if rm -f "$f" 2>/dev/null; then
            echo "       - $(basename "$f")"
            freed=$((freed + s))
        fi
    done
    echo -e "${GREEN}[OK]   $(msg "bk.pruned") ${#old[@]} $(msg "bk.pruned_unit")（~$((freed / 1024)) MB）${NC}"
}

# 后台发起的恢复请求文件（容器内 BACKUP_DIR 挂载到宿主备份目录后可达）。
# 后台点「恢复」只写请求文件，真正的恢复由本脚本在宿主侧执行
# —— 容器内无法安全完成「先备份当前状态 + 停服原子替换 + 重启」。
# 默认落在「容器可见的备份目录」内，即容器 RESTORE_TRIGGER 的宿主侧对应路径。
# 注：此处曾误写 BACKUP_DIR_HOST（从未定义）→ 默认退化成 /restore.request，
# 导致按文档只配 BACKUP_VISIBLE_DIR 时，--process-restore 永远找不到请求文件。
RESTORE_REQUEST_FILE="${RESTORE_REQUEST_FILE:-${BACKUP_VISIBLE_DIR:-}/restore.request}"

# 处理前台（后台 UI）投递的恢复请求。仅 ADMIN 从后台发起才可能生成该文件。
process_restore_request() {
    # L-15：BACKUP_VISIBLE_DIR 未配时 RESTORE_REQUEST_FILE 会退化到 /restore.request
    # （:1020 的兜底），后台写入的请求文件根本不会被读到 —— 表现为「点了恢复没反应」。
    # 这里显式告警，避免静默失效。
    if [[ -z "${BACKUP_VISIBLE_DIR:-}" ]]; then
        echo -e "${YELLOW}[警告] BACKUP_VISIBLE_DIR 未设置，恢复请求路径已退化为 ${RESTORE_REQUEST_FILE:-/restore.request}；${NC}" >&2
        echo -e "${YELLOW}       若后台「备份」页的恢复无响应，请在 /etc/diting/host.env 配置 BACKUP_VISIBLE_DIR（--install-server 已生成骨架）${NC}" >&2
    fi
    local reqf="${RESTORE_REQUEST_FILE:-}"
    [[ -n "$reqf" && -f "$reqf" ]] || return 1
    local file name by
    file="$(sed -n 's/.*"file":"\([^"]*\)".*/\1/p' "$reqf" | head -n1)"
    name="$(sed -n 's/.*"name":"\([^"]*\)".*/\1/p' "$reqf" | head -n1)"
    # F8.6：把发起者带进恢复流程，供审计记录「谁发起的恢复」。旧请求文件没有该字段，
    # 回退为 host(cli)（等价于宿主侧手动执行）。
    by="$(sed -n 's/.*"by":"\([^"]*\)".*/\1/p' "$reqf" | head -n1)"
    export RESTORE_REQUESTED_BY="${by:-host(cli)}"
    if [[ -z "$file" ]]; then
        echo -e "${RED}[错误] 恢复请求文件格式异常，已忽略: $reqf${NC}" >&2
        rm -f "$reqf"
        return 1
    fi
    echo -e "${YELLOW}[信息] 检测到后台恢复请求: ${name:-$file}${NC}"
    if [[ ! -f "$file" ]]; then
        echo -e "${RED}[错误] 请求的备份文件不存在: $file${NC}" >&2
        rm -f "$reqf"
        return 1
    fi
    # 先删请求文件再执行，避免恢复过程中的失败被反复重试成循环
    rm -f "$reqf"
    do_restore "$file"
}

# 把备份同步到「容器可见」目录，供后台列表/下载使用。
# 独立于备份逻辑：未配置/不可写时静默跳过，不影响备份本身。
sync_to_visible_dir() {
    local src="$1"
    local dst="${BACKUP_VISIBLE_DIR:-}"
    [[ -n "$dst" && -f "$src" ]] || return 0
    mkdir -p "$dst" 2>/dev/null || return 0
    # 同一目录（SAME 源和目标）不复制
    [[ "$(dirname "$src")" == "$dst" ]] && return 0
    # pre_restore_* 不同步：它是恢复前的回滚点，每恢复一次就多一份，
    # 复制到可见目录会让占用翻倍（实测 4 次恢复 = 1.3G 冗余）。
    # 且它只服务于「宿主侧手动回滚」这一场景，无需在网页里下载。
    [[ "$(basename "$src")" == pre_restore_* ]] && return 0
    cp -f "$src" "$dst/" 2>/dev/null || true
    # 审查 G3：可见目录副本同样含全部凭据，权限与源一致收紧为 600
    chmod 600 "$dst/$(basename "$src")" 2>/dev/null || true
}

# ── F8.6 恢复后一致性审查标记 ──────────────────────────────────────────────
# 恢复是「整库回滚」：时间基准、折叠水位线、流量累计器都会一起被拨回过去，
# 而 prune 与流量差量都默认「时间是单调的」。所以在替换数据库之前，先往
# **即将生效的那份副本**写入 admin_config.restore_audit_pending，服务启动时
# 检测到它就立刻跑一次一致性审查（见 server/src/restore-audit.js）。
#
# 时序很重要：必须在重启前写。服务启动瞬间就会读该标记，重启后再写等于没写。
# 也不能直接写 restore_src：未压缩备份就是原始备份文件本身，写标记会污染它
# （同一份备份可能还要再次恢复/归档），因此先复制一份再写。
#
# 工具优先级：sqlite3 → 备份可见目录标记文件（服务端 BACKUP_DIR 与之同源）。
# 全部失败只告警、不阻断恢复 —— 审查是增强能力，不能挡住「救数据」。
_restore_pending_payload() {
    local name="$1" by="$2" mtime="${3:-0}" ts
    ts="$(date +%s%3N 2>/dev/null || echo "$(date +%s)000")"
    # 白名单过滤：name 来自文件名，by 来自后台请求文件；两者都不允许引号/换行，
    # 这样拼进 JSON 与 SQL 字面量都是安全的（调用方不再做二次转义）。
    name="$(printf '%s' "$name" | tr -cd 'A-Za-z0-9._-')"
    by="$(printf '%s' "${by:-host(cli)}" | tr -cd 'A-Za-z0-9._:() -' | cut -c1-120)"
    [[ "$mtime" =~ ^[0-9]+$ ]] || mtime=0
    # mtime = 备份文件自身的修改时间（ms）。「恢复自 N 天前的备份」要靠它，
    # 不能用 ts（那是本次恢复的时刻）。
    printf '{"name":"%s","ts":%s,"by":"%s","mtime":%s}' "$name" "$ts" "$by" "$mtime"
}

# 向待替换的库副本写标记；返回 0 表示成功。
_restore_mark_pending_db() {
    local db_file="$1" payload="$2"
    command -v sqlite3 >/dev/null 2>&1 || return 1
    sqlite3 "$db_file" \
        "CREATE TABLE IF NOT EXISTS admin_config (key TEXT PRIMARY KEY, value TEXT);
         INSERT INTO admin_config (key, value) VALUES ('restore_audit_pending', '$payload')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value;" 2>/dev/null || return 1
    return 0
}

# 降级路径：库内标记写不进去时，落到备份可见目录（容器内 BACKUP_DIR 与之同源），
# 服务端启动时一并读取。文件随恢复库一起生效，语义与库内标记等价。
_restore_write_pending_file() {
    local payload="$1" dst="${BACKUP_VISIBLE_DIR:-}"
    [[ -n "$dst" && -d "$dst" ]] || return 1
    printf '%s' "$payload" > "$dst/.restore_audit_pending.json" 2>/dev/null || return 1
    chmod 644 "$dst/.restore_audit_pending.json" 2>/dev/null || true
    return 0
}

# 恢复数据库：校验 → 自动备份当前 → 原子替换 → 重启服务。
# 外层只补审计：恢复会覆盖当前库，API 侧那条 request_restore_backup 记录会随
# 旧库一起消失（F8.6），所以结果必须在新库里再记一条（via=script）。
do_restore() {
    local in_path="${1:-}" rc=0
    RESTORE_RESULT=""
    _restore_apply "$in_path" || rc=$?
    local result="${RESTORE_RESULT:-failed}"
    [[ $rc -eq 0 && -z "$RESTORE_RESULT" ]] && result=ok
    # 不阻塞主流程：库刚重启，容器内 node 可能还没就绪；写失败由服务端审查的
    # restore_completed 兜底（前提是标记写入成功）。
    db_audit_log restore_backup \
        "name=$(basename "${in_path:-}") result=${result} rc=${rc} pre_restore=${RESTORE_PRE_BACKUP:-}" 2>/dev/null || true
    return $rc
}

_restore_apply() {
    _init_backup_dir
    local in_path="$1"
    [[ -z "$in_path" ]] && { echo -e "${RED}[错误] 用法: --restore <备份文件路径>${NC}" >&2; return 1; }
    [[ -f "$in_path" ]] || { echo -e "${RED}[错误] 文件不存在: $in_path${NC}" >&2; return 1; }
    ensure_docker_if_volume || return 1

    # ── 解压（备份可能是 .gz）──────────────────────────────────────────────
    # 解压到同目录临时文件，校验/替换都用解压后的路径；退出时清理。
    local restore_src="$in_path" tmp_dec="" marked_tmp=""
    if [[ "$in_path" == *.gz ]]; then
        if ! command -v gzip >/dev/null 2>&1; then
            echo -e "${RED}[错误] 备份为 gzip 压缩格式，但本机无 gzip（apt-get install -y gzip）${NC}" >&2
            return 1
        fi
        tmp_dec="$(mktemp "${TMPDIR:-/tmp}/diting_restore_XXXXXX.db")"
        echo -e "${YELLOW}[信息] 解压备份中…${NC}"
        if ! gzip -dc "$in_path" > "$tmp_dec" 2>/dev/null; then
            rm -f "$tmp_dec"
            echo -e "${RED}[错误] 解压失败，备份文件可能已损坏${NC}" >&2
            return 1
        fi
        restore_src="$tmp_dec"
    fi
    # 无论成功失败都清理临时解压/标记副本
    trap '[[ -n "${tmp_dec:-}" && -f "${tmp_dec:-}" ]] && rm -f "$tmp_dec"; [[ -n "${marked_tmp:-}" && -f "${marked_tmp:-}" ]] && rm -f "$marked_tmp"' RETURN

    # ── 校验：SQLite 完整性 + 魔数 ──────────────────────────────────────────
    # 用 read 而非 $(head -c)：SQLite 头部第 16 字节是 \0，命令替换会丢弃并告警
    local magic=""
    IFS= read -r -n 15 -d '' magic < "$restore_src" 2>/dev/null || magic="$(head -c 15 "$restore_src" 2>/dev/null)"
    if [[ "$magic" != "SQLite format 3" ]]; then
        echo -e "${RED}[错误] 文件不是合法的 SQLite 数据库${NC}" >&2
        return 1
    fi
    # 有 sqlite3 时做 integrity_check
    if command -v sqlite3 >/dev/null 2>&1; then
        if ! sqlite3 "$restore_src" "PRAGMA integrity_check;" 2>/dev/null | grep -qx "ok"; then
            echo -e "${RED}[错误] 备份文件完整性校验未通过，已放弃恢复${NC}" >&2
            return 1
        fi
        echo -e "${GREEN}[OK]   备份文件完整性校验通过${NC}"
    else
        echo -e "${YELLOW}[警告] 宿主机无 sqlite3，跳过完整性校验（仅校验了魔数）${NC}"
    fi

    # ── F8.6：把审查标记写进「即将替换进库」的那份文件 ──────────────────────
    # 必须在重启前完成（服务启动即读标记）；写失败只降级、不阻断恢复。
    local pending_json marked_db="" backup_mtime=0
    # 备份文件时间（秒 → 毫秒）；stat 失败按 0 处理，服务端会退化为「较早的备份」文案。
    backup_mtime="$(stat -c %Y "$in_path" 2>/dev/null || echo 0)"
    [[ "$backup_mtime" =~ ^[0-9]+$ ]] || backup_mtime=0
    pending_json="$(_restore_pending_payload "$(basename "$in_path")" \
        "${RESTORE_REQUESTED_BY:-host(cli)}" "$((backup_mtime * 1000))")"
    if [[ "$restore_src" == "$in_path" ]]; then
        # 未压缩备份 = 原始文件，不能污染：复制一份再写
        marked_tmp="$(mktemp "${TMPDIR:-/tmp}/diting_restore_marked_XXXXXX.db")"
        if cp "$restore_src" "$marked_tmp" 2>/dev/null; then
            marked_db="$marked_tmp"
        else
            rm -f "$marked_tmp"; marked_tmp=""
        fi
    else
        # 解压产物是临时文件，可就地写（原始 .gz 不受影响）
        marked_db="$restore_src"
    fi
    if [[ -n "$marked_db" ]] && _restore_mark_pending_db "$marked_db" "$pending_json"; then
        restore_src="$marked_db"
        # 清掉上一次可能残留的降级标记，避免服务端读到更旧的元数据
        rm -f "${BACKUP_VISIBLE_DIR:-}/.restore_audit_pending.json" 2>/dev/null || true
    elif _restore_write_pending_file "$pending_json"; then
        echo -e "${YELLOW}[信息] 库内无法写审查标记（无 sqlite3），已改用备份目录标记文件${NC}"
    else
        echo -e "${YELLOW}[警告] 无法写入恢复审查标记，本次恢复将跳过启动审查（恢复动作仍会记审计）${NC}" >&2
    fi

    local loc; loc="$(locate_db)"
    if [[ -z "$loc" ]]; then
        echo -e "${RED}[错误] 无法定位当前数据库，确认服务端已安装${NC}" >&2
        return 1
    fi

    echo ""
    echo -e "${YELLOW}[警告] 恢复将覆盖当前全部数据！恢复前会自动备份当前状态。${NC}"
    # 非交互场景（cron 调 --process-restore，或 stdin 非终端）无法回答确认：
    # 此时放行 —— 后台「恢复」按钮本身已是管理员显式操作（写保护 + 审计日志），
    # 且流程内已强制自动备份当前状态可回滚，不再要求第二次人工确认。
    if [[ -t 0 && "${RESTORE_ASSUME_YES:-}" != "1" ]]; then
        read -r -p "确认恢复？输入 yes 继续: " confirm || { RESTORE_RESULT=cancelled; echo "已取消"; return 0; }
        [[ "$confirm" == "yes" ]] || { RESTORE_RESULT=cancelled; echo "已取消"; return 0; }
    else
        echo -e "${YELLOW}[信息] 非交互执行（后台请求/管道），跳过二次确认${NC}"
    fi

    # ── 恢复前自动备份（后悔药）──────────────────────────────────────────────
    echo -e "${YELLOW}[信息] 自动备份当前数据库（恢复失败可回滚）…${NC}"
    local pre_restore; pre_restore="$DB_BACKUP_DIR/pre_restore_$(date +%Y%m%d_%H%M%S).db"
    # 临时关闭 errexit，允许备份失败时继续（当前库可能已坏）
    set +e
    do_backup "$pre_restore" 2>/dev/null
    set -e
    # 开启压缩时实际产物带 .gz 后缀，必须按实际落盘文件判断，否则会误报「备份失败」
    [[ -f "${pre_restore}.gz" ]] && pre_restore="${pre_restore}.gz"
    if [[ -f "$pre_restore" ]]; then
        echo -e "${GREEN}[OK]   已保存当前状态: ${pre_restore}${NC}"
    else
        echo -e "${YELLOW}[警告] 当前数据库备份失败（可能已损坏），仍继续恢复${NC}"
    fi

    # ── 原子替换 ────────────────────────────────────────────────────────────
    # 注意（F8.6）：当前 `db.js` 使用 rollback journal（未设 journal_mode，现网也无
    # -wal/-shm），覆盖 monitor.db 不会残留旧日志。若将来改用 WAL，这里必须同时
    # 删除 -wal/-shm，否则旧 WAL 会被新库误认成自己的日志（数据错乱）。
    if [[ "$loc" == docker:* ]]; then
        local cid svc cpath
        cid="$(echo "$loc" | cut -d: -f2)"
        svc="$(echo "$loc" | cut -d: -f3)"
        cpath="$(echo "$loc" | cut -d: -f4)"
        echo -e "${YELLOW}[信息] 停止服务端容器以安全替换数据库…${NC}"
        timeout 180 docker stop "$cid" >/dev/null 2>&1 || true
        # 注意：必须用解压后的 restore_src，绝不能用 in_path（可能是 .gz，
        # 直接拷进去会把数据库写坏）
        cp "$restore_src" "${restore_src}.tmp"
        timeout 180 docker cp "${restore_src}.tmp" "${cid}:${cpath}" 2>/dev/null
        rm -f "${restore_src}.tmp"
        echo -e "${YELLOW}[信息] 重启服务端…${NC}"
        timeout 180 docker start "$cid" >/dev/null 2>&1 || true
        # compose 管理的容器用 restart 更稳妥
        local proj; proj="$(timeout 180 docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$cid" 2>/dev/null)"
        if [[ -n "$proj" && -n "${SRC_DIR:-}" && -d "$SRC_DIR/server" ]]; then
            ( cd "$SRC_DIR/server" && timeout 180 docker compose up -d "$svc" 2>/dev/null ) || timeout 180 docker start "$cid" >/dev/null 2>&1 || true
        fi
    elif [[ "$loc" == volume:* ]]; then
        local vol; vol="$(echo "$loc" | cut -d: -f2)"
        echo -e "${YELLOW}[信息] 通过临时容器写入卷…${NC}"
        # 同样必须用解压后的文件（临时解压文件在 /tmp，需按其所在目录挂载）
        timeout 180 docker run --rm -v "$vol":/data -v "$(dirname "$restore_src")":/in \
            alpine:3.20 cp "/in/$(basename "$restore_src")" /data/monitor.db 2>/dev/null
    else
        local fpath; fpath="$(echo "$loc" | cut -d: -f2)"
        echo -e "${YELLOW}[信息] 替换宿主机数据库文件…${NC}"
        # 停服
        if [[ -n "${SRC_DIR:-}" && -d "$SRC_DIR/server" ]]; then
            ( cd "$SRC_DIR/server" && timeout 180 docker compose down 2>/dev/null ) || true
        fi
        cp "$fpath" "${fpath}.before_restore.bak"
        cp "$restore_src" "$fpath"
        # 现网是 rollback journal，下面两个文件通常不存在；保留删除是为了将来
        # 启用 WAL 后不把旧日志带进新库（见「原子替换」开头的说明）。
        rm -f "${fpath}-wal" "${fpath}-shm" 2>/dev/null || true
        # 重启
        if [[ -n "${SRC_DIR:-}" && -d "$SRC_DIR/server" ]]; then
            ( cd "$SRC_DIR/server" && timeout 180 docker compose up -d 2>/dev/null ) || true
        fi
    fi

    echo -e "${GREEN}[OK]   数据库已恢复${NC}"
    echo -e "${YELLOW}[提示] 请刷新后台确认数据正确；如有问题可从 ${pre_restore:-（无）} 回滚${NC}"
    # 供外层 do_restore 写审计（恢复动作在新库里必须留痕，F8.6）
    RESTORE_RESULT=ok
    RESTORE_PRE_BACKUP="$(basename "${pre_restore:-}")"
    # 恢复结果回写状态，供后台展示（与备份共用 backup_state）
    db_backup_state_set last_status=ok last_run_ts="$(date +%s%3N 2>/dev/null || echo "$(date +%s)000")" \
        "last_error=" "last_file=restore:$(basename "$in_path")" 2>/dev/null || true
}

# 安装/卸载每日自动备份（cron）。
# 用法：do_backup_schedule install|uninstall [保留天数] [小时]
# 设计要点：
#  - 写入两行（# diting-backup 每日备份 / # diting-backup-restore 恢复轮询），卸载时按标记精准移除，不动其它条目；
#  - 备份输出到 $DB_BACKUP_DIR 并按保留天数轮转，避免占满磁盘；
#  - 无 crontab 命令时给出清晰指引（最小化容器需 apt-get install -y cron）。
do_backup_schedule() {
    _init_backup_dir
    local act="${1:-status}"
    local keep="${2:-$DB_BACKUP_KEEP_DAYS}"
    local hour="${3:-3}"
    local marker="# diting-backup"
    local self; self="$(realpath "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo "$0")"

    case "$act" in
        install)
            if ! command -v crontab >/dev/null 2>&1; then
                echo -e "${RED}[错误] 未检测到 crontab，请安装后重试（Debian/Ubuntu: apt-get install -y cron）${NC}" >&2
                return 1
            fi
            [[ "$keep" =~ ^[0-9]+$ ]] || keep="$DB_BACKUP_KEEP_DAYS"
            [[ "$hour" =~ ^[0-9]+$ ]] || hour=3
            [[ "$hour" -ge 0 && "$hour" -le 23 ]] || hour=3
            # 先移除旧的同名条目，保证幂等（重复安装不会产生多行）
            local cur
            cur="$(crontab -l 2>/dev/null | grep -v -F "$marker" || true)"
            # BACKUP_AUTO=1 让脚本读后台配置的周期判断是否执行 —— 周期改了不用重建 cron。
            # 先 source /etc/diting/host.env（可选）：里面配置 BACKUP_VISIBLE_DIR /
            # RESTORE_REQUEST_FILE（即 compose 挂进容器的那个卷的宿主侧路径），
            # 使备份能被后台列表/下载，并让后台「恢复」请求落在此可被消费的位置。
            # 每 5 分钟轮询一次恢复请求：后台点「恢复」最多 5 分钟内由宿主执行。
            local pre="[ -f /etc/diting/host.env ] && . /etc/diting/host.env;"
            local line="0 ${hour} * * * ${pre} BACKUP_AUTO=1 ${self} --backup --keep-days ${keep} >> ${DB_BACKUP_DIR}/backup.log 2>&1 ${marker}"
            local line2="*/5 * * * * ${pre} ${self} --process-restore >> ${DB_BACKUP_DIR}/restore.log 2>&1 ${marker}-restore"
            printf '%s\n%s\n%s\n' "$cur" "$line" "$line2" | grep -v '^$' | crontab -
            echo -e "${GREEN}[OK]   $(msg "bk.cron_installed")${NC}"
            echo "       $line"
            echo "       $line2"
            echo -e "${YELLOW}$(msg "bk.cron_hint")${NC}"
            echo -e "       $(msg "bk.cron_log") ${DB_BACKUP_DIR}/backup.log"
            echo -e "       $(msg "bk.cron_remove") sudo bash $self --backup-schedule uninstall"
            ;;
        uninstall)
            if ! command -v crontab >/dev/null 2>&1; then
                echo -e "${RED}[错误] 未检测到 crontab${NC}" >&2; return 1
            fi
            local before after newcron
            before="$(crontab -l 2>/dev/null | grep -c -F "$marker" || true)"
            # 先算出过滤后的内容再写回。切勿写成 `... | crontab - || crontab -r`：
            # 一旦写回失败（或管道因 pipefail 判非 0），-r 会清空用户整个 crontab。
            # 这里只在「过滤后确实没有其它条目」时才 -r。
            newcron="$(crontab -l 2>/dev/null | grep -v -F "$marker" | grep -v '^$' || true)"
            if [[ -z "$newcron" ]]; then
                crontab -r 2>/dev/null || true
            else
                printf '%s\n' "$newcron" | crontab - 2>/dev/null || true
            fi
            after="$(crontab -l 2>/dev/null | grep -c -F "$marker" || true)"
            if [[ "${after:-0}" -eq 0 ]]; then
                echo -e "${GREEN}[OK]   $(msg "bk.cron_removed")（移除 ${before:-0} 条）${NC}"
            else
                echo -e "${RED}[错误] $(msg "bk.cron_remove_failed")${NC}" >&2; return 1
            fi
            ;;
        status|*)
            if ! command -v crontab >/dev/null 2>&1; then
                echo -e "  $(msg "bk.cron_none")"; return 0
            fi
            local lines
            lines="$(crontab -l 2>/dev/null | grep -F "$marker" || true)"
            if [[ -n "$lines" ]]; then
                echo -e "  $(msg "bk.cron_active")"
                echo "$lines" | sed 's/^/       /'
            else
                echo -e "  $(msg "bk.cron_none")"
            fi
            ;;
    esac
}

# 列出已有备份（含占用总量、时间跨度与定时备份状态）
do_backup_list() {
    _init_backup_dir
    echo "== 数据库备份列表 =="
    # 目录刚对齐时，历史备份可能还留在旧默认目录，提醒一句避免误以为备份丢了
    if [[ "$DB_BACKUP_DIR" != "/var/backups/diting" && -d /var/backups/diting ]]; then
        local _old_cnt
        _old_cnt="$(find /var/backups/diting -maxdepth 1 -type f \( -name 'monitor_*.db' -o -name 'monitor_*.db.gz' \) 2>/dev/null | wc -l)"
        if [[ "${_old_cnt:-0}" -gt 0 ]]; then
            echo -e "${YELLOW}  另有 ${_old_cnt} 个旧备份位于 /var/backups/diting（不在当前目录 $DB_BACKUP_DIR）${NC}"
            echo -e "  可执行：sudo mv /var/backups/diting/monitor_* $DB_BACKUP_DIR/"
        fi
    fi
    if [[ ! -d "$DB_BACKUP_DIR" ]]; then
        echo "  暂无备份（目录 $DB_BACKUP_DIR 不存在）"
        echo -e "  ${YELLOW}首次备份: sudo bash diting.sh --backup${NC}"
        echo -e "  ${YELLOW}每日自动: sudo bash diting.sh --backup-schedule install${NC}"
        return
    fi
    # 按修改时间排序（不能按文件名字典序：pre_restore_* 会混进 monitor_* 中间，
    # 导致「时间跨度」显示错误）。备份文件名由本脚本生成、不含空格/换行。
    local -a files=()
    local f
    while IFS= read -r f; do
        [[ -n "$f" ]] && files+=("$f")
    done < <(find "$DB_BACKUP_DIR" -maxdepth 1 -type f \( -name '*.db' -o -name '*.db.gz' \) \
             -printf '%T@\t%p\n' 2>/dev/null | LC_ALL=C sort -n -k1,1 -k2,2 | cut -f2-)

    if [[ ${#files[@]} -eq 0 ]]; then
        echo "  暂无备份文件"
        echo -e "  ${YELLOW}首次备份: sudo bash diting.sh --backup${NC}"
        echo -e "  ${YELLOW}每日自动: sudo bash diting.sh --backup-schedule install${NC}"
        return
    fi

    local total_kb=0 sz first_f last_f
    for f in "${files[@]}"; do
        sz="$(du -k "$f" 2>/dev/null | cut -f1)"; sz="${sz:-0}"
        total_kb=$((total_kb + sz))
        printf '  %s  %8s  %s\n' \
            "$(date -r "$f" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')" \
            "$(du -h "$f" 2>/dev/null | cut -f1)" \
            "$(basename "$f")"
    done
    first_f="$(basename "${files[0]}")"
    last_f="$(basename "${files[${#files[@]}-1]}")"

    echo ""
    echo -e "  $(msg "bk.total") ${#files[@]} $(msg "bk.total_unit")  |  $(msg "bk.size") ~$((total_kb / 1024)) MB  |  $(msg "bk.dir") $DB_BACKUP_DIR"
    echo -e "  $(msg "bk.range") ${first_f} → ${last_f}"
    echo -e "  $(msg "bk.keep_tip") ${DB_BACKUP_KEEP_DAYS} $(msg "bk.keep_days")"
    echo ""
    echo -e "  ${YELLOW}$(msg "bk.restore_hint") sudo bash diting.sh --restore $DB_BACKUP_DIR/<文件名>${NC}"
    echo -e "  ${YELLOW}$(msg "bk.auto_hint") sudo bash diting.sh --backup-schedule install${NC}"
    do_backup_schedule status
}

# 数据库统计信息
do_db_stats() {
    echo "== 数据库统计 =="
    ensure_deps || return 1
    ensure_docker_if_volume || return 1
    local loc; loc="$(locate_db)"
    if [[ -z "$loc" ]]; then
        echo -e "${RED}[错误] 无法定位数据库${NC}" >&2
        return 1
    fi

    local sqlite_cmd="sqlite3"
    local db_arg="$loc"
    if [[ "$loc" == docker:* ]]; then
        local cid cpath
        cid="$(echo "$loc" | cut -d: -f2)"
        cpath="$(echo "$loc" | cut -d: -f4)"
        # 容器内无 sqlite3 时用宿主机临时拷贝
        if ! timeout 180 docker exec "$cid" sh -c 'command -v sqlite3 >/dev/null 2>&1' 2>/dev/null; then
            echo -e "${YELLOW}[信息] 容器无 sqlite3，临时导出统计…${NC}"
            local tmp; tmp="$(mktemp)"
            timeout 180 docker cp "${cid}:${cpath}" "$tmp" 2>/dev/null
            sqlite_cmd="sqlite3"
            db_arg="$tmp"
        else
            echo -e "${YELLOW}[信息] 通过容器内 sqlite3 查询统计…${NC}"
            timeout 180 docker exec "$cid" sqlite3 "$cpath" <<'SQL'
SELECT '文件大小: ' || printf('%.2f MB', length(hex(a))/2.0/1048576) FROM (SELECT hex(randomblob(1)) a);
SQL
            sqlite_cmd="timeout 180 docker exec $cid sqlite3 $cpath"
            db_arg=""
        fi
    elif [[ "$loc" == volume:* ]]; then
        local vol; vol="$(echo "$loc" | cut -d: -f2)"
        local tmp; tmp="$(mktemp)"
        timeout 180 docker run --rm -v "$vol":/data alpine:3.20 cp /data/monitor.db "$tmp" 2>/dev/null
        db_arg="$tmp"
    else
        db_arg="$(echo "$loc" | cut -d: -f2)"
    fi

    if [[ -n "$db_arg" && -f "$db_arg" ]]; then
        echo "  路径: $db_arg"
        local sz; sz="$(du -h "$db_arg" | cut -f1)"
        echo "  文件大小: $sz"
        echo ""
        echo "  ── 表统计 ──"
        $sqlite_cmd "$db_arg" "SELECT 'agents（客户端）: ' || COUNT(*) || ' 条' FROM agents;" 2>/dev/null
        $sqlite_cmd "$db_arg" "SELECT 'metrics（指标）: ' || COUNT(*) || ' 条' FROM metrics;" 2>/dev/null
        $sqlite_cmd "$db_arg" "SELECT '  最早: ' || datetime(MIN(ts)/1000, 'unixepoch', 'localtime') FROM metrics;" 2>/dev/null
        $sqlite_cmd "$db_arg" "SELECT '  最新: ' || datetime(MAX(ts)/1000, 'unixepoch', 'localtime') FROM metrics;" 2>/dev/null
        $sqlite_cmd "$db_arg" "SELECT 'admin_config（配置项）: ' || COUNT(*) || ' 条' FROM admin_config;" 2>/dev/null
        $sqlite_cmd "$db_arg" "SELECT 'alert_state（告警状态）: ' || COUNT(*) || ' 条' FROM alert_state;" 2>/dev/null
        echo ""
        echo "  ── 占用明细 ──"
        $sqlite_cmd "$db_arg" "SELECT name, printf('%.1f MB', pgsize/1048576.0) FROM dbstat WHERE name IN ('agents','metrics','admin_config','alert_state') GROUP BY name;" 2>/dev/null \
            || $sqlite_cmd "$db_arg" "SELECT 'metrics 表: ' || printf('%.1f MB', SUM(pgsize)/1048576.0) FROM dbstat WHERE name='metrics';" 2>/dev/null
    fi
    # 清理临时文件
    [[ -n "${tmp:-}" && -f "${tmp:-}" ]] && rm -f "$tmp"
}

# ── 数据库压缩：VACUUM + 启用增量回收 ─────────────────────────────────────────
# 保留策略只删行，删掉的页留在 freelist 里，文件只涨不缩（本机实测：1510MB 的库
# 里 96.4% 是空闲页，真实数据只有 54MB）。auto_vacuum 是写在库头里的持久标志，
# 存量库必须"先改标志、再 VACUUM"才生效；之后的日常回收由服务端在 prune 后
# 调 PRAGMA incremental_vacuum 完成（见 src/db.js）。
do_db_vacuum() {
    ensure_deps || return 1
    ensure_docker_if_volume || return 1
    local loc; loc="$(locate_db)"
    if [[ -z "$loc" ]]; then
        echo -e "${RED}[错误] 无法定位数据库${NC}" >&2
        return 1
    fi
    echo "== 数据库压缩（VACUUM）=="
    echo -e "${YELLOW}[提示] VACUUM 会重写整个库文件，期间需要独占写锁；${NC}"
    echo -e "${YELLOW}       建议低峰执行，库很大时也可能因占用繁忙而失败（失败不会损坏数据）。${NC}"
    if ! ui_confirm "$(msg "db_menu.header")" "确认压缩数据库？"; then
        echo "已取消"
        return 0
    fi

    local js; js="$(mktemp --suffix=.js)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const fs = require('fs');
const p = process.argv[2];
const mb = (n) => (n / 1048576).toFixed(1);
const before = fs.statSync(p).size;
const db = new D(p);
db.pragma('busy_timeout = 8000');
const pagesBefore = db.pragma('page_count', { simple: true });
const freeBefore = db.pragma('freelist_count', { simple: true });
const pct = pagesBefore > 0 ? (freeBefore / pagesBefore * 100).toFixed(1) : '0.0';
try { db.pragma('auto_vacuum = INCREMENTAL'); } catch (e) { /* 老库先置位 */ }
db.exec('VACUUM');
const freeAfter = db.pragma('freelist_count', { simple: true });
const mode = db.pragma('auto_vacuum', { simple: true });
db.close();
const after = fs.statSync(p).size;
console.log(`压缩前: ${mb(before)} MB（空闲 ${mb(freeBefore * (before / (pagesBefore || 1)))} MB / ${pct}%）`);
console.log(`压缩后: ${mb(after)} MB（空闲页 ${freeAfter}）`);
console.log(`日常回收: ${mode === 2 ? '已启用（auto_vacuum=INCREMENTAL，清理后自动归还）' : '未启用（下次启动会自动置位）'}`);
console.log(`VACUUM_OK before=${before} after=${after} free_before=${freeBefore} free_after=${freeAfter} mode=${mode}`);
JS
    local out rc
    out="$(db_run_js "$js" 2>&1)"; rc=$?
    rm -f "$js"
    if [[ $rc -ne 0 ]]; then
        echo -e "${RED}[错误] 压缩失败（数据库未被破坏）${NC}" >&2
        printf '%s\n' "$out" | tail -6 | sed 's/^/       /' >&2
        echo -e "${YELLOW}       若提示 database is locked：请先停服务再执行——${NC}" >&2
        echo -e "         原生: sudo systemctl stop diting-server && sudo bash diting.sh --db-vacuum${NC}" >&2
        echo -e "         Docker: cd /opt/diting-src/server && sudo docker compose stop server${NC}" >&2
        return 1
    fi
    printf '%s\n' "$out" | grep -E '^(压缩前|压缩后|日常回收)' | sed 's/^/  /'
    echo -e "${GREEN}[OK]   数据库已压缩${NC}"
    return 0
}

# ── 查看服务端日志 ───────────────────────────────────────────────────────────
# 统一入口，省得排障时还要自己判断形态：
#   原生（systemd）→ journalctl -u diting-server
#   Docker        → docker compose logs --tail N server
# 用法：--logs [行数|follow]
do_logs() {
    local arg="${1:-}" n=100 follow=""
    [[ "$arg" =~ ^[0-9]+$ ]] && n="$arg"
    [[ "$arg" == "follow" || "$arg" == "-f" ]] && follow=1

    if systemctl cat diting-server.service >/dev/null 2>&1; then
        echo "== 服务端日志（systemd，最近 ${n} 行）=="
        local -a jargs=(-u diting-server -n "$n" --no-pager)
        [[ -n "$follow" ]] && jargs+=(-f)
        journalctl "${jargs[@]}"
        return $?
    fi

    if [[ -d "${SRC_DIR}/server" ]] && ( cd "${SRC_DIR}/server" && docker compose ps -q 2>/dev/null | grep -q . ); then
        echo "== 服务端日志（Docker，最近 ${n} 行）=="
        if [[ -n "$follow" ]]; then
            ( cd "${SRC_DIR}/server" && docker compose logs --tail "$n" -f server )
        else
            ( cd "${SRC_DIR}/server" && docker compose logs --tail "$n" server )
        fi
        return $?
    fi

    echo -e "${RED}[错误] 未找到运行中的服务端（既无 diting-server.service，也无 compose 容器）${NC}" >&2
    echo -e "       原生部署请确认 systemd 单元存在；Docker 部署请确认 $SRC_DIR/server 下的容器在跑" >&2
    return 1
}

# ── 数据库管理子菜单（交互模式）─────────────────────────────────────────────────
db_manage_menu() {
    local c
    c="$(ui_menu "$(msg "db_menu.header")" "$(msg "db_menu.prompt")" \
        "1" "$(msg "db_menu.backup")" \
        "2" "$(msg "db_menu.restore")" \
        "3" "$(msg "db_menu.list")" \
        "4" "$(msg "db_menu.stats")" \
        "5" "$(msg "db_menu.schedule")" \
        "0" "$(msg "db_menu.back")" )" || return
    [[ -z "$c" ]] && return
    case "$c" in
        1) do_backup "" "" ;;
        2)
            local bkp; bkp="$(ui_prompt "$(msg "db_menu.header")" "$(msg "db_menu.restore_prompt")")" || return
            [[ -n "$bkp" ]] && do_restore "$bkp" || msg "cancelled"
            ;;
        3) do_backup_list ;;
        4) do_db_stats ;;
        5) db_manage_schedule_menu ;;
        *) return ;;
    esac
}

# 定时备份子菜单：安装 / 卸载 / 查看状态
db_manage_schedule_menu() {
    local c
    c="$(ui_menu "$(msg "db_menu.schedule_header")" "$(msg "db_menu.schedule_prompt")" \
        "1" "$(msg "db_menu.schedule_install")" \
        "2" "$(msg "db_menu.schedule_remove")" \
        "3" "$(msg "db_menu.schedule_status")" \
        "0" "$(msg "db_menu.back")" )" || return
    [[ -z "$c" ]] && return
    case "$c" in
        1) do_backup_schedule install ;;
        2) do_backup_schedule uninstall ;;
        3) do_backup_list ;;
        *) return ;;
    esac
}

# 定位服务端 node_modules 目录（原生部署执行数据库脚本时用）。
# node 的模块解析以「脚本所在目录」为根：脚本若放在 /tmp（mktemp），require('better-sqlite3')
# 会 MODULE_NOT_FOUND —— 必须用 NODE_PATH 显式指向服务端依赖目录。
server_node_modules() {
    local cand selfdir
    selfdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
    for cand in "$SRC_DIR/server/node_modules" "$selfdir/server/node_modules" "./server/node_modules"; do
        [[ -n "$cand" && -d "$cand/better-sqlite3" ]] && { echo "$cand"; return 0; }
    done
    echo ""
    return 1
}

# 在服务端数据库上执行一段 Node 脚本。
# 参数约定：脚本内用 process.argv[2] 取库路径（node 的 argv[1] 是脚本自身路径），
# 其余入参依次为 argv[3..]。
# 三种部署形态通用：运行中容器 / 仅卷存在 / 宿主机文件。
# 依赖服务端镜像自带的 better-sqlite3（无额外依赖）；原生部署需宿主机 node 可用。
#
# 落点约束（T0.0 / M1）：node 的模块解析根 = 脚本所在目录。
#   - 运行中容器：脚本必须落在 /app（镜像 WORKDIR，依赖在 /app/node_modules）；
#   - 仅卷存在：脚本挂在 /host_js（只读挂载），解析根是 /host_js → 必须给容器补 NODE_PATH；
#   - 宿主机文件：脚本在 mktemp 目录 → 必须给 node 补 NODE_PATH 指向服务端 node_modules。
db_run_js() {
    local js="$1"; shift
    local loc; loc="$(locate_db)"
    if [[ -z "$loc" ]]; then
        echo -e "${RED}[错误] 无法定位数据库，确认服务端已安装${NC}" >&2
        return 1
    fi
    # 容器内 node 以非 root 用户（Dockerfile: USER node）运行，而 mktemp 文件是 0600：
    # docker cp 会连同权限复制，volume 分支更是只读挂载 → 容器内读不到脚本会 EACCES。
    # 这里放开读权限（脚本内不含凭据，库路径等参数走 argv 传入）。
    [[ -f "$js" ]] && chmod 644 "$js" 2>/dev/null || true
    if [[ "$loc" == docker:* ]]; then
        local cid cpath js_dst
        cid="$(echo "$loc" | cut -d: -f2)"
        cpath="$(echo "$loc" | cut -d: -f4)"
        js_dst="/app/diting_db.js"
        timeout 180 docker cp "$js" "${cid}:${js_dst}" >/dev/null 2>&1 || return 1
        timeout 180 docker exec "$cid" node "$js_dst" "$cpath" "$@" || {
            timeout 180 docker exec "$cid" rm -f "$js_dst" >/dev/null 2>&1 || true
            echo -e "${RED}[错误] 在容器 ${cid} 内执行数据库脚本失败（若报 Cannot find module 'better-sqlite3'，说明镜像布局与预期不符）${NC}" >&2
            return 1
        }
        timeout 180 docker exec "$cid" rm -f "$js_dst" >/dev/null 2>&1 || true
    elif [[ "$loc" == volume:* ]]; then
        local vol simg jsdir jsname
        vol="$(echo "$loc" | cut -d: -f2)"
        jsdir="$(dirname "$js")"; jsname="$(basename "$js")"
        simg="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'diting.*server|server' | head -n1)"
        if [[ -z "$simg" ]]; then
            echo -e "${RED}[错误] 未找到服务端镜像，无法启动临时容器${NC}" >&2
            return 1
        fi
        # 脚本只读挂载在 /host_js，解析根不是 /app → 用 NODE_PATH 指向镜像内依赖目录
        timeout 180 docker run --rm -e NODE_PATH=/app/node_modules \
            -v "$vol":/data -v "$jsdir":/host_js:ro \
            "$simg" node "/host_js/$jsname" /data/monitor.db "$@" || return 1
    else
        local fpath nm
        fpath="$(echo "$loc" | cut -d: -f2)"
        if ! command -v node >/dev/null 2>&1; then
            echo -e "${RED}[错误] 原生部署需要宿主机 node（且能 require better-sqlite3）${NC}" >&2
            return 1
        fi
        if ! nm="$(server_node_modules)"; then
            echo -e "${RED}[错误] 未找到服务端依赖目录（server/node_modules），无法执行数据库脚本${NC}" >&2
            return 1
        fi
        NODE_PATH="$nm" node "$js" "$fpath" "$@" || return 1
    fi
}

# 读取 admin_config.ui_settings 里的某个顶层字段值（查不到/解析失败输出空串）。
# 用法：db_ui_field_get <字段名>
db_ui_field_get() {
    local field="$1" js; js="$(mktemp)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
const row = db.prepare("SELECT value FROM admin_config WHERE key = 'ui_settings'").get();
let v = '';
if (row && row.value) { try { v = (JSON.parse(row.value)[process.argv[3]] || ''); } catch (e) { v = ''; } }
console.log(String(v));
JS
    db_run_js "$js" "$field"
    local rc=$?
    rm -f "$js"
    return $rc
}

# 读取后台配置字段：读库失败时打印**可见**告警并返回空值。
# 背景（T0.0 / M8）：调用点原本一律 `2>/dev/null || true`，读库失败与"配置为空"完全无法区分；
# db_run_js 修好后这些读取会首次真实生效，此处把失败显式化，避免又回到静默失败。
# 用法：db_ui_field_get_soft <字段名>（值输出到 stdout，告警输出到 stderr）
db_ui_field_get_soft() {
    local field="$1" val
    if val="$(db_ui_field_get "$field" 2>/dev/null)"; then
        printf '%s' "$val"
        return 0
    fi
    echo -e "${YELLOW}[信息] 未能读取后台配置「${field}」（数据库不可达或权限不足），本次按默认值处理${NC}" >&2
    return 1
}

# 回写备份状态到 admin_config.backup_state（后台「备份监控」读它）。
# 用法：db_backup_state_set k=v k=v ...（值不要含换行）
db_backup_state_set() {
    local js; js="$(mktemp)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
const KEY = 'backup_state';
const def = { last_run_ts: 0, last_status: 'unknown', last_file: '', last_size_bytes: 0, last_raw_bytes: 0, last_duration_ms: 0, last_error: '', last_pruned: 0, backup_count: 0, total_bytes: 0, updated_at: 0 };
let cur = Object.assign({}, def);
const row = db.prepare('SELECT value FROM admin_config WHERE key = ?').get(KEY);
if (row && row.value) { try { cur = Object.assign(cur, JSON.parse(row.value)); } catch (e) { /* 保留默认 */ } }
// 只接受白名单键，避免脏键写入
const allow = new Set(Object.keys(def));
for (const arg of process.argv.slice(3)) {
  const i = arg.indexOf('=');
  if (i < 0) continue;
  const k = arg.slice(0, i);
  if (!allow.has(k)) continue;
  const raw = arg.slice(i + 1);
  cur[k] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
}
cur.updated_at = Date.now();
db.prepare('INSERT INTO admin_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(cur));
JS
    db_run_js "$js" "$@" >/dev/null 2>&1
    local rc=$?
    rm -f "$js"
    return $rc
}

# 向 audit_logs 写一条脚本侧审计（F8.6：恢复动作留痕）。
# 为什么必须由脚本写：后台点「恢复」时 API 记的 request_restore_backup 会随旧库
# 一起被覆盖，恢复完成后再查只剩备份库里的旧记录 —— 事后无法复盘谁恢复了什么。
# 用法：db_audit_log <action> <detail>；admin 取发起者（RESTORE_REQUESTED_BY），via=script。
db_audit_log() {
    local action="$1" detail="${2:-}"
    [[ -n "$action" ]] || return 1
    local js; js="$(mktemp)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  admin TEXT NOT NULL,
  ip TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  via TEXT DEFAULT ''
)`);
db.prepare('INSERT INTO audit_logs (ts, admin, ip, action, detail, via) VALUES (?, ?, ?, ?, ?, ?)')
  .run(Date.now(), process.argv[3], '', process.argv[4], process.argv[5], 'script');
JS
    db_run_js "$js" "${RESTORE_REQUESTED_BY:-host(cli)}" "$action" "$detail" >/dev/null 2>&1
    local rc=$?
    rm -f "$js"
    return $rc
}

# 按后台配置判断「今天是否该备份」。cron 固定每日触发，周期由这里决定，
# 因此后台改周期无需重建 crontab。
# 输出：yes（该跑）/ no（跳过，并打印原因）/ unknown（读不到配置，按本地策略跑）
backup_should_run() {
    local sched
    sched="$(db_ui_field_get_soft backup_schedule || true)"
    case "$sched" in
        off)    echo "skipped"; echo "（后台备份周期=关闭）" >&2; return 1 ;;
        daily|"")  # 未配置时按每日（与 db.js 默认 off 不同：未配置视为未接管，保持可用）
            echo "yes"; return 0 ;;
        weekly)
            # 周一执行（%u：1=周一）
            if [[ "$(date +%u)" -eq 1 ]]; then echo "yes"; return 0; fi
            echo "skipped"; echo "（后台备份周期=每周，今天不是周一）" >&2; return 1
            ;;
        "")
            echo "unknown"; return 0 ;;
        *)
            echo "unknown"; return 0 ;;
    esac
}

# 清除管理端 IP 白名单（ui_settings.admin_allow_ips）。
# 用途：白名单配错把管理员锁在门外（/api/* 全部 403 ip not allowed）时的救援入口。
# 无需登录、无需重启 —— auth.js 每次请求读库，改完即时生效。
# ── 版本发布：推进 server/package.json 版本并打 vX.Y.Z tag ────────────────────
# 用法：--release [patch|minor|major|X.Y.Z]（默认 patch）
# 页脚版本号优先读 git tag（v 前缀自动去除），tag 推送后重启服务即生效。
# 刻意不使用 npm version：它在工作区不干净时直接拒绝，且 commit 会带上所有暂存文件。
do_release() {
    local bump="${1:-patch}"
    case "$bump" in
        patch|minor|major) : ;;
        v[0-9]*|[0-9]*.[0-9]*.[0-9]*) : ;;
        *)
            echo -e "${RED}[错误] 无效的版本参数: $bump（可用 patch|minor|major 或 X.Y.Z）${NC}" >&2
            return 1
            ;;
    esac

    if ! git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo -e "${RED}[错误] 当前目录不是 git 仓库，无法发布版本${NC}" >&2
        return 1
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${RED}[错误] 未找到 node，无法改写 package.json${NC}" >&2
        return 1
    fi

    local cur
    cur="$(node -p "require('$SCRIPT_DIR/server/package.json').version")"
    local new
    case "$bump" in
        patch) new="$(node -e "const [a,b,c]='$cur'.split('.').map(Number);console.log([a,b,c+1].join('.'))")" ;;
        minor) new="$(node -e "const [a,b]='$cur'.split('.').map(Number);console.log([a,b+1,0].join('.'))")" ;;
        major) new="$(node -e "const [a]='$cur'.split('.').map(Number);console.log([a+1,0,0].join('.'))")" ;;
        *)     new="${bump#v}" ;;
    esac

    # 目标 tag 已存在时直接拒绝，避免静默发布旧版本
    if git -C "$SCRIPT_DIR" rev-parse -q --verify "refs/tags/v$new" >/dev/null; then
        echo -e "${RED}[错误] tag v$new 已存在，请换一个版本号${NC}" >&2
        return 1
    fi

    if ! git -C "$SCRIPT_DIR" diff --quiet || ! git -C "$SCRIPT_DIR" diff --cached --quiet; then
        echo -e "${YELLOW}[警告] 工作区有未提交改动；本次仅提交 server/package.json，其余改动不会被带入 tag${NC}"
    fi

    echo -e "${YELLOW}[信息] 版本 $cur → $new${NC}"
    node -e "const fs=require('fs');const f='$SCRIPT_DIR/server/package.json';const p=JSON.parse(fs.readFileSync(f,'utf8'));p.version='$new';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')" \
        || { echo -e "${RED}[错误] 写入 package.json 失败${NC}" >&2; return 1; }

    git -C "$SCRIPT_DIR" add server/package.json
    if ! git -C "$SCRIPT_DIR" commit -m "chore(release): v$new" -- server/package.json; then
        echo -e "${RED}[错误] 提交失败（版本号未变化？）${NC}" >&2
        return 1
    fi
    git -C "$SCRIPT_DIR" tag "v$new"

    local branch
    branch="$(git -C "$SCRIPT_DIR" branch --show-current)"
    echo -e "${YELLOW}[信息] 推送 $branch 与 tag v$new …${NC}"
    if ! git -C "$SCRIPT_DIR" push origin "$branch" "v$new" 2>&1 | tail -2; then
        echo -e "${RED}[错误] 推送失败，可稍后手动执行：git push origin $branch v$new${NC}" >&2
        return 1
    fi

    echo -e "${GREEN}[OK]   版本已发布：v$new${NC}"
    echo -e "       使页脚生效：sudo systemctl restart diting-server"
    echo -e "       或完整重建：sudo bash diting.sh --update-server"
}

do_clear_ip_whitelist() {
    echo "$(msg "wl.header")"
    echo ""
    echo -e "${YELLOW}$(msg "wl.warn")${NC}"
    # 交互模式才确认：命令行调用（救援/CI）要求一步到位
    if [[ "$UI_TTY" -eq 1 ]]; then
        if ! ui_confirm "$(msg "wl.header")" "$(msg "wl.warn")\n\n$(msg "wl.confirm_prompt")"; then
            msg "wl.cancelled"; return 0
        fi
    fi

    ensure_docker_if_volume || return 1

    local cur
    if ! cur="$(db_ui_field_get admin_allow_ips)"; then
        echo -e "${RED}[错误] $(msg "wl.failed")：$(msg "wl.read_failed")${NC}" >&2
        echo -e "       $(msg "wl.node_hint")" >&2
        return 1
    fi
    if [[ -z "$cur" ]]; then
        echo -e "${GREEN}[OK]   $(msg "wl.empty")${NC}"
        echo -e "       $(msg "wl.empty_hint")"
        return 0
    fi
    echo -e "  $(msg "wl.current") ${cur}"

    local js out; js="$(mktemp)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
const before = db.prepare("SELECT value FROM admin_config WHERE key = 'ui_settings'").get();
// json_set 保留其它设置字段，仅把 admin_allow_ips 置空
const r = db.prepare("UPDATE admin_config SET value = json_set(value, '$.admin_allow_ips', '') WHERE key = 'ui_settings'").run();
const after = db.prepare("SELECT value FROM admin_config WHERE key = 'ui_settings'").get();
const pick = (row) => { let v = ''; if (row && row.value) { try { v = JSON.parse(row.value).admin_allow_ips || ''; } catch (e) { v = ''; } } return v; };
console.log('BEFORE=' + pick(before));
console.log('CHANGED=' + r.changes);
console.log('AFTER=' + pick(after));
JS
    if ! out="$(db_run_js "$js")"; then
        rm -f "$js"
        echo -e "${RED}[错误] $(msg "wl.failed")${NC}" >&2
        return 1
    fi
    rm -f "$js"

    local after; after="$(printf '%s\n' "$out" | sed -n 's/^AFTER=//p' | tail -n1)"
    if [[ -n "$after" ]]; then
        echo -e "${RED}[错误] $(msg "wl.failed")（$(msg "wl.current") ${after}）${NC}" >&2
        return 1
    fi
    echo ""
    echo -e "${GREEN}[OK]   $(msg "wl.ok")${NC}"
    echo -e "       $(msg "wl.old_value") ${cur}  →  （空）"
    echo -e "${YELLOW}$(msg "wl.hint")${NC}"
}

# 计算字符串的 sha256（与 server 端 db.hashToken 同口径：小写 hex、无换行）。
sha256_hex() {
    if command -v sha256sum >/dev/null 2>&1; then
        printf '%s' "$1" | sha256sum | cut -d' ' -f1
    else
        printf '%s' "$1" | openssl dgst -sha256 -r | cut -d' ' -f1
    fi
}

# 定位真实 server/.env（与 locate_db 同思路的多候选；找不到返回非零）。
locate_server_env() {
    local cand selfdir
    selfdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
    for cand in "$SRC_DIR/server/.env" "$selfdir/server/.env" "./server/.env"; do
        [[ -n "$cand" && -f "$cand" ]] && { echo "$cand"; return 0; }
    done
    echo ""
    return 1
}

# 服务端实际对外端口：Docker 取 docker port 的发布端口，原生取 .env 的 PORT，兜底 8081。
# 注意：P0 阶段 compose 仍把 PORT 写成字面量，所以 docker 部署必须以实际发布端口为准。
server_port() {
    local loc; loc="$(locate_db)"
    if [[ "$loc" == docker:* ]]; then
        local cid hp
        cid="$(echo "$loc" | cut -d: -f2)"
        hp="$(docker port "$cid" 2>/dev/null | awk -F: 'NR==1{print $NF}' | tr -d '\r')"
        [[ "$hp" =~ ^[0-9]+$ ]] && { echo "$hp"; return 0; }
    fi
    local envf p
    if envf="$(locate_server_env)"; then
        p="$(sed -n 's/^PORT=//p' "$envf" | tr -d '\r' | tail -n1)"
        [[ "$p" =~ ^[0-9]+$ ]] && { echo "$p"; return 0; }
    fi
    echo 8081
}

# 重置管理员 Token：仅通过 SSH 在服务器上运行。
# P0：Token 以「数据库哈希」为唯一权威来源 —— 直接写库、立即生效，**不重启、不重建容器**。
# 旧实现改宿主 .env 后发 `docker compose restart`：restart 不会重建容器 → 容器内 env 仍是
# 旧 Token；非标准部署路径下连 .env 都找不到，却照样打印"新 Token"（已失效路径，全部移除）。
do_reset_admin_token() {
    echo "$(msg "reset.header")"
    echo ""
    echo -e "${YELLOW}$(msg "reset.warn")${NC}"
    if ! ui_confirm "$(msg "reset.header")" "$(msg "reset.warn")\n\n$(msg "reset.confirm_prompt")"; then
        msg "reset.cancelled"; return 0
    fi

    ensure_deps || return 1

    local new_token new_hash
    new_token="adm_$(openssl rand -hex 24)"
    new_hash="$(sha256_hex "$new_token")"
    if [[ ! "$new_hash" =~ ^[0-9a-f]{64}$ ]]; then
        echo -e "${RED}[错误] sha256 计算失败，已中止（未做任何修改）${NC}" >&2
        return 1
    fi

    local loc; loc="$(locate_db)"
    if [[ -z "$loc" ]]; then
        echo -e "${RED}[错误] 未找到服务端数据库，无法重置（未做任何修改）${NC}" >&2
        echo -e "       请确认服务端已安装并至少启动过一次（数据库文件/卷已创建）" >&2
        return 1
    fi

    # 单事务写库：水位线 → 吊销会话 → 新哈希 → 清理历史残留。
    # 水位线必须最先写：verifySession 在 sid 缓存之前调 isRevoked，且 isRevoked 每次读库，
    # 因此旧 Cookie 立即失效（不依赖进程内 clearSessionCache）。
    local js out
    js="$(mktemp)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
db.pragma('busy_timeout = 5000');
const hash = process.argv[3];
const now = String(Date.now());
const tx = db.transaction(() => {
  db.prepare("INSERT OR REPLACE INTO admin_config(key,value) VALUES('session_revoked_before',?)").run(now);
  db.prepare('UPDATE sessions SET revoked=1 WHERE revoked=0').run();
  db.prepare("INSERT OR REPLACE INTO admin_config(key,value) VALUES('admin_token_hash',?)").run(hash);
  db.prepare("DELETE FROM admin_config WHERE key IN ('admin_token_raw','admin_initialized')").run();
});
tx();
const got = db.prepare("SELECT value FROM admin_config WHERE key='admin_token_hash'").get();
console.log('HASH_OK=' + (got && got.value === hash ? '1' : '0'));
JS
    if ! out="$(db_run_js "$js" "$new_hash")"; then
        rm -f "$js"
        echo -e "${RED}[错误] 写入数据库失败，Token 未变更${NC}" >&2
        return 1
    fi
    rm -f "$js"
    if ! printf '%s\n' "$out" | grep -qx 'HASH_OK=1'; then
        echo -e "${RED}[错误] 写入校验失败（库中哈希与预期不一致），Token 未变更${NC}" >&2
        return 1
    fi

    # 自检：用新 Token 打管理面只读端点（adminOrReadonly，不受 2FA 影响、不吃 loginGuard）。
    # 不用 /api/login：2FA 开启时它必返 401 need_totp，且 3 次失败会封 IP 81s。
    local port code i
    port="$(server_port)"
    code=""
    for i in 1 2 3; do
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
            -H 'X-Forwarded-Proto: https' -H "X-Admin-Token: ${new_token}" \
            "http://127.0.0.1:${port}/api/admin/alert-rules" 2>/dev/null || echo 000)"
        [[ "$code" == "200" ]] && break
        sleep 2
    done

    echo ""
    echo -e "${GREEN}$(msg "reset.ok")${NC}"
    echo ""
    echo "  $new_token"
    echo ""
    echo -e "${YELLOW}$(msg "reset.save")${NC}"

    if [[ "$code" == "200" ]]; then
        echo -e "${GREEN}[OK]   自检通过：立即生效，无需重启${NC}"
        return 0
    fi

    # 哈希已落库（上面校验过），自检失败只可能是访问面问题；Token 仍然有效，必须照常给用户。
    echo -e "${RED}[警告] 自检未通过（HTTP ${code}）：Token 已写入数据库，但服务端未能确认${NC}" >&2
    case "$code" in
        401) echo -e "       服务端未读到新哈希：确认服务端版本已包含 P0 改动（未重启不生效）" >&2 ;;
        403) echo -e "       被 IP 白名单或 HTTPS 口径拦截：检查后台 admin_allow_ips" >&2 ;;
        000) echo -e "       服务端未监听 127.0.0.1:${port}：确认容器/服务在运行" >&2 ;;
        *)   echo -e "       非预期状态码，请查看服务端日志" >&2 ;;
    esac
    return 1
}

uninstall_all() {
    echo "== 卸载受控端 =="
    # 受控端实际部署的是 /opt/diting/uninstall.sh（见 agent-go/install.sh）；
    # 兼容早期重命名失误遗留的 unditing.sh。
    if [[ -f /opt/diting/uninstall.sh ]]; then
        bash /opt/diting/uninstall.sh || true
    elif [[ -f /opt/diting/unditing.sh ]]; then
        bash /opt/diting/unditing.sh || true
    else
        echo "  受控端未安装"
    fi
    echo "== 卸载服务端 (Docker) =="
    if [[ ! -d "$SRC_DIR/server" ]]; then
        echo "  服务端未安装"
        return 0
    fi
    ( cd "$SRC_DIR/server" && docker compose down ) || true

    # 残留凭据检测：卸载只删容器，数据卷与 .env 都保留；若其中有管理员凭据，
    # 重装后会判定「已安装」，安装向导不会再出现（见 db_admin_token_probe 注释）。
    # 这里显式告知后果，并给出一键清除（只清凭据，节点数据保留）。
    # 注意区分"确认无残留"与"检测失败"——后者不能给用户"重装会进向导"的保证。
    local envtok="" probe="" ans="" envc
    envc="$(locate_server_env 2>/dev/null || true)"
    [[ -n "$envc" ]] && envtok="$(sed -n 's/^ADMIN_TOKEN=..*/p' "$envc" | head -n1 || true)"
    probe="$(db_admin_token_probe)"
    if [[ "$probe" == 'UNKNOWN' ]]; then
        echo -e "${YELLOW}[提示] 无法完成凭据残留检测（服务端镜像/宿主 node 不可用，或数据库不可达）。${NC}"
        echo -e "       请手动确认库中是否存在 admin_token_hash：有则重装不会出现安装向导。"
    elif [[ "$probe" == 'ABSENT' && -z "$envtok" ]]; then
        echo -e "${GREEN}[OK]   无管理员凭据残留，重装后将正常进入安装向导。${NC}"
    else
        echo -e "${YELLOW}[警告] 检测到管理员凭据残留（$([[ "$probe" == 'HAS' ]] && echo -n '数据库哈希 ')$([[ -n "$envtok" ]] && echo -n '.env 明文')）。${NC}"
        echo -e "       不清除的话，重装后会判定为「已安装」，安装向导不会再出现（沿用旧 Token 登录）。"
        if [[ -t 0 ]]; then
            # read EOF（Ctrl-D）返回非零，set -e 下会杀掉脚本：兜底置空走「保留」分支
            read -r -p "彻底清除管理员凭据，让下次安装重新走向导？(y/N): " ans || ans=""
            if [[ "$ans" =~ ^[Yy]$ ]]; then
                purge_admin_credentials || true
            else
                # 注意：--reset-admin-token 是"换新 Token 继续已安装态"，不是回到向导的手段
                echo "  已保留凭据。之后可运行 --reset-admin-token 更换 Token（仍为已安装态），"
                echo "  或重跑卸载并选清除，回到安装向导。"
            fi
        else
            echo -e "       非交互环境，已保留。要回到安装向导：重跑卸载并选清除，"
            echo -e "       或手动删除库中的 admin_token_hash 键（--reset-admin-token 只会换 Token，不会回到向导）。"
        fi
    fi
    echo -e "${YELLOW}[提示] 源码仍在 $SRC_DIR，数据库在 Docker 卷中；如需彻底清除请手动删除。${NC}"
}

# ── i18n 语言表（在 show_menu 之前定义，供 msg() 使用）─────────────────────────
declare -A I18N_ZH=(
    [menu.header]="━━━ 谛听轻量探针 一键部署  v%s (%s) ━━━━━━━━"
    [menu.os]="系统:"
    [menu.arch]="架构:"
    [menu.notes]="本版要点:"
    [menu.new_version]="▲ 发现新版 v%s（当前 v%s），建议先选「4) 更新安装脚本」"
    [menu.up_to_date]="✓ 已是最新脚本 (v%s)"
    [menu.install_server]="安装服务端 (Docker)"
    [menu.install_agent]="安装受控端 Agent (systemd)"
    [menu.update_agent]="更新受控端 (拉取最新 agent 代码)"
    [menu.update_script]="更新安装脚本 (diting.sh 自身)"
    [menu.update_server]="更新服务端 (拉取最新 + 重建)"
    [menu.status]="查看状态"
    [menu.uninstall]="卸载"
    [menu.db_manage]="数据库管理（备份/恢复/统计）"
    [menu.reset_token]="重置管理员 Token（丢失 Token 时救援）"
    [menu.switch_lang]="切换语言 / Switch Language"
    [menu.switch_lang.current]="当前界面语言:"
    [menu.switch_lang.done]="✓ 已保存，重启脚本或返回菜单即时生效"
    [menu.press_enter]="按回车返回菜单"
    [menu.clear_whitelist]="清除 IP 白名单（误配锁门时救援）"
    [menu.exit]="退出"
    [menu.prompt]="请选择 [0-10]: "
    [menu.exit_msg]="退出"
    [db_menu.header]="━━━ 数据库管理 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    [db_menu.backup]="备份数据库"
    [db_menu.restore]="从备份恢复"
    [db_menu.list]="查看备份列表"
    [db_menu.stats]="查看数据库统计"
    [db_menu.schedule]="定时自动备份（每日，cron）"
    [db_menu.schedule_header]="━━━ 定时自动备份 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    [db_menu.schedule_install]="安装每日自动备份"
    [db_menu.schedule_remove]="取消每日自动备份"
    [db_menu.schedule_status]="查看备份列表与定时状态"
    [db_menu.back]="返回主菜单"
    [db_menu.prompt]="请选择: "
    [db_menu.schedule_prompt]="请选择 [0-3]: "
    [db_menu.restore_prompt]="备份文件路径: "
    [cancelled]="已取消"
    [status.server_header]="== 服务端 (Docker) =="
    [status.server_not_running]="  已安装但未运行 → 可选「5) 更新服务端」重建启动"
    [status.server_not_installed]="  未安装 → 请先「1) 安装服务端」"
    [status.agent_header]="== 受控端 (systemd) =="
    [status.agent_active]="  active"
    [status.agent_inactive]="  inactive / 未运行"
    [status.agent_not_installed]="  未安装"
    [reset.header]="== 重置管理员 Token =="
    [reset.confirm_prompt]="确认重置？输入 yes 继续: "
    [reset.cancelled]="已取消"
    [reset.ok]="[OK]   新管理员 Token 已生成"
    [reset.save]="[重要] 请立即保存！旧 Token 已失效，需用新 Token 登录。"
    [reset.warn]="[警告] 此操作将生成新的管理员 Token，旧 Token 立即失效！"
    [wl.header]="== 清除 IP 白名单 =="
    [wl.warn]="[警告] 清除后任何来源 IP 都能访问管理接口（安全性下降）。仅用于白名单配错把管理员锁在门外时的救援。"
    [wl.confirm_prompt]="确认清除？"
    [wl.cancelled]="已取消"
    [wl.empty]="当前未配置 IP 白名单（默认全放行），无需清除"
    [wl.empty_hint]="若仍无法登录，请检查 Nginx allow/deny、云防火墙或反代来源 IP 等其它拦截层。"
    [wl.current]="当前白名单:"
    [wl.ok]="IP 白名单已清除，管理接口恢复全放行"
    [wl.old_value]="原值:"
    [wl.hint]="[提示] 改库即时生效，无需重启；请重新登录后台确认。恢复正常后可在「设置」重新配置白名单。"
    [bk.total]="共"
    [bk.total_unit]="个备份"
    [bk.size]="占用"
    [bk.dir]="目录"
    [bk.range]="时间跨度"
    [bk.keep_tip]="保留策略"
    [bk.keep_days]="天（超出自动清理）"
    [bk.restore_hint]="恢复"
    [bk.auto_hint]="开启每日自动备份"
    [bk.pruning]="清理超过保留期的旧备份…"
    [bk.pruned]="已清理"
    [bk.pruned_unit]="个过期备份"
    [bk.cron_installed]="已安装每日自动备份（cron）"
    [bk.cron_hint]="[提示] 备份会落到默认目录并按保留天数轮转；请确认 cron 服务已运行。"
    [bk.cron_log]="日志"
    [bk.cron_remove]="取消自动备份"
    [bk.cron_removed]="已取消每日自动备份"
    [bk.cron_remove_failed]="取消自动备份失败，请手动执行 crontab -e 删除标记行"
    [bk.space_hint]="可减小保留天数（--keep-days）、清理旧的 pre_restore_*.db，或把备份目录挂到更大的分区。"
    [bk.compress_hint]="压缩: 开启（gzip，体积约 20%）"
    [bk.nocompress_hint]="压缩: 关闭（体积与数据库等大）"
    [bk.cron_active]="当前已启用每日自动备份："
    [bk.cron_none]="当前未启用每日自动备份"
    [wl.failed]="清除失败"
    [wl.read_failed]="无法读取数据库"
    [wl.node_hint]="原生部署要求宿主机 node 与 better-sqlite3 版本匹配；Docker 部署不受此影响。"
)
declare -A I18N_EN=(
    [menu.header]="━━━ 谛听轻量探针 Deploy  v%s (%s) ━━━━━━━━"
    [menu.os]="OS:"
    [menu.arch]="Arch:"
    [menu.notes]="Notes:"
    [menu.new_version]="▲ New version v%s available (current v%s), recommend '4) Update script'"
    [menu.up_to_date]="✓ Script up to date (v%s)"
    [menu.install_server]="Install Server (Docker)"
    [menu.install_agent]="Install Agent (systemd)"
    [menu.update_agent]="Update Agent (fetch latest)"
    [menu.update_script]="Update diting.sh (self)"
    [menu.update_server]="Update Server (fetch + rebuild)"
    [menu.status]="Status"
    [menu.uninstall]="Uninstall"
    [menu.db_manage]="Database (backup/restore/stats)"
    [menu.reset_token]="Reset Admin Token (rescue when lost)"
    [menu.switch_lang]="Switch Language / 切换语言"
    [menu.switch_lang.current]="Current UI language:"
    [menu.switch_lang.done]="✓ Saved; takes effect on menu redraw / restart"
    [menu.press_enter]="Press Enter to return to menu"
    [menu.clear_whitelist]="Clear IP Whitelist (rescue from lockout)"
    [menu.exit]="Exit"
    [menu.prompt]="Select [0-10]: "
    [menu.exit_msg]="Exit"

    [db_menu.header]="━━━ Database ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    [db_menu.backup]="Backup Database"
    [db_menu.restore]="Restore from Backup"
    [db_menu.list]="List Backups"
    [db_menu.stats]="Database Stats"
    [db_menu.schedule]="Scheduled daily backup (cron)"
    [db_menu.schedule_header]="━━━ Scheduled Backup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    [db_menu.schedule_install]="Install daily auto-backup"
    [db_menu.schedule_remove]="Remove daily auto-backup"
    [db_menu.schedule_status]="Show backups & schedule status"
    [db_menu.back]="Back to Main Menu"
    [db_menu.prompt]="Select: "
    [db_menu.schedule_prompt]="Select [0-3]: "
    [db_menu.restore_prompt]="Backup file path: "
    [cancelled]="Cancelled"
    [status.server_header]="== Server (Docker) =="
    [status.server_not_running]="  Installed but not running → try '5) Update Server'"
    [status.server_not_installed]="  Not installed → run '1) Install Server' first"
    [status.agent_header]="== Agent (systemd) =="
    [status.agent_active]="  active"
    [status.agent_inactive]="  inactive / not running"
    [status.agent_not_installed]="  Not installed"
    [reset.header]="== Reset Admin Token =="
    [reset.confirm_prompt]="Confirm? Type yes to continue: "
    [reset.cancelled]="Cancelled"
    [reset.ok]="[OK]   New admin token generated"
    [reset.save]="[Important] Save it now! Old token is invalid."
    [reset.warn]="[Warning] This will generate a new admin token. Old token will be invalid!"
    [wl.header]="== Clear IP Whitelist =="
    [wl.warn]="[Warning] After clearing, any source IP can reach the admin API (lower security). Only use this to recover from a misconfigured whitelist that locked you out."
    [wl.confirm_prompt]="Confirm clearing?"
    [wl.cancelled]="Cancelled"
    [wl.empty]="No IP whitelist configured (all allowed by default) - nothing to clear"
    [wl.empty_hint]="If you still cannot log in, check other blocking layers: Nginx allow/deny, cloud firewall, or reverse-proxy source IP."
    [wl.current]="Current whitelist:"
    [wl.ok]="IP whitelist cleared - admin API allows all sources again"
    [wl.old_value]="Old value:"
    [wl.hint]="[Note] Takes effect immediately (no restart). Log in again to confirm; you may re-configure the whitelist in Settings afterwards."
    [bk.total]="Total"
    [bk.total_unit]="backups"
    [bk.size]="Size"
    [bk.dir]="Dir"
    [bk.range]="Range"
    [bk.keep_tip]="Retention"
    [bk.keep_days]="days (older ones pruned)"
    [bk.restore_hint]="Restore"
    [bk.auto_hint]="Enable daily auto-backup"
    [bk.pruning]="Pruning backups older than retention…"
    [bk.pruned]="Pruned"
    [bk.pruned_unit]="expired backups"
    [bk.cron_installed]="Daily auto-backup installed (cron)"
    [bk.cron_hint]="[Note] Backups land in the default dir and rotate by retention days; make sure the cron service is running."
    [bk.cron_log]="Log"
    [bk.cron_remove]="Remove auto-backup"
    [bk.cron_removed]="Daily auto-backup removed"
    [bk.cron_remove_failed]="Failed to remove; please delete the tagged line via crontab -e"
    [bk.space_hint]="Try a smaller --keep-days, remove old pre_restore_*.db, or point the backup dir at a larger partition."
    [bk.compress_hint]="Compression: on (gzip, ~20% of size)"
    [bk.nocompress_hint]="Compression: off (same size as the database)"
    [bk.cron_active]="Daily auto-backup is enabled:"
    [bk.cron_none]="Daily auto-backup is not enabled"
    [wl.failed]="Failed to clear"
    [wl.read_failed]="cannot read the database"
    [wl.node_hint]="Native deployments require a host node matching better-sqlite3 ABI; Docker deployments are unaffected."
)

# ── 交互层（纯文本，对齐 komari 风格）──────────────────────────────────────────
# 菜单与输入统一走纯文本 read：装了图形库和没装，输出完全一致，
# SSH / 容器 / 极简系统上不再存在"两套渲染路径"。
#
# UI_TTY 在**顶层**一次性判定：ui_* 的返回值常被命令替换捕获（c="$(ui_menu ...)"），
# 命令替换会让函数内的 stdout 变成管道，[ -t 1 ] 恒为假——所以判据用 stdin + stderr。
UI_TTY=0
[[ -t 0 && -t 2 ]] && UI_TTY=1

# 交互式终端下清屏重绘，避免连续操作时屏幕越滚越长；非交互（管道/CI）只画一次。
# 调用点：菜单循环每轮开始处。
render_screen() {
    [[ "$UI_TTY" -eq 1 ]] && clear 2>/dev/null || true
    echo "" >&2
    printf "${BLUE}$(msg "menu.header")${NC}\n" "$SCRIPT_VERSION" "$SCRIPT_DATE" >&2
    echo -e "  $(msg "menu.os") ${GREEN}$(detect_os)${NC}  $(msg "menu.arch") ${GREEN}$(detect_arch)${NC}" >&2
    echo -e "  $(msg "menu.notes") ${SCRIPT_NOTES}" >&2
    return 0
}

# ui_menu <标题> <prompt> <"tag item" 列表...>
# 输出所选 tag 到 stdout；条目按 tag 补 "N)"。EOF（管道输入耗尽）→ return 1，
# 由调用方决定如何退出——**不能用 exit 0**，否则 `printf '' | diting.sh` 会被当成
# "用户正常退出"，CI 里静默成功。
ui_menu() {
    local title="$1"; shift
    local prompt="$1"; shift
    echo "" >&2
    [[ -n "$title" ]] && echo -e "${BLUE}${title}${NC}" >&2
    local i tag
    for ((i=1; i<=$#; i+=2)); do
        tag="${!i}"
        echo "  ${tag}) ${@:i+1:1}" >&2
    done
    echo "" >&2
    local c
    read -r -p "$prompt" c || return 1
    echo "$c"
}

# ui_prompt <标题> <提示> [默认值] → 输出到 stdout（回车 = 默认值；EOF → return 1）
# 标题参数保留以兼容既有调用点，纯文本模式下不再使用。
ui_prompt() {
    local _title="$1" text="$2" def="${3:-}"
    local v
    read -r -p "$text${def:+ [$def]}: " v || return 1
    echo "${v:-$def}"
}

# ui_confirm <标题> <提示> → 0=yes 1=no。空输入 = 取消（安全优先）。
# 刻意**不**照搬 komari ui_yesno 的"空=是"：本脚本的调用方含 uninstall_all /
# do_clear_ip_whitelist / --reset-admin-token，一次误回车就会卸载或使旧凭据失效。
ui_confirm() {
    local _title="$1" text="$2"
    local v
    read -r -p "$text (yes/no): " v || return 1
    [[ "$v" == "yes" || "$v" == "y" || "$v" == "Y" ]]
}

# ui_msg <标题> <消息> → 纯文本，统一走 stderr（不污染被命令替换捕获的 stdout）
ui_msg() {
    local title="$1" text="$2"
    echo -e "${BLUE}${title}${NC}" >&2
    echo "$text" >&2
}

# ── 菜单 ───────────────────────────────────────────────────────────────────────
# pause_return 输出型动作（如「查看状态」）执行完后的暂停：菜单每轮会清屏重绘，
# status_all 这类纯 echo 输出若不暂停会一闪而过（用户只见"秒退回菜单"）。
pause_return() {
    echo ""
    read -rp "—— $(msg "menu.press_enter") ——"
}

# switch_lang 菜单项动作：切换界面语言并持久化（纯 read，任何环境可用）。
switch_lang() {
    local cur="中文"; [[ "$I18N_LANG" == "en" ]] && cur="English"
    echo ""
    echo -e "$(msg "menu.switch_lang.current") ${GREEN}${cur}${NC}"
    local _c
    read -rp "  [1] 中文  [2] English (回车取消/Enter to cancel): " _c
    case "$_c" in
        1) I18N_LANG="zh"; save_lang zh; echo -e "${GREEN}$(msg "menu.switch_lang.done")${NC}" ;;
        2) I18N_LANG="en"; save_lang en; echo -e "${GREEN}$(msg "menu.switch_lang.done")${NC}" ;;
        *) return ;;
    esac
}

show_menu() {
    # 顶部信息：纯文本一套，始终打印（交互终端下先 clear 重绘）
    render_screen
    local _rv; _rv="$(remote_script_version)"
    if version_gt "$_rv" "$SCRIPT_VERSION"; then
        # msg 只做查表，%s 需由 printf 填充（否则会原样输出 "v%s"）
        printf "  ${YELLOW}$(msg "menu.new_version")${NC}\n" "$_rv" "$SCRIPT_VERSION" >&2
    elif [[ -n "$_rv" ]]; then
        printf "  ${GREEN}$(msg "menu.up_to_date")${NC}\n" "$SCRIPT_VERSION" >&2
    fi
    # 标题已由 render_screen 打印，菜单本身不再重复。
    local c
    c="$(ui_menu "" "$(msg "menu.prompt")" \
        "1" "$(msg "menu.install_server")" \
        "2" "$(msg "menu.install_agent")" \
        "3" "$(msg "menu.update_agent")" \
        "4" "$(msg "menu.update_script")" \
        "5" "$(msg "menu.update_server")" \
        "6" "$(msg "menu.status")" \
        "7" "$(msg "menu.uninstall")" \
        "8" "$(msg "menu.db_manage")" \
        "9" "$(msg "menu.reset_token")" \
        "10" "$(msg "menu.clear_whitelist")" \
        "11" "$(msg "menu.switch_lang")" \
        "0" "$(msg "menu.exit")" )" || exit 1
    # 空回车（非 EOF）→ 重绘菜单；EOF 已在上一行以非零退出，
    # 避免 `printf '' | diting.sh` 被当成"用户主动退出"而静默成功。
    [[ -z "$c" ]] && return
    case "$c" in
        1) install_server ;;
        2) install_agent ;;
        3) update_agent ;;
        4) update_script ;;
        5) update_server ;;
        6) status_all; pause_return ;;
        7) uninstall_all ;;
        8) db_manage_menu ;;
        9) do_reset_admin_token ;;
        10) do_clear_ip_whitelist ;;
        11) switch_lang ;;
        *) echo "$(msg "menu.exit_msg")"; exit 0 ;;
    esac
}

# ── 参数解析 ───────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --install-server) ACTION="server"; shift ;;
        # 监听端口：配合 --install-server（非交互部署用）。校验在 resolve_server_port 内做，
        # 非法值会让安装在任何写盘动作之前中止。
        --port)           need_val_guard "$1" "${2:-}"; A_SERVER_PORT="${2:-}"; shift 2 ;;
        # 跳过保护性检查；当前唯一用途是"升级前备份失败仍继续"
        --force)          A_FORCE=1; shift ;;
        --install-agent)  ACTION="agent";  shift ;;
        --update-script)  ACTION="update-script"; shift ;;
        --update-server)  ACTION="update-server"; shift ;;
        --update-agent)   ACTION="update-agent"; shift ;;
        --status)         ACTION="status"; shift ;;
        --uninstall)      ACTION="uninstall"; shift ;;
        # 兼容两种调用：--backup（默认目录）与 --backup <输出路径>。
        # 路径以 / 或 . 开头才当作输出路径，避免把后续选项（如 --status）误吞。
        --backup)
            ACTION="backup"; shift
            if [[ -n "${1:-}" && ( "$1" == /* || "$1" == ./* ) ]]; then
                A_BACKUP_PATH="$1"; shift
            fi
            ;;
        # 所有带值参数统一用 ${2:-}：脚本开头是 set -u，漏写值时裸 $2 会直接
        # 以「$2: unbound variable」中断，连用法提示都来不及打印。
        --restore)        need_val_guard "$1" "${2:-}"; A_RESTORE_PATH="${2:-}"; ACTION="restore"; shift 2 ;;
        --backup-list)    ACTION="backup-list"; shift ;;
        --db-stats)       ACTION="db-stats"; shift ;;
        --db-vacuum)      ACTION="db-vacuum"; shift ;;
        # 可选值：行数 / follow。只有长得像才吞掉下一个参数，避免把 --status 之类误当行数。
        --logs)
            ACTION="logs"; shift
            if [[ -n "${1:-}" && ( "$1" =~ ^[0-9]+$ || "$1" == "follow" || "$1" == "-f" ) ]]; then
                A_LOG_ARG="$1"; shift
            fi
            ;;
        --keep-days)      need_val_guard "$1" "${2:-}"; A_BACKUP_KEEP="${2:-}"; shift 2 ;;
        --no-compress)    DB_BACKUP_COMPRESS=0; shift ;;
        --compress)       DB_BACKUP_COMPRESS=1; shift ;;
        # 安装/取消/查看每日自动备份：--backup-schedule install|uninstall|status
        --backup-schedule)
            ACTION="backup-schedule"; A_BACKUP_SCHEDULE="${2:-status}"; shift
            [[ -n "${1:-}" && "$1" != --* ]] && { A_BACKUP_SCHEDULE="$1"; shift; }
            ;;
        --reset-admin-token) ACTION="reset-admin-token"; shift ;;
        --clear-ip-whitelist) ACTION="clear-ip-whitelist"; shift ;;
        # 版本发布：--release [patch|minor|major|X.Y.Z]（默认 patch）
        --release)
            ACTION="release"; shift
            [[ -n "${1:-}" && "$1" != --* ]] && { A_RELEASE="$1"; shift; }
            ;;
        # 消费后台「恢复」按钮投递的请求文件（仅供 cron 调用）
        --process-restore) ACTION="process-restore"; shift ;;
        --server)      need_val_guard "$1" "${2:-}"; A_SERVER="${2:-}"; shift 2 ;;
        --id)          need_val_guard "$1" "${2:-}"; A_ID="${2:-}"; shift 2 ;;
        --token)       need_val_guard "$1" "${2:-}"; A_TOKEN="${2:-}"; shift 2 ;;
        --token-file)  need_val_guard "$1" "${2:-}"; A_TOKEN_FILE="${2:-}"; shift 2 ;;
        --setup-token) need_val_guard "$1" "${2:-}"; A_SETUP="${2:-}"; shift 2 ;;
        --setup-name)  need_val_guard "$1" "${2:-}"; A_SETUP_NAME="${2:-}"; shift 2 ;;
        --interval)    need_val_guard "$1" "${2:-}"; A_INTERVAL="${2:-}"; shift 2 ;;
        --probe-targets) need_val_guard "$1" "${2:-}"; A_PROBE_TARGETS="${2:-}"; shift 2 ;;
        --month-rotate) need_val_guard "$1" "${2:-}"; A_MONTH_ROTATE="${2:-}"; shift 2 ;;
        --repo)        need_val_guard "$1" "${2:-}"; REPO_RAW="${2:-}"; shift 2 ;;
        -h|--help)     show_usage; exit 0 ;;
        *) echo -e "${RED}[错误] 未知参数: $1${NC}" >&2; show_usage; exit 1 ;;
    esac
done

# ── 入口 ───────────────────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
    echo -e "${RED}[错误] 必须以 root 运行（sudo bash diting.sh）${NC}" >&2
    exit 1
fi

if [[ -n "$ACTION" ]]; then
    case "$ACTION" in
        server)       install_server ;;
        agent)        install_agent ;;
        update-script) update_script ;;
        update-server) update_server ;;
        update-agent)  update_agent ;;
        status)       status_all ;;
        uninstall)    uninstall_all ;;
        backup)       do_backup "${A_BACKUP_PATH:-}" "${A_BACKUP_KEEP:-}" ;;
        backup-schedule) do_backup_schedule "${A_BACKUP_SCHEDULE:-status}" "${A_BACKUP_KEEP:-}" ;;
        restore)      do_restore "${A_RESTORE_PATH:-}" ;;
        backup-list)  do_backup_list ;;
        db-stats)     do_db_stats ;;
        db-vacuum)    do_db_vacuum ;;
        logs)         do_logs "${A_LOG_ARG:-}" ;;
        reset-admin-token) do_reset_admin_token ;;
        clear-ip-whitelist) do_clear_ip_whitelist ;;
        release)      do_release "${A_RELEASE:-patch}" ;;
        process-restore) process_restore_request || true ;;
    esac
elif [[ -t 0 ]]; then
    # 首次交互运行（无持久化语言选择）时询问一次；回车 = 采用环境判定结果。
    # 非交互（--action 命令行）模式不打扰，直接用环境判定。
    if ! load_saved_lang >/dev/null 2>&1; then
        echo "━━━ 请选择界面语言 / Select UI language ━━━"
        _c=""
        read -rp "  [1] 中文 (默认)  [2] English: " _c || _c=""
        case "$_c" in
            1) I18N_LANG="zh" ;;
            2) I18N_LANG="en" ;;
            *) : ;;
        esac
        save_lang "$I18N_LANG"   # 无论回车与否都落盘，避免每次启动重复询问
    fi
    while true; do show_menu; done
else
    show_usage
    exit 1
fi
