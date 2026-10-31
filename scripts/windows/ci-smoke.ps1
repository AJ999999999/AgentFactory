<#
CI only (GitHub Actions, windows-latest). Installs the harness's scheduled task the way
a user would, against a local engagement and a fake Copilot CLI laid out exactly like
`npm install -g @github/copilot` lays out the real one (a .cmd shim), waits for the
loop to do a turn, checks the task's settings, the doctor and a quiet tick, and removes
the task. Every failure becomes an annotation readable from the checks API.
#>
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$work = Join-Path $env:RUNNER_TEMP "af-smoke"
$taskName = "AgentFactory harness - smoke"
$engDir = Join-Path $work ".af\harness\smoke"
$cli = Join-Path $repo "src\harness\cli.ts"

function Esc([string]$s) { return ($s -replace '%', '%25' -replace "`r", '%0D' -replace "`n", '%0A') }
function Fail([string]$msg) {
  $tail = ""
  foreach ($f in @("$engDir\loop.log", "$engDir\loop.err.log")) {
    if (Test-Path $f) { $tail += "`n--- $(Split-Path -Leaf $f)`n" + ((Get-Content $f -Tail 40) -join "`n") }
  }
  Write-Host "::error title=windows scheduled task::$(Esc ($msg + $tail))"
  & "$repo\scripts\windows\uninstall-harness-task.ps1" -Engagement smoke -Workspace $work
  exit 1
}

Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null

# 1. A fake Copilot CLI, installed the way npm installs the real one.
$npm = Join-Path $work "npm-global"
$pkg = Join-Path $npm "node_modules\@github\copilot"
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
@'
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.0.0-fake"); process.exit(0); }
fs.mkdirSync("work", { recursive: true });
fs.writeFileSync("work/hello.md", "written by the fake Copilot CLI on Windows\n");
fs.writeFileSync("work/args.json", JSON.stringify(args));
console.log("Some prose first, with % and & and | in it.");
console.log(JSON.stringify({ done: true, note: "fake copilot wrote work/hello.md" }));
'@ | Set-Content -Encoding ascii -Path (Join-Path $pkg "index.js")
@'
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@github\copilot\index.js" %*
'@ | Set-Content -Encoding ascii -Path (Join-Path $npm "copilot.cmd")
$copilot = Join-Path $npm "copilot.cmd"

# 2. An engagement with one piece of work for a library role (a builder).
@'
{ "id": "smoke", "title": "Windows smoke", "principals": { "partner": "you" },
  "goals": [{ "id": "g", "title": "Smoke", "objective": "Prove the loop runs on Windows", "owner": "partner",
    "scope": ["work"], "assumptions": [], "budget": { "turns": 5 },
    "todos": [{ "id": "hello", "lane": "build", "text": "Write work/hello.md", "writeScope": ["work"] }] }] }
'@ | Set-Content -Encoding ascii -Path (Join-Path $work "smoke.json")
Push-Location $work
& node --no-warnings $cli agents install
if ($LASTEXITCODE) { Fail "agents install failed" }
& node --no-warnings $cli open smoke.json
if ($LASTEXITCODE) { Fail "harness open failed" }

# 3. Install the task. S4U because the CI user has no interactive logon; users install
#    with the default (Interactive), which can read their stored credentials.
& "$repo\scripts\windows\install-harness-task.ps1" -Engagement smoke -Workspace $work -PollMinutes 1 -Copilot $copilot -LogonType S4U
if (-not $?) { Fail "install-harness-task.ps1 failed" }

$t = Get-ScheduledTask -TaskName $taskName
$rep = $t.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1
$settings = "triggers=$($t.Triggers.Count); repeat=$($rep.Repetition.Interval) for '$($rep.Repetition.Duration)'; instances=$($t.Settings.MultipleInstances); battery=$($t.Settings.DisallowStartIfOnBatteries)/$($t.Settings.StopIfGoingOnBatteries); limit=$($t.Settings.ExecutionTimeLimit); action=$($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
Write-Host "::notice title=task settings::$(Esc $settings)"
if ($t.Settings.MultipleInstances -ne "IgnoreNew") { Fail "MultipleInstances is $($t.Settings.MultipleInstances), not IgnoreNew" }
if ($rep.Repetition.Interval -ne "PT15M") { Fail "the retry trigger repeats every '$($rep.Repetition.Interval)', not PT15M" }
if ($rep.Repetition.Duration -and $rep.Repetition.Duration -ne "") { Fail "the retry trigger stops after $($rep.Repetition.Duration); it must repeat indefinitely" }
if ($t.Settings.DisallowStartIfOnBatteries -or $t.Settings.StopIfGoingOnBatteries) { Fail "the task won't run on battery" }

# 4. The loop's first wake should do the turn.
$log = Join-Path $engDir "loop.log"
$deadline = (Get-Date).AddMinutes(6)
$done = $false
while ((Get-Date) -lt $deadline -and -not $done) {
  Start-Sleep -Seconds 5
  $done = (Test-Path $log) -and (Select-String -Path $log -Pattern "hello: completed" -Quiet)
}
if (-not $done) {
  $info = (Get-ScheduledTaskInfo -TaskName $taskName | Format-List | Out-String)
  Fail "the loop didn't complete the todo within 6 minutes.`n$info"
}
$control = Join-Path $engDir "control"
& git -C $control fetch -q origin
$hello = & git -C $control show origin/main:work/hello.md
if ($hello -notmatch "fake Copilot CLI on Windows") { Fail "work/hello.md isn't on main" }
$argsJson = & git -C $control show origin/main:work/args.json
# Worker mode: every seat runs as the af-worker profile, with its lane's skill in the prompt.
if ($argsJson -notmatch '"--agent","af-worker"' -or $argsJson -notmatch 'Skill \(builder\)') { Fail "the fake CLI didn't get the worker profile with the builder skill: $argsJson" }
$autocrlf = & git -C $control config --get core.autocrlf
if ($autocrlf -ne "false") { Fail "the control repo converts line endings (core.autocrlf=$autocrlf)" }

# 5. The doctor should pass now: node, git, copilot (through the .cmd shim), remote,
#    heartbeat and the installed task. The judges' model maps to Claude Code, which this
#    runner doesn't have: the fake CLI stands in for it, so doctor checks it's found.
$doc = & node --no-warnings $cli doctor --copilot $copilot --claude $copilot 2>&1 | Out-String
$docExit = $LASTEXITCODE
Write-Host $doc
if ($docExit) { Fail "doctor failed:`n$doc" }

# 6. A scheduler that starts a fresh process each time: the second tick is quiet.
$first = & node --no-warnings $cli tick --runner ci-tick --copilot $copilot 2>$null | Out-String
$second = & node --no-warnings $cli tick --runner ci-tick --copilot $copilot 2>$null | Out-String
if ($second -notmatch '"quiet": true') { Fail "the second tick from a fresh process wasn't quiet:`n$second" }

# 7. Remove it; the node loop must stop too.
$hb = Get-ChildItem -Path $engDir -Filter "heartbeat-*.json" | Where-Object { $_.Name -ne "heartbeat-ci-tick.json" } | Select-Object -First 1
$loopPid = (Get-Content $hb.FullName -Raw | ConvertFrom-Json).pid
& "$repo\scripts\windows\uninstall-harness-task.ps1" -Engagement smoke -Workspace $work
Start-Sleep -Seconds 3
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Fail "the task is still registered" }
if (Get-Process -Id $loopPid -ErrorAction SilentlyContinue) { Fail "the loop (pid $loopPid) is still running after uninstall" }
Pop-Location

Write-Host "::notice title=windows scheduled task::$(Esc "passed: installed, ran a turn through the .cmd shim, doctor ok, quiet tick ok, removed. $settings")"
exit 0
