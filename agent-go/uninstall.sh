#!/usr/bin/env bash
# Diting Agent (Go) - systemd uninstall script.
# Idempotent: safe to run even if the agent was never installed.
#   --purge  additionally remove credentials (agent.env) + traffic state (state.json)
#            after interactive confirmation (default: keep).
#   --yes    skip the confirmation prompt (for automation; implies consent to --purge).
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'

PURGE=0
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        --yes|-y) ASSUME_YES=1 ;;
        *) echo -e "${RED}[error] unknown option: $arg${NC}" >&2
           echo "usage: uninstall.sh [--purge] [--yes]" >&2
           exit 2 ;;
    esac
done

echo ""
echo "=== Diting Agent (Go) uninstall ==="

if systemctl is-active --quiet diting-agent 2>/dev/null; then
    systemctl stop diting-agent
    echo -e "${GREEN}[OK] service stopped${NC}"
else
    echo -e "${YELLOW}[skip] service not running${NC}"
fi
if systemctl is-enabled --quiet diting-agent 2>/dev/null; then
    systemctl disable diting-agent >/dev/null 2>&1 || true
    echo -e "${GREEN}[OK] autostart disabled${NC}"
fi
rm -f /etc/systemd/system/diting-agent.service
systemctl daemon-reload 2>/dev/null || true
echo -e "${GREEN}[OK] unit removed + daemon-reload${NC}"
rm -f /opt/diting/diting-agent
echo -e "${GREEN}[OK] /opt/diting/diting-agent removed${NC}"

if [ "$PURGE" -eq 1 ]; then
    echo -e "${YELLOW}[purge] 将删除凭据 /etc/diting/agent.env 与流量状态 /var/lib/diting/state.json${NC}"
    CONFIRM=0
    if [ "$ASSUME_YES" -eq 1 ]; then
        CONFIRM=1
    elif (: < /dev/tty) 2>/dev/null; then
        # 须实际打开 /dev/tty 探测：setsid 下 [ -r /dev/tty ] 仍真但打开即 ENXIO。
        printf "确认删除? 此操作不可恢复 [y/N] " > /dev/tty 2>/dev/null || true
        read -r ans < /dev/tty 2>/dev/null || ans=""
        case "$ans" in y|Y|yes|YES) CONFIRM=1 ;; esac
    else
        echo -e "${YELLOW}[purge] 无交互终端，未确认 ⇒ 保留凭据（自动化请加 --yes）${NC}"
    fi
    if [ "$CONFIRM" -eq 1 ]; then
        rm -f /etc/diting/agent.env /var/lib/diting/state.json
        rmdir /etc/diting 2>/dev/null || true
        rmdir /var/lib/diting 2>/dev/null || true
        echo -e "${GREEN}[OK] agent.env + state.json 已删除（凭据清除）${NC}"
    else
        echo -e "${YELLOW}[keep] 未确认，保留 agent.env + state.json${NC}"
    fi
else
    echo -e "${YELLOW}[keep] /etc/diting/agent.env + /var/lib/diting/state.json NOT removed${NC}"
    echo -e "${YELLOW}       (monthly-traffic state survives reinstall with the same agent ID)${NC}"
    echo -e "${RED}[warn] /etc/diting/agent.env 仍含 Agent Token 明文。转赠/丢弃整机前请手动清除：${NC}"
    echo -e "${RED}       sudo rm -f /etc/diting/agent.env${NC}"
    echo -e "${RED}       或重新运行: sudo bash uninstall.sh --purge${NC}"
fi
echo ""
echo "uninstall done."