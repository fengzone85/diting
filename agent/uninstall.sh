#!/usr/bin/env bash
# =============================================================================
# Diting Agent — native systemd uninstallation script
# =============================================================================
# Cleans up all artefacts created by install.sh.
# Idempotent: safe to run even if the agent was never installed.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'

echo ""
echo "━━━ Diting Agent 卸载 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Stop service ───────────────────────────────────────────────────────────
if systemctl is-active --quiet diting-agent 2>/dev/null; then
    systemctl stop diting-agent
    echo -e "${GREEN}[OK]   已停止服务${NC}"
else
    echo -e "${YELLOW}[跳过] 服务未运行，无需停止${NC}"
fi

# ── 2. Disable service ────────────────────────────────────────────────────────
if systemctl is-enabled --quiet diting-agent 2>/dev/null; then
    systemctl disable diting-agent >/dev/null 2>&1 || true
    echo -e "${GREEN}[OK]   已取消开机自启${NC}"
else
    echo -e "${YELLOW}[跳过] 服务未设置开机自启${NC}"
fi

# ── 3. Remove systemd unit ────────────────────────────────────────────────────
if [[ -f /etc/systemd/system/diting-agent.service ]]; then
    rm -f /etc/systemd/system/diting-agent.service
    echo -e "${GREEN}[OK]   删除 service 文件${NC}"
else
    echo -e "${YELLOW}[跳过] service 文件不存在${NC}"
fi

# ── 4. Reload systemd ─────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl reset-failed >/dev/null 2>&1 || true
echo -e "${GREEN}[OK]   systemd daemon-reload 完成${NC}"

# ── 5. Remove system user ─────────────────────────────────────────────────────
if id diting >/dev/null 2>&1; then
    # 兜底：确保没有 diting 进程残留，否则 userdel 可能因占用失败
    pkill -u diting 2>/dev/null || true
    sleep 1
    if userdel diting >/dev/null 2>&1; then
        echo -e "${GREEN}[OK]   删除系统用户 diting${NC}"
    else
        echo -e "${YELLOW}[警告] 删除用户 diting 失败（可能仍有进程占用），请手动执行: userdel diting${NC}"
    fi
else
    echo -e "${YELLOW}[跳过] 用户 diting 不存在${NC}"
fi

# ── 6. Remove directories ─────────────────────────────────────────────────────
if [[ -d /opt/diting ]]; then
    rm -rf /opt/diting
    echo -e "${GREEN}[OK]   删除 /opt/diting/${NC}"
else
    echo -e "${YELLOW}[跳过] /opt/diting 不存在${NC}"
fi

if [[ -d /var/lib/diting ]]; then
    rm -rf /var/lib/diting
    echo -e "${GREEN}[OK]   删除 /var/lib/diting/${NC}"
else
    echo -e "${YELLOW}[跳过] /var/lib/diting 不存在${NC}"
fi

# ── 7. Remove config directory ───────────────────────────────────────────────
if [[ -d /etc/diting ]]; then
    rm -rf /etc/diting
    echo -e "${GREEN}[OK]   删除 /etc/diting/${NC}"
else
    echo -e "${YELLOW}[跳过] /etc/diting 不存在${NC}"
fi

echo ""
echo "━━━ 卸载完成 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "  ${GREEN}✅ Diting Agent 已完全卸载${NC}"
echo ""
echo "  残留检查（如需确认）："
echo "    getent passwd diting    # 应无输出"
echo "    ls /opt/diting/          # 应报错"
echo "    ls /var/lib/diting/      # 应报错"
echo "    ls /etc/diting/          # 应报错"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
