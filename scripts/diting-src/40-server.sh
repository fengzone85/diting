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
# 外部连不上。因此端口只能由安装器决定（对齐上游把端口写进 systemd ExecStart），
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

    init_env_file "$port"

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
    echo -e "   生产请在 Nginx / 宝塔 / 1Panel 中绑定域名反代到 127.0.0.1:${port}（默认路径，面板管证书）"
    echo -e "   Nginx upstream 需与端口一致：proxy_pass http://127.0.0.1:${port};"
    echo -e "   ${YELLOW}⚠️ 反代必须透传 WebSocket 升级头，否则公开主题页实时数据为空（显示离线/N/A）${NC}"
    echo -e "   完整可粘贴配置与面板步骤：docs/src/content/docs/reverse-proxy.md"
    echo -e "   无面板/无域名的局域网机器可选：sudo bash diting.sh --bundled-proxy（自签 HTTPS，占用 443）"
}

# ── 可选：无面板 / 无域名的局域网自签 HTTPS 反代（B 路径）────────────────────
# 默认部署走 A 路径（宝塔 / 1Panel / 已有 Nginx 绑定域名反代）；本开关只给纯净
# 机器用，占用宿主 443。nginx 容器用 network_mode: host，反代源地址仍是 loopback，
# 因此 TRUST_PROXY 保持默认，A 路径用户不受影响。
setup_bundled_proxy() {
    ensure_deps || return 1
    ensure_docker || return 1

    local server_dir="$SRC_DIR/server"
    if [[ ! -f "$server_dir/docker-compose.yml" ]]; then
        echo -e "${RED}[错误] 未找到 $server_dir/docker-compose.yml，请先执行 --install-server${NC}" >&2
        return 1
    fi

    local port ip
    port="$(grep -E '^PORT=' "$server_dir/.env" 2>/dev/null | cut -d= -f2 || true)"
    [[ -n "$port" ]] || port=8081
    # 容器配置固定反代到 8081；自定义 PORT 时要求先同步，避免静默连不上后端。
    if [[ "$port" != "8081" ]] && ! grep -q "127.0.0.1:${port}" "$server_dir/nginx/bundled.conf" 2>/dev/null; then
        echo -e "${RED}[错误] .env 的 PORT=${port}，但 server/nginx/bundled.conf 固定反代到 127.0.0.1:8081。${NC}" >&2
        echo -e "${YELLOW}       请把该文件所有 8081 改成 ${port} 后重试（A 路径不受影响）。${NC}" >&2
        return 1
    fi
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [[ -n "$ip" ]] || ip="127.0.0.1"

    local cert_dir="$server_dir/certs"
    mkdir -p "$cert_dir"
    chmod 0755 "$cert_dir"

    # 幂等：证书已存在则不覆盖，避免浏览器反复提示证书变更。
    if [[ ! -f "$cert_dir/server.crt" || ! -f "$cert_dir/server.key" || ! -f "$cert_dir/ca.crt" ]]; then
        local ext
        ext="$(mktemp)"
        cat > "$ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${ip}
EOF
        openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
            -keyout "$cert_dir/ca.key" -out "$cert_dir/ca.crt" \
            -subj "/O=diting-local/CN=diting Local Root CA" >/dev/null 2>&1
        openssl req -newkey rsa:2048 -nodes -sha256 \
            -keyout "$cert_dir/server.key" -out "$cert_dir/server.csr" \
            -subj "/O=diting-local/CN=${ip}" >/dev/null 2>&1
        openssl x509 -req -in "$cert_dir/server.csr" -CA "$cert_dir/ca.crt" -CAkey "$cert_dir/ca.key" \
            -CAcreateserial -out "$cert_dir/server.crt" -days 825 -sha256 -extfile "$ext" >/dev/null 2>&1
        rm -f "$ext" "$cert_dir/server.csr" "$cert_dir/ca.srl"
        chmod 0644 "$cert_dir/ca.crt" "$cert_dir/server.crt"
        chmod 0600 "$cert_dir/ca.key" "$cert_dir/server.key"
        echo -e "${GREEN}[OK]   已生成自签 CA 与服务端证书（SAN: localhost / 127.0.0.1 / ${ip}）${NC}"
    else
        echo -e "${GREEN}[OK]   已有自签证书，保持不变${NC}"
    fi

    ( cd "$server_dir" && docker compose --profile bundled-proxy up -d ) || return 1
    echo ""
    echo -e "${GREEN}✅ 自签 HTTPS 反代已启动${NC}"
    echo -e "   访问：https://${ip}/install（浏览器会有一次自签证书警告，属预期）"
    echo -e "   证书目录：$cert_dir"
    echo -e "   ${YELLOW}跨机受控端需信任 $cert_dir/ca.crt（加入系统信任库或设 SSL_CERT_FILE）${NC}"
    echo -e "   本机受控端可直接使用 http://localhost:${port}"
    echo -e "   该 profile 占用宿主 443；A 路径（面板反代）用户请勿使用。"
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

# ── Batch F：原生 systemd 升级 readiness + 自动回滚（REL-03）──────────────────
# 原生形态（运行目录分离）升级＝部署当前源码树 → 重启 → 应用级 readiness →
# 失败自动回滚旧副本+库。**不自动 git reset**：SCRIPT_DIR 是含 WIP 的开发仓库，
# reset --hard 会毁未提交工作；源码由操作者自管 git（与 docker 一键 pull 区分）。

# 从 env 文件读键值（去引号/尾空白），读不到输出空。
_env_get() {
    local f="$1" k="$2" v=""
    [[ -n "$f" && -f "$f" ]] || { echo ""; return 0; }
    v="$(sed -n "s/^[[:space:]]*${k}[[:space:]]*=[[:space:]]*//p" "$f" 2>/dev/null | tail -n1)"
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    v="${v%%[[:space:]]*}"
    echo "$v"
}

# JSON 字符串转义（反斜杠/双引号），零新依赖。
_json_esc() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

# 升级事务元数据：独立键 upgrade_state.json（不并入 ui_settings，不记秘密）。
# 用法：_upgrade_state <file> <txid> <stage> <old_hash> <old_ver> <bak> <rollback_dir> <new_hash> [error]
_upgrade_state() {
    local f="$1" txid="$2" stage="$3" oh="$4" ov="$5" bak="$6" rd="$7" nh="$8" err="${9:-}"
    local ts; ts="$(date +%Y-%m-%dT%H:%M:%S%z 2>/dev/null || date)"
    {
        printf '{\n'
        printf '  "txid": "%s",\n' "$(_json_esc "$txid")"
        printf '  "stage": "%s",\n' "$(_json_esc "$stage")"
        printf '  "old_hash": "%s",\n' "$(_json_esc "$oh")"
        printf '  "old_version": "%s",\n' "$(_json_esc "$ov")"
        printf '  "new_hash": "%s",\n' "$(_json_esc "$nh")"
        printf '  "backup": "%s",\n' "$(_json_esc "$bak")"
        printf '  "rollback_dir": "%s",\n' "$(_json_esc "$rd")"
        printf '  "error": "%s",\n' "$(_json_esc "$err")"
        printf '  "ts": "%s"\n' "$(_json_esc "$ts")"
        printf '}\n'
    } > "$f" 2>/dev/null || true
}

# 应用级 readiness：/api/version 连续 need 次 200 且版本符（校验新副本生效 + DB 可读）。
# 崩溃循环保护：NRestarts>=3 提前判失败。超时 DITING_READY_TIMEOUT（默认 60s）。
# 用法：_wait_readiness <port> [expected_version]
_wait_readiness() {
    local port="$1" expect="${2:-}"
    local timeout="${DITING_READY_TIMEOUT:-60}" interval="${DITING_READY_INTERVAL:-2}" need="${DITING_READY_NEED:-3}"
    local ok=0 deadline code ver nrestarts tmp
    deadline=$(( $(date +%s) + timeout ))
    tmp="$(mktemp 2>/dev/null || echo "/tmp/diting-ready.$$")"
    while (( $(date +%s) < deadline )); do
        nrestarts="$(systemctl show diting-server -p NRestarts --value 2>/dev/null || echo 0)"
        [[ "$nrestarts" =~ ^[0-9]+$ ]] || nrestarts=0
        if (( nrestarts >= 3 )); then
            echo -e "${RED}[readiness] 崩溃循环（NRestarts=$nrestarts）${NC}" >&2
            rm -f "$tmp" 2>/dev/null || true
            return 1
        fi
        code="$(curl -s -m 5 -o "$tmp" -w '%{http_code}' "http://127.0.0.1:${port}/api/version" 2>/dev/null)" || code=000
        if [[ "$code" == "200" ]]; then
            ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp" 2>/dev/null || true)"
            if [[ -z "$expect" || "$ver" == "$expect" ]]; then
                ok=$(( ok + 1 ))
                if (( ok >= need )); then rm -f "$tmp" 2>/dev/null || true; return 0; fi
            else
                ok=0
            fi
        else
            ok=0
        fi
        sleep "$interval"
    done
    rm -f "$tmp" 2>/dev/null || true
    echo -e "${RED}[readiness] 超时（${timeout}s 内未连续 ${need} 次健康）${NC}" >&2
    return 1
}

# F6 自动回滚：恢复旧副本（快照排除 node_modules → 重 npm ci）+ 恢复升级前库
# （迁移不可逆保护）+ 重启 + 再探 readiness。非仅打印 hint。
# 用法：_native_rollback <rollback_dir> <app> <bak> <port> <old_ver> <db> <state_file> <txid> <old_hash>
_native_rollback() {
    local rd="$1" app="$2" bak="$3" port="$4" ov="$5" db="$6" sf="$7" txid="$8" oh="$9"
    echo -e "${YELLOW}[回滚] readiness 失败，恢复升级前状态…${NC}" >&2
    _upgrade_state "$sf" "$txid" rolling_back "$oh" "$ov" "$bak" "$rd" "" "readiness failed"
    if [[ -d "$rd" ]]; then
        # --checksum：按内容比对而非 size+mtime。回滚必须确定性还原旧副本——
        # 新旧文件可能恰好同长度同秒 mtime（如 version.txt），-a 快查会跳过导致还原不全。
        rsync -a --checksum --delete --exclude node_modules "$rd/" "$app/" 2>/dev/null || true
        ( cd "$app" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || \
            echo -e "${YELLOW}[回滚] npm ci 失败，旧副本依赖可能不完整${NC}" >&2
    fi
    if [[ -n "$bak" && -f "$bak" && -n "$db" ]]; then
        systemctl stop diting-server 2>/dev/null || true
        case "$bak" in
            *.gz) gzip -dc "$bak" > "$db" 2>/dev/null || true ;;
            *)    cp -p "$bak" "$db" 2>/dev/null || true ;;
        esac
        local u; u="$(server_run_user)"
        [[ -n "$u" ]] && chown "$u" "$db" 2>/dev/null || true
    fi
    server_ctl restart >/dev/null 2>&1 || true
    if _wait_readiness "$port" "$ov"; then
        echo -e "${GREEN}[回滚] 旧版本已恢复并就绪${NC}" >&2
        _upgrade_state "$sf" "$txid" rolled_back "$oh" "$ov" "$bak" "$rd" "" "readiness failed; old version restored"
        return 0
    fi
    echo -e "${RED}[回滚] 旧版本仍不健康，需人工介入（备份：${bak:-无}）${NC}" >&2
    _upgrade_state "$sf" "$txid" rollback_failed "$oh" "$ov" "$bak" "$rd" "" "old version unhealthy after rollback"
    return 1
}

# 原生 systemd 升级事务：备份 → 快照旧副本 → deploy → 重启 → readiness → 失败回滚。
update_server_native() {
    local app="${DITING_APP_DIR:-/data/simple-probe-data/server-data/app}"
    [[ -d "$app" ]] || { echo -e "${RED}[错误] 未找到运行副本 $app（请先 --deploy-server）${NC}" >&2; return 1; }
    local envf port db
    envf="$(server_env_file)"
    port="$(server_native_port)"; port="${port:-8081}"
    db="$(_env_get "$envf" DB_PATH)"
    local txid; txid="$(date +%Y%m%d_%H%M%S)_$$"
    local sf; sf="$(dirname "$app")/upgrade_state.json"
    local oh ov
    oh="$(cat "$app/git_hash.txt" 2>/dev/null || echo '')"
    ov="$(cat "$app/version.txt" 2>/dev/null || echo '')"; ov="${ov#v}"
    echo -e "${GREEN}[升级] 原生 systemd：部署当前源码树 → 重启 → readiness（失败自动回滚）${NC}"
    echo -e "${YELLOW}[信息] 源码由操作者自管 git（不自动 reset 开发仓库）；事务 ${txid}${NC}"
    _upgrade_state "$sf" "$txid" backup "$oh" "$ov" "" "" ""

    _init_backup_dir
    local _bak="${DB_BACKUP_DIR}/monitor_$(date +%Y%m%d_%H%M%S)_pre-upgrade.db"
    if do_backup "$_bak" 0; then
        [[ -f "${_bak}.gz" && ! -f "$_bak" ]] && _bak="${_bak}.gz"
        echo -e "${GREEN}[OK]   升级前备份 → ${_bak}${NC}"
    else
        if [[ "${A_FORCE:-0}" == "1" ]]; then
            echo -e "${YELLOW}[警告] 备份失败，按 --force 继续（风险自负）${NC}"; _bak=""
        else
            echo -e "${RED}[错误] 升级前备份失败，中止（当前服务仍在跑旧版）；--force 可跳过${NC}" >&2
            _upgrade_state "$sf" "$txid" failed "$oh" "$ov" "" "" "" "backup failed"
            return 1
        fi
    fi

    local rd="${app}.rollback-${txid}"
    if ! rsync -a --exclude node_modules "$app/" "$rd/" 2>/dev/null; then
        echo -e "${RED}[错误] 旧副本快照失败，中止${NC}" >&2
        _upgrade_state "$sf" "$txid" failed "$oh" "$ov" "$_bak" "" "" "snapshot failed"
        return 1
    fi
    _upgrade_state "$sf" "$txid" deploy "$oh" "$ov" "$_bak" "$rd" ""

    if ! deploy_server; then
        echo -e "${RED}[错误] 部署失败，回滚${NC}" >&2
        _native_rollback "$rd" "$app" "$_bak" "$port" "$ov" "$db" "$sf" "$txid" "$oh" || true
        return 1
    fi
    local nh nv
    nh="$(cat "$app/git_hash.txt" 2>/dev/null || echo '')"
    nv="$(cat "$app/version.txt" 2>/dev/null || echo '')"; nv="${nv#v}"
    if ! server_ctl restart; then
        echo -e "${RED}[错误] 重启失败，回滚${NC}" >&2
        _native_rollback "$rd" "$app" "$_bak" "$port" "$ov" "$db" "$sf" "$txid" "$oh" || true
        return 1
    fi
    _upgrade_state "$sf" "$txid" readiness "$oh" "$ov" "$_bak" "$rd" "$nh"

    if _wait_readiness "$port" "$nv"; then
        _upgrade_state "$sf" "$txid" done "$oh" "$ov" "$_bak" "$rd" "$nh"
        echo -e "${GREEN}[OK]   升级完成并就绪（${oh:-?} → ${nh:-?}，版本 ${nv:-?}）${NC}"
        [[ -n "$_bak" && -f "$_bak" ]] && echo -e "       升级前备份：${_bak}"
        rm -rf "$rd" 2>/dev/null || true
        return 0
    fi
    _native_rollback "$rd" "$app" "$_bak" "$port" "$ov" "$db" "$sf" "$txid" "$oh" || true
    return 1
}

# ── Batch F：原生 systemd 服务端卸载（REL-15）─────────────────────────────────
# 只卸服务端（不连带 agent）；默认保留 DB/数据卷/.env/源码（不误删用户数据）。
_uninstall_server_systemd() {
    local unit_file="${DITING_SERVER_UNIT_FILE:-/etc/systemd/system/diting-server.service}"
    echo "== 卸载服务端 (systemd) =="
    if systemctl cat diting-server.service >/dev/null 2>&1 || [[ -f "$unit_file" ]]; then
        systemctl stop diting-server 2>/dev/null || true
        systemctl disable diting-server 2>/dev/null || true
        [[ -f "$unit_file" ]] && rm -f "$unit_file" 2>/dev/null || true
        systemctl daemon-reload 2>/dev/null || true
        systemctl reset-failed diting-server 2>/dev/null || true
        echo -e "${GREEN}[OK]   diting-server.service 已停止 / disable / 清理${NC}"
    else
        echo "  未检测到 diting-server.service"
    fi
    echo -e "${YELLOW}[提示] 数据库 / .env / 源码均保留；如需彻底清除请手动删除（运行副本目录与 unit 的 EnvironmentFile）。${NC}"
}

_uninstall_server_docker() {
    echo "== 卸载服务端 (Docker) =="
    if [[ ! -d "$SRC_DIR/server" ]]; then
        echo "  服务端未安装"
        return 0
    fi
    ( cd "$SRC_DIR/server" && docker compose down ) || true
}

# --uninstall-server：只卸服务端，按形态分派，不动 agent。
uninstall_server() {
    local mode; mode="$(server_deploy_mode)"
    case "$mode" in
        systemd) _uninstall_server_systemd ;;
        docker)  _uninstall_server_docker ;;
        *) echo -e "${RED}[错误] 未找到可卸载的服务端（无 diting-server.service，也无 Docker compose 项目）${NC}" >&2; return 1 ;;
    esac
}

update_server() {
    # Batch F：原生 systemd 形态走 readiness + 自动回滚；docker 形态保持原逻辑。
    if [[ "$(server_deploy_mode)" == "systemd" ]]; then
        local _rc=0
        update_server_native || _rc=$?
        return $_rc
    fi
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
    # 存量升级同样要补 SESSION_SECRET：否则 --upgrade 后每次重启丢登录态、分发链接作废。
    ensure_session_secret

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
    # 对齐上游的 active 校验：`up -d` 返回 0 只代表容器创建成功，
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
# ── 服务端运行控制（原生 systemd / Docker 双形态）──────────────────────────────
# 脚本的「安装 / 更新」只覆盖 Docker 形态，但存量部署有原生化（systemd 单元
# diting-server.service）的：此前菜单没有任何启停入口，status 也只查 compose，
# 导致 `sudo bash diting.sh` 对运行中的原生服务端完全无效。
# 这里补一层形态探测 + 统一控制：
#   systemd → systemctl start/stop/restart diting-server
#   docker  → docker compose up -d / stop / restart server
# 探测顺序 systemd 优先：原生机器上通常也装了 docker（跑别的服务），
# 反过来会让原生实例被误判成容器。
server_deploy_mode() {
    # 单元文件路径可覆盖：非标准安装位置、以及单测里隔离真实单元时用。
    local unit_file="${DITING_SERVER_UNIT_FILE:-/etc/systemd/system/diting-server.service}"
    if systemctl cat diting-server.service >/dev/null 2>&1; then
        echo "systemd"
        return 0
    fi
    if [[ -f "$unit_file" ]]; then
        echo "systemd"
        return 0
    fi
    if [[ -d "$SRC_DIR/server" ]]; then
        echo "docker"
        return 0
    fi
    echo ""
}

# 原生部署的 systemd 单元工作目录（Docker 形态输出空）。
server_workdir() {
    systemctl show -p WorkingDirectory --value diting-server.service 2>/dev/null | tr -d '\r\n' || true
}

# 服务端环境文件位置（运行目录分离）：优先取 systemd 单元的 EnvironmentFile
#（.env 位于仓库树外 server-data/.env），回退单元工作目录下 .env（旧布局兼容）。
server_env_file() {
    local wd envf
    envf="$(systemctl cat diting-server.service 2>/dev/null | sed -n 's/^EnvironmentFile=-\?//p' | head -n1 | tr -d '\r\n')"
    wd="$(server_workdir)"
    for f in "$envf" "$wd/.env"; do
        if [[ -n "$f" && -f "$f" ]]; then echo "$f"; return 0; fi
    done
    return 0
}

# 原生部署的监听端口：读服务端环境文件，读不到时调用方回退 8081（server.js 默认值）。
server_native_port() {
    local envf
    envf="$(server_env_file)"
    [[ -n "$envf" ]] || return 0
    sed -n 's/^PORT=//p' "$envf" 2>/dev/null | head -n1 | tr -d '\r\n'
}

# deploy_server —— 运行目录分离（L2）：把服务端「运行副本」同步到仓库树外。
# 默认目标 ${DITING_APP_DIR:-/data/simple-probe-data/server-data/app}。
# 不同步 node_modules（目标内 npm ci 自建）、.env（配置在 server-data/.env，
# 由 systemd EnvironmentFile 注入）、web/ 与 test/（非运行所需）。
# 只做同步 + 依赖 + 版本文件 + 语法自检，**不重启服务**（切换 unit + 重启须单独请示）。
deploy_server() {
    local src="${SCRIPT_DIR}/server"
    local app="${DITING_APP_DIR:-/data/simple-probe-data/server-data/app}"
    [[ -d "$src" ]] || { echo -e "${RED}[错误] 未找到源码目录 $src${NC}" >&2; return 1; }
    command -v rsync >/dev/null 2>&1 || { echo -e "${RED}[错误] 需要 rsync${NC}" >&2; return 1; }
    command -v npm >/dev/null 2>&1 || { echo -e "${RED}[错误] 需要 npm${NC}" >&2; return 1; }

    # 前置检查：构建产物（vite 输出）不在 git 内，必须先在仓库构建——
    # 否则副本缺 public/index.html 与 assets/，SPA 直接 500（2026-11-12 实测）。
    [[ -f "$src/public/index.html" ]] || {
        echo -e "${RED}[错误] 构建产物缺失（$src/public/index.html）：请先执行 cd server/web \&\& npm run build${NC}" >&2
        return 1
    }

    echo -e "${GREEN}[同步] $src/ → $app/${NC}"
    mkdir -p "$app"
    # --delete 把源侧删除同步到副本；exclude 的 node_modules 等不被删除（留作缓存）。
    # ⚠ 排除名不得带尾斜杠：worktree 里 node_modules 常是指向主树的**符号链接**，
    # 'node_modules/'（目录限定）不匹配链接本身，会被 rsync 复制进副本，
    # npm ci 随后会透过链接删主树依赖（2026-11-12 实测险情，被环境护栏拦下）。
    rsync -a --delete \
        --exclude 'node_modules' \
        --exclude 'web/' \
        --exclude 'test/' \
        --exclude 'coverage/' \
        --exclude '.env' \
        --exclude 'certs/' \
        --exclude 'data/' \
        --exclude '*.log' \
        --exclude 'public.bak-*/' \
        --exclude 'build_time.txt' \
        --exclude 'git_hash.txt' \
        --exclude 'version.txt' \
        "$src/" "$app/" || { echo -e "${RED}[错误] rsync 失败${NC}" >&2; return 1; }

    echo -e "${GREEN}[依赖] npm ci --omit=dev（node_modules 建于 $app 内）${NC}"
    # 显式用真实 rm（绝对路径）清旧依赖：npm ci 的内部删除可能被环境的批量删除护栏
    # 拦下（IDE shim），且绝不能让 npm 透过残留链接删外部目录。
    [[ -e "$app/node_modules" ]] && /bin/rm -rf "$app/node_modules"
    (cd "$app" && npm ci --omit=dev --no-audit --no-fund) || { echo -e "${RED}[错误] npm ci 失败${NC}" >&2; return 1; }

    date +"%Y-%m-%d %H:%M:%S (%Z)" > "$app/build_time.txt"
    git -C "$SCRIPT_DIR" rev-parse --short HEAD > "$app/git_hash.txt" 2>/dev/null || echo "-" > "$app/git_hash.txt"
    # version.txt：git describe 转写（run-copy 无 .git，server.js 读它保持 tag 版本口径）
    git -C "$SCRIPT_DIR" describe --tags --match 'v[0-9]*' --abbrev=0 2>/dev/null | tr -d '\r\n' > "$app/version.txt" || true

    node --check "$app/server.js" || { echo -e "${RED}[错误] server.js 语法自检失败${NC}" >&2; return 1; }
    echo -e "${GREEN}[OK]   运行副本就绪：$app（版本 $(cat "$app/git_hash.txt")，构建 $(cat "$app/build_time.txt")）${NC}"
    echo -e "${YELLOW}[提示] 环境文件应在 /data/simple-probe-data/server-data/.env（unit 的 EnvironmentFile 指向）；${NC}"
    echo -e "${YELLOW}       切换 unit + 重启为独立动作，请单独执行并确认。${NC}"
}

# server_ctl start|stop|restart|status —— 按部署形态分派。
# 注意：全部命令都用 `|| rc=$?` 接住，避免 set -e 在 systemctl 失败时直接退出脚本，
# 让用户还能看到下面的错误提示。
server_ctl() {
    local act="${1:-status}" mode rc=0
    mode="$(server_deploy_mode)"
    case "$mode" in
        systemd)
            case "$act" in
                start)   systemctl start diting-server || rc=$? ;;
                stop)    systemctl stop diting-server || rc=$? ;;
                restart) systemctl restart diting-server || rc=$? ;;
                status)  systemctl status diting-server --no-pager -l 2>&1 | head -n 20 || rc=$? ;;
            esac
            ;;
        docker)
            [[ -d "$SRC_DIR/server" ]] || { echo -e "${RED}$(msg "ctl.not_found")${NC}" >&2; return 1; }
            case "$act" in
                start)   ( cd "$SRC_DIR/server" && docker compose up -d server ) || rc=$? ;;
                stop)    ( cd "$SRC_DIR/server" && docker compose stop server ) || rc=$? ;;
                restart) ( cd "$SRC_DIR/server" && docker compose restart server ) || rc=$? ;;
                status)  ( cd "$SRC_DIR/server" && docker compose ps ) || rc=$? ;;
            esac
            ;;
        *)
            echo -e "${RED}$(msg "ctl.not_found")${NC}" >&2
            return 1
            ;;
    esac
    if [[ $rc -ne 0 ]]; then
        echo -e "${RED}$(msg "ctl.failed")${NC}" >&2
        return $rc
    fi
    [[ "$act" == "status" ]] || echo -e "${GREEN}$(msg "ctl.done_$act")${NC}"
    return 0
}

# 交互子菜单：启动 / 停止 / 重启 / 查看状态（菜单项在 show_menu 里以「12」进入）。
server_ctl_menu() {
    local c
    c="$(ui_menu "$(msg "ctl.header")" "$(msg "ctl.prompt")" \
        "1" "$(msg "ctl.start")" \
        "2" "$(msg "ctl.stop")" \
        "3" "$(msg "ctl.restart")" \
        "4" "$(msg "ctl.status")" \
        "0" "$(msg "ctl.back")" )" || return
    [[ -z "$c" ]] && return
    case "$c" in
        # 交互菜单每轮会 clear 重绘：不 pause 的话刚打印的结果/Token 会立刻被清掉。
        1) server_ctl start; pause_return ;;
        2) server_ctl stop; pause_return ;;
        3) server_ctl restart; pause_return ;;
        4) server_ctl status; pause_return ;;
        *) return ;;
    esac
}

status_all() {
    echo "$(msg "status.server_header")"
    local mode
    mode="$(server_deploy_mode)"
    case "$mode" in
        systemd)
            local state pid since wd port
            state="$(systemctl is-active diting-server.service 2>/dev/null || true)"
            echo "  形态: systemd (diting-server.service)"
            if [[ "$state" == "active" ]]; then
                pid="$(systemctl show -p MainPID --value diting-server.service 2>/dev/null || true)"
                since="$(systemctl show -p ActiveEnterTimestamp --value diting-server.service 2>/dev/null || true)"
                wd="$(server_workdir)"
                port="$(server_native_port)"; port="${port:-8081}"
                echo -e "  ${GREEN}active${NC}  端口 ${port}${pid:+  PID ${pid}}"
                [[ -n "$since" ]] && echo "  启动于: ${since}"
                [[ -n "$wd" ]] && echo "  工作目录: ${wd}"
            else
                echo -e "  ${RED}${state:-inactive}${NC} / 未运行 → 菜单「12) $(msg "menu.server_control")」或 --start-server"
            fi
            ;;
        docker)
            local running=0
            if ( cd "$SRC_DIR/server" && docker compose ps --filter status=running -q 2>/dev/null ) | grep -q .; then
                running=1
                ( cd "$SRC_DIR/server" && docker compose ps --format '  {{.Name}}  {{.Status}}' )
            fi
            if [[ $running -eq 0 ]]; then
                echo "$(msg "status.server_not_running")"
            fi
            ;;
        *)
            echo "$(msg "status.server_not_installed")"
            ;;
    esac
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

