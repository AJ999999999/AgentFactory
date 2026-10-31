<#
.SYNOPSIS
What the scheduled task runs: the harness loop for one engagement, logging to a file.
Started hidden by install-harness-task.ps1; you don't run this yourself.
#>
param(
  [Parameter(Mandatory = $true)][string]$Engagement,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [string]$Runner = ($env:COMPUTERNAME).ToLower(),
  [int]$PollMinutes = 10,
  [int]$Slots = 1,
  [string]$Caps = "shell",
  [string]$Copilot = "copilot",
  [string]$Node = "node"
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $Workspace
$dir = Join-Path $Workspace ".af\harness\$Engagement"
$log = Join-Path $dir "loop.log"
$err = Join-Path $dir "loop.err.log"
$cli = Join-Path $root "src\harness\cli.ts"

# The loop writes its own log. Anything on stderr (a crash before it could log) goes
# to loop.err.log; stdout duplicates the log and is dropped.
& $Node --no-warnings $cli loop --engagement $Engagement --runner $Runner --poll $PollMinutes --slots $Slots --caps $Caps --copilot $Copilot --log $log 2>> $err > $null
exit $LASTEXITCODE
