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
