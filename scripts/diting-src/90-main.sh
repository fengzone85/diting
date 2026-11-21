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
    [menu.server_control]="服务端运行控制（启动/停止/重启）"
    [menu.exit]="退出"
    [menu.prompt]="请选择 [0-12]: "
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
    [status.server_header]="== 服务端 =="
    [status.server_not_running]="  已安装但未运行 → 用「12) 服务端运行控制」启动，或 --start-server"
    [status.server_not_installed]="  未安装 → 请先「1) 安装服务端」"
    [ctl.header]="━━━ 服务端运行控制 ━━━━━━━━━━━━━━━━━━━━━━━━━━"
    [ctl.start]="启动服务端"
    [ctl.stop]="停止服务端"
    [ctl.restart]="重启服务端"
    [ctl.status]="查看服务端状态（systemctl status / compose ps）"
    [ctl.back]="返回主菜单"
    [ctl.prompt]="请选择: "
    [ctl.done_start]="[OK]   服务端已启动"
    [ctl.done_stop]="[OK]   服务端已停止"
    [ctl.done_restart]="[OK]   服务端已重启"
    [ctl.not_found]="[错误] 未找到可控制的服务端（无 diting-server.service，也无 Docker compose 项目）"
    [ctl.failed]="[错误] 操作失败，请查看上方输出（systemd 部署可 journalctl -u diting-server 排查）"
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
    [menu.server_control]="Server control (start/stop/restart)"
    [menu.exit]="Exit"
    [menu.prompt]="Select [0-12]: "
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
    [status.server_header]="== Server =="
    [status.server_not_running]="  Installed but not running → use '12) Server control' or --start-server"
    [status.server_not_installed]="  Not installed → run '1) Install Server' first"
    [ctl.header]="━━━ Server Control ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    [ctl.start]="Start server"
    [ctl.stop]="Stop server"
    [ctl.restart]="Restart server"
    [ctl.status]="Show server status (systemctl status / compose ps)"
    [ctl.back]="Back to Main Menu"
    [ctl.prompt]="Select: "
    [ctl.done_start]="[OK]   Server started"
    [ctl.done_stop]="[OK]   Server stopped"
    [ctl.done_restart]="[OK]   Server restarted"
    [ctl.not_found]="[Error] No controllable server found (no diting-server.service, no Docker compose project)"
    [ctl.failed]="[Error] Operation failed; see output above (systemd: journalctl -u diting-server)"
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

# ── 交互层（纯文本，对齐上游风格）──────────────────────────────────────────
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
# 刻意**不**照搬上游 ui_yesno 的"空=是"：本脚本的调用方含 uninstall_all /
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
        "12" "$(msg "menu.server_control")" \
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
        # 两个救援动作都会打印关键信息（新 Token / 清除结果），必须暂停，
        # 否则菜单清屏后用户什么都看不到——「重置 Token 没反应」的根因。
        9) do_reset_admin_token; pause_return ;;
        10) do_clear_ip_whitelist; pause_return ;;
        11) switch_lang ;;
        12) server_ctl_menu ;;
        *) echo "$(msg "menu.exit_msg")"; exit 0 ;;
    esac
}

# ── 参数解析 ───────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --install-server) ACTION="server"; shift ;;
        --bundled-proxy) ACTION="bundled-proxy"; shift ;;
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
        # 服务端进程控制（原生 systemd / Docker 自动识别；纯进程操作，不改源码/数据）
        --start-server)   ACTION="start-server"; shift ;;
        --stop-server)    ACTION="stop-server"; shift ;;
        --restart-server) ACTION="restart-server"; shift ;;
        --deploy-server)  ACTION="deploy-server"; shift ;;
        --uninstall)      ACTION="uninstall"; shift ;;
        --uninstall-server) ACTION="uninstall-server"; shift ;;
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
        --reset-admin-password) ACTION="reset-admin-password"; shift ;;
        --reset-2fa) ACTION="reset-2fa"; shift ;;
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
# deploy-server 只写目标运行副本目录（默认 server-data/app，属当前用户），无需 root；
# 其余动作涉及 systemd/安装路径，仍要求 root。
if [[ "$(id -u)" -ne 0 && "$ACTION" != "deploy-server" ]]; then
    echo -e "${RED}[错误] 必须以 root 运行（sudo bash diting.sh）${NC}" >&2
    exit 1
fi

if [[ -n "$ACTION" ]]; then
    case "$ACTION" in
        server)       install_server ;;
        bundled-proxy) setup_bundled_proxy ;;
        agent)        install_agent ;;
        update-script) update_script ;;
        update-server) update_server ;;
        update-agent)  update_agent ;;
        status)       status_all ;;
        start-server)   server_ctl start ;;
        stop-server)    server_ctl stop ;;
        restart-server) server_ctl restart ;;
        deploy-server)  deploy_server ;;
        uninstall)    uninstall_all ;;
        uninstall-server) uninstall_server ;;
        backup)       do_backup "${A_BACKUP_PATH:-}" "${A_BACKUP_KEEP:-}" ;;
        backup-schedule) do_backup_schedule "${A_BACKUP_SCHEDULE:-status}" "${A_BACKUP_KEEP:-}" ;;
        restore)      do_restore "${A_RESTORE_PATH:-}" ;;
        backup-list)  do_backup_list ;;
        db-stats)     do_db_stats ;;
        db-vacuum)    do_db_vacuum ;;
        logs)         do_logs "${A_LOG_ARG:-}" ;;
        reset-admin-token) do_reset_admin_token ;;
        reset-admin-password) do_reset_admin_password ;;
        reset-2fa) do_reset_2fa ;;
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
