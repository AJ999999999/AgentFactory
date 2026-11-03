# Start Copilot CLI in this terminal with a name the desk can show.
#   .\copilot-here.ps1 [-Name billing] [any copilot flags, e.g. --remote]
# The tab title and the desk's log both use the name, so you can tell terminals apart.
param([string]$Name = (Split-Path -Leaf (Get-Location)))
$Host.UI.RawUI.WindowTitle = "copilot: $Name"
$env:AF_DESK_TERMINAL = $Name
# Copilot puts what it's doing in the tab title, over the name: then the desk's "Type in
# its tab" can't find the tab. The desk shows what it's doing on the thread instead.
$env:COPILOT_DISABLE_TERMINAL_TITLE = "1"
& copilot @args
