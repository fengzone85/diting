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
  // r3/P0-2：连登录全局失败计数一并清——「重置凭据以便重新拿回访问权」的语义包含它，
  // 否则密码通道的节流计数残留（旧版曾是封禁态，救援链断裂）。
  db.prepare("DELETE FROM admin_config WHERE key IN ('admin_token_raw','admin_initialized','login_guard_global')").run();
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
        # P2-6：Token 走 curl 配置（stdin）而非 -H argv——argv 会被同机用户从
        # /proc/*/cmdline 读到。curl -K - 从 stdin 读配置，凭据不落命令行。
        code="$(printf 'header = "X-Forwarded-Proto: https"\nheader = "X-Admin-Token: %s"\n' "${new_token}" \
            | curl -s -o /dev/null -w '%{http_code}' --max-time 5 -K - \
            "http://127.0.0.1:${port}/api/admin/alert-rules" 2>/dev/null || echo 000)"
        [[ "$code" == "200" ]] && break
        sleep 2
    done

    echo ""
    echo -e "${GREEN}$(msg "reset.ok")${NC}"
    echo ""
    # 裸行输出：带前导空格时用户整行复制会把空格一起粘进登录框 → 401（无任何提示），
    # 现场排查成本极高。Token 自身不含空白，单独一行最安全。
    echo "$new_token"
    echo ""
    echo -e "${YELLOW}$(msg "reset.save")${NC}"
    # r1/§3.6②：token 重置不动管理密码——必须明说，避免用户以为凭据已全部换新。
    echo -e "${YELLOW}[提示] 管理密码未变动；如需一并清除：后台「登录会话」页清除，或 sudo bash diting.sh --reset-admin-password${NC}"

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

# 重置管理密码（清密码+恢复码，回到纯 Token 登录）：仅通过 SSH 在服务器上运行。
# 与 --reset-admin-token 同口径（r1/§3.6）：水位线最先写 → 全会话吊销 → 删凭据键；
# 写库即时生效、不重启。覆盖「忘记密码」「密码+Token 全丢」救援路径（§3.7）。
do_reset_admin_password() {
    echo "== 重置管理密码 =="
    echo ""
    echo -e "${YELLOW}将清除管理密码与全部恢复码（2FA 保持不变），并吊销所有登录会话。${NC}"
    echo -e "${YELLOW}之后可用 Admin Token 登录（密码登录关闭），可在后台重新设置密码。${NC}"
    if ! ui_confirm "重置管理密码" "将清除管理密码与恢复码并吊销所有会话。\n\n确定继续？"; then
        echo "已取消。"; return 0
    fi
    ensure_deps || return 1
    local loc; loc="$(locate_db)"
    if [[ -z "$loc" ]]; then
        echo -e "${RED}[错误] 未找到服务端数据库，无法重置（未做任何修改）${NC}" >&2
        return 1
    fi
    local js out
    js="$(mktemp)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
db.pragma('busy_timeout = 5000');
const now = String(Date.now());
const tx = db.transaction(() => {
  // 水位线最先写：旧 Cookie 立即失效（同 --reset-admin-token 口径）。
  db.prepare("INSERT OR REPLACE INTO admin_config(key,value) VALUES('session_revoked_before',?)").run(now);
  db.prepare('UPDATE sessions SET revoked=1 WHERE revoked=0').run();
  db.prepare("DELETE FROM admin_config WHERE key IN ('admin_password_hash','login_guard_global')").run();
  // r1/P1-5 容错：旧库/服务端从未启动过可能没有 recovery_codes 表。
  try { db.prepare('DELETE FROM recovery_codes').run(); } catch (e) { /* 表不存在 */ }
});
tx();
const left = db.prepare("SELECT value FROM admin_config WHERE key='admin_password_hash'").get();
console.log('PWD_CLEARED=' + (left && left.value ? '0' : '1'));
JS
    if ! out="$(db_run_js "$js")"; then
        rm -f "$js"
        echo -e "${RED}[错误] 写入数据库失败，密码未变更${NC}" >&2
        return 1
    fi
    rm -f "$js"
    if ! printf '%s\n' "$out" | grep -qx 'PWD_CLEARED=1'; then
        echo -e "${RED}[错误] 写入校验失败（库中密码哈希仍在），密码未变更${NC}" >&2
        return 1
    fi
    echo -e "${GREEN}[OK]   管理密码与恢复码已清除，全部会话已吊销（即时生效，无需重启）${NC}"
    echo -e "       登录页密码通道已关闭；Token 未变动。如需换 Token：sudo bash diting.sh --reset-admin-token"
}

# 重置 2FA（清 TOTP 密钥与恢复码，关闭 2FA）：仅通过 SSH 在服务器上运行。
# 终极破玻璃（r1/§3.7）：TOTP 设备丢失且恢复码用尽/丢失、无法登录时使用。
# 同款口径：水位线最先写 → 全会话吊销 → 删 2FA 键；写库即时生效、不重启。
do_reset_2fa() {
    echo "== 重置 2FA =="
    echo ""
    echo -e "${YELLOW}将清除 TOTP 密钥与全部恢复码并关闭 2FA，同时吊销所有登录会话。${NC}"
    echo -e "${YELLOW}之后登录不再需要第二因子；请在登录后尽快重新开启 2FA。${NC}"
    if ! ui_confirm "重置 2FA" "将关闭 2FA（清除 TOTP 密钥与恢复码）并吊销所有会话。\n\n确定继续？"; then
        echo "已取消。"; return 0
    fi
    ensure_deps || return 1
    local loc; loc="$(locate_db)"
    if [[ -z "$loc" ]]; then
        echo -e "${RED}[错误] 未找到服务端数据库，无法重置（未做任何修改）${NC}" >&2
        return 1
    fi
    local js out
    js="$(mktemp)"
    cat > "$js" <<'JS'
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
db.pragma('busy_timeout = 5000');
const now = String(Date.now());
const tx = db.transaction(() => {
  // 水位线最先写：旧 Cookie 立即失效（同 --reset-admin-token 口径）。
  db.prepare("INSERT OR REPLACE INTO admin_config(key,value) VALUES('session_revoked_before',?)").run(now);
  db.prepare('UPDATE sessions SET revoked=1 WHERE revoked=0').run();
  db.prepare("DELETE FROM admin_config WHERE key IN ('admin_2fa_secret','admin_2fa_enabled')").run();
  try { db.prepare('DELETE FROM recovery_codes').run(); } catch (e) { /* 表不存在 */ }
});
tx();
const left = db.prepare("SELECT value FROM admin_config WHERE key='admin_2fa_enabled'").get();
console.log('TWOFA_CLEARED=' + (!left || left.value !== '1' ? '1' : '0'));
JS
    if ! out="$(db_run_js "$js")"; then
        rm -f "$js"
        echo -e "${RED}[错误] 写入数据库失败，2FA 未变更${NC}" >&2
        return 1
    fi
    rm -f "$js"
    if ! printf '%s\n' "$out" | grep -qx 'TWOFA_CLEARED=1'; then
        echo -e "${RED}[错误] 写入校验失败（2FA 仍为开启态），请按上方错误信息排查${NC}" >&2
        return 1
    fi
    echo -e "${GREEN}[OK]   2FA 已关闭（TOTP 密钥与恢复码已清除），全部会话已吊销（即时生效，无需重启）${NC}"
    echo -e "       登录后请尽快在后台「登录会话」页重新开启 2FA"
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
    # Batch F：服务端卸载按形态分派（原生 systemd 也停/disable/清理）；agent 已在上面卸载。
    local _smode; _smode="$(server_deploy_mode)"
    if [[ -z "$_smode" ]]; then
        echo "  服务端未安装"
        return 0
    fi
    case "$_smode" in
        systemd) _uninstall_server_systemd ;;
        docker)  _uninstall_server_docker ;;
    esac

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
            # r1/P1-6：只删 token 哈希会留下管理密码/恢复码残留（新装实例仍可被旧密码登录），
            # 必须连 admin_password_hash 与 recovery_codes 一起清（或直接跑 purge 口径）。
            echo -e "       或手动删除库中 admin_token_hash、admin_password_hash 两个键与 recovery_codes 表"
            echo -e "       （--reset-admin-token 只会换 Token，不会回到向导；漏删密码键会留下旧密码残留）。"
        fi
    fi
    echo -e "${YELLOW}[提示] 源码仍在 $SRC_DIR，数据库在 Docker 卷中；如需彻底清除请手动删除。${NC}"
}

