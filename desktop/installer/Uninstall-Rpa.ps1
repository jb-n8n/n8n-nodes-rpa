# Removes the RPA desktop runner and the RPA browser from this Windows machine. Run it from an administrator PowerShell:
#
#   & 'C:\Program Files\RPA Runner\Uninstall-Rpa.ps1' [-RemoveData]
#
# It ends both programs and removes the scheduled tasks, the firewall rules and C:\Program Files\RPA Runner. It turns
# automatic sign-in off (and removes the stored password) only when the installer turned it on. It keeps the data
# directory, C:\ProgramData\RPA Runner (the policy, the tokens, the certificates, logs), unless -RemoveData is given,
# so that an install after it finds the same tokens and certificates. It never removes a Windows user.
# Exit codes: 0 removed, 1 refused or failed.
[CmdletBinding()]
param([switch]$RemoveData)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RpaInstall.psm1') -Force

if (-not (Test-RpaAdministrator)) {
  Write-Host 'Run Uninstall-Rpa.ps1 from an administrator PowerShell.'
  exit 1
}

Write-Host 'Removing RPA:'
try { $result = Invoke-RpaUninstall -RemoveData:$RemoveData }
catch {
  Write-Host $_.Exception.Message
  Write-Host 'The removal did not finish. Fix the cause and run Uninstall-Rpa.ps1 again.'
  exit 1
}

Write-Host ''
Write-Host 'RPA is removed.'
if ($result.AutoSignIn) {
  if ($result.AutoSignInOff) { Write-Host ('  Automatic sign-in of {0} is off and the stored password is removed.' -f $result.User) }
  else { Write-Host '  Automatic sign-in now names another user, so it was left as it is.' }
  Write-Host '  The settings that keep the desktop unlocked (no lock screen, no lock when idle, no screen saver, display on) stay.'
}
if ($RemoveData) { Write-Host ('  Removed:   {0}' -f $result.Layout.DataDir) }
else { Write-Host ('  Kept:      {0} (remove it with -RemoveData)' -f $result.Layout.DataDir) }
if ($result.User) { Write-Host ('  Kept:      the Windows user {0}' -f $result.User) }
