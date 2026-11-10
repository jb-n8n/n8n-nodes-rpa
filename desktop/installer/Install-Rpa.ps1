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
# Unpack the package where only you or administrators can change it, for example under your own profile or under
# C:\Program Files: the installer reads the owner and access rules of the package's files and folders and of the
# folders above it when it starts, and refuses when someone else could change them.
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

# Before anything else is loaded from this folder: who may change the package. The installer runs as an
# administrator, loads its module from here and copies its programs from here. What is checked, as it is when the
# installer starts: every file and folder of the package (its owner, its access rules, and that it is no link or
# junction), and each folder above the package up to the drive, for a right to delete, rename or re-permission what is
# below it. Accepted are Administrators, SYSTEM, Windows' own installer account and the person running this. This
# script itself is already running when the check starts, so the check says nothing about it.
$packageTrusted = @{}
foreach ($sid in 'S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0',
  [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { $packageTrusted[$sid] = $true }

# The first owner or holder of one of the rights in a security descriptor that is not accepted, as a name, or nothing.
# An entry that only passes rights on to what is inside is not counted: each file and folder inside is read itself.
function Find-PackageChanger($Security, [int]$Rights) {
  $who = $null
  $owner = $Security.GetOwner([Security.Principal.SecurityIdentifier])
  if (-not $packageTrusted.ContainsKey($owner.Value)) { $who = $owner }
  else {
    foreach ($rule in $Security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
      if (([int]$rule.FileSystemRights -band $Rights) -and -not $packageTrusted.ContainsKey($rule.IdentityReference.Value)) { $who = $rule.IdentityReference; break }
    }
  }
  if (-not $who) { return $null }
  try { $who.Translate([Security.Principal.NTAccount]).Value } catch { $who.Value }
}

# Why the package cannot be used, or nothing. Identical security descriptors are judged once, so a package of tens of
# thousands of files costs one read per file. Folders are walked without entering a link, with paths of any length.
function Get-PackageRefusal([string]$Folder) {
  $changed = '{0} can be changed by {1}. Unpack the package in a folder only you or administrators can change, and run it from there.'
  $link = '{0} is a link or junction. Unpack the package again and run the installer from the new folder.'
  $sections = [Security.AccessControl.AccessControlSections]'Owner, Access'
  # Create files or folders, delete, delete what is inside, change the rules, take ownership, and the generic forms
  # of "write" and "all".
  $change = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  # On a folder above the package: delete or rename it, delete or rename what is in it, change its rules, take it.
  # (Creating new files or folders there, which Windows lets every user do at the top of a drive, replaces nothing.)
  $replace = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000
  # \\?\ in front lets Windows take paths over 260 characters; not for a network path.
  $long = '\\?\'
  if ($Folder.StartsWith('\\')) { $long = '' }

  $unreadable = 'someone whose access rules cannot be read'
  if ([IO.File]::GetAttributes($Folder) -band [IO.FileAttributes]::ReparsePoint) { return ($link -f $Folder) }
  $above = [IO.Path]::GetDirectoryName($Folder)
  while ($above) {
    if ([IO.File]::GetAttributes($above) -band [IO.FileAttributes]::ReparsePoint) { return ($link -f $above) }
    try { $who = Find-PackageChanger ([IO.Directory]::GetAccessControl($above, $sections)) $replace } catch { $who = $unreadable }
    if ($who) { return ($changed -f $above, $who) }
    $above = [IO.Path]::GetDirectoryName($above)
  }
  try { $who = Find-PackageChanger ([IO.Directory]::GetAccessControl($Folder, $sections)) $change } catch { $who = $unreadable }
  if ($who) { return ($changed -f $Folder, $who) }

  $verdicts = @{}
  $pending = New-Object Collections.Generic.Stack[string]
  $pending.Push($Folder)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in (New-Object IO.DirectoryInfo ($long + $directory)).EnumerateFileSystemInfos()) {
      $path = Join-Path $directory $entry.Name
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { return ($link -f $path) }
      try {
        if ($entry.Attributes -band [IO.FileAttributes]::Directory) {
          $security = [IO.Directory]::GetAccessControl($long + $path, $sections)
          $pending.Push($path)
        } else { $security = [IO.File]::GetAccessControl($long + $path, $sections) }
      } catch { return ($changed -f $path, $unreadable) }
      $sddl = $security.GetSecurityDescriptorSddlForm($sections)
      if (-not $verdicts.ContainsKey($sddl)) { $verdicts[$sddl] = Find-PackageChanger $security $change }
      if ($verdicts[$sddl]) { return ($changed -f $path, $verdicts[$sddl]) }
    }
  }
  $null
}
$refusal = Get-PackageRefusal $PSScriptRoot
if ($refusal) {
  Write-Host $refusal
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
