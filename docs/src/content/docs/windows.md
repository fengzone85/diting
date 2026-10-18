---
title: Windows 部署
description: Windows 受控端部署
---

# Windows 部署

DiTing 受控端在 Windows 上以 **Go 单二进制**形态运行（~5MB、零外部依赖，无需安装 Python）。

## 前置条件

- Windows 10 / Server 2016 及以上
- **管理员**权限的 PowerShell（安装需注册计划任务、授予安装目录权限）
- 服务端已部署，且本机可访问其 HTTPS 地址

## 安装

在监控后台「添加 Agent」处复制一键命令，以**管理员**身份运行。命令形如：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "`$p=Join-Path `$env:TEMP 'diting-go-install.ps1'; iwr 'https://raw.githubusercontent.com/fengzone85/diting/master/agent-go/install-go.ps1' -OutFile `$p -UseBasicParsing; & `$p -RepoBase 'https://github.com/fengzone85/diting/releases/latest/download' -ServerUrl 'https://monitor.example.com' -AgentId '<AgentId>' -AgentToken '<Token>' -Interval 20"
```

安装器（`agent-go/install-go.ps1`）会：

1. 从 GitHub Release 下载 `diting-agent-windows-amd64.exe`，并做 **SHA256 强制校验**
2. 安装到 `%ProgramData%\diting-agent`，并授予运行账户该目录的 Modify 权限
3. 生成环境变量载体 `run_scheduled.bat` 与隐藏启动器 `run_hidden.vbs`
4. 注册「开机即启动」的计划任务 `HostMonitorAgent-<AgentId>`，随后立即启动

参数说明：
- `-ServerUrl`：服务端 URL，必须为 `https://`（仅 localhost/127.0.0.1/::1 允许 http）
- `-AgentId` / `-AgentToken`：后台分配的节点标识与令牌
- `-Interval`：上报间隔（秒），默认 20，下限 5
- `-ProbeTargets`：可选，网络质量自测目标（`label:host[:port]` 逗号分隔）

> 旧版 Python 受控端（`agent/windows/`）已冻结，新装一律走上述 Go 版；
> 存量 Python 节点的卸载见文末「旧版（Python）受控端卸载」。

## 采集支持

Windows 版受控端经 Win32 API / PDH 性能计数器直采（纯 `syscall.NewLazyDLL`，不引第三方依赖）：

| 指标 | 支持 |
|---|---|
| CPU 使用率 | ✅ `GetSystemTimes` 差分 |
| 内存使用率 | ✅ `GlobalMemoryStatusEx` |
| 磁盘使用率 | ✅ 全部固定盘求和 |
| 磁盘 IO 速率 | ✅ PDH `\PhysicalDisk(_Total)` 读/写 Bytes/sec |
| 网络流量 | ✅ `GetIfEntry2` 64 位计数，排除 loopback |
| 温度 | ✅ PDH `\Thermal Zone Information`；无 ACPI 热区时上报 `null` |
| 进程总数 | ✅ PDH `\System\Processes`（仅一个整数计数，不含任何进程明细） |
| Swap | ✅ 页文件语义（与 `psutil.swap_memory` 一致，Windows 上通常为 0） |
| 开机时长 | ✅ `GetTickCount64` |
| 系统负载 | ⚠️ Windows 无 load average，`load1` / `load5` / `load15` 恒为 `0.0`（= 未采集） |
| 网络质量 | ✅ 纯 TCP 握手时延；`loss` 只有 0 / 100 二值，不伪造中间值 |
| 操作系统名 | ✅ 注册表产品名（如 `Windows 11`），不含 build 号 |

## 服务管理

安装后注册为计划任务 `HostMonitorAgent-<AgentId>`：**开机即启动（无需登录）**，以
`LocalService` 最小权限运行（安装期已授予安装目录 Modify 权限、并加入「Performance
Monitor Users」组以读 PDH 计数器），崩溃自动重启（10 × 1min），单实例互斥。

```powershell
# 查看任务状态
Get-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>"

# 手动运行 / 停止
Start-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>"
Stop-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>"

# 查看最近运行结果
Get-ScheduledTaskInfo -TaskName "HostMonitorAgent-<AgentId>"
```

> 手动启动请用 `Start-ScheduledTask` 或 `wscript "%ProgramData%\diting-agent\run_hidden.vbs"`；
> **勿直接双击 `run_scheduled.bat`**——它会留下 cmd 窗口，关窗即杀掉 agent
> （计划任务本身在 session 0 运行，无窗口）。

配置位于 `%ProgramData%\diting-agent\run_scheduled.bat`（环境变量 `SERVER_URL` / `AGENT_ID` /
`AGENT_TOKEN` / `INTERVAL` / `STATE_FILE` / `PROBE_TARGETS`）。服务端「修改探测目标」命令
改的就是该文件里的 `PROBE_TARGETS` 行并重启任务，无需重装、无需 Token。

## 卸载

Go 版受控端不写注册表、不装系统服务，卸载只需删除计划任务与安装目录。
以**管理员**身份运行 PowerShell：

```powershell
# 1) 停任务并结束进程
Stop-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>"
Stop-Process -Name diting-agent -Force -ErrorAction SilentlyContinue

# 2) 删除计划任务
Unregister-ScheduledTask -TaskName "HostMonitorAgent-<AgentId>" -Confirm:$false

# 3) 删除安装目录（含 state.json 月流量累计）
Remove-Item -Recurse -Force "$env:ProgramData\diting-agent"
```

校验是否清理干净：

```powershell
Get-ScheduledTask -TaskName "HostMonitorAgent-*" -ErrorAction SilentlyContinue  # 应无输出
Test-Path "$env:ProgramData\diting-agent"                                       # 应为 False
```

服务端不会因卸载自动删除节点记录，卡片会在超过上报阈值后转为离线；
如需彻底移除，请在后台删除该 Agent。

### 旧版（Python）受控端卸载

「旧版」指 `agent/windows/` 的 Python 受控端（已冻结）。它的安装痕迹共三处：
计划任务、安装目录、全局 `psutil` 依赖。以**管理员**身份运行 PowerShell：

```powershell
# 1) 停掉正在运行的 Python 实例（进程占用会导致目录删除失败）
Get-ScheduledTask -TaskName "HostMonitorAgent-*" | Stop-ScheduledTask
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
  Where-Object { $_.CommandLine -like '*windows_agent.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2) 删除计划任务（任务名含 AgentId，用通配符可一次清理）
Get-ScheduledTask -TaskName "HostMonitorAgent-*" | Unregister-ScheduledTask -Confirm:$false

# 3) 删除安装目录
Remove-Item -Recurse -Force "$env:ProgramData\diting-agent"

# 4) 可选：卸载全局依赖（机器上没有其他 Python 程序使用 psutil 时）
python -m pip uninstall -y psutil
```

安装目录有两种可能：经一键命令（自举下载）安装时为 `%ProgramData%\diting-agent`；
若在仓库克隆目录内直接执行 `install.ps1`，则为该克隆目录（如 `C:\diting\agent\windows`，
脚本以自身所在目录作为安装目录）。

> **注意**：Go 版安装器刻意复用同一安装目录与任务名 `HostMonitorAgent-<AgentId>`
> （以便服务端「修改探测目标」命令在 Python → Go 升级后继续生效）。若该机已升级到
> Go 版，上述第 2 步的删任务会**一并删除 Go 版受控端**；只想清理 Python 残留文件时，
> 只删除 `windows_agent.py` / `win_collector.py` / `requirements.txt` / `__pycache__`。
