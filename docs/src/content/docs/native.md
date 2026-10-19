---
title: 原生 Linux 部署
description: 无 Docker 的原生 systemd 部署方式
---

# 原生 Linux 部署

适用于无 Docker 环境、精简系统、小内存 VPS（256-512MB）。受控端以 **Go 单二进制**运行（M3 起的默认形态），零外部依赖；服务端为 Node.js 原生进程。

## 资源对比

| 部署形态 | 内存基线 | 前置依赖 | 体积 |
|---|---|---|---|
| Docker 容器（服务端） | 65-150MB | Docker Engine (~120MB) | ~80MB |
| **原生 systemd** | 服务端 30-60MB + Go 受控端 <10MB | 无（受控端零依赖） | 二进制 ~5MB |
| 差值 | **省 ~125MB** | — | — |

> 受控端另有 Python 实现（内存 12-25MB），已冻结、仅存量节点使用，新装一律 Go。

## 一键安装（受控端）

```bash
# 后台「添加 Agent」生成的一键命令（含服务端地址与凭据），或手动：
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/diting.sh -o diting.sh
chmod +x diting.sh
sudo ./diting.sh --install-agent --server https://your-server --id <id> --token <token>
```

`diting.sh --install-agent` 内部调用 `agent-go/install.sh`，支持交互与非交互两种模式：

```bash
# 非交互模式（agent-go/install.sh 参数）
curl -fsSL ... | bash -s -- --server "https://monitor.example.com" --token "YOUR_TOKEN"

# 也可直接用安装脚本本身
sudo bash agent-go/install.sh --server https://monitor.example.com --id <id> --token <token> --interval 20
```

## 文件布局

```
/opt/diting/                          ← 程序目录（mkdir -p 创建，未额外 chmod）
├── diting-agent                      ← Go 二进制（755 root:root）
└── uninstall.sh                      ← 卸载脚本
/etc/diting/agent.env                 ← 配置（600，含 SERVER_URL / AGENT_ID / AGENT_TOKEN）
/var/lib/diting/                      ← 状态目录（700 diting:diting，月流量 state.json）
/etc/systemd/system/diting-agent.service
```

> `chmod 700` 只作用于 `/var/lib/diting`（agent-go/install.sh:102）；`/opt/diting` 本身未收窄权限。

## systemd 服务

以下与仓库内 `agent-go/diting-agent.service` 一致：

```ini
[Unit]
Description=Diting Agent (Go)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=diting
EnvironmentFile=/etc/diting/agent.env
ExecStart=/opt/diting/diting-agent
Restart=always
RestartSec=5

# 加固：只读系统 + 仅状态目录可写（Go agent 无出站依赖外的文件需求）
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/diting

[Install]
WantedBy=multi-user.target
```

> Python 版 unit（`agent/diting-agent.service`）另有内核 / cgroup 隔离与
> `AmbientCapabilities=CAP_NET_RAW`（ICMP 探测需要），已随 Python 端冻结、不再演进。

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

# 卸载（幂等；保留 /etc/diting/agent.env 与 /var/lib/diting/state.json，便于同 ID 重装续上月流量）
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/agent-go/uninstall.sh | bash
```

## 与 Docker 形态共存

两种形态可以混用：
- 资源充裕的机器用 Docker（隔离性更好）
- 256MB 小鸡用原生（省内存）
- 所有形态上报的数据格式完全一致

切换形态：卸载当前形态 → 安装另一种形态 → 同一 Token 即可恢复历史数据。

## 另见

本页即 **Go 二进制形态**的 systemd 部署说明（安装 / 布局 / unit / 卸载）。Docker 形态、
环境变量全表与「修改探测目标」见《受控端部署》；旧 Python 受控端（`agent/`）已冻结，仅存量节点参考。
