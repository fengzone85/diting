#Requires -Version 5.1
<#
.SYNOPSIS
    Windows Monitor Agent 安装脚本：安装依赖，可选注册为开机启动的计划任务。
.DESCRIPTION
    1) 检查 Python 3.9+
    2) pip install -r requirements.txt
    3) (可选 -RegisterTask) 注册登录即启动的计划任务，使 agent 后台常驻
    4) 授予当前用户对安装目录的读写权限（agent 需写 state.json 月流量状态文件）
.PARAMETER ServerUrl   监控服务端地址，如 https://monitor.example.com
.PARAMETER AgentId     在后台「添加 Agent」获得的 ID
.PARAMETER AgentToken  在后台「添加 Agent」获得的 Token
.PARAMETER DiskPath    统计的磁盘盘符，默认 C:\
.PARAMETER Interval    上报间隔（秒），默认 15
.PARAMETER ProbeTargets 网络质量自测目标（可选）。格式 label:host[:port]，逗号分隔；不填则用默认三家运营商 DNS + 8.8.8.8，置空则关闭。目标写在本地，服务端不可下发。
.PARAMETER RegisterTask 开关；指定则创建开机启动任务
.PARAMETER Repo        agent 载荷（windows_agent.py 等）的 raw 仓库基址；经一键命令单独下载 install.ps1 时用于自举拉取配套文件
.EXAMPLE
    .\install.ps1 -RegisterTask -ServerUrl https://monitor.example.com -AgentId win-pc-01 -AgentToken xxxx
#>
param(
    [string]$ServerUrl,
    [string]$AgentId,
    [string]$AgentToken,
    [string]$DiskPath = 'C:\',
    [int]$Interval = 15,
    [string]$ProbeTargets = '',
    [switch]$RegisterTask,
    [string]$Repo = 'https://raw.githubusercontent.com/fengzone85/diting/master/agent/windows'
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# ── 供应链完整性（L-6）────────────────────────────────────────────────────────
# 下载配套文件后可选 SHA256 校验，防 CDN/中间人投毒。
# 用法：先对已知良好版本算好各文件哈希（按下载顺序），
#   $env:SP_AGENT_SHA256S = "哈希1,哈希2,哈希3"
# 未设置则跳过校验（仍建议审阅下载内容）。
function Test-FileSha256 {
    param([string]$Path, [string]$Expected)
    if (-not $Expected) { return $true }
    $algo = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hash = ($algo.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    $algo.Dispose()
    if ($hash -ne $Expected.Trim().ToLower()) {
        Write-Error "校验和不符: $Path 期望 $Expected 实际 $hash"
        return $false
    }
    Write-Host "[OK] SHA256 校验通过: $Path"
    return $true
}

# 0) 自举：一键命令只单独下载了 install.ps1，同目录没有 agent 载荷。
#    此时把配套文件下载到持久安装目录（%ProgramData%\diting-agent），
#    后续依赖安装 / 计划任务全部指向该目录（避免指向 TEMP 被清理）。
$InstallDir = $ScriptDir
if (-not (Test-Path (Join-Path $ScriptDir 'windows_agent.py'))) {
    $InstallDir = Join-Path $env:ProgramData 'diting-agent'
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Host "同目录未找到 windows_agent.py，正从 $Repo 下载配套文件到 $InstallDir ..."
    $files = 'windows_agent.py', 'win_collector.py', 'requirements.txt'
    $expList = if ($env:SP_AGENT_SHA256S) { $env:SP_AGENT_SHA256S -split ',' } else { @() }
    for ($i = 0; $i -lt $files.Count; $i++) {
        $f = $files[$i]
        try {
            Invoke-WebRequest "$Repo/$f" -OutFile (Join-Path $InstallDir $f) -UseBasicParsing
        } catch {
            Write-Error "下载 $f 失败：$($_.Exception.Message)"
            exit 1
        }
        $exp = if ($i -lt $expList.Count) { $expList[$i] } else { '' }
        if (-not (Test-FileSha256 -Path (Join-Path $InstallDir $f) -Expected $exp)) { exit 1 }
    }
    Write-Host '配套文件下载完成。'
}

# ── 0b) 权限：确保运行 agent 的账户能写状态文件 ─────────────────────────────────
# 背景（2026-10-13 真机事故）：在管理员会话里安装时，自举目录与其中文件属主是
# Administrators、ACL 只给 BUILTIN\Users 读权限；而 agent 由计划任务以登录用户的
# **常规权限**常驻，于是 state.json 每次写入都 PermissionError，月流量累计静默
# 归零数周（旧实现只打 debug 日志，默认级别看不见）。安装期（此处有管理员权限）
# 把本目录树的 Modify 授予当前用户——最小授权：只给这一个目录，不动其它路径。
$GrantUser = "$env:USERDOMAIN\$env:USERNAME"
& icacls $InstallDir /grant "${GrantUser}:(OI)(CI)M" /T | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK]  已授予 $GrantUser 对 $InstallDir 的读写权限（state.json 需可写）"
} else {
    Write-Warning "授予 $GrantUser 对 $InstallDir 的写权限失败，agent 可能无法保存月流量状态。"
    Write-Warning "请以管理员身份重跑本脚本，或手动执行：icacls `"$InstallDir`" /grant `"$GrantUser:(OI)(CI)M`" /T"
}

# 1) 检查 Python
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) {
    Write-Error '未找到 python。请先安装 Python 3.9+ 并勾选「Add to PATH」。'
    exit 1
}
$ver = & python -c "import sys; print('%d.%d' % sys.version_info[:2])"
Write-Host "检测到 Python $ver"

# 2) 安装依赖
Write-Host '正在安装依赖 (psutil) ...'
& python -m pip install --upgrade pip | Out-Null
& python -m pip install -r (Join-Path $InstallDir requirements.txt)
Write-Host '依赖安装完成。'

# 3) 注册计划任务（开机自启、崩溃自动重启）
if ($RegisterTask) {
    if (-not $ServerUrl -or -not $AgentId -or -not $AgentToken) {
        Write-Error '注册计划任务需提供 -ServerUrl -AgentId -AgentToken'
        exit 1
    }
    $bat = Join-Path $InstallDir 'run_scheduled.bat'
    $probeLine = if ($ProbeTargets) { "set PROBE_TARGETS=$ProbeTargets" } else { "" }
    $content = @"
@echo off
chcp 65001 >nul
set SERVER_URL=$ServerUrl
set AGENT_ID=$AgentId
set AGENT_TOKEN=$AgentToken
set DISK_PATH=$DiskPath
set INTERVAL=$Interval
$probeLine
python "$InstallDir\windows_agent.py"
"@
    # 中文 PROBE_TARGETS 的编码链：bat 必须无 BOM UTF-8 + 首行 chcp 65001。
    # 此前 -Encoding ascii 把中文写成 '?'（实测 probes 标签变 '??' 且四家去重剩一个）；
    # PS5.1 的 -Encoding utf8 带 BOM 会让 cmd 首行报错，故用 WriteAllText 无 BOM 落盘。
    [IO.File]::WriteAllText($bat, $content, (New-Object System.Text.UTF8Encoding($false)))

    $action = New-ScheduledTaskAction -Execute $bat -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0) -Hidden
    $taskName = "HostMonitorAgent-$AgentId"
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Force | Out-Null
    Write-Host "已注册开机启动任务：$taskName （可在「任务计划程序」中管理）"
}

Write-Host ''
Write-Host '安装完成。'
Write-Host "  - 安装目录：$InstallDir"
Write-Host "  - 临时运行：python `"$InstallDir\windows_agent.py`""
if (-not $RegisterTask) {
    Write-Host '  - 注册为服务：powershell -ExecutionPolicy Bypass -File install.ps1 -RegisterTask -ServerUrl <url> -AgentId <id> -AgentToken <token>'
}
# ── 启动 Agent ────────────────────────────────────────────────────────────────
# 关键：不要在管理员会话里用 Start-Process 直接拉起 agent —— 子进程会继承提权
# token，agent 以管理员身份常驻（违背受控端最小权限），且它写出的 state.json
# 属主是 Administrators，之后普通权限的计划任务实例再也写不进去，月流量静默归零
# （2026-10-13 真机事故的成因之一）。注册了任务就从任务启动（任务以登录用户的
# 常规权限运行）；未注册任务则提示用户手动以普通权限启动。
if ($RegisterTask) {
    Write-Host '正在通过计划任务启动 Agent（常规权限）...'
    & schtasks /run /tn "HostMonitorAgent-$AgentId" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK]  已启动：HostMonitorAgent-$AgentId"
    } else {
        Write-Warning "计划任务启动失败，请手动运行：$InstallDir\run_scheduled.bat"
    }
} else {
    $IsElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($IsElevated) {
        Write-Host "提示：当前是管理员会话，请以普通权限双击运行 $InstallDir\run_scheduled.bat 启动 agent"
        Write-Host '（在管理员会话里启动会让 agent 提权常驻，且写出的状态文件普通权限改不动。）'
    } else {
        Write-Host '正在启动 Agent（后台运行，隐藏窗口）...'
        Start-Process -WindowStyle Hidden -FilePath "$InstallDir\run_scheduled.bat"
    }
}
