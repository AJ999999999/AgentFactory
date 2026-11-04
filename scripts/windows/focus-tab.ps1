# Bring a terminal forward by the title copilot-here.ps1 gave it ("copilot: billing"),
# from $env:AF_DESK_JUMP. Prints True when it found one.
#
# Windows Terminal shows each of its tabs to UI Automation as a tab item named by the
# tab's title, so a tab that isn't the one showing is selected first; its window then
# takes that title and is raised. A plain console window is found by its title alone.
$title = $env:AF_DESK_JUMP
$shell = New-Object -ComObject WScript.Shell
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $A = [System.Windows.Automation.AutomationElement]
  $scope = [System.Windows.Automation.TreeScope]
  $isTab = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $isTerminal = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, "CASCADIA_HOSTING_WINDOW_CLASS")
  foreach ($window in $A::RootElement.FindAll($scope::Children, $isTerminal)) {
    foreach ($tab in $window.FindAll($scope::Descendants, $isTab)) {
      if (-not $tab.Current.Name.Contains($title)) { continue }
      $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      Start-Sleep -Milliseconds 150
      if (-not $shell.AppActivate($title)) { [void]$shell.AppActivate($window.Current.ProcessId) }
      "True"
      exit 0
    }
  }
} catch {
  # No UI Automation here: fall back to the window title.
}
$shell.AppActivate($title)
