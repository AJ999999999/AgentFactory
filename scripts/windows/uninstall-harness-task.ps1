<#
.SYNOPSIS
Stop and remove an engagement's scheduled harness task. The engagement's state stays in
git; installing the task again carries on where it stopped.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Engagement,
  [string]$Workspace = (Get-Location).Path
)
$ErrorActionPreference = "Stop"
$taskName = "AgentFactory harness - $Engagement"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed '$taskName'."
} else {
  Write-Host "No task named '$taskName'."
}
# Stopping the task ends PowerShell, not necessarily the node loop it started: stop
# the loop by the pid in its heartbeat (only if that pid is still a node process).
$dir = Join-Path $Workspace ".af\harness\$Engagement"
if (Test-Path -LiteralPath $dir) {
  foreach ($hb in Get-ChildItem -LiteralPath $dir -Filter "heartbeat-*.json") {
    $procId = (Get-Content -LiteralPath $hb.FullName -Raw | ConvertFrom-Json).pid
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq "node") {
      Stop-Process -Id $procId -Force
      Write-Host "Stopped the harness loop (pid $procId)."
    }
  }
}
