#Requires -Version 5.1
<#
.SYNOPSIS
    Diting Agent (Go) Windows installer: download exe + scheduled task.
.DESCRIPTION
    Scheduled task with -AtStartup (boots without login) running as LocalService
    (least-privilege; dir ACL granted via icacls at install time),
    auto-restart (10 x 1min), single-instance (IgnoreNew + in-bat guard).
    This fixes all three flaws of the Python installer (instance stacking,
    crash exhaustion, login-required startup).
.PARAMETER ServerUrl / AgentId / AgentToken  (required)
.PARAMETER Interval       Report interval seconds (default 20)
.PARAMETER ProbeTargets   label:host[:port] comma-separated (optional)
.PARAMETER MonthRotate    Traffic reset day (0=cumulative, 1-31; default 0)
.PARAMETER InstallDir     Default %ProgramData%\diting-agent (same as the Python agent,
                          so upgrades reuse the same directory)
.PARAMETER RepoBase       Release download base (default latest/download)
.NOTES
    Deliberately reuses the Python agent's task name (HostMonitorAgent-<id>) and
    run_scheduled.bat name/path so the server's Token-free 「修改探测目标」 command
    (buildModifyCommands, api.js) keeps working after a Python -> Go upgrade.
    This closes the "half-switch window" flagged in the consolidation roadmap §4.2.
#>
param(
    [string]$ServerUrl,
    [string]$AgentId,
    [string]$AgentToken,
    [int]$Interval = 20,
    [string]$ProbeTargets = '',
    [int]$MonthRotate = 0,
    [string]$InstallDir = (Join-Path $env:ProgramData 'diting-agent'),
    [string]$RepoBase = 'https://github.com/fengzone85/diting/releases/latest/download'
)
$ErrorActionPreference = 'Stop'

# L-13: scheme check before any credential is used
if ($ServerUrl -notmatch '^https://') {
    if ($ServerUrl -match '^http://(localhost|127\.0\.0\.1|\[::1\])') {
        Write-Warning 'localhost http: local test only; production must use https'
    } else {
        Write-Error 'SERVER_URL must use https (agent refuses plain http for non-localhost)'
        exit 1
    }
}

if ($MonthRotate -lt 0 -or $MonthRotate -gt 31) {
    Write-Warning "Invalid -MonthRotate $MonthRotate; falling back to 0 (cumulative)."
    $MonthRotate = 0
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# M3 §4.6: explicitly grant the scheduled-task run account Modify on the install
# dir. The dir is created by this (elevated) installer, so by default only
# SYSTEM/Administrators can write it — a non-admin run account would hit the same
# silent state-write failure that broke the Python agent. Granting LocalService
# here closes that class of bug regardless of how the dir was created.
# S-1-5-19 = NT AUTHORITY\LocalService. (OI)(CI) = inherit to subfiles/subdirs.
icacls "$InstallDir" /grant "*S-1-5-19:(OI)(CI)(M)" /Q | Out-Null
Write-Host '[OK] ACL: LocalService granted Modify on install dir'

# 审查 B2：移除本地用户对安装目录的读取权。run_scheduled.bat 明文存放 AGENT_TOKEN
# （见下方写入），而 %ProgramData% 子目录默认继承的 ACL 允许任意本地交互用户
# （Users / Authenticated Users）读取——等同把令牌交给同机所有用户，可借此伪装
# agent 向服务端上报伪造指标。做法：禁用继承后显式只授予三个账号（均含 (OI)(CI)
# 继承到子文件，保证后续写入的 bat/exe 同样受保护），再移除 Users 与
# Authenticated Users。SID：S-1-5-18=SYSTEM，S-1-5-32-544=Administrators，
# S-1-5-19=LocalService，S-1-5-11=Authenticated Users，S-1-5-32-545=Users。
icacls "$InstallDir" /inheritance:r /Q | Out-Null
icacls "$InstallDir" /grant "*S-1-5-18:(OI)(CI)(F)" /Q | Out-Null
icacls "$InstallDir" /grant "*S-1-5-32-544:(OI)(CI)(F)" /Q | Out-Null
icacls "$InstallDir" /grant "*S-1-5-19:(OI)(CI)(M)" /Q | Out-Null
icacls "$InstallDir" /remove:g "*S-1-5-11" /Q | Out-Null
icacls "$InstallDir" /remove:g "*S-1-5-32-545" /Q | Out-Null
Write-Host '[OK] ACL: Users/Authenticated Users read removed (SYSTEM/Administrators/LocalService only)'

# Least-privilege parity with the Linux agent (which reads /proc as a normal user):
# the run account also needs read access to the PDH performance counters the agent
# uses (\PhysicalDisk, \System\Processes, \Thermal Zone Information). Standard users
# can read these, but LocalService is not a member of "Users", so grant the
# purpose-built "Performance Monitor Users" role (well-known SID S-1-5-32-558,
# locale-independent). Idempotent and non-fatal: any counter that still can't be
# read degrades gracefully to 0/nil rather than failing the install.
try {
    $perfGroup = Get-LocalGroup -SID 'S-1-5-32-558' -ErrorAction Stop
    $alreadyMember = Get-LocalGroupMember -Group $perfGroup.Name -ErrorAction Stop |
        Where-Object { $_.SID.Value -eq 'S-1-5-19' }
    if (-not $alreadyMember) {
        $lsName = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-19')).Translate([System.Security.Principal.NTAccount]).Value
        Add-LocalGroupMember -Group $perfGroup.Name -Member $lsName -ErrorAction Stop
        Write-Host '[OK] LocalService granted perf-counter read (Performance Monitor Users)'
    }
} catch {
    Write-Warning "Could not grant LocalService perf-counter read: $($_.Exception.Message)"
}

# 1. Download exe + SHA256 verify
$exe = Join-Path $InstallDir 'diting-agent.exe'
Write-Host "Downloading $RepoBase/diting-agent-windows-amd64.exe ..."
Invoke-WebRequest "$RepoBase/diting-agent-windows-amd64.exe" -OutFile $exe -UseBasicParsing
$expected = (Invoke-WebRequest "$RepoBase/diting-agent-windows-amd64.exe.sha256" -UseBasicParsing).Content.Trim()
$actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) {
    Write-Error "SHA256 mismatch: want $expected got $actual"
    exit 1
}
Write-Host '[OK] SHA256 verified'

# 2. run.bat with single-instance guard (belt and braces alongside IgnoreNew)
# Keep the Python agent's file name run_scheduled.bat: the server's modify-probe
# command rewrites the "set PROBE_TARGETS=" line in this exact file.
# When --ProbeTargets is omitted, write the server-side default target list so
# the line ALWAYS exists (otherwise the modify command would append it after
# the exe launch line, where it would never take effect).
$ptValue = if ($ProbeTargets) { $ProbeTargets } else { 'CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8' }
$ptLine = "set PROBE_TARGETS=$ptValue"
$bat = Join-Path $InstallDir 'run_scheduled.bat'
$cont = @"
@echo off
chcp 65001 >nul
rem single-instance guard: skip launch if already running
tasklist /FI "IMAGENAME eq diting-agent.exe" 2>nul | find /I "diting-agent.exe" >nul && exit /b 0
set SERVER_URL=$ServerUrl
set AGENT_ID=$AgentId
set AGENT_TOKEN=$AgentToken
set INTERVAL=$Interval
set MONTH_ROTATE=$MonthRotate
set STATE_FILE=$InstallDir\state.json
$ptLine
"$exe"
"@
# UTF-8 no BOM + chcp 65001 first line: cmd reads ascii fine here (no CJK by default)
[IO.File]::WriteAllText($bat, $cont, (New-Object Text.UTF8Encoding($false)))
Write-Host "[OK] run.bat written"

# Convenience hidden launcher for MANUAL starts. The scheduled task already runs in
# session 0 (no console window); this is only for the "double-click to start" case.
# Running run_scheduled.bat directly opens a cmd window, and closing it kills the
# agent (console close = CTRL_CLOSE to the whole process tree). run_hidden.vbs
# launches it with window style 0 (hidden).
$vbs = Join-Path $InstallDir 'run_hidden.vbs'
$vbsCont = 'CreateObject("WScript.Shell").Run "cmd /c ""{0}""", 0, False' -f $bat
[IO.File]::WriteAllText($vbs, $vbsCont, (New-Object Text.UTF8Encoding($false)))
Write-Host "[OK] hidden launcher written: $vbs"

# 3. Scheduled task: AtStartup + LocalService + auto-restart + single instance.
# Task name stays HostMonitorAgent-<id> (same as the Python installer) so the
# server-side modify command's Stop/Start-ScheduledTask keeps targeting it.
$taskName = "HostMonitorAgent-$AgentId"
$action   = New-ScheduledTaskAction -Execute $bat -WorkingDirectory $InstallDir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -User 'LocalService' -RunLevel Limited -Settings $settings -Force | Out-Null
Write-Host "[OK] scheduled task '$taskName' registered (AtStartup/LocalService, restart 10x1min, single-instance)"

# 4. Start now
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host ("task state: {0}  lastRun: {1}" -f (Get-ScheduledTask -TaskName $taskName).State, $info.LastRunTime)
Write-Host ''
Write-Host '=== install done (Go) ==='
Write-Host "  config: $bat   exe: $exe"
Write-Host "  uninstall: Unregister-ScheduledTask -TaskName $taskName; Remove-Item -Recurse '$InstallDir'"
Write-Host "  manual start: wscript '$vbs'   (do NOT double-click run_scheduled.bat)"
