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
    # 运行目录分离（L2）后 .env 在仓库树外、由 unit 的 EnvironmentFile 指定
    # （如 /data/simple-probe-data/server-data/.env）：上面三个固定候选都会落空，
    # 不问 unit 要路径的话，本机 CLI 备份/恢复永远「无法定位数据库」（2026-11-12
    # 真机演练实测）。unit 优先于 Docker 卷判定：systemd 部署的机器即便装了
    # Docker 也不该把库操作指到无关卷上。
    local unit_env=""
    unit_env="$(server_env_file)"
    if [[ -n "$unit_env" && -f "$unit_env" ]]; then
        env_db="$(sed -n 's/^[[:space:]]*DB_PATH[[:space:]]*=[[:space:]]*//p' "$unit_env" | tail -n1)"
        env_db="${env_db%\"}"; env_db="${env_db#\"}"; env_db="${env_db%\'}"; env_db="${env_db#\'}"
        env_db="${env_db%%[[:space:]]*}"
        if [[ -n "$env_db" && -f "$env_db" ]]; then
            echo "file:$env_db"
            return
        fi
    fi
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

# 只清除「管理员凭据」（库哈希 + 历史残留键 + .env 的 ADMIN_TOKEN 行 + 管理密码/
# 恢复码/登录失败桶）并吊销全部旧会话（与 --reset-admin-token 同口径：水位线最先写，
# 旧 Cookie 立即失效），刻意不动节点指标/配置与 SESSION_SECRET/SETUP_TOKEN——
# 清凭据 ≠ 清数据，受控端一键注册等其余凭据保持有效。
# r1/§3.6①：密码/恢复码必须一并清——否则卸载重装后旧管理密码仍可登录（凭据残留）。
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
  // r1/§3.6①：管理密码/登录失败桶一并删；恢复码表旧库可能不存在，try/catch 容错。
  db.prepare("DELETE FROM admin_config WHERE key IN ('admin_token_hash','admin_token_raw','admin_initialized','admin_password_hash','login_guard_global')").run();
  try { db.prepare('DELETE FROM recovery_codes').run(); } catch (e) { /* 旧库无该表 */ }
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

# 补齐存量部署的 SESSION_SECRET（只处理 Docker 形态）。
# 为什么需要：install_server 的首装分支会生成 SESSION_SECRET，但 else 分支（既有 .env）
# 与 update_server 都不会补。旧部署该行为空/缺失时，服务端每次重启随机生成签名密钥，
# 后果不止登录态失效——distribution.js 由 SESSION_SECRET 派生 TOKEN_KEY，已发出的一次性
# 安装/下载链接会同时作废。
# 原生/systemd 形态不在此处理：脚本的安装/更新只覆盖 Docker（见 server_deploy_mode 注释），
# 原生部署由 server.js 启动时的「SESSION_SECRET 未设置」告警提示管理员手工补齐。
# 幂等：已有非空值一律不动。
ensure_session_secret() {
    local envf="$SRC_DIR/server/.env" cur sess
    [[ -f "$envf" ]] || return 0
    # P0-1：.env 含密钥，无论是否补齐都先收敛到 600 —— 此前提前 return 会跳过 chmod，
    # 「secret 已存在但权限宽」的存量 .env 永远收不紧。
    chmod 600 "$envf" 2>/dev/null || true
    cur="$(sed -n 's/^SESSION_SECRET=//p' "$envf" 2>/dev/null | tr -d '\r\n' | head -1 || true)"
    [[ -n "$cur" ]] && return 0
    sess="$(openssl rand -hex 32)"
    if grep -q '^SESSION_SECRET=' "$envf"; then
        sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=${sess}#" "$envf"
    else
        printf 'SESSION_SECRET=%s\n' "$sess" >> "$envf"
    fi
    echo -e "${GREEN}[OK]   已补齐 SESSION_SECRET（存量 .env 原值为空）${NC}"
    echo -e "${YELLOW}[提示] 重启后此前发出的一次性安装/下载链接将失效，需在后台重新生成${NC}"
    return 0
}

# 首装/存量 .env 初始化（P0-1：从 install_server 抽出，便于桩测试）。
#   - 首装：umask 077 创建（模板即便 644 也只落到 600），写入随机 SESSION_SECRET/SETUP_TOKEN，
#     落盘后显式 chmod 600 兜底（不依赖 sed -i 的权限实现差异）；
#   - 存量：只同步 PORT，凭据一律不动，ensure_session_secret 幂等补齐。
# 红线：.env 含 SESSION_SECRET/SETUP_TOKEN，任何路径创建/改写后权限必须收敛到 600
# （auth.js 对无 sid 的旧式签名 Cookie 仅验签放行，644 的 .env 等于可伪造管理员会话）。
init_env_file() {
    local port="${1:-}"
    if [[ -z "$port" ]]; then
        echo -e "${RED}[错误] init_env_file 需要端口参数${NC}" >&2
        return 1
    fi
    if [[ ! -f .env ]]; then
        ( umask 077; cp .env.example .env )
        chmod 600 .env
        local sess setup
        sess="$(openssl rand -hex 32)"
        setup="$(openssl rand -hex 16)"
        sed -i "s#^PORT=.*#PORT=${port}#" .env
        sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=${sess}#" .env
        sed -i "s#^SETUP_TOKEN=.*#SETUP_TOKEN=${setup}#" .env
        # 管理员凭据不预生成：由浏览器 /install 向导创建（对齐上游），库中只存 sha256 哈希，
        # 明文只在向导完成页显示一次。预生成会让"未安装"判据恒为 false，
        # 安装向导永远不会出现 —— 这正是旧版首装不弹引导的原因。
        sed -i "s#^ADMIN_TOKEN=.*#ADMIN_TOKEN=#" .env
        chmod 600 .env
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
        # 存量 .env 可能缺 SESSION_SECRET（旧版本/手工拷贝），补一次（幂等）。
        ensure_session_secret
    fi
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
    # P1-8：恢复目标必须位于备份目录内——realpath 后判定，拒绝 `..` 与软链逃逸。
    # 能写 restore.request 的本地用户不应借此让 root 把任意 SQLite 文件恢复进库。
    local real target_ok="" base realbase
    real="$(realpath "$file" 2>/dev/null || true)"
    _init_backup_dir
    for base in "${DB_BACKUP_DIR:-}" "${BACKUP_VISIBLE_DIR:-}"; do
        [[ -n "$base" ]] || continue
        realbase="$(realpath "$base" 2>/dev/null || true)"
        if [[ -n "$real" && -n "$realbase" && "$real" == "$realbase"/* ]]; then
            target_ok=1
            break
        fi
    done
    if [[ -z "$target_ok" ]]; then
        echo -e "${RED}[错误] 恢复目标不在备份目录内，已拒绝: ${file}${NC}" >&2
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

