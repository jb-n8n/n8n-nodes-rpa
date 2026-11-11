# The installer's module, second of three files (RpaInstall.psd1 loads them into one module): automatic sign-in, the
# stored passwords, and the records of what -AutoSignIn and -Unattended change, for Windows PowerShell 5.1. Every such
# change is recorded in install.json before it is made and put back by the uninstaller; what an uninstall cannot put
# back goes into a list that the next install reads. The steps of -Unattended are in RpaInstall.Machine.ps1.
#
# Registry values are read and written through .NET (not reg.exe: Windows PowerShell 5.1 leaves an empty string out of
# a tool's command line, and quotes in the data would need escaping). install.json keeps a value as its type (REG_SZ,
# REG_DWORD, ...) and its data: a string as it is (also an empty one), a number in decimal, a list of strings as a
# list, bytes as hex pairs.

$script:Winlogon = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
# The LSA secret Winlogon reads the automatic sign-in password from, and the one the RPA Supervisor reads the bot
# user's password from (desktop/runner/src/Rpa.Supervisor/LsaSecret.cs). An L$ secret can be read on this machine only,
# by SYSTEM and administrators.
$script:AutoSignInSecret = 'DefaultPassword'
$script:SupervisorSecret = 'L$RpaRunnerBotPassword'
# Where a user's registry is loaded for a moment when that user is not signed in.
$script:HiveMount = 'HKU\RpaBotUser'
$script:MountedSid = $null
$script:RegistryKinds = @{
  REG_SZ = 'String'; REG_EXPAND_SZ = 'ExpandString'; REG_DWORD = 'DWord'; REG_QWORD = 'QWord'
  REG_MULTI_SZ = 'MultiString'; REG_BINARY = 'Binary'; REG_NONE = 'None'
}

# What the registry returned for a value, as the type and data install.json keeps. -Kind is the .NET kind's name;
# -Key and -Name say which value it is when its kind is one the installer does not record.
function ConvertFrom-RpaRegistryData([string]$Kind, $Data, [string]$Key, [string]$Name) {
  switch ($Kind) {
    'String' { return @{ type = 'REG_SZ'; value = [string]$Data } }
    'ExpandString' { return @{ type = 'REG_EXPAND_SZ'; value = [string]$Data } }
    'DWord' { return @{ type = 'REG_DWORD'; value = [string][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$Data), 0) } }
    'QWord' { return @{ type = 'REG_QWORD'; value = [string][BitConverter]::ToUInt64([BitConverter]::GetBytes([long]$Data), 0) } }
    'MultiString' { return @{ type = 'REG_MULTI_SZ'; value = [string[]]@($Data) } }
    'Binary' { return @{ type = 'REG_BINARY'; value = -join (@($Data) | ForEach-Object { ([byte]$_).ToString('X2') }) } }
    'None' { return @{ type = 'REG_NONE'; value = -join (@($Data) | ForEach-Object { ([byte]$_).ToString('X2') }) } }
  }
  throw ('{0} {1} is a registry value of the kind {2}, which the installer does not record.' -f $Key, $Name, $Kind)
}

# The object .NET takes for a recorded type and data. Lists and bytes come back wrapped, so that PowerShell hands the
# caller one array and not its elements.
function ConvertTo-RpaRegistryData([string]$Type, $Value) {
  switch ($Type) {
    'REG_DWORD' { return [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$Value), 0) }
    'REG_QWORD' { return [BitConverter]::ToInt64([BitConverter]::GetBytes([uint64]$Value), 0) }
    'REG_MULTI_SZ' { return , [string[]]@($Value | Where-Object { $null -ne $_ }) }
    { $_ -eq 'REG_BINARY' -or $_ -eq 'REG_NONE' } {
      $hex = [string]$Value
      $bytes = New-Object byte[] ([int]($hex.Length / 2))
      for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
      return , $bytes
    }
    { $_ -eq 'REG_SZ' -or $_ -eq 'REG_EXPAND_SZ' } { return [string]$Value }
  }
  throw ('{0} is not a registry type the installer writes' -f $Type)
}

# Opens the registry key a recorded key names (HKLM\... or HKU\...), or returns nothing when it is not there. With
# -Create the key is made when it is missing. The caller disposes what it gets.
function Open-RpaRegistryKey([string]$Key, [bool]$Writable, [bool]$Create) {
  $actual = Resolve-RpaRegistryKey $Key
  $at = $actual.IndexOf('\')
  $root = [Microsoft.Win32.Registry]::LocalMachine
  if ($actual.Substring(0, $at) -eq 'HKU') { $root = [Microsoft.Win32.Registry]::Users }
  if ($Create) { return $root.CreateSubKey($actual.Substring($at + 1)) }
  $root.OpenSubKey($actual.Substring($at + 1), $Writable)
}

# Writes one value, making its key when that is missing. -Value is in the form install.json keeps.
function Set-RpaRegistryValue([string]$Key, [string]$Name, [string]$Type, $Value) {
  $data = ConvertTo-RpaRegistryData $Type $Value
  $open = Open-RpaRegistryKey $Key $true $true
  try { $open.SetValue($Name, $data, [Microsoft.Win32.RegistryValueKind]$script:RegistryKinds[$Type]) } finally { $open.Dispose() }
}

# Deletes one value. A value or key that is not there is not an error.
function Remove-RpaRegistryValue([string]$Key, [string]$Name) {
  $open = Open-RpaRegistryKey $Key $true $false
  if (-not $open) { return }
  try { $open.DeleteValue($Name, $false) } finally { $open.Dispose() }
}

# What names a recorded change: two records with the same identity are the same setting.
function Get-RpaChangeId($Change) {
  '{0}|{1}|{2}' -f $Change.kind, $Change.key, $Change.name
}

# A recorded change in words, with what was there before the installer changed it.
function Get-RpaChangeText($Change) {
  switch ([string]$Change.kind) {
    'registry' {
      if ($Change.existed) { return ('registry {0} {1} (it was {2} {3})' -f $Change.key, $Change.name, $Change.type, (ConvertTo-Json -InputObject $Change.value -Compress)) }
      return ('registry {0} {1} (it did not exist)' -f $Change.key, $Change.name)
    }
    'key' { return ('registry key {0} (it did not exist)' -f $Change.key) }
    'task' { return ('scheduled task {0}{1} (it was enabled)' -f $Change.key, $Change.name) }
    'power' { return ('power timeout {0} {1} (it was {2} seconds)' -f $Change.key, $Change.name, $Change.value) }
    'secret' {
      if ([string]$Change.key -eq $script:SupervisorSecret) { return "the bot user's password stored for the RPA Supervisor (it is still stored)" }
      return 'the password stored for automatic sign-in (it is still stored)'
    }
    'group' { return ('the membership of {0} in Remote Desktop Users (it was not a member)' -f $Change.value) }
    'service' { return ('the service {0} (it was not there)' -f $Change.key) }
    'firewall' {
      $what = 'the runner'
      if ([string]$Change.key -eq $script:BrowserRule) { $what = 'the browser' }
      return ('firewall rule {0} (it was for {1})' -f $Change.key, $what)
    }
    'shortcut' { return ('the Start menu shortcut {0} (it was not there)' -f $Change.key) }
  }
  ('{0} {1} {2}' -f $Change.kind, $Change.key, $Change.name).Trim()
}

# The list Uninstall-Rpa.ps1 leaves behind (uninstall-leftovers.json) when it could not put a setting back: what an earlier list held
# (-Existing, or nothing) and, for each failure, the record install.json had for the setting (what it was before the
# install), why it was not put back, for which bot user and when. A setting that is listed already keeps its first
# entry, which holds the older "before".
function Add-RpaLeftovers($Existing, [object[]]$Failed, [string]$User, [string]$At) {
  $entries = @()
  if ($Existing -and $Existing.notPutBack) { $entries = @($Existing.notPutBack) }
  $known = @($entries | Where-Object { $_.kind -ne 'other' } | ForEach-Object { Get-RpaChangeId $_ })
  foreach ($failure in $Failed) {
    $entry = [ordered]@{}
    if ($failure.Change) {
      if ($known -contains (Get-RpaChangeId $failure.Change)) { continue }
      foreach ($property in $failure.Change.PSObject.Properties) { $entry[$property.Name] = $property.Value }
    } else { $entry.kind = 'other' }
    $entry.reason = $failure.Text
    $entry.user = $User
    $entry.at = $At
    $entries += New-Object psobject -Property $entry
  }
  [ordered]@{
    note       = 'Settings that Uninstall-Rpa.ps1 could not put back to what they were before Install-Rpa.ps1 -AutoSignIn or -Unattended changed them. Each entry is the record of what was there before, and why it was not put back.'
    notPutBack = $entries
  }
}

# Records what a sign-in step is about to change and writes the record to install.json at once, before the change. A
# setting an earlier run recorded keeps that first record, so the uninstaller puts back what was there before the
# first install.
function Add-RpaSignInChange([hashtable]$Run, [Collections.IDictionary]$Change) {
  $id = Get-RpaChangeId $Change
  foreach ($known in $Run.Install.signInChanges) { if ((Get-RpaChangeId $known) -eq $id) { return } }
  $record = New-Object psobject -Property $Change
  $Run.Install.signInChanges = @($Run.Install.signInChanges) + $record
  $Run.NewChanges = @($Run.NewChanges) + $record
  Save-RpaInstallFile $Run
}

# The registry key to use for a recorded key: HKU\<SID>\... is under the mount point while that user's registry is
# loaded from its file.
function Resolve-RpaRegistryKey([string]$Key) {
  if ($script:MountedSid -and $Key.StartsWith(('HKU\{0}\' -f $script:MountedSid), [StringComparison]::OrdinalIgnoreCase)) {
    return $script:HiveMount + $Key.Substring(4 + $script:MountedSid.Length)
  }
  $Key
}

# A registry value as it is now, in the form install.json keeps it: whether it exists, and its type and data.
function Get-RpaRegistryRecord([string]$Key, [string]$Name) {
  $record = [ordered]@{ kind = 'registry'; key = $Key; name = $Name; existed = $false }
  $open = Open-RpaRegistryKey $Key $false $false
  if (-not $open) { return $record }
  try {
    if (@($open.GetValueNames()) -notcontains $Name) { return $record }
    $data = $open.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $recorded = ConvertFrom-RpaRegistryData ([string]$open.GetValueKind($Name)) $data $Key $Name
    $record.existed = $true
    $record.type = $recorded.type
    $record.value = $recorded.value
  } finally { $open.Dispose() }
  $record
}

# Sets a registry value for a sign-in step, after recording what was there.
function Set-RpaSignInValue([hashtable]$Run, [string]$Key, [string]$Name, [string]$Type, [string]$Data) {
  Add-RpaSignInChange $Run (Get-RpaRegistryRecord $Key $Name)
  Set-RpaRegistryValue $Key $Name $Type $Data
}

# Removes a registry value for a sign-in step, after recording what was there.
function Remove-RpaSignInValue([hashtable]$Run, [string]$Key, [string]$Name) {
  $record = Get-RpaRegistryRecord $Key $Name
  if (-not $record.existed) { return }
  Add-RpaSignInChange $Run $record
  Remove-RpaRegistryValue $Key $Name
}

# The file a user's registry is kept in (NTUSER.DAT in the user's profile), or nothing when Windows lists no profile
# for the user or the file is not there.
function Get-RpaUserHiveFile([string]$Sid) {
  $profileKey = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{0}' -f $Sid
  $profileDir = (Get-ItemProperty -LiteralPath $profileKey -ErrorAction SilentlyContinue).ProfileImagePath
  if (-not $profileDir) { return $null }
  $hive = Join-Path $profileDir 'NTUSER.DAT'
  if (-not (Get-RpaPathState $hive).Exists) { return $null }
  $hive
}

# Whether the registry of a user can be reached: it is loaded (the user is signed in), or its file is there.
function Test-RpaUserRegistry([string]$Sid) {
  (Test-Path -LiteralPath ('Registry::HKEY_USERS\{0}' -f $Sid)) -or [bool](Get-RpaUserHiveFile $Sid)
}

# Makes the registry of a user reachable under HKU\<SID>: it is there while the user is signed in; otherwise it is
# loaded from the user's own profile until Dismount-RpaUserHive. Never from the default profile, which every later
# user of the machine would inherit. Returns whether it loaded the file.
function Mount-RpaUserHive([string]$Sid) {
  if (Test-Path -LiteralPath ('Registry::HKEY_USERS\{0}' -f $Sid)) { return $false }
  $hive = Get-RpaUserHiveFile $Sid
  if (-not $hive) { throw 'The user has no profile on this machine.' }
  if ((Get-RpaPathState $hive).IsLink) { throw ('{0} is a link.' -f $hive) }
  Invoke-RpaNative reg.exe @('load', $script:HiveMount, $hive)
  $script:MountedSid = $Sid
  $true
}

function Dismount-RpaUserHive([bool]$Mounted) {
  if (-not $Mounted) { return }
  $script:MountedSid = $null
  # An open key keeps the file loaded; .NET closes the ones it no longer uses when it collects.
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  Invoke-RpaNative reg.exe @('unload', $script:HiveMount)
}

# The current value of a power timeout on mains power, in seconds, or nothing when powercfg does not show it. The
# value lines end in a hex number; the last two are the mains and the battery value, whatever the display language.
function Get-RpaPowerTimeout([string]$Subgroup, [string]$Setting) {
  $numbers = @()
  $ErrorActionPreference = 'Continue'
  foreach ($line in @(& (Get-RpaSystemTool 'powercfg.exe') /query SCHEME_CURRENT $Subgroup $Setting 2>$null)) {
    if ($line -match '0x([0-9A-Fa-f]{8})\s*$') { $numbers += [Convert]::ToUInt32($Matches[1], 16) }
  }
  if ($numbers.Count -lt 2) { return $null }
  $numbers[$numbers.Count - 2]
}

# Winlogon reads the password from the LSA secret DefaultPassword; the registry value DefaultPassword is never written.
function Set-RpaSignInPassword([hashtable]$Run) {
  if (-not $Run.Password) { throw 'There is no password to store for automatic sign-in.' }
  Add-RpaNativeTypes
  Add-RpaSignInChange $Run ([ordered]@{ kind = 'secret'; key = $script:AutoSignInSecret; name = '' })
  [RpaLsaSecret]::Store($script:AutoSignInSecret, $Run.Password)
}

# The bot user's password for the RPA Supervisor, which reads it for each sign-in: in the LSA secret
# L$RpaRunnerBotPassword, the same way as the one for automatic sign-in. The password is the SecureString the run
# holds (-UserPassword, or the one made for a user the run created); it does not go into a command's parameters, a
# file or the output. The step that registers the service comes after this one and starts the service again, which it needs
# to use a password stored again.
function Set-RpaSupervisorPassword([hashtable]$Run) {
  if (-not $Run.Password) { throw 'There is no password to store for the RPA Supervisor.' }
  Add-RpaNativeTypes
  Add-RpaSignInChange $Run ([ordered]@{ kind = 'secret'; key = $script:SupervisorSecret; name = '' })
  [RpaLsaSecret]::Store($script:SupervisorSecret, $Run.Password)
}

# The password stored for automatic sign-in (the LSA secret DefaultPassword), as a SecureString, or nothing when it is
# missing or empty. It goes to no command line, file or output.
function Read-RpaAutoSignInPassword {
  Add-RpaMoveTypes
  [RpaLsaRead]::Read($script:AutoSignInSecret)
}

# The password stored for the RPA Supervisor (the LSA secret L$RpaRunnerBotPassword), as a SecureString, or nothing
# when it is missing or empty.
function Read-RpaSupervisorPassword {
  Add-RpaMoveTypes
  [RpaLsaRead]::Read($script:SupervisorSecret)
}

# The step 'keep the supervisor password for automatic sign-in', on the way back from -Unattended to -AutoSignIn: the
# password the supervisor has is kept in the run's memory, and the steps of automatic sign-in that follow store it, so
# that the bot user keeps its password. The step that removes the supervisor's secret comes after them.
function Copy-RpaSupervisorPassword([hashtable]$Run) {
  $stored = Read-RpaSupervisorPassword
  if (-not $stored) { throw 'The password stored for the RPA Supervisor is missing or empty; nothing of it was kept.' }
  $Run.Password = $stored
}

# The step 'keep the automatic sign-in password for the supervisor', when an install with automatic sign-in moves to
# -Unattended: the bot user's password stays the one it has (a new password set by an administrator would make what
# the bot user's programs protect with it unreadable). It is read from the secret for automatic sign-in while that is
# still there, kept in the run's memory (a failed run stores it for automatic sign-in again) and stored for the
# supervisor.
function Copy-RpaAutoSignInPassword([hashtable]$Run) {
  $stored = Read-RpaAutoSignInPassword
  if (-not $stored) { throw 'The password stored for automatic sign-in is missing or empty; nothing of it was kept.' }
  $Run.Password = $stored
  Set-RpaSupervisorPassword $Run
}

# The step 'turn off automatic sign-in': puts back what -AutoSignIn changed, from its records in install.json, the last
# first, as Uninstall-Rpa.ps1 does (the Winlogon values, the secret DefaultPassword, the settings that kept the desktop
# unlocked). The records of -Unattended stay; install.json keeps only the records of what could not be put back, and
# says that automatic sign-in is off. From here on a failed run turns automatic sign-in on again.
function Disable-RpaAutoSignIn([hashtable]$Run) {
  # Not the Start menu shortcut, which is no sign-in setting.
  $records = @($Run.Install.signInChanges | Where-Object { $_ -and -not (Test-RpaUnattendedChange $_) -and [string]$_.kind -ne 'shortcut' })
  $Run.AutoSignInTurnedOff = $true
  $failed = @(Restore-RpaSignInChanges $records $false)
  $left = @($failed | Where-Object { $_.Change } | ForEach-Object { Get-RpaChangeId $_.Change })
  $done = @($records | ForEach-Object { Get-RpaChangeId $_ } | Where-Object { $left -notcontains $_ })
  $Run.Install.signInChanges = @($Run.Install.signInChanges | Where-Object { $done -notcontains (Get-RpaChangeId $_) })
  $Run.Install.autoSignIn = $false
  Save-RpaInstallFile $Run
  if ($failed.Count -gt 0) { throw ('Could not turn automatic sign-in off: {0}' -f (@($failed | ForEach-Object { $_.Text }) -join '; ')) }
}

# After a failed run that had turned automatic sign-in off: turns it on again as -AutoSignIn does, with the password the
# run kept in memory, recording each setting anew. Returns, like Restore-RpaSignInChanges, what it could not do.
function Enable-RpaAutoSignInAgain([hashtable]$Run) {
  Write-Host ('  undo: turn automatic sign-in of {0} on again' -f $Run.Account.Display)
  try {
    Set-RpaSignInPassword $Run
    Enable-RpaAutoSignIn $Run
    Set-RpaDesktopUnlocked $Run
    $Run.AutoSignInTurnedOff = $false
  } catch {
    $text = 'automatic sign-in of {0}, which this run had turned off: {1}' -f $Run.Account.Display, $_.Exception.GetBaseException().Message
    Write-Host ('    could not put back: {0}' -f $text)
    @{ Change = $null; Text = $text }
  }
}

# Deletes an LSA secret; one that is not there is no error.
function Remove-RpaLsaSecret([string]$Name) {
  Add-RpaNativeTypes
  [RpaLsaSecret]::Remove($Name)
}

function Enable-RpaAutoSignIn([hashtable]$Run) {
  Set-RpaSignInValue $Run $script:Winlogon 'AutoAdminLogon' 'REG_SZ' '1'
  Set-RpaSignInValue $Run $script:Winlogon 'ForceAutoLogon' 'REG_SZ' '1'
  Set-RpaSignInValue $Run $script:Winlogon 'DefaultUserName' 'REG_SZ' $Run.Account.Name
  Set-RpaSignInValue $Run $script:Winlogon 'DefaultDomainName' 'REG_SZ' $Run.Account.Domain
  Remove-RpaSignInValue $Run $script:Winlogon 'AutoLogonCount'
  # A password kept in the registry in plain text by an earlier setup is removed and, being a secret, not recorded.
  Remove-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE{0}' -f $script:Winlogon.Substring(4)) -Name 'DefaultPassword' -ErrorAction SilentlyContinue
}

# Nothing may lock or cover the desktop. For the whole machine: no lock screen, no lock when idle, no first sign-in
# animation, no Server Manager or network prompt at logon, display and sleep timeouts never. For the bot user: no
# screen saver and no Lock command, written into that user's own registry (its profile is created first when it has
# never signed in).
function Set-RpaDesktopUnlocked([hashtable]$Run) {
  $policies = 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  Set-RpaSignInValue $Run 'HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization' 'NoLockScreen' 'REG_DWORD' '1'
  Set-RpaSignInValue $Run $policies 'InactivityTimeoutSecs' 'REG_DWORD' '0'
  Set-RpaSignInValue $Run $policies 'EnableFirstLogonAnimation' 'REG_DWORD' '0'
  if (Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\ServerManager') {
    Set-RpaSignInValue $Run 'HKLM\SOFTWARE\Microsoft\ServerManager' 'DoNotOpenServerManagerAtLogon' 'REG_DWORD' '1'
  }
  $networkPrompt = 'HKLM\SYSTEM\CurrentControlSet\Control\Network\NewNetworkWindowOff'
  if (-not (Test-Path -LiteralPath ('Registry::HKEY_LOCAL_MACHINE{0}' -f $networkPrompt.Substring(4)))) {
    Add-RpaSignInChange $Run ([ordered]@{ kind = 'key'; key = $networkPrompt; name = '' })
    (Open-RpaRegistryKey $networkPrompt $true $true).Dispose()
  }
  foreach ($task in @(Get-ScheduledTask -TaskName 'ServerManager' -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Disabled' })) {
    Add-RpaSignInChange $Run ([ordered]@{ kind = 'task'; key = $task.TaskPath; name = $task.TaskName })
    $task | Disable-ScheduledTask | Out-Null
  }
  foreach ($timeout in @(@{ Subgroup = 'SUB_VIDEO'; Setting = 'VIDEOIDLE'; Name = 'monitor-timeout-ac' }, @{ Subgroup = 'SUB_SLEEP'; Setting = 'STANDBYIDLE'; Name = 'standby-timeout-ac' })) {
    $seconds = Get-RpaPowerTimeout $timeout.Subgroup $timeout.Setting
    if ($null -ne $seconds -and $seconds -ne 0) {
      Add-RpaSignInChange $Run ([ordered]@{ kind = 'power'; key = $timeout.Subgroup; name = $timeout.Setting; value = [string]$seconds })
    }
    Invoke-RpaNative powercfg.exe @('/change', $timeout.Name, '0')
  }

  Add-RpaNativeTypes
  [RpaAccounts]::CreateUserProfile($Run.Sid, $Run.Account.Name)
  $user = 'HKU\{0}' -f $Run.Sid
  $mounted = Mount-RpaUserHive $Run.Sid
  try {
    foreach ($key in "$user\Control Panel\Desktop", "$user\Software\Policies\Microsoft\Windows\Control Panel\Desktop") {
      Set-RpaSignInValue $Run $key 'ScreenSaveActive' 'REG_SZ' '0'
      Set-RpaSignInValue $Run $key 'ScreenSaverIsSecure' 'REG_SZ' '0'
    }
    Set-RpaSignInValue $Run "$user\Software\Microsoft\Windows\CurrentVersion\Policies\System" 'DisableLockWorkstation' 'REG_DWORD' '1'
  } finally {
    Dismount-RpaUserHive $mounted
  }
}

# Puts one recorded change back. Throws when it cannot.
function Restore-RpaSignInChange($Change) {
  switch ([string]$Change.kind) {
    'registry' {
      if ($Change.existed) {
        $value = $Change.value
        # Automatic sign-in that was on for someone before the install cannot come back: its stored password was
        # replaced. Turning it on without one would only produce failed sign-ins.
        if ($Change.key -eq $script:Winlogon -and $Change.name -eq 'AutoAdminLogon') { $value = '0' }
        Set-RpaRegistryValue ([string]$Change.key) ([string]$Change.name) ([string]$Change.type) $value
      } else {
        Remove-RpaRegistryValue ([string]$Change.key) ([string]$Change.name)
      }
    }
    'key' {
      # The key did not exist before; it holds nothing the installer did not put there.
      $key = [string]$Change.key
      $at = $key.LastIndexOf('\')
      $parent = Open-RpaRegistryKey $key.Substring(0, $at) $true $false
      if ($parent) { try { $parent.DeleteSubKeyTree($key.Substring($at + 1), $false) } finally { $parent.Dispose() } }
    }
    'task' { Get-ScheduledTask -TaskPath ([string]$Change.key) -TaskName ([string]$Change.name) -ErrorAction SilentlyContinue | Enable-ScheduledTask | Out-Null }
    'power' {
      Invoke-RpaNative powercfg.exe @('/setacvalueindex', 'SCHEME_CURRENT', [string]$Change.key, [string]$Change.name, [string]$Change.value)
      Invoke-RpaNative powercfg.exe @('/setactive', 'SCHEME_CURRENT')
    }
    'secret' { Remove-RpaLsaSecret ([string]$Change.key) }
    'group' { Remove-RpaGroupMember ([string]$Change.key) ([string]$Change.name) }
    'service' { Remove-RpaSupervisor }
    'firewall' { Set-RpaFirewallRuleProgram ([string]$Change.key) (Get-RpaSignedInProgram ([string]$Change.key)) }
    'shortcut' { Remove-RpaShortcut ([string]$Change.key) }
  }
}

# Puts recorded changes back, the last one first. The values of a user go into that user's registry, loaded from its
# profile when the user is not signed in; when that profile is no longer on the machine (the user was removed), the
# setting went with it, and the record is skipped with a line that says so. With -KeepWinlogon the automatic sign-in
# values and the password stored for it are left alone (someone has pointed automatic sign-in at another account
# since).
# Each change that cannot be put back is printed when that happens. Returns those: for each, the record (Change;
# nothing when a user's registry could not be closed again) and a line that names it with the reason (Text).
function Restore-RpaSignInChanges([object[]]$Changes, [bool]$KeepWinlogon) {
  $failed = @()
  $ordered = @($Changes)
  [array]::Reverse($ordered)
  foreach ($change in $ordered) {
    $key = [string]$change.key
    if ($KeepWinlogon -and (($change.kind -eq 'secret' -and $key -eq $script:AutoSignInSecret) -or $key -eq $script:Winlogon)) { continue }
    $mounted = $false
    $failure = $null
    try {
      if ($change.kind -eq 'registry' -and $key -match '^HKU\\(S-[0-9-]+)\\') {
        $sid = $Matches[1]
        if (-not (Test-RpaUserRegistry $sid)) {
          Write-Host ('    skipped: {0}: the profile of that user is no longer on this machine' -f (Get-RpaChangeText $change))
          continue
        }
        $mounted = Mount-RpaUserHive $sid
      }
      Restore-RpaSignInChange $change
    } catch {
      $failure = @{ Change = $change; Text = ('{0}: {1}' -f (Get-RpaChangeText $change), $_.Exception.GetBaseException().Message) }
    } finally {
      try { Dismount-RpaUserHive $mounted } catch { $failed += @{ Change = $null; Text = $_.Exception.Message }; Write-Host ('    could not put back: {0}' -f $_.Exception.Message) }
    }
    if ($failure) {
      $failed += $failure
      Write-Host ('    could not put back: {0}' -f $failure.Text)
    }
  }
  $failed
}

# The list an uninstall left of what it could not put back, read from its file under Program Files. State is missing,
# trusted (a file with one name that Administrators or SYSTEM own, holding a list) or untrusted (anything else in its
# place: a folder, a link, a file of another owner or with a second name, a file that is not a list). Only a trusted
# list is read (List).
function Read-RpaLeftovers([string]$File) {
  $state = Get-RpaPathState $File
  if (-not $state.Exists) { return @{ State = 'missing'; List = $null } }
  if (-not $state.IsLink -and -not $state.IsFolder -and $state.Links -eq 1 -and $state.OwnerTrusted) {
    try {
      $list = Get-Content -Raw -LiteralPath $File -Encoding UTF8 | ConvertFrom-Json
      if ($list -and $null -ne $list.PSObject.Properties['notPutBack']) { return @{ State = 'trusted'; List = $list } }
    } catch { }
  }
  @{ State = 'untrusted'; List = $null }
}

# Writes what the uninstaller could not put back to uninstall-leftovers.json in the install directory, as a file only
# SYSTEM and Administrators can read or change. Under Program Files only administrators can create anything, and the
# file stays when the program files, and with -RemoveData the data directory, are removed; the next install reads it.
# A list an earlier uninstall left there is added to. Anything else in its place is left as it is, and the list is
# not written. Returns the path.
function Save-RpaLeftovers([hashtable]$Layout, [object[]]$Failed, [string]$User) {
  $file = $Layout.LeftoversFile
  [void][IO.Directory]::CreateDirectory($Layout.InstallDir)
  $earlier = Read-RpaLeftovers $file
  if ($earlier.State -eq 'untrusted') { throw ('{0} is there already and is not a list that Administrators or SYSTEM own; it was left as it is' -f $file) }
  $list = Add-RpaLeftovers $earlier.List $Failed $User ([DateTime]::UtcNow.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", [Globalization.CultureInfo]::InvariantCulture))
  if ($earlier.State -eq 'trusted') { Remove-Item -LiteralPath $file -Force }
  New-RpaProtectedFile -Path $file -Text (ConvertTo-Json -InputObject $list -Depth 6) -AdministratorsOnly
  $file
}
