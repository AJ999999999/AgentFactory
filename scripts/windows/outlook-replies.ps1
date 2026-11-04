# Your answers to Slack messages, as Slack's workflow emailed them to you: every mail in
# the Inbox from the last day whose subject starts with the prefix ("af-desk " for the
# desk's, "af-harness " for the harness's). Each one found is printed (as JSON) and moved to
# Deleted Items, so it's read once; the other prefix's mails are left for their reader.
# Needs the classic Outlook app (Outlook for Microsoft 365), running or able to start.
# -Only <ask id>: just that ask's mail (the Slack test's); otherwise every one but the test's.
param([string]$Only = '', [string]$Prefix = 'af-desk')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace('MAPI')
$inbox = $ns.GetDefaultFolder(6)
$deleted = $ns.GetDefaultFolder(3)
$items = $inbox.Items
$items.Sort('[ReceivedTime]', $true)
$since = (Get-Date).AddDays(-1)
$found = @()
$hits = @()
foreach ($m in $items) {
  if ($m.Class -ne 43) { continue }  # mail only, not meeting requests or receipts
  if ($m.ReceivedTime -lt $since) { break }
  if ($m.Subject -notmatch ('^\s*' + [regex]::Escape($Prefix) + '\s')) { continue }
  if ($Only) { if ($m.Subject -notmatch ('\s' + [regex]::Escape($Only) + '\s')) { continue } }
  elseif ($m.Subject -match ('^\s*' + [regex]::Escape($Prefix) + '\s+test-')) { continue }
  # A sender in your own organisation has an Exchange address; its SMTP one is what you'd recognise.
  $from = $m.SenderEmailAddress
  if ($m.SenderEmailType -eq 'EX') {
    try { $from = $m.Sender.GetExchangeUser().PrimarySmtpAddress } catch { }
  }
  $found += [pscustomobject]@{ subject = [string]$m.Subject; body = [string]$m.Body; from = [string]$from; at = $m.ReceivedTime.ToString('o') }
  $hits += $m
}
# Moved after the walk: moving while walking the collection skips mails.
foreach ($m in $hits) { $m.Move($deleted) | Out-Null }
ConvertTo-Json -InputObject @($found) -Compress -Depth 3
