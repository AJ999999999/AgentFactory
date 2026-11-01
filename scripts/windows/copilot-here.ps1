# Start Copilot CLI in this terminal, under a name the desk shows.
#   .\copilot-here.ps1 [-Name billing]
#       A session the desk drives (`npm run desk -- attach`): type prompts here or on the
#       desk, answer its asks in either place, /tui for Copilot's own screen. If the desk
#       isn't running, Copilot's own screen starts here instead.
#   .\copilot-here.ps1 [-Name billing] -Native [any copilot flags]
#       Copilot's own screen, seen by the desk through its hooks (npm run desk -- install).
# The window title is "copilot: <Name>", which the desk's "Go to" looks for.
param([string]$Name = (Split-Path -Leaf (Get-Location)), [switch]$Native)
$Host.UI.RawUI.WindowTitle = "copilot: $Name"
$env:AF_DESK_TERMINAL = $Name
if ($Native) {
  & copilot @args
  return
}
$cli = Join-Path $PSScriptRoot "..\..\src\desk\cli.ts"
& node --no-warnings $cli attach $Name --folder (Get-Location).Path
