<#
.SYNOPSIS
Keep an AgentFactory engagement's harness running on this machine with Task Scheduler.

.DESCRIPTION
Registers one scheduled task per engagement. The task runs `harness loop`: it starts
at logon, and is retried every 15 minutes; a retry while the loop is alive is ignored,
so a crashed or killed loop is back within 15 minutes. It runs as you, only while you're
logged on (a locked screen is fine), so it uses your Copilot CLI sign-in and your git
credentials. Nothing runs while the machine sleeps; the loop catches up when it wakes.

Run it from the directory where you opened the engagement (the one holding .af\harness).

.EXAMPLE
cd C:\workspace\engagements
powershell -ExecutionPolicy Bypass -File C:\workspace\AgentFactory\scripts\windows\install-harness-task.ps1 -Engagement kids-rockets
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Engagement,
  [string]$Workspace = (Get-Location).Path,
  [string]$Runner = ($env:COMPUTERNAME).ToLower(),
  [int]$PollMinutes = 10,
  [int]$Slots = 1,
  [string]$Caps = "shell",
  [string]$Copilot = "copilot",
  [string]$Node = "",
  # Interactive: runs while you're logged on, with your credentials (use this).
  # S4U: runs without a logon session but can't read your stored credentials (CI only).
  [ValidateSet("Interactive", "S4U")][string]$LogonType = "Interactive",
  [switch]$WakeToRun
)
$ErrorActionPreference = "Stop"

$runScript = Join-Path $PSScriptRoot "run-harness.ps1"
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$config = Join-Path $Workspace ".af\harness\$Engagement\config.json"
if (-not (Test-Path -LiteralPath $config)) {
  throw "No engagement '$Engagement' in $Workspace (missing $config). Open it from this directory first: npm run harness -- open <engagement.json> --remote <url>"
}
# The task doesn't inherit this shell's PATH (or nvm's choice), so pin the node to use.
if (-not $Node) { $Node = (Get-Command node -ErrorAction Stop).Source }
$version = (& $Node --version).TrimStart("v").Split(".")
if ([int]$version[0] -lt 22 -or ([int]$version[0] -eq 22 -and [int]$version[1] -lt 18)) {
  throw "Node $($version -join '.') at $Node is too old: the harness needs 22.18 or later."
}
if ($Copilot -match '[\\/]') { $Copilot = (Resolve-Path -LiteralPath $Copilot).Path }

$taskName = "AgentFactory harness - $Engagement"
$user = "$env:USERDOMAIN\$env:USERNAME"
$q = { param($s) '"' + $s + '"' }
$argLine = @(
  "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
  "-File", (& $q $runScript),
  "-Engagement", (& $q $Engagement), "-Workspace", (& $q $Workspace), "-Runner", (& $q $Runner),
  "-PollMinutes", $PollMinutes, "-Slots", $Slots, "-Caps", (& $q $Caps),
  "-Copilot", (& $q $Copilot), "-Node", (& $q $Node)
) -join " "

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine -WorkingDirectory $Workspace
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
if ($WakeToRun) { $settings.WakeToRun = $true }
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $LogonType -RunLevel Limited
$desc = "Keeps the AgentFactory harness for '$Engagement' running (scripts\windows\run-harness.ps1). Log: $Workspace\.af\harness\$Engagement\loop.log"

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
} catch {
  # Some machines don't let a standard user add a logon trigger. The 15-minute retry
  # alone still starts the loop (StartWhenAvailable catches up after sleep or logon).
  Write-Warning "Couldn't add the at-logon trigger ($($_.Exception.Message.Trim())). Using the 15-minute retry alone."
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $repeat -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
}
Start-ScheduledTask -TaskName $taskName

Write-Host "Installed '$taskName'. It's running now and restarts within 15 minutes if it stops."
Write-Host "  log:    $Workspace\.af\harness\$Engagement\loop.log"
Write-Host "  check:  npm run harness -- doctor     (from $Workspace)"
Write-Host "  remove: powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\uninstall-harness-task.ps1`" -Engagement $Engagement"
