#!/usr/bin/env bash
# Diting Agent (Go) - systemd installation script.
# Compatible with agent/install.sh parameters; downloads a single binary
# from GitHub Release (with .sha256 verification). --setup-token response
# parsing needs python3 (only that flag; plain --id/--token has zero deps).
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
sha256_of() { local f="$1"; (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null) | awk '{print $1}'; }
download() {
    local url="$1" out="$2"
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$out"
    elif command -v wget >/dev/null 2>&1; then wget -qO "$out" "$url"
    else echo -e "${RED}[error] curl or wget required${NC}" >&2; return 1; fi
}
validate_server_url() {
    case "${1:-}" in
        https://*) ;;
        http://localhost*|http://127.0.0.1*|http://\[::1\]*)
            echo -e "${YELLOW}[warn] localhost http: local test only${NC}" >&2 ;;
        http://*)
            echo -e "${RED}[error] SERVER_URL must use https${NC}" >&2; return 1 ;;
        *) echo -e "${RED}[error] SERVER_URL must start with http(s)://${NC}" >&2; return 1 ;;
    esac
}
usage() {
    cat <<EOF
Usage: sudo bash install.sh [OPTIONS]
  --server URL           Server address (required)
  --id AGENT_ID          Agent ID (required unless --setup-token)
  --token TOKEN          Agent token (required unless --setup-token)
  --token-file FILE      Read token from file
  --setup-token SECRET   One-click self-registration (needs python3)
  --setup-name NAME      Node display name
  --interval SECONDS     Report interval (default 20)
  --probe-targets LIST   label:host[:port] comma-separated
  --repo URL             Release download base (default .../releases/latest/download)
EOF
    exit 0
}
INTERVAL=20
RELEASE_BASE="https://github.com/fengzone85/diting/releases/latest/download"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --server) SERVER_URL="$2"; shift 2 ;;
        --id) AGENT_ID="$2"; shift 2 ;;
        --token) AGENT_TOKEN="$2"; shift 2 ;;
        --token-file) AGENT_TOKEN_FILE="$2"; shift 2 ;;
        --setup-token) SETUP_TOKEN="$2"; shift 2 ;;
        --setup-name) SETUP_NAME="$2"; shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --probe-targets) PROBE_TARGETS="$2"; shift 2 ;;
        --repo) RELEASE_BASE="$2"; shift 2 ;;
        --install-agent) shift ;;
        --help|-h) usage ;;
        *) echo -e "${RED}[error] unknown arg: $1${NC}" >&2; usage ;;
    esac
done
[[ "$(id -u)" -eq 0 ]] || { echo -e "${RED}[error] run as root${NC}" >&2; exit 1; }
case "$(uname -m)" in
    x86_64) GOARCH="amd64" ;;
    aarch64|arm64) GOARCH="arm64" ;;
    *) echo -e "${RED}[error] unsupported arch${NC}" >&2; exit 1 ;;
esac
BIN_NAME="diting-agent-linux-${GOARCH}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo -e "${YELLOW}[info] downloading ${RELEASE_BASE}/${BIN_NAME}${NC}"
download "${RELEASE_BASE}/${BIN_NAME}" "${TMP}/${BIN_NAME}"
if [[ "${SP_AGENT_GO_SKIP_SHA256:-0}" == "1" ]]; then
    echo -e "${YELLOW}[warn] SHA256 skipped (not recommended)${NC}"
else
    download "${RELEASE_BASE}/${BIN_NAME}.sha256" "${TMP}/${BIN_NAME}.sha256"
    EXPECTED="$(tr -d '[:space:]' < "${TMP}/${BIN_NAME}.sha256")"
    GOT="$(sha256_of "${TMP}/${BIN_NAME}")"
    [[ "$GOT" == "$EXPECTED" ]] || { echo -e "${RED}[error] SHA256 mismatch: want ${EXPECTED} got ${GOT}${NC}" >&2; exit 1; }
    echo -e "${GREEN}[OK] SHA256 verified${NC}"
fi
if [[ -z "${AGENT_TOKEN:-}" && -n "${AGENT_TOKEN_FILE:-}" ]]; then
    [[ -f "$AGENT_TOKEN_FILE" ]] || { echo -e "${RED}[error] token file missing${NC}" >&2; exit 1; }
    AGENT_TOKEN="$(tr -d '[:space:]' < "$AGENT_TOKEN_FILE")"
fi
if [[ -n "${SETUP_TOKEN:-}" ]]; then
    [[ -n "${SERVER_URL:-}" ]] || { echo -e "${RED}[error] --setup-token needs --server${NC}" >&2; exit 1; }
    validate_server_url "$SERVER_URL" || exit 1
    command -v python3 >/dev/null 2>&1 || { echo -e "${RED}[error] --setup-token needs python3${NC}" >&2; exit 1; }
    echo -e "${YELLOW}[info] self-registering...${NC}"
    REG_JSON="$(curl -fsSL -X POST -H 'Content-Type: application/json' -d "{\"setup_token\":\"${SETUP_TOKEN}\",\"name\":\"${SETUP_NAME:-}\"}" "${SERVER_URL%/}/api/setup/register")"
    AGENT_ID="$(echo "$REG_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("agent_id",""))')"
    AGENT_TOKEN="$(echo "$REG_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("agent_token",""))')"
    [[ -n "$AGENT_ID" && -n "$AGENT_TOKEN" ]] || { echo -e "${RED}[error] registration failed: ${REG_JSON}${NC}" >&2; exit 1; }
    echo -e "${GREEN}[OK] registered, ID: ${AGENT_ID}${NC}"
fi
[[ -z "${SERVER_URL:-}" ]] && { read -rp "SERVER_URL: " SERVER_URL; }
[[ -z "${AGENT_ID:-}" ]] && { read -rp "AGENT_ID: " AGENT_ID; }
[[ -z "${AGENT_TOKEN:-}" ]] && { read -rs AGENT_TOKEN; echo ""; }
[[ -n "$SERVER_URL" && -n "$AGENT_ID" && -n "$AGENT_TOKEN" ]] || { echo -e "${RED}[error] empty required fields${NC}" >&2; exit 1; }
validate_server_url "$SERVER_URL" || exit 1
id diting >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin -d /nonexistent -c "Diting Agent" diting
mkdir -p /opt/diting /var/lib/diting /etc/diting
install -m 755 "${TMP}/${BIN_NAME}" /opt/diting/diting-agent
chown root:root /opt/diting/diting-agent
chown -R diting:diting /var/lib/diting && chmod 700 /var/lib/diting
ENV_CONTENT="SERVER_URL=${SERVER_URL}
AGENT_ID=${AGENT_ID}
AGENT_TOKEN=${AGENT_TOKEN}
INTERVAL=${INTERVAL}
DISK_PATH=/
STATE_FILE=/var/lib/diting/state.json
"
[[ -n "${PROBE_TARGETS:-}" ]] && ENV_CONTENT="${ENV_CONTENT}PROBE_TARGETS=${PROBE_TARGETS}
"
TMP_ENV="$(mktemp)"; chmod 600 "$TMP_ENV"
echo "$ENV_CONTENT" > "$TMP_ENV"
mv "$TMP_ENV" /etc/diting/agent.env
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/diting-agent.service" ]]; then
    cp "${SCRIPT_DIR}/diting-agent.service" /etc/systemd/system/
else
    curl -fsSL "https://raw.githubusercontent.com/fengzone85/diting/master/agent-go/diting-agent.service" -o /etc/systemd/system/diting-agent.service
fi
chmod 644 /etc/systemd/system/diting-agent.service
# 部署卸载脚本（diting.sh 的 uninstall_all 依赖 /opt/diting/uninstall.sh）
if [[ -f "${SCRIPT_DIR}/uninstall.sh" ]]; then
    cp "${SCRIPT_DIR}/uninstall.sh" /opt/diting/uninstall.sh
    chmod 644 /opt/diting/uninstall.sh
fi
systemctl daemon-reload
systemctl enable --now diting-agent
sleep 2
if systemctl is-active --quiet diting-agent; then
    echo -e "${GREEN}[OK] service active${NC}"
else
    echo -e "${RED}[error] service failed, logs:${NC}" >&2
    journalctl -u diting-agent -n 30 --no-pager
    exit 1
fi
echo "=== install done (Go) === config: /etc/diting/agent.env"
