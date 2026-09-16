#Requires -Version 5.1
<#
.SYNOPSIS
    Diting Agent (Go) Windows installer: download exe + scheduled task.
.DESCRIPTION
    Scheduled task with -AtStartup (boots without login) running as SYSTEM,
    auto-restart (10 x 1min), single-instance (IgnoreNew + in-bat guard).
    This fixes all three flaws of the Python installer (instance stacking,
    crash exhaustion, login-required startup).
.PARAMETER ServerUrl / AgentId / AgentToken  (required)
.PARAMETER Interval       Report interval seconds (default 20)
.PARAMETER ProbeTargets   label:host[:port] comma-separated (optional)
.PARAMETER InstallDir     Default C:\diting-agent
.PARAMETER RepoBase       Release download base (default latest/download)
#>
param(
    [string]$ServerUrl,
    [string]$AgentId,
    [string]$AgentToken,
    [int]$Interval = 20,
    [string]$ProbeTargets = '',
    [string]$InstallDir = 'C:\diting-agent',
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

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

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
$ptLine = if ($ProbeTargets) { "set PROBE_TARGETS=$ProbeTargets" } else { "" }
$bat = Join-Path $InstallDir 'run-agent.bat'
$cont = @"
@echo off
chcp 65001 >nul
rem single-instance guard: skip launch if already running
tasklist /FI "IMAGENAME eq diting-agent.exe" 2>nul | find /I "diting-agent.exe" >nul && exit /b 0
set SERVER_URL=$ServerUrl
set AGENT_ID=$AgentId
set AGENT_TOKEN=$AgentToken
set INTERVAL=$Interval
$ptLine
"$exe"
"@
# UTF-8 no BOM + chcp 65001 first line: cmd reads ascii fine here (no CJK by default)
[IO.File]::WriteAllText($bat, $cont, (New-Object Text.UTF8Encoding($false)))
Write-Host "[OK] run.bat written"

# 3. Scheduled task: AtStartup + SYSTEM + auto-restart + single instance
$action   = New-ScheduledTaskAction -Execute $bat -WorkingDirectory $InstallDir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName 'diting-agent' -Action $action -Trigger $trigger `
    -User 'SYSTEM' -RunLevel Highest -Settings $settings -Force | Out-Null
Write-Host "[OK] scheduled task 'diting-agent' registered (AtStartup/SYSTEM, restart 10x1min, single-instance)"

# 4. Start now
Start-ScheduledTask -TaskName 'diting-agent'
Start-Sleep -Seconds 3
$info = Get-ScheduledTaskInfo -TaskName 'diting-agent'
Write-Host ("task state: {0}  lastRun: {1}" -f (Get-ScheduledTask -TaskName 'diting-agent').State, $info.LastRunTime)
Write-Host ''
Write-Host '=== install done (Go) ==='
Write-Host "  config: $bat   exe: $exe"
Write-Host '  uninstall: sudo equivalent -> Unregister-ScheduledTask -TaskName diting-agent; Remove-Item -Recurse InstallDir'
