# Removes the RPA desktop runner and the RPA browser from this Windows machine. Run it from an administrator Windows
# PowerShell (powershell.exe, 64-bit):
#
#   & 'C:\Program Files\RPA Runner\Uninstall-Rpa.ps1' [-RemoveData]
#
# It ends both programs and removes the scheduled tasks, the firewall rules and C:\Program Files\RPA Runner. When the
# installer turned automatic sign-in on, it puts every setting -AutoSignIn changed back to what install.json recorded
# and removes the stored password; when automatic sign-in names another user by now, it leaves the sign-in values and
# the stored password alone. A setting it cannot put back is printed when that happens and listed, with what it was
# before, in C:\Program Files\RPA Runner\uninstall-leftovers.json, a file only administrators can read or change;
# the install directory then stays, with that one file in it, also with -RemoveData. The next install reads the list
# and records those settings again, so that a later uninstall tries them again.
#
# It keeps the data directory, C:\ProgramData\RPA Runner (the policy, the tokens, the certificates, logs), unless
# -RemoveData is given. A later install for the same bot user takes the kept directory over when everything in it
# belongs to Administrators, to SYSTEM or to that user, and keeps the policy, the tokens and the certificates. An
# install for another user refuses what the first user left there (logs, certificates, exports), and so does an
# install for a user of the same name that was removed and created again.
#
# -RemoveData is refused while a process is running of the bot user or of any account that owns something in the
# data directory: sign that user out first (where automatic sign-in is on, run without -RemoveData first, then sign
# the bot user out and run Uninstall-Rpa.ps1 -RemoveData from the unpacked package). Every refusal comes before
# anything is removed. The uninstaller never removes a Windows user.
#
# Run from an unpacked package instead of the install directory, it first checks who can change that package, as
# Install-Rpa.ps1 does.
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
# Run from the install directory, the uninstaller is what the installer put under Program Files. Run from anywhere
# else, it is in an unpacked package, which gets the same check as for an install before its module is loaded.
$check = Test-Package $PSScriptRoot 'uninstaller' (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'RPA Runner')
if ($check.Refusal) {
  Write-Host $check.Refusal
  Write-Host 'Nothing was changed.'
  exit 1
}
Import-Module (Join-Path $check.Package 'RpaInstall.psm1') -Force

if (-not (Test-RpaAdministrator)) {
  Write-Host 'Run Uninstall-Rpa.ps1 from an administrator PowerShell.'
  exit 1
}
$plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = [bool]$RemoveData } -Facts (Get-RpaUninstallFacts)
if ($plan.Refusals.Count -gt 0) {
  foreach ($refusal in $plan.Refusals) { Write-Host $refusal }
  Write-Host 'Nothing was changed.'
  exit 1
}

Write-Host 'Removing RPA:'
try { $result = Invoke-RpaUninstall -Plan $plan -RemoveData:$RemoveData }
catch {
  Write-Host $_.Exception.Message
  # The last look at who is signed in, directly before the data directory would have gone.
  if ($_.Exception.Data['Refused']) { Write-Host 'Nothing was removed. The programs were stopped, and their tasks were started again.' }
  else {
    $installed = Join-Path (Get-RpaLayout).InstallDir 'Uninstall-Rpa.ps1'
    Write-Host 'The removal did not finish. Fix the cause and run Uninstall-Rpa.ps1 again'
    Write-Host ('(from the unpacked package when {0} is gone by now).' -f $installed)
  }
  exit 1
}

Write-Host ''
foreach ($line in Get-RpaUninstallSummary $result) { Write-Host $line }
