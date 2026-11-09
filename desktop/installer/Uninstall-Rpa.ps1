# Removes the RPA desktop runner and the RPA browser from this Windows machine. Run it from an administrator Windows
# PowerShell (powershell.exe, 64-bit):
#
#   & 'C:\Program Files\RPA Runner\Uninstall-Rpa.ps1' [-RemoveData]
#
# It ends both programs and removes the scheduled tasks, the firewall rules and C:\Program Files\RPA Runner. When the
# installer turned automatic sign-in on, it puts every setting -AutoSignIn changed back to what install.json recorded
# and removes the stored password; when automatic sign-in names another user by now, it leaves the sign-in values and
# the stored password alone. It keeps the data directory, C:\ProgramData\RPA Runner (the policy, the tokens, the
# certificates, logs), unless -RemoveData is given, so that an install after it finds the same tokens and
# certificates. It never removes a Windows user.
# Exit codes: 0 removed, 1 refused or failed.
[CmdletBinding()]
param([switch]$RemoveData)
$ErrorActionPreference = 'Stop'

# A 32-bit PowerShell on 64-bit Windows is shown another Program Files and another registry.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  Write-Host 'Run Uninstall-Rpa.ps1 from the 64-bit Windows PowerShell, not Windows PowerShell (x86).'
  exit 1
}
if ($PSVersionTable.PSEdition -eq 'Core') {
  Write-Host 'Run Uninstall-Rpa.ps1 from Windows PowerShell (powershell.exe), not PowerShell 7 (pwsh).'
  exit 1
}
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
  if ($result.SignInKept) { Write-Host '  Automatic sign-in now names another user, so it and the stored password were left as they are.' }
  else { Write-Host ('  Automatic sign-in of {0} is off and the stored password is removed.' -f $result.User) }
  if (@($result.NotRestored).Count -eq 0) { Write-Host '  The other settings -AutoSignIn changed are back to what they were before.' }
  else {
    Write-Host '  Of the other settings -AutoSignIn changed, these could not be put back:'
    foreach ($line in $result.NotRestored) { Write-Host ('    {0}' -f $line) }
  }
}
if ($RemoveData) { Write-Host ('  Removed:   {0}' -f $result.Layout.DataDir) }
elseif (Test-Path -LiteralPath $result.Layout.DataDir) { Write-Host ('  Kept:      {0} (remove it with -RemoveData)' -f $result.Layout.DataDir) }
if ($result.User) { Write-Host ('  Kept:      the Windows user {0}' -f $result.User) }
