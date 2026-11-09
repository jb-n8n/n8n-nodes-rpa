# Installs the RPA desktop runner and the RPA browser on this Windows machine, or upgrades an install. Run it from an
# administrator Windows PowerShell (powershell.exe, 64-bit), from the unpacked package (the folder this file is in):
#
#   .\Install-Rpa.ps1 [-User <name>] [-UserPassword <SecureString>] [-RunnerPort 8765] [-BrowserPort 3000]
#                     [-AllowFrom <address>[,<address>...] | -AllowFromAnyAddress | -NoFirewall]
#                     [-NoBrowser] [-AutoSignIn] [-Force]
#
# Both programs run inside the signed-in session of one Windows user, the bot user, started by scheduled tasks at that
# user's logon.
#
#   -User          The bot user (default rpa-runner). A local user that does not exist is created as a standard user;
#                  DOMAIN\name must exist already. An existing user's password is never changed, and an existing user
#                  that is an administrator is refused.
#   -UserPassword  The password for a new local user, or, with -AutoSignIn, the existing user's password to store
#                  (it is tried against the account first).
#                  For example: -UserPassword (Read-Host 'Password' -AsSecureString)
#   -RunnerPort    The runner's port (default 8765).   -BrowserPort  The browser's port (default 3000).
#   -AllowFrom     The addresses that may connect: IP addresses or ranges such as 10.0.0.0/24, normally the n8n host.
#                  The firewall rules let in these addresses only, for the two programs only, on networks Windows
#                  treats as Domain or Private (not Public).
#   -AllowFromAnyAddress  The firewall rules let in any address instead.
#   -NoFirewall    Leave Windows Firewall alone. One of these three is needed on a first install.
#   -NoBrowser     Install the runner only.
#   -AutoSignIn    Have Windows sign the bot user in by itself at every start and keep the desktop unlocked. The
#                  password is stored on this machine, and several settings change for the whole machine; the installer
#                  lists them and asks for YES first, unless -Force is given. Uninstall-Rpa.ps1 puts them back.
#   -Force         Do not ask, and upgrade even while the runner is running (a run in progress fails).
#
# Programs go to C:\Program Files\RPA Runner, data (policy.json, the tokens, the certificates, logs) to
# C:\ProgramData\RPA Runner. Running the installer again upgrades: it replaces the programs and keeps the data and the
# user; give it the same -User, ports and -NoBrowser as before. It keeps the firewall addresses of the earlier run when
# none are given, and automatic sign-in that an earlier run turned on (then -AutoSignIn needs no -UserPassword; give
# one to store a changed password). Without a user of its own making, -AutoSignIn needs -UserPassword: a password the
# installer generated is stored for Windows and known to nobody. The installer prints no secret.
# Exit codes: 0 installed, 1 refused or failed, 3 declined at the question.
[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()][string]$User = 'rpa-runner',
  [Security.SecureString]$UserPassword,
  [ValidateRange(1, 65535)][int]$RunnerPort = 8765,
  [ValidateRange(1, 65535)][int]$BrowserPort = 3000,
  [string[]]$AllowFrom = @(),
  [switch]$AllowFromAnyAddress,
  [switch]$NoBrowser,
  [switch]$NoFirewall,
  [switch]$AutoSignIn,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

# A 32-bit PowerShell on 64-bit Windows is shown another Program Files and another registry.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  Write-Host 'Run Install-Rpa.ps1 from the 64-bit Windows PowerShell, not Windows PowerShell (x86).'
  exit 1
}
# The installer is written for and tested with Windows PowerShell 5.1; PowerShell 7 lacks calls it uses.
if ($PSVersionTable.PSEdition -eq 'Core') {
  Write-Host 'Run Install-Rpa.ps1 from Windows PowerShell (powershell.exe), not PowerShell 7 (pwsh).'
  exit 1
}

# Before anything else is loaded from this folder: who may change it. The installer runs as an administrator and
# copies its programs from here, so the folder must not be one that somebody else can write to. This reads the
# folder's own owner and access rules (also those its files inherit), not every file in it. Returns the first name
# that is not Administrators, SYSTEM, Windows' own installer account or the person running this, or nothing.
function Get-PackageChanger([string]$Folder) {
  $trusted = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0',
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  # Create files or folders, delete, delete what is inside, change the rules, take ownership, and the generic forms
  # of "write" and "all".
  $write = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  $acl = Get-Acl -LiteralPath $Folder
  $changers = @()
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  if ($trusted -notcontains $owner.Value) { $changers += $owner }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and ([int]$rule.FileSystemRights -band $write) -and $trusted -notcontains $rule.IdentityReference.Value) {
      $changers += $rule.IdentityReference
    }
  }
  if ($changers.Count -eq 0) { return $null }
  try { $changers[0].Translate([Security.Principal.NTAccount]).Value } catch { $changers[0].Value }
}
$changer = Get-PackageChanger $PSScriptRoot
if ($changer) {
  Write-Host ('{0} can be changed by {1}. Unpack the package in a folder only you or administrators can change, and run it from there.' -f $PSScriptRoot, $changer)
  Write-Host 'Nothing was changed.'
  exit 1
}

Import-Module (Join-Path $PSScriptRoot 'RpaInstall.psm1') -Force

$parameters = @{
  User = $User; UserPassword = $UserPassword; RunnerPort = $RunnerPort; BrowserPort = $BrowserPort
  AllowFrom = $AllowFrom; AllowFromAnyAddress = [bool]$AllowFromAnyAddress
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
  Write-Host '-AutoSignIn changes how this machine works:'
  Write-Host ('  - The password of {0} is stored on this machine, where Windows keeps a password for automatic sign-in.' -f $User)
  Write-Host '    An administrator of this machine can read it.'
  Write-Host ('  - Windows signs {0} in by itself at every start, and again after a sign-out.' -f $User)
  Write-Host '  - For the whole machine, for every user: the lock screen and the lock when idle are turned off, the display'
  Write-Host '    and sleep timeouts are set to never, and the first sign-in animation, Server Manager at sign-in and the'
  Write-Host '    new network question are turned off.'
  Write-Host ('  - For {0}: the screen saver and the Lock command are turned off.' -f $User)
  Write-Host ("  - Anyone who can reach this machine's screen or console can use the desktop of {0}." -f $User)
  Write-Host '  Uninstall-Rpa.ps1 puts these settings back to what they were. It cannot bring back a password that was'
  Write-Host '  stored for automatic sign-in before.'
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
  Write-Host 'The install did not finish. Fix the cause and run Install-Rpa.ps1 again with the same parameters.'
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
else {
  $from = 'any address'
  if ($plan.AllowFrom -notcontains 'any') { $from = $plan.AllowFrom -join ', ' }
  if ($NoBrowser) { Write-Host ('  Firewall:  inbound TCP {0} is open to {1} (rule RPA-Runner-In)' -f $RunnerPort, $from) }
  else { Write-Host ('  Firewall:  inbound TCP {0} and {1} are open to {2} (rules RPA-Runner-In and RPA-Browser-In)' -f $RunnerPort, $BrowserPort, $from) }
  Write-Host '             on Domain and Private networks, not on Public ones'
}
Write-Host ('  Remove:    {0}' -f (Join-Path $layout.InstallDir 'Uninstall-Rpa.ps1'))
Write-Host ''
if ($plan.Steps -contains 'turn on automatic sign-in') { Write-Host ('Automatic sign-in is on: Windows signs {0} in at its next start.' -f $User) }
Write-Host ('Sign in as {0}, then run Show-RpaConnection.ps1:' -f $User)
Write-Host ('  powershell -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path (Join-Path $layout.InstallDir 'scripts') 'Show-RpaConnection.ps1'))
if (-not $upgrade) { Write-Host ('If {0} is already signed in, sign out and sign in again.' -f $User) }
