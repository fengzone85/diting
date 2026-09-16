#!/usr/bin/env bash
# Diting Agent (Go) - systemd uninstall script.
# Idempotent: safe to run even if the agent was never installed.
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'

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
echo -e "${YELLOW}[keep] /etc/diting/agent.env + /var/lib/diting/state.json NOT removed${NC}"
echo -e "${YELLOW}       (monthly-traffic state survives reinstall with the same agent ID)${NC}"
echo ""
echo "uninstall done."
