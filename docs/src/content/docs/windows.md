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
| 温度 | ⚠️ Windows 上 psutil 无 `sensors_temperatures`，恒为 `null`（Go 版走 PDH 热区） |
| Swap | ✅（`swap_memory`，Windows 多用页面文件，通常为 0） |
| 开机时长 | ✅ |
| 系统负载 | ⚠️ Windows 无 load average，`load1/load5/load15` 恒为 `0.0`（未采集；禁用进程数近似——进程数属指纹字段） |
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

## 排障：月流量每到重启就归零

**症状**：该节点的 `net_rx_month` / `net_tx_month` 每次 agent 进程重启（含开机）都从小数值
重新增长，`state.json` 的修改时间长期不变。

**根因（2026-10-13 真机确认）**：以**管理员** PowerShell 运行 `install.ps1` 时，自举创建的
`%ProgramData%\diting-agent` 及其中文件属主是 `Administrators`、ACL 只给 `BUILTIN\Users`
读权限；而 agent 由计划任务以登录用户的**常规权限**运行 → 写 `state.json` 报 `PermissionError`，
旧实现的写失败只打 `log.debug`（默认级别 WARNING），因此无声无息。

**修复**（管理员 cmd，一次性；只授权这一个目录，不改变 agent 的运行身份）：

```cmd
icacls "C:\ProgramData\diting-agent" /grant "%USERDOMAIN%\%USERNAME%:(OI)(CI)M" /T
```

随后重启任务：`schtasks /end /tn HostMonitorAgent-<AgentId>` →
`schtasks /run /tn HostMonitorAgent-<AgentId>`。修复后首次启动若读到已跨月的旧状态会清零
一次（预期行为），此后跨重启保持连续。

> 权限口径与 Linux 版一致：`install.sh` 是 `chown -R diting:diting /var/lib/diting`（安装期
> 提权、运行期非提权），Windows 侧对应「安装期 `icacls` 授权 + 计划任务常规权限运行」。
> 本仓库的 `install.ps1` 已内置这一步（第 0b 步），详见 `agent/windows/README.md`。

## 卸载

删除计划任务并移除安装目录：

```powershell
# 删除计划任务
Unregister-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>" -Confirm:$false

# 删除安装目录
Remove-Item -Recurse -Force "C:\diting-agent"
```
