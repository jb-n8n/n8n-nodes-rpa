# Installs the RPA desktop runner and the RPA browser on this Windows machine, or upgrades an install. Run it from an
# administrator PowerShell, from the unpacked package (the folder this file is in):
#
#   .\Install-Rpa.ps1 [-User <name>] [-UserPassword <SecureString>] [-RunnerPort 8765] [-BrowserPort 3000]
#                     [-NoBrowser] [-NoFirewall] [-AutoSignIn] [-Force]
#
# Both programs run inside the signed-in session of one Windows user, the bot user, started by scheduled tasks at that
# user's logon.
#
#   -User          The bot user (default rpa-runner). A local user that does not exist is created as a standard user;
#                  DOMAIN\name must exist already. An existing user's password is never changed.
#   -UserPassword  The password for a new local user, or, with -AutoSignIn, the existing user's password to store.
#                  For example: -UserPassword (Read-Host 'Password' -AsSecureString)
#   -RunnerPort    The runner's port (default 8765).   -BrowserPort  The browser's port (default 3000).
#   -NoBrowser     Install the runner only.            -NoFirewall   Leave Windows Firewall alone.
#   -AutoSignIn    Have Windows sign the bot user in by itself at every start and keep its desktop unlocked. The
#                  password is stored on this machine. Asks for YES first, unless -Force is given.
#   -Force         Do not ask, and upgrade even while the runner is running (a run in progress fails).
#
# Programs go to C:\Program Files\RPA Runner, data (policy.json, the tokens, the certificates, logs) to
# C:\ProgramData\RPA Runner. An upgrade replaces the programs and keeps the data and the user; give it the same
# parameters as the first install. The installer prints no secret.
# Exit codes: 0 installed, 1 refused or failed, 3 declined at the question.
[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()][string]$User = 'rpa-runner',
  [Security.SecureString]$UserPassword,
  [ValidateRange(1, 65535)][int]$RunnerPort = 8765,
  [ValidateRange(1, 65535)][int]$BrowserPort = 3000,
  [switch]$NoBrowser,
  [switch]$NoFirewall,
  [switch]$AutoSignIn,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RpaInstall.psm1') -Force

# A 32-bit PowerShell on 64-bit Windows is shown another Program Files and another registry.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  Write-Host 'Run Install-Rpa.ps1 from the 64-bit Windows PowerShell, not Windows PowerShell (x86).'
  exit 1
}

$parameters = @{
  User = $User; UserPassword = $UserPassword; RunnerPort = $RunnerPort; BrowserPort = $BrowserPort
  NoBrowser = [bool]$NoBrowser; NoFirewall = [bool]$NoFirewall; AutoSignIn = [bool]$AutoSignIn; Force = [bool]$Force
}
$plan = Get-RpaInstallPlan -Parameters $parameters -Facts (Get-RpaMachineFacts -Parameters $parameters)
foreach ($warning in $plan.Warnings) { Write-Warning $warning }
if ($plan.Refusals.Count -gt 0) {
  foreach ($refusal in $plan.Refusals) { Write-Host $refusal }
  Write-Host 'Nothing was changed.'
  exit 1
}

if ($plan.Steps -contains 'turn on automatic sign-in' -and -not $Force) {
  Write-Host "-AutoSignIn changes how this machine works:"
  Write-Host "  - The password of $User is stored on this machine, where Windows keeps a password for automatic sign-in."
  Write-Host "    An administrator of this machine can read it."
  Write-Host "  - Windows signs $User in by itself at every start, and again after a sign-out."
  Write-Host "  - The desktop of $User stays open: no lock screen, no lock when idle, no screen saver, and the display"
  Write-Host "    stays on. Anyone who can reach this machine's screen or console can use that desktop."
  Write-Host "  - Until $User has signed in once, the no-lock settings go into the default profile, which Windows also"
  Write-Host "    copies for every user created later."
  $answer = ''
  try { $answer = Read-Host 'Type YES to continue' } catch { $answer = '' }
  if ($answer -cne 'YES') {
    Write-Host 'Nothing was changed.'
    exit 3
  }
}

$upgrade = $plan.Steps -contains 'stop running services'
if ($upgrade) { Write-Host 'Upgrading RPA:' } else { Write-Host 'Installing RPA:' }
try { Invoke-RpaInstallPlan -Plan $plan -Parameters $parameters -SourceDir $PSScriptRoot }
catch {
  Write-Host $_.Exception.Message
  Write-Host 'The install did not finish. Fix the cause and run Install-Rpa.ps1 again.'
  exit 1
}

$layout = Get-RpaLayout
Write-Host ''
Write-Host 'RPA is installed.'
Write-Host ('  Programs:  {0}' -f $layout.InstallDir)
Write-Host ('  Data:      {0} (policy.json, the tokens, the certificates, logs)' -f $layout.DataDir)
Write-Host ('  Policy:    {0}' -f (Join-Path $layout.DataDir 'policy.json'))
Write-Host ('             A new policy allows no app. Change it with {0}' -f (Join-Path (Join-Path $layout.InstallDir 'runner') 'RpaPolicy.exe'))
if ($NoBrowser) { Write-Host ('  Task:      \RPA\RPA Runner starts when {0} signs in' -f $User) }
else { Write-Host ('  Tasks:     \RPA\RPA Runner and \RPA\RPA Browser start when {0} signs in' -f $User) }
if ($NoFirewall) { Write-Host '  Firewall:  not changed (-NoFirewall)' }
elseif ($NoBrowser) { Write-Host ('  Firewall:  inbound TCP {0} is open (rule RPA-Runner-In)' -f $RunnerPort) }
else { Write-Host ('  Firewall:  inbound TCP {0} and {1} are open (rules RPA-Runner-In and RPA-Browser-In)' -f $RunnerPort, $BrowserPort) }
Write-Host ('  Remove:    {0}' -f (Join-Path $layout.InstallDir 'Uninstall-Rpa.ps1'))
Write-Host ''
if ($plan.Steps -contains 'turn on automatic sign-in') { Write-Host ('Automatic sign-in is on: Windows signs {0} in at its next start.' -f $User) }
Write-Host ('Sign in as {0}, then run Show-RpaConnection.ps1:' -f $User)
Write-Host ('  powershell -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path (Join-Path $layout.InstallDir 'scripts') 'Show-RpaConnection.ps1'))
