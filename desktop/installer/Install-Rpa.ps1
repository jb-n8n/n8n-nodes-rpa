# Installs the RPA desktop runner and the RPA browser on this Windows machine, or upgrades an install. Run it from an
# administrator Windows PowerShell (powershell.exe, 64-bit), from the unpacked package (the folder this file is in):
#
#   .\Install-Rpa.ps1 [-User <name>] [-UserPassword <SecureString>] [-RunnerPort 8765] [-BrowserPort 3000]
#                     [-AllowFrom <address>[,<address>...] | -AllowFromAnyAddress [-IncludePublicNetwork] | -NoFirewall]
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
#                  The firewall rules let in these addresses only, for the two programs only, on every network
#                  (Domain, Private and Public, as Windows names them). A range of every address (0.0.0.0/0) is
#                  refused: that is what -AllowFromAnyAddress is for.
#   -AllowFromAnyAddress  The firewall rules let in any address instead, on Domain and Private networks only. Where
#                  the machine's network is Public (most cloud machines and machines outside a domain) that lets
#                  nothing in, and a first install is refused; then give -AllowFrom, or add -IncludePublicNetwork.
#   -IncludePublicNetwork  With -AllowFromAnyAddress: the rules apply on Public networks too.
#   -NoFirewall    Leave Windows Firewall alone. One of -AllowFrom, -AllowFromAnyAddress and -NoFirewall is needed on
#                  a first install; an upgrade without any of them keeps what the install was made with.
#   -NoBrowser     Install the runner only. With the browser installed, whoever holds the browser token and can reach
#                  the browser's port acts as the bot user through the browser: it can read the files the bot user can
#                  read (the runner's token among them), and it can create files with a name and content of its
#                  choice where the bot user can write, which is a way to run programs as the bot user. The runner's
#                  policy does not limit that, so the policy is a limit for the runner token only; on a machine where
#                  the policy must hold against n8n itself, install with -NoBrowser and run the browser on another
#                  machine.
#   -AutoSignIn    Have Windows sign the bot user in by itself at every start and keep the desktop unlocked. The
#                  password is stored on this machine, and several settings change for the whole machine; the installer
#                  lists them and asks for YES first, unless -Force is given. Uninstall-Rpa.ps1 puts them back.
#   -Force         Do not ask (about -AutoSignIn, or about another -User than the one of the install), and upgrade
#                  even while the runner is running (a run in progress fails).
#
# Unpack the package on a local drive where only you or administrators can change it, for example under your own
# profile or under C:\Program Files: when it starts, the installer finds the real location of the package and reads
# the owner and access rules of the package's files and folders and of the folders above it, and refuses when someone
# else could change them. It does not judge this script itself, which is running by then.
#
# Programs go to C:\Program Files\RPA Runner, data (policy.json, the tokens, the certificates, logs) to
# C:\ProgramData\RPA Runner. A data directory that is there before the first install (for example one an uninstall
# kept) is used when everything in it belongs to Administrators, to SYSTEM or to the bot user of this install, and
# that user was there before this run: an install for the same user keeps the policy, the tokens and the certificates.
# Otherwise the installer says how many entries belong to other accounts and names the first, and refuses.
# Running the installer again upgrades: it replaces the programs and keeps the data and the user; give it the same
# -User, ports and -NoBrowser as before. Another -User than the one of the install is named and asked about first
# (unless -Force is given), and is refused while automatic sign-in is set up for the first user or while the data
# directory holds what the first user left there. An upgrade keeps the firewall addresses and networks of the earlier
# run when none are given, and automatic sign-in that an earlier run turned on (then -AutoSignIn needs no
# -UserPassword; give one to store a changed password). On a change of user (another -User on an upgrade, or a first
# install over a data directory whose access rules name another user) both tokens are replaced, because the earlier
# user could read them, and the n8n credentials then need the new ones. Without a user of its own making,
# -AutoSignIn needs -UserPassword: a password the installer generated is stored for Windows and known to nobody. The
# installer prints no secret.
# When an earlier uninstall could not put a setting of -AutoSignIn back, it left a list in
# C:\Program Files\RPA Runner\uninstall-leftovers.json. The installer reads that list (when it is a file of
# Administrators or SYSTEM), records each setting with what it was before the earlier install, and removes the list
# when the install has finished; the next uninstall then tries those settings again.
# Exit codes: 0 installed, 1 refused or failed, 3 declined at the question.
[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()][string]$User = 'rpa-runner',
  [Security.SecureString]$UserPassword,
  [ValidateRange(1, 65535)][int]$RunnerPort = 8765,
  [ValidateRange(1, 65535)][int]$BrowserPort = 3000,
  [string[]]$AllowFrom = @(),
  [switch]$AllowFromAnyAddress,
  [switch]$IncludePublicNetwork,
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

# ---- package check: begin (the same text in Install-Rpa.ps1 and Uninstall-Rpa.ps1; a test compares the two) ----
# Before anything else is loaded from the folder this script is in: where that folder really is and who may change
# it. The script runs as an administrator and loads its module from the package (the installer also copies the
# programs from it). What is checked, as it is when the script starts:
#   - the package is on a local fixed drive (not a network share or drive, not a removable or optical drive);
#   - its real location, which Windows gives for the opened folder: a subst drive, a junction or a symbolic link on
#     the way to the package is resolved, and everything after this point uses the real location;
#   - every file and folder of the package: its owner, its access rules, and that it is no link or junction;
#   - each folder above the package up to the drive: a right to delete, rename or re-permission what is below it.
# Accepted are Administrators, SYSTEM, Windows' own installer account and the person running this. This script itself
# is already running when the check starts, so the check says nothing about it. The check cannot be a file of its
# own, because that file would be loaded from the package before the package is judged.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class RpaPackagePath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
  // The path Windows itself gives for an opened folder (\\?\C:\... or \\?\UNC\...), with every link on the way resolved.
  public static string Final(string folder) {
    using (SafeFileHandle handle = CreateFile(folder, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder buffer = new StringBuilder(1024);
      uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
      if (length > buffer.Capacity) {
        buffer = new StringBuilder((int)length + 1);
        length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
      }
      if (length == 0 || length > buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
      return buffer.ToString();
    }
  }
}
'@

# What kind of place a path is on when that is not a local fixed drive, or nothing.
function Get-PackagePlace([string]$Path) {
  if ($Path.StartsWith('\\')) { return 'a network share' }
  switch ((New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($Path))).DriveType) {
    'Fixed' { return $null }
    'Network' { return 'a network drive' }
    'Removable' { return 'a removable drive' }
    'CDRom' { return 'an optical drive' }
    'Ram' { return 'a RAM disk' }
    default { return 'a drive of a kind Windows does not name' }
  }
}

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

# Why the package cannot be used, or nothing. -Tool is what this script is called in the texts. Identical security
# descriptors are judged once, so a package of tens of thousands of files costs one read per file. Folders are walked
# without entering a link, with paths of any length.
function Get-PackageRefusal([string]$Folder, [string]$Tool) {
  $changed = '{0} can be changed by {1}. Unpack the package in a folder only you or administrators can change, and run it from there.'
  $link = '{0} is a link or junction. Unpack the package again and run the {1} from the new folder.'
  $sections = [Security.AccessControl.AccessControlSections]'Owner, Access'
  # Create files or folders, delete, delete what is inside, change the rules, take ownership, and the generic forms
  # of "write" and "all".
  $change = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  # On a folder above the package: delete or rename it, delete or rename what is in it, change its rules, take it.
  # (Creating new files or folders there, which Windows lets every user do at the top of a drive, replaces nothing.)
  $replace = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000
  # \\?\ in front lets Windows take paths over 260 characters.
  $long = '\\?\'

  $unreadable = 'someone whose access rules cannot be read'
  if ([IO.File]::GetAttributes($Folder) -band [IO.FileAttributes]::ReparsePoint) { return ($link -f $Folder, $Tool) }
  $above = [IO.Path]::GetDirectoryName($Folder)
  while ($above) {
    if ([IO.File]::GetAttributes($above) -band [IO.FileAttributes]::ReparsePoint) { return ($link -f $above, $Tool) }
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
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { return ($link -f $path, $Tool) }
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

# Judges the package this script was started from. -Started is the folder the script is in, -Tool what the script is
# called in the texts (installer, uninstaller). Returns the real location of the package (Package) and why it cannot
# be used (Refusal), or nothing there. A package whose real location is -Installed, the install directory under
# Program Files, is not walked: that folder is the installer's own work, and only administrators can change it.
function Test-Package([string]$Started, [string]$Tool, [string]$Installed) {
  $result = @{ Package = $Started; Refusal = $null }
  $notLocal = 'Run the {2} from a folder on a local drive. {0} is on {1}.'
  $place = Get-PackagePlace $Started
  if ($place) { $result.Refusal = $notLocal -f $Started, $place, $Tool; return $result }
  try { $final = [RpaPackagePath]::Final($Started) } catch { $final = $null }
  if (-not $final) { $result.Refusal = 'Run the {1} from a folder on a local drive. The real location of {0} could not be read.' -f $Started, $Tool; return $result }
  if ($final.StartsWith('\\?\UNC\')) { $result.Refusal = $notLocal -f $Started, 'a network share', $Tool; return $result }
  $result.Package = $final.Substring(4)
  $place = Get-PackagePlace $result.Package
  if ($place) { $result.Refusal = $notLocal -f $Started, $place, $Tool; return $result }
  if ($Installed -and $result.Package -eq $Installed) { return $result }
  # A package with tens of thousands of files takes some seconds to read.
  Write-Host "Checking the package's files..."
  $result.Refusal = Get-PackageRefusal $result.Package $Tool
  $result
}
# ---- package check: end ----
$check = Test-Package $PSScriptRoot 'installer' ''
if ($check.Refusal) {
  Write-Host $check.Refusal
  Write-Host 'Nothing was changed.'
  exit 1
}
$package = $check.Package

Import-Module (Join-Path $package 'RpaInstall.psd1') -Force

$parameters = @{
  User = $User; UserPassword = $UserPassword; RunnerPort = $RunnerPort; BrowserPort = $BrowserPort
  AllowFrom = $AllowFrom; AllowFromAnyAddress = [bool]$AllowFromAnyAddress; IncludePublicNetwork = [bool]$IncludePublicNetwork
  NoBrowser = [bool]$NoBrowser; NoFirewall = [bool]$NoFirewall; AutoSignIn = [bool]$AutoSignIn; Force = [bool]$Force
}
$plan = Get-RpaInstallPlan -Parameters $parameters -Facts (Get-RpaMachineFacts -Parameters $parameters)
foreach ($warning in $plan.Warnings) { Write-Warning $warning }
if ($plan.Refusals.Count -gt 0) {
  foreach ($refusal in $plan.Refusals) { Write-Host $refusal }
  Write-Host 'Nothing was changed.'
  exit 1
}

# What the installer has confirmed before it changes anything: another -User than the one the install was made for,
# and what -AutoSignIn means. One answer covers both.
$askSignIn = ($plan.Steps -contains 'turn on automatic sign-in') -and -not $Force
if ($plan.Questions.Count -gt 0 -or $askSignIn) {
  foreach ($question in $plan.Questions) { Write-Host $question }
  if ($plan.Questions.Count -gt 0) {
    if ($plan.Steps -contains 'create user') { Write-Host ('  There is no Windows user {0}: continuing creates it.' -f $User) }
    Write-Host ("  Continuing makes {0} the bot user of this install: the scheduled tasks then run as {0}, and {0} gets the" -f $User)
    Write-Host "  bot user's access to the data directory."
  }
}
if ($askSignIn) {
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
}
if ($plan.Questions.Count -gt 0 -or $askSignIn) {
  $answer = ''
  try { $answer = Read-Host 'Type YES to continue' } catch { $answer = '' }
  if ($answer -cne 'YES') {
    Write-Host 'Nothing was changed.'
    exit 3
  }
}

$upgrade = $plan.Steps -contains 'stop running services'
if ($upgrade) { Write-Host 'Upgrading RPA:' } else { Write-Host 'Installing RPA:' }
try { Invoke-RpaInstallPlan -Plan $plan -Parameters $parameters -SourceDir $package }
catch {
  Write-Host $_.Exception.Message
  $notPutBack = @($_.Exception.Data['NotPutBack'] | Where-Object { $_ })
  $userKept = $_.Exception.Data['UserKept']
  if ($notPutBack.Count -eq 0) {
    Write-Host 'The install did not finish. Fix the cause and run Install-Rpa.ps1 again with the same parameters.'
  } else {
    # The undo could not put everything back, so it removed nothing more. What is left, and what to do about it.
    Write-Host 'The install did not finish, and the settings listed above could not be put back.'
    Write-Host ('  They stay recorded in {0}, with what they were before:' -f (Get-RpaLayout).InstallFile)
    Write-Host '  Uninstall-Rpa.ps1 and the next run of Install-Rpa.ps1 use that record.'
    Write-Host '  The set-up of automatic sign-in did not finish. What the earlier steps installed is left in place.'
    if ($userKept) {
      Write-Host ('  The user {0}, which this run created, is kept. Its password is known to nobody.' -f $userKept)
      Write-Host ('  What to do: fix the cause, remove the user {0}, and run Install-Rpa.ps1 again with the same parameters.' -f $userKept)
    } else {
      Write-Host '  What to do: fix the cause and run Install-Rpa.ps1 again with the same parameters.'
    }
  }
  exit 1
}

$layout = Get-RpaLayout
Write-Host ''
Write-Host 'RPA is installed.'
Write-Host ('  Programs:  {0}' -f $layout.InstallDir)
Write-Host ('  Data:      {0} (policy.json, the tokens, the certificates, logs)' -f $layout.DataDir)
Write-Host ('  Policy:    {0}' -f (Join-Path $layout.DataDir 'policy.json'))
$policyTool = Join-Path (Join-Path $layout.InstallDir 'runner') 'RpaPolicy.exe'
if ($plan.Steps -contains 'write policy') { Write-Host ('             It is new and allows no app. Change it with {0}' -f $policyTool) }
else { Write-Host ('             It was there already and is kept as it is. Change it with {0}' -f $policyTool) }
if ($NoBrowser) { Write-Host ('  Task:      \RPA\RPA Runner starts when {0} signs in' -f $User) }
else { Write-Host ('  Tasks:     \RPA\RPA Runner and \RPA\RPA Browser start when {0} signs in' -f $User) }
if ($NoFirewall) { Write-Host '  Firewall:  not changed (-NoFirewall)' }
elseif (-not $plan.AllowFrom) { Write-Host '  Firewall:  not changed (this install was made with -NoFirewall)' }
else {
  $from = 'any address'
  if ($plan.AllowFrom -notcontains 'any') { $from = $plan.AllowFrom -join ', ' }
  if ($NoBrowser) { Write-Host ('  Firewall:  inbound TCP {0} is open to {1} (rule RPA-Runner-In)' -f $RunnerPort, $from) }
  else { Write-Host ('  Firewall:  inbound TCP {0} and {1} are open to {2} (rules RPA-Runner-In and RPA-Browser-In)' -f $RunnerPort, $BrowserPort, $from) }
  if ($plan.PublicNetwork) { Write-Host '             on Domain, Private and Public networks' }
  else { Write-Host '             on Domain and Private networks, not on Public ones' }
}
Write-Host ('  Remove:    {0}' -f (Join-Path $layout.InstallDir 'Uninstall-Rpa.ps1'))
Write-Host ''
if ($plan.Steps -contains 'remove the old tokens') {
  if ($NoBrowser) { Write-Host 'The runner token is new and the browser token is removed: the earlier bot user could read them.' }
  else { Write-Host 'Both tokens are new: the earlier bot user could read the old ones.' }
  Write-Host 'Update the n8n credentials with the new tokens, which Show-RpaConnection.ps1 -ShowTokens shows.'
}
if ($plan.Steps -contains 'turn on automatic sign-in') { Write-Host ('Automatic sign-in is on: Windows signs {0} in at its next start.' -f $User) }
Write-Host ('Sign in as {0}, then run Show-RpaConnection.ps1:' -f $User)
# Windows PowerShell by its full path, so that the line does not depend on what is found along PATH where it is typed.
Write-Host ('  {0} -ExecutionPolicy Bypass -File "{1}"' -f (Join-Path $PSHOME 'powershell.exe'), (Join-Path (Join-Path $layout.InstallDir 'scripts') 'Show-RpaConnection.ps1'))
if (-not $upgrade) { Write-Host ('If {0} is already signed in, sign out and sign in again.' -f $User) }
