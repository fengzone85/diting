---
title: 原生 Linux 部署
description: 无 Docker 的原生 systemd 部署方式
---

# 原生 Linux 部署

适用于无 Docker 环境、精简系统、小内存 VPS（256-512MB）。

## 资源对比

| 部署形态 | 内存基线 | 前置依赖 | 镜像大小 |
|---|---|---|---|
| Docker 容器 | 65-150MB | Docker Engine (~120MB) | ~80MB |
| **原生 systemd** | **12-25MB** | **Python 3.8+** | **~50KB** |
| 差值 | **~125MB** | — | — |

> 同一套代码（`agent.py` + `collector.py`），零改动，全在部署层。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/agent/install.sh | bash
```

支持交互模式和非交互模式：

```bash
# 非交互模式
curl -fsSL ... | bash -s -- --token "YOUR_TOKEN" --url "https://monitor.example.com"
```

## 文件布局

```
/opt/diting/           (700 root:root)
├── agent.py
├── collector.py
└── agent.env                (600 root:root)
    ├── AGENT_TOKEN=xxx
    └── SERVER_URL=https://...
```

## systemd 服务

以下与仓库内 `agent/diting-agent.service` 一致：

```ini
[Unit]
Description=Diting Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=diting
Group=diting
EnvironmentFile=/etc/diting/agent.env
ExecStart=/usr/bin/python3 /opt/diting/agent.py
WorkingDirectory=/opt/diting
SyslogIdentifier=diting-agent
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=10s

# ping 需要 CAP_NET_RAW；NoNewPrivileges=true 下文件 capabilities 会被忽略，
# 必须用 AmbientCapabilities 传递，并用 CapabilityBoundingSet 收窄范围。
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW

# ── 隔离加固 ──
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/diting
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectClock=true
ProtectHostname=true
ProtectControlGroups=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
```

## 管理命令

```bash
# 查看状态
systemctl status diting-agent

# 查看日志
journalctl -u diting-agent -f

# 重启
systemctl restart diting-agent

# 停止
systemctl stop diting-agent

# 卸载（幂等）
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/agent/uninstall.sh | bash
```

## 与 Docker 形态共存

两种形态可以混用：
- 资源充裕的机器用 Docker（隔离性更好）
- 256MB 小鸡用原生（省内存）
- 所有形态上报的数据格式完全一致

切换形态：卸载当前形态 → 安装另一种形态 → 同一 Token 即可恢复历史数据。

## 另见

另有 **Go 二进制形态**（~5MB 静态二进制、内存 <10MB、零依赖），数据格式与安全模型与本形态完全一致，见《受控端部署》中的「Go 受控端」章节。
