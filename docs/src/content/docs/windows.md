---
title: Windows 部署
description: Windows 受控端部署
---

# Windows 部署

DiTing 受控端支持 Windows，使用 psutil 采集系统指标。

## 前置条件

- Windows 10 / Server 2016 及以上
- Python 3.8+（[下载](https://www.python.org/downloads/)）

## 安装

以管理员身份运行 PowerShell：

```powershell
cd C:\
git clone https://github.com/fengzone85/diting.git
cd diting\agent\windows
.\install.ps1 -RegisterTask -ServerUrl "https://monitor.example.com" -AgentId "win-pc-01" -AgentToken "<Token>"
```

参数说明：
- `-RegisterTask`：注册「登录即启动」的计划任务，使 agent 后台常驻
- `-ServerUrl`：服务端 URL（如 `https://monitor.example.com`）
- `-AgentId`：节点标识
- `-AgentToken`：节点 Token

## 采集支持

Windows 版受控端通过 psutil 采集：

| 指标 | 支持 |
|---|---|
| CPU 使用率 | ✅ |
| 内存使用率 | ✅ |
| 磁盘使用率 | ✅ |
| 网络流量 | ✅ |
| 温度 | ✅（如硬件支持） |
| Swap | ✅ |
| 开机时长 | ✅ |
| 系统负载 | ❌（Windows 无此概念） |
| 网络质量 | ✅ ICMP/TCP |

## 服务管理

安装后注册为「登录即启动」的计划任务（任务名 `HostMonitorAgent-<AgentId>`），随系统登录自启。

```powershell
# 查看任务状态
Get-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>"

# 手动运行 / 停止
Start-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>"
Stop-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>"

# 查看最近运行结果
Get-ScheduledTaskInfo -TaskName "HostMonitorAgent-<AgentId>"
```

## 卸载

删除计划任务并移除安装目录：

```powershell
# 删除计划任务
Unregister-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>" -Confirm:$false

# 删除安装目录
Remove-Item -Recurse -Force "C:\diting-agent"
```
