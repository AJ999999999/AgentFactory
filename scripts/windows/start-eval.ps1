<#
.SYNOPSIS
Starts an eval run as its own hidden process, so it keeps going when the terminal or the
Claude Code session that started it ends (a background task there is stopped after two
hours, and every task stops when the session hits a usage limit).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\windows\start-eval.ps1 -RunId full-copilot-3 -EvalArgs "--arms A,B,C,D --runs 2"

The run waits out usage limits and dead gateways by itself (see src/eval/run.ts). Watch it
with: Get-Content .af\eval\<run id>\eval.log -Wait. Start it again with the same -RunId to
continue a run that stopped; finished case runs are skipped.
#>
param(
  [Parameter(Mandatory = $true)][string]$RunId,
  [string]$EvalArgs = "",
  [string]$Node = "node"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$out = Join-Path $root ".af\eval\$RunId"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$run = Join-Path $root "src\eval\run.ts"
# eval.log is the run's own log; stdout and stderr go next to it, for a crash it couldn't log.
$p = Start-Process -FilePath $Node -ArgumentList (@("--no-warnings", "`"$run`"", "--run-id", $RunId) + ($EvalArgs -split '\s+' | Where-Object { $_ })) `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $out "stdout.log") -RedirectStandardError (Join-Path $out "stderr.log")
Set-Content -Path (Join-Path $out "pid") -Value $p.Id
Write-Output "eval $RunId started (pid $($p.Id)); log: $(Join-Path $out 'eval.log')"
