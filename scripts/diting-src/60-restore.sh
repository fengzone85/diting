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
# P0-2：对「目标侧临时副本」复核。源文件已在解压后做过 integrity_check（_restore_apply），
# 这里防的是复制中断/磁盘满导致的半截文件被 mv 上位。有 sqlite3 用 integrity_check，
# 没有则退回字节数比对。
_restore_verify_tmp() {
    local tmp="$1" src="$2"
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$tmp" "PRAGMA integrity_check;" 2>/dev/null | grep -qx "ok" && return 0
        return 1
    fi
    local a b
    a="$(stat -c %s "$src" 2>/dev/null || echo "")"
    b="$(stat -c %s "$tmp" 2>/dev/null || echo "")"
    [[ -n "$a" && "$a" == "$b" ]]
}

# P0-2：恢复替换段的停服兜底。无论 _restore_apply 成败（含 RETURN trap 路径），
# 把替换前停掉的服务拉回运行态，绝不把生产留在停止态。未停过服时幂等无操作。
_restore_ensure_started() {
    case "${RESTORE_STOPPED_MODE:-}" in
        systemd)
            systemctl start diting-server.service >/dev/null 2>&1 || true
            ;;
        compose)
            if [[ -n "${SRC_DIR:-}" && -d "$SRC_DIR/server" ]]; then
                ( cd "$SRC_DIR/server" && timeout 180 docker compose up -d 2>/dev/null ) || true
            fi
            ;;
        docker)
            local cid svc proj
            cid="${RESTORE_STOPPED_CID:-}"
            svc="${RESTORE_STOPPED_SVC:-server}"
            timeout 180 docker start "$cid" >/dev/null 2>&1 || true
            # compose 管理的容器用 compose up 更稳妥（保留替换前的既有语义）
            proj="$(timeout 180 docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$cid" 2>/dev/null)"
            if [[ -n "$proj" && -n "${SRC_DIR:-}" && -d "$SRC_DIR/server" ]]; then
                ( cd "$SRC_DIR/server" && timeout 180 docker compose up -d "$svc" 2>/dev/null ) || timeout 180 docker start "$cid" >/dev/null 2>&1 || true
            fi
            ;;
        volume)
            [[ -n "${RESTORE_STOPPED_CID:-}" ]] && timeout 180 docker start "${RESTORE_STOPPED_CID}" >/dev/null 2>&1 || true
            ;;
    esac
    RESTORE_STOPPED_MODE=""
    RESTORE_STOPPED_CID=""
    RESTORE_STOPPED_SVC=""
}

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
    # 停服状态由替换段置位、RETURN trap 经 _restore_ensure_started 消费；
    # 进来先清零，防同 shell 上一次调用残留。
    RESTORE_STOPPED_MODE=""
    RESTORE_STOPPED_CID=""
    RESTORE_STOPPED_SVC=""
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
    # 无论成功失败都清理临时解压/标记副本；替换段停过服时由 _restore_ensure_started
    # 在函数返回路径统一拉起服务（P0-2：失败路径不得把生产留在停止态）
    trap '[[ -n "${tmp_dec:-}" && -f "${tmp_dec:-}" ]] && rm -f "$tmp_dec"; [[ -n "${marked_tmp:-}" && -f "${marked_tmp:-}" ]] && rm -f "$marked_tmp"; _restore_ensure_started' RETURN

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
    # P0-2 三分支共同约束：① 先停服再写（运行中直写会损坏库）② 目标同目录临时文件
    # + mv 原子 rename（跨文件系统 mv 非原子）③ 复制后对目标侧副本复核
    # ④ 失败保留原库与 .bak；服务恢复由 _restore_apply 的 RETURN trap 统一兜底。
    if [[ "$loc" == docker:* ]]; then
        local cid svc cpath
        cid="$(echo "$loc" | cut -d: -f2)"
        svc="$(echo "$loc" | cut -d: -f3)"
        cpath="$(echo "$loc" | cut -d: -f4)"
        echo -e "${YELLOW}[信息] 停止服务端容器以安全替换数据库…${NC}"
        timeout 180 docker stop "$cid" >/dev/null 2>&1 || true
        RESTORE_STOPPED_MODE=docker
        RESTORE_STOPPED_CID="$cid"
        RESTORE_STOPPED_SVC="$svc"
        # 注意：必须用解压后的 restore_src，绝不能用 in_path（可能是 .gz，
        # 直接拷进去会把数据库写坏）。先拷进容器内同目录临时文件再 mv 原子替换：
        # 直接 docker cp 覆盖目标，中断时会留半截库。
        if ! timeout 180 docker cp "$restore_src" "${cid}:${cpath}.restore.tmp" 2>/dev/null; then
            echo -e "${RED}[错误] 恢复文件拷入容器失败，已放弃（原库未动）${NC}" >&2
            return 1
        fi
        local srcsz cpsz
        srcsz="$(stat -c %s "$restore_src" 2>/dev/null || echo "")"
        cpsz="$(timeout 180 docker exec "$cid" stat -c %s "${cpath}.restore.tmp" 2>/dev/null | tr -d '\r\n' || echo "")"
        if [[ -z "$srcsz" || "$srcsz" != "$cpsz" ]]; then
            timeout 180 docker exec "$cid" rm -f "${cpath}.restore.tmp" >/dev/null 2>&1 || true
            echo -e "${RED}[错误] 容器内恢复副本不完整，已放弃（原库未动）${NC}" >&2
            return 1
        fi
        # 同宿主机分支：docker cp 产物是 root 属主，替换前按容器内原库校准（P0-2）
        timeout 180 docker exec "$cid" chown --reference="${cpath}" "${cpath}.restore.tmp" >/dev/null 2>&1 || true
        timeout 180 docker exec "$cid" chmod --reference="${cpath}" "${cpath}.restore.tmp" >/dev/null 2>&1 || true
        if ! timeout 180 docker exec "$cid" mv -f "${cpath}.restore.tmp" "${cpath}" >/dev/null 2>&1; then
            timeout 180 docker exec "$cid" rm -f "${cpath}.restore.tmp" >/dev/null 2>&1 || true
            echo -e "${RED}[错误] 容器内原子替换失败，已放弃（原库未动）${NC}" >&2
            return 1
        fi
        timeout 180 docker exec "$cid" rm -f "${cpath}-wal" "${cpath}-shm" >/dev/null 2>&1 || true
        echo -e "${YELLOW}[信息] 替换完成，准备重启服务端…${NC}"
    elif [[ "$loc" == volume:* ]]; then
        local vol; vol="$(echo "$loc" | cut -d: -f2)"
        echo -e "${YELLOW}[信息] 通过临时容器写入卷…${NC}"
        # locate_db 给 volume: 形态 = 卷存在但容器未运行；仍防御性复查一次（能停则停）
        local vcid
        vcid="$(docker ps -q --filter "volume=$vol" 2>/dev/null | head -n1)"
        if [[ -n "$vcid" ]]; then
            echo -e "${YELLOW}[信息] 卷仍被容器 ${vcid} 使用，先停止…${NC}"
            timeout 180 docker stop "$vcid" >/dev/null 2>&1 || true
            RESTORE_STOPPED_MODE=volume
            RESTORE_STOPPED_CID="$vcid"
        fi
        # 卷内临时文件 + cmp 完整性比对 + mv 原子替换（busybox 自带 cmp/mv）；
        # 同样必须用解压后的文件（临时解压文件在 /tmp，需按其所在目录挂载）。
        local srcdir srcname
        srcdir="$(dirname "$restore_src")"
        srcname="$(basename "$restore_src")"
        # busybox 无 chown --reference：数值化捕获原库 uid:gid/mode 再套到 tmp 上（P0-2）
        if ! timeout 180 docker run --rm -v "$vol":/data -v "$srcdir":/in alpine:3.20 sh -c \
            "cp '/in/$srcname' /data/monitor.db.restore.tmp \
             && cmp -s '/in/$srcname' /data/monitor.db.restore.tmp \
             && { ref=\"\$(stat -c '%u:%g' /data/monitor.db 2>/dev/null)\"; md=\"\$(stat -c '%a' /data/monitor.db 2>/dev/null)\"; \
                  [ -n \"\$ref\" ] && chown \"\$ref\" /data/monitor.db.restore.tmp; \
                  [ -n \"\$md\" ] && chmod \"\$md\" /data/monitor.db.restore.tmp; true; } \
             && mv -f /data/monitor.db.restore.tmp /data/monitor.db \
             && rm -f /data/monitor.db-wal /data/monitor.db-shm" 2>/dev/null; then
            timeout 180 docker run --rm -v "$vol":/data alpine:3.20 rm -f /data/monitor.db.restore.tmp 2>/dev/null || true
            echo -e "${RED}[错误] 卷内恢复失败，已放弃（原库未动）${NC}" >&2
            return 1
        fi
    else
        local fpath; fpath="$(echo "$loc" | cut -d: -f2)"
        echo -e "${YELLOW}[信息] 替换宿主机数据库文件…${NC}"
        # 停服（P0-2）：原生 systemd 部署先 systemctl stop，compose 部署 down；
        # 两者都识别不了时显式告警后继续（替换动作本身仍是原子的）。
        if systemctl cat diting-server.service >/dev/null 2>&1; then
            echo -e "${YELLOW}[信息] 停止 diting-server（systemd）…${NC}"
            if systemctl stop diting-server.service; then
                RESTORE_STOPPED_MODE=systemd
            else
                echo -e "${RED}[错误] 停服失败，放弃恢复（避免运行中直写）${NC}" >&2
                return 1
            fi
        elif [[ -n "${SRC_DIR:-}" && -d "$SRC_DIR/server" ]] \
            && ( cd "$SRC_DIR/server" && docker compose ps -q 2>/dev/null | grep -q . ); then
            echo -e "${YELLOW}[信息] 停止服务端容器（compose）…${NC}"
            ( cd "$SRC_DIR/server" && timeout 180 docker compose down 2>/dev/null ) || true
            RESTORE_STOPPED_MODE=compose
        else
            echo -e "${YELLOW}[警告] 未识别到运行中的服务端（systemd/compose），按停服态继续替换${NC}"
        fi
        cp "$fpath" "${fpath}.before_restore.bak"
        # 临时文件必须与目标同目录：跨文件系统 mv 不是原子 rename
        if ! cp "$restore_src" "${fpath}.restore.tmp"; then
            echo -e "${RED}[错误] 写入临时恢复文件失败，已放弃（原库未动）${NC}" >&2
            return 1
        fi
        if ! _restore_verify_tmp "${fpath}.restore.tmp" "$restore_src"; then
            rm -f "${fpath}.restore.tmp"
            echo -e "${RED}[错误] 恢复副本完整性校验未通过，已放弃（原库未动）${NC}" >&2
            return 1
        fi
        # mv 上位的 tmp 是 root 产物，会把属主/权限一起换掉——服务以非 root 运行时
        # 直接 SQLITE_CANTOPEN（2026-11-12 真机演练实测）。替换前按原库校准。
        chown --reference="$fpath" "${fpath}.restore.tmp" 2>/dev/null || true
        chmod --reference="$fpath" "${fpath}.restore.tmp" 2>/dev/null || true
        mv -f "${fpath}.restore.tmp" "$fpath"
        # 现网是 rollback journal，下面两个文件通常不存在；保留删除是为了将来
        # 启用 WAL 后不把旧日志带进新库（见「原子替换」开头的说明）。
        rm -f "${fpath}-wal" "${fpath}-shm" 2>/dev/null || true
    fi

    # 替换完成：把服务拉回运行态（幂等；中途失败由 RETURN trap 兜底）
    _restore_ensure_started

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

