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

