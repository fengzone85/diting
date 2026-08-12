#!/usr/bin/env bash
#
# diting 一键部署 / 管理脚本
# 参考 komari 的 TUI 交互框架（whiptail/dialog + 纯文本回退）
#
# 用法：
#   bash install-diting.sh          # 进入交互菜单
#   bash install-diting.sh install  # 非交互：安装（需已存在 /opt/diting 并配好 .env）
#   bash install-diting.sh upgrade  # 非交互：升级
#   bash install-diting.sh status   # 非交互：状态
#
set -euo pipefail

# ============ 全局配置 ============
INSTALL_DIR="/opt/diting"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
ENV_FILE="${INSTALL_DIR}/server/.env"
ENV_EXAMPLE="${INSTALL_DIR}/server/.env.example"
DATA_DIR="${INSTALL_DIR}/server-data"
# 默认部署分支（新 Vue SPA 管理端）；如需稳定旧版改为 master
DEFAULT_BRANCH="feature/vue-spa-admin-rewrite"
DEFAULT_REPO="https://github.com/fengzone85/diting.git"

# ============ 日志层 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

# ============ TUI 探测 ============
TUI_TOOL=""
detect_tui() {
    if command -v whiptail >/dev/null 2>&1; then TUI_TOOL="whiptail"
    elif command -v dialog >/dev/null 2>&1; then TUI_TOOL="dialog"
    else TUI_TOOL=""
    fi
}
detect_tui
tui_enabled() { [ -n "$TUI_TOOL" ]; }

# ============ TUI 组件 ============
# 菜单：$1=标题 $2=提示 $3=默认tag 其余为 "tag label" 对
# 输出选择到 stdout（TUI 模式用 3>&1 1>&2 2>&3 翻转）
ui_menu() {
    local title="$1" prompt="$2" default="${3:-}"; shift 3 || true
    if tui_enabled; then
        local args=(--title "$title" --menu "$prompt" 18 70 10)
        [ -n "$default" ] && args+=(--default-item "$default")
        while [ $# -gt 0 ]; do args+=("$1" "$2"); shift 2 || true; done
        local result
        if [ "$TUI_TOOL" = "whiptail" ]; then
            result=$(whiptail "${args[@]}" 3>&1 1>&2 2>&3) || return 1
        else
            result=$(dialog "${args[@]}" 2>&1 1>&2 3>&1) || return 1
        fi
        echo "$result"
    else
        echo "$title" >&2
        echo "$prompt" >&2
        local i=1
        while [ $# -gt 0 ]; do
            echo "  $1) $2" >&2
            shift 2 || true
        done
        echo -n "请选择 [${default:-1}]: " >&2
        local choice; read -r choice
        echo "${choice:-$default}"
    fi
}

# 文本输入：$1=标题 $2=提示 $3=默认值
ui_input() {
    local title="$1" prompt="$2" default="${3:-}"
    if tui_enabled; then
        local result
        if [ "$TUI_TOOL" = "whiptail" ]; then
            result=$(whiptail --title "$title" --inputbox "$prompt" 10 70 "$default" 3>&1 1>&2 2>&3) || return 1
        else
            result=$(dialog --title "$title" --inputbox "$prompt" 10 70 "$default" 2>&1 1>&2 3>&1) || return 1
        fi
        echo "$result"
    else
        echo "$title" >&2
        echo -n "$prompt [$default]: " >&2
        local v; read -r v
        echo "${v:-$default}"
    fi
}

# 密码输入（隐藏）：$1=标题 $2=提示
ui_password() {
    local title="$1" prompt="$2"
    if tui_enabled; then
        local result
        if [ "$TUI_TOOL" = "whiptail" ]; then
            result=$(whiptail --title "$title" --passwordbox "$prompt" 10 70 3>&1 1>&2 2>&3) || return 1
        else
            result=$(dialog --title "$title" --passwordbox "$prompt" 10 70 2>&1 1>&2 3>&1) || return 1
        fi
        echo "$result"
    else
        echo "$title" >&2
        echo -n "$prompt (输入不显示): " >&2
        local v; read -r -s v; echo >&2
        echo "$v"
    fi
}

# 确认框：$1=标题 $2=提示 → 返回 0=是 1=否
ui_yesno() {
    local title="$1" prompt="$2"
    if tui_enabled; then
        if [ "$TUI_TOOL" = "whiptail" ]; then
            whiptail --title "$title" --yesno "$prompt" 12 60
        else
            dialog --title "$title" --yesno "$prompt" 12 60
        fi
    else
        echo "$title" >&2
        echo -n "$prompt [y/N]: " >&2
        local v; read -r v
        case "$v" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
    fi
}

# 消息框：$1=标题 $2=文本
ui_msgbox() {
    local title="$1" text="$2"
    if tui_enabled; then
        if [ "$TUI_TOOL" = "whiptail" ]; then
            whiptail --title "$title" --msgbox "$text" 12 70
        else
            dialog --title "$title" --msgbox "$text" 12 70
        fi
    else
        echo "=== $title ===" >&2
        echo "$text" >&2
        # 纯文本模式也等待用户确认，避免结果一闪而过
        # 非交互环境（read 读 EOF）用 3 秒超时兜底
        read -r -t 3 -p "按回车返回菜单..." _ 2>/dev/null || true
        echo >&2
    fi
}

# ============ 工具函数 ============
rand_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | xxd -p; }

need_root() {
    if [ "$(id -u)" -ne 0 ]; then
        log_error "本脚本需要 root 权限，请使用 sudo 或 root 用户运行"
        exit 1
    fi
}

check_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        log_error "未检测到 docker，请先安装：https://docs.docker.com/get-docker/"
        return 1
    fi
    if ! docker compose version >/dev/null 2>&1 && ! docker-compose version >/dev/null 2>&1; then
        log_error "未检测到 docker compose 插件，请安装 docker compose"
        return 1
    fi
    return 0
}

docker_compose() {
    if docker compose version >/dev/null 2>&1; then
        docker compose -f "$COMPOSE_FILE" "$@"
    else
        docker-compose -f "$COMPOSE_FILE" "$@"
    fi
}

# ============ 业务：首次部署 .env 引导 ============
generate_env() {
    log_step "交互式生成 server/.env"
    if [ ! -f "$ENV_EXAMPLE" ]; then
        log_error "找不到 .env.example：$ENV_EXAMPLE"
        return 1
    fi

    # 端口
    local port
    port=$(ui_input "服务端口" "请输入 diting 服务端监听端口（容器内外一致）:" "8081") || return 1
    while ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; do
        port=$(ui_input "服务端口" "端口非法，请输入 1-65535 之间的数字:" "8081") || return 1
    done

    # 管理员 Token（必填，支持自动生成）
    local admin_token
    if ui_yesno "管理员 Token" "是否自动生成一个强随机管理员 Token？\n（选“否”可手动输入自定义 Token）"; then
        admin_token=$(rand_hex 24)
        log_success "已自动生成管理员 Token：$admin_token"
        log_warn "请妥善保存此 Token，首次登录后台时需要使用"
    else
        admin_token=$(ui_password "管理员 Token" "请输入管理员 Token（用于后台管理，必填，请使用强随机串）:") || return 1
        while [ -z "$admin_token" ]; do
            admin_token=$(ui_password "管理员 Token" "Token 不能为空，请重新输入:") || return 1
        done
    fi

    # 会话签名密钥（自动生成建议，可改）
    local session_secret; session_secret=$(rand_hex 32)
    session_secret=$(ui_input "会话密钥" "会话 Cookie 签名密钥（留空则自动生成）:" "$session_secret") || return 1

    # 自助注册 Token（可选）
    local setup_token
    if ui_yesno "自助注册" "是否启用受控端自助注册 Token（agent 可免手动建档）？"; then
        setup_token=$(rand_hex 16)
        setup_token=$(ui_input "注册 Token" "请输入 SETUP_TOKEN（留空自动生成）:" "$setup_token") || return 1
    else
        setup_token=""
    fi

    # 只读 Token（可选）
    local readonly_token=""
    if ui_yesno "只读账号" "是否创建只读 Token（仅查看，不能增删改）？"; then
        readonly_token=$(rand_hex 16)
        readonly_token=$(ui_input "只读 Token" "请输入 READONLY_TOKEN（留空自动生成）:" "$readonly_token") || return 1
    fi

    # 告警邮箱（可选）
    local smtp_user="" smtp_pass="" alert_to=""
    if ui_yesno "邮件告警" "是否配置 QQ SMTP 邮件告警？"; then
        smtp_user=$(ui_input "QQ 邮箱" "请输入 QQ 邮箱（如 123456@qq.com）:" "") || return 1
        smtp_pass=$(ui_password "邮箱授权码" "请输入 QQ 邮箱授权码:") || return 1
        alert_to=$(ui_input "告警接收" "接收告警的邮箱（默认同发件人）:" "${smtp_user}") || return 1
    fi

    # 写出 .env（基于 .env.example，覆盖关键字段）
    mkdir -p "$(dirname "$ENV_FILE")"
    {
        # 基础（必填）
        echo "PORT=${port}"
        echo "DB_PATH=/data/monitor.db"
        echo "ADMIN_TOKEN=${admin_token}"
        echo "SESSION_SECRET=${session_secret}"
        echo "SESSION_TTL_MS=43200000"
        echo "SETUP_TOKEN=${setup_token}"
        echo "READONLY_TOKEN=${readonly_token}"
        # 监控节奏
        echo "AGENT_INTERVAL=15"
        echo "OFFLINE_THRESHOLD_SEC=60"
        echo "RETENTION_DAYS=30"
        # 告警阈值
        echo "ALERT_CPU_PCT=90"
        echo "ALERT_MEM_PCT=90"
        echo "ALERT_COOLDOWN_SEC=1800"
        # SMTP（按需）
        if [ -n "$smtp_user" ]; then
            echo "SMTP_HOST=smtp.qq.com"
            echo "SMTP_PORT=465"
            echo "SMTP_SECURE=true"
            echo "SMTP_USER=${smtp_user}"
            echo "SMTP_PASS=${smtp_pass}"
            echo "ALERT_FROM=${smtp_user}"
            echo "ALERT_TO=${alert_to}"
        fi
        echo "TELEGRAM_BOT_TOKEN="
        echo "TELEGRAM_CHAT_ID="
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log_success "已生成 $ENV_FILE（权限 600）"
}

# ============ 业务：安装 / 升级 / 卸载 / 状态 ============
install_diting() {
    log_step "安装 diting"
    need_root
    check_docker || return 1

    if [ ! -d "$INSTALL_DIR" ]; then
        log_step "克隆仓库到 $INSTALL_DIR（分支: $DEFAULT_BRANCH）"
        local repo
        repo=$(ui_input "仓库地址" "请输入 diting 仓库地址:" "$DEFAULT_REPO") || return 1
        git clone -b "$DEFAULT_BRANCH" "$repo" "$INSTALL_DIR" || { log_error "克隆失败"; return 1; }
    fi
    cd "$INSTALL_DIR"

    if [ ! -f "$ENV_FILE" ]; then
        log_warn "未找到 $ENV_FILE，进入首次部署引导"
        generate_env || return 1
    else
        log_info "已存在 .env，跳过引导（如需重配请手动编辑 $ENV_FILE）"
    fi

    log_step "启动服务（docker compose up -d --build）"
    docker_compose up -d --build
    log_success "diting 已启动，访问 http://<本机IP>:${PORT:-8081}"
}

upgrade_diting() {
    log_step "升级 diting"
    need_root
    check_docker || return 1
    [ -d "$INSTALL_DIR" ] || { log_error "未找到 $INSTALL_DIR，请先安装"; return 1; }
    cd "$INSTALL_DIR"
    log_step "切换到部署分支 $DEFAULT_BRANCH"
    git checkout "$DEFAULT_BRANCH" 2>/dev/null || git checkout -b "$DEFAULT_BRANCH" "origin/$DEFAULT_BRANCH" 2>/dev/null || true
    log_step "拉取最新代码"
    git pull --ff-only || { log_warn "git pull 失败，可能本地有改动，跳过"; }
    log_step "重建并重启（保留 server-data 卷）"
    docker_compose up -d --build
    log_success "升级完成"
}

uninstall_diting() {
    log_step "卸载 diting"
    if ! ui_yesno "确认卸载" "将停止并删除 diting 容器与镜像。\n数据卷 server-data 也会被删除（监控数据不可恢复）。\n确定要继续吗？"; then
        log_info "已取消卸载"
        return 0
    fi
    need_root
    [ -f "$COMPOSE_FILE" ] || { log_error "未找到 $COMPOSE_FILE"; return 1; }
    cd "$INSTALL_DIR"
    docker_compose down -v --rmi local 2>/dev/null || docker_compose down -v
    log_success "diting 已卸载（代码目录 $INSTALL_DIR 保留，可手动删除）"
}

status_diting() {
    log_step "diting 状态"
    if [ ! -f "$COMPOSE_FILE" ]; then
        log_warn "未安装（找不到 $COMPOSE_FILE）"
        return 0
    fi
    cd "$INSTALL_DIR"
    docker_compose ps
    local port; port=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 8081)
    if curl -fsS "http://localhost:${port:-8081}/api/version" >/dev/null 2>&1; then
        log_success "服务探活正常（:${port:-8081}）"
    else
        log_warn "服务未响应 /api/version，请查看日志"
    fi
}

logs_diting() {
    log_step "查看日志（Ctrl+C 退出）"
    [ -f "$COMPOSE_FILE" ] || { log_error "未安装"; return 1; }
    cd "$INSTALL_DIR"
    docker_compose logs -f
}

restart_diting() {
    log_step "重启服务"
    need_root
    [ -f "$COMPOSE_FILE" ] || { log_error "未安装"; return 1; }
    cd "$INSTALL_DIR"
    docker_compose restart
    log_success "已重启"
}

stop_diting() {
    log_step "停止服务"
    need_root
    [ -f "$COMPOSE_FILE" ] || { log_error "未安装"; return 1; }
    cd "$INSTALL_DIR"
    docker_compose stop
    log_success "已停止"
}

# 操作后暂停：固定 sleep 等待（不依赖 stdin，避免非交互环境 read 秒过）
# 若 stdin 是真实 TTY，则允许按回车提前跳过；否则纯等待 PAUSE_SECONDS 秒
PAUSE_SECONDS=4
press_any_key() {
    echo "操作已完成。${PAUSE_SECONDS} 秒后返回菜单（TTY 下可按回车跳过）..." >&2
    if [ -t 0 ]; then
        # 真实终端：回车立即返回，否则等 PAUSE_SECONDS 秒
        read -r -t "$PAUSE_SECONDS" _ 2>/dev/null || true
    else
        sleep "$PAUSE_SECONDS"
    fi
}

# ============ 横幅 + 主菜单 ============
show_banner() {
    if tui_enabled; then clear; fi
    cat <<'EOF'

================================================
        d i t i n g   监控面板
        一键部署 / 管理脚本
================================================

EOF
}

main_menu() {
    while true; do
        show_banner
        local choice
        choice=$(ui_menu "diting 管理菜单" "请选择操作：" "1" \
            "1" "安装 / 部署 diting（首次含 .env 引导）" \
            "2" "升级 diting（拉取代码 + 重建，保留数据）" \
            "3" "卸载 diting（含数据卷，需确认）" \
            "4" "查看状态（容器 + 探活）" \
            "5" "查看日志（实时 tail）" \
            "6" "重启服务" \
            "7" "停止服务" \
            "8" "退出" ) || choice="8"

        case "$choice" in
            1) install_diting ;;
            2) upgrade_diting ;;
            3) uninstall_diting ;;
            4) status_diting ;;
            5) logs_diting ;;
            6) restart_diting ;;
            7) stop_diting ;;
            8) log_info "再见"; exit 0 ;;
            *) ui_msgbox "错误" "无效选项：$choice" ;;
        esac

        # 操作后统一暂停，避免结果一闪而过（回车立即返回，5 秒兜底）
        press_any_key
    done
}

# ============ 入口 ============
case "${1:-menu}" in
    install)  install_diting ;;
    upgrade)  upgrade_diting ;;
    uninstall) uninstall_diting ;;
    status)   status_diting ;;
    logs)     logs_diting ;;
    restart)  restart_diting ;;
    stop)     stop_diting ;;
    menu|"")  main_menu ;;
    *) echo "用法: $0 [install|upgrade|uninstall|status|logs|restart|stop|menu]"; exit 1 ;;
esac
