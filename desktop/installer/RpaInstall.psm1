# What Install-Rpa.ps1 and Uninstall-Rpa.ps1 do, for Windows PowerShell 5.1 (the PowerShell that ships with Windows).
#
# The installer works in three parts, so that what it decides can be tested without a Windows machine:
#   Get-RpaMachineFacts    looks at the machine (Windows only) and changes nothing
#   Get-RpaInstallPlan     turns the parameters and those facts into refusals, warnings and an ordered list of steps;
#                          it looks at nothing but its two arguments
#   Invoke-RpaInstallPlan  runs exactly the listed steps, in order (Windows only)
#
# The commands for permissions, the stored sign-in password, the registry and the scheduled tasks come from the AWS
# test bed's first-boot script (deploy/terraform/modules/aws-ec2-desktop-runner/setup.ps1.tftpl), where they are proven.
# No function here prints, logs or returns a secret.

$script:MinimumBuild = 17763
$script:TaskPath = '\RPA\'
$script:RunnerTask = 'RPA Runner'
$script:BrowserTask = 'RPA Browser'
$script:RunnerRule = 'RPA-Runner-In'
$script:BrowserRule = 'RPA-Browser-In'
$script:StarterPolicy = '{ "allowedApps": [], "maxFileBytes": 20971520 }'
$script:Winlogon = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$script:WinlogonPath = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$script:Utf8 = New-Object Text.UTF8Encoding $false

# ---------------------------------------------------------------------------------------------------------------------
# The plan (runs anywhere)
# ---------------------------------------------------------------------------------------------------------------------

# Decides what an install does. -Parameters holds Install-Rpa.ps1's parameters (User, UserPassword, RunnerPort,
# BrowserPort, NoBrowser, NoFirewall, AutoSignIn, Force); -Facts is what Get-RpaMachineFacts returns. With a refusal
# there are no steps: the installer changes nothing.
function Get-RpaInstallPlan {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Parameters,
    [Parameter(Mandatory = $true)][hashtable]$Facts
  )
  $user = [string]$Parameters.User
  $hasPassword = $null -ne $Parameters.UserPassword
  $browser = -not $Parameters.NoBrowser
  $autoSignIn = [bool]$Parameters.AutoSignIn
  $upgrade = [bool]$Facts.Installed
  $refusals = New-Object Collections.Generic.List[string]
  $warnings = New-Object Collections.Generic.List[string]
  $steps = New-Object Collections.Generic.List[string]

  # Without these two nothing else can be judged (the other facts are not even gathered).
  if (-not $Facts.IsAdmin) { $refusals.Add('Run Install-Rpa.ps1 from an administrator PowerShell.') }
  if (-not $Facts.Is64Bit -or $Facts.OsBuild -lt $script:MinimumBuild) {
    $refusals.Add('Windows 10 1809, Windows 11 or Windows Server 2019 or later (64-bit) is required.')
  }

  if ($refusals.Count -eq 0) {
    # On an upgrade the installed runner and browser hold the ports.
    if (-not $upgrade) {
      $ports = @([int]$Parameters.RunnerPort)
      if ($browser) { $ports += [int]$Parameters.BrowserPort }
      foreach ($port in $ports) {
        $process = $Facts.PortsInUse[$port]
        if ($process) { $refusals.Add(('Port {0} is in use by {1}. Choose another with -RunnerPort or -BrowserPort.' -f $port, $process)) }
      }
    }
    if ($Facts.UserIsDomain -and -not $Facts.UserExists) {
      $refusals.Add(('{0} does not exist. Create it in your directory first; the installer only creates local users.' -f $user))
    }
    # An existing user's password is never changed, so automatic sign-in can only store one that is given.
    if ($autoSignIn -and $Facts.UserExists -and -not $hasPassword) {
      $refusals.Add(('-AutoSignIn for the existing user {0} needs -UserPassword.' -f $user))
    }
    if (-not $upgrade -and -not $Facts.UserExists -and -not $Facts.UserIsDomain -and -not $autoSignIn -and -not $hasPassword) {
      $refusals.Add(('Give -UserPassword for the new user {0}, or use -AutoSignIn to have a random password stored for automatic sign-in.' -f $user))
    }
    if ($upgrade -and $Facts.RunnerRunning) {
      $text = 'The runner is running; a run in progress will fail. Use -Force to continue.'
      if ($Parameters.Force) { $warnings.Add($text) } else { $refusals.Add($text) }
    }
    if ($autoSignIn -and $Facts.UserExists -and $Facts.UserPasswordExpires) {
      $warnings.Add(("{0}'s password expires; automatic sign-in stops working when it does." -f $user))
    }
  }

  if ($refusals.Count -eq 0) {
    # An upgrade replaces the program files and keeps the user, the policy and both tokens (and the certificates,
    # which no step touches). The program files come before the user, and automatic sign-in comes last, so that a
    # failed copy leaves no new user behind and no sign-in is switched on for an install that did not finish.
    if ($upgrade) { $steps.Add('stop running services') }
    $steps.Add('copy program files')
    if (-not $upgrade -and -not $Facts.UserExists) { $steps.Add('create user') }
    $steps.Add('protect the data directory')
    if (-not $upgrade) {
      $steps.Add('write policy')
      $steps.Add('write token')
      if ($browser) { $steps.Add('write browser-token') }
    }
    if (-not $Parameters.NoFirewall) {
      $steps.Add('add the runner firewall rule')
      if ($browser) { $steps.Add('add the browser firewall rule') } elseif ($upgrade) { $steps.Add('remove the browser firewall rule') }
    }
    $steps.Add('register the runner task')
    if ($browser) { $steps.Add('register the browser task') } elseif ($upgrade) { $steps.Add('remove the browser task') }
    if ($autoSignIn) {
      $steps.Add('store sign-in password')
      $steps.Add('turn on automatic sign-in')
      $steps.Add('keep the desktop unlocked')
    }
    $steps.Add('write install.json')
    if ($upgrade) { $steps.Add('start tasks') }
  }

  @{ Refusals = $refusals.ToArray(); Warnings = $warnings.ToArray(); Steps = $steps.ToArray() }
}

# 64 symbols, so a random byte modulo 64 is uniform; retried until it has an upper, a lower and a digit and no part of
# an account or full name (Windows' complexity rule refuses a password containing rpa, runner or admin). Letters,
# digits, - and _ need no escaping in a header, a URL or a shell.
function New-RpaSecret {
  param([Parameter(Mandatory = $true)][ValidateRange(8, 1024)][int]$Length)
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    do {
      $bytes = New-Object byte[] $Length
      $rng.GetBytes($bytes)
      $s = -join ($bytes | ForEach-Object { $alphabet[$_ % 64] })
    } until ($s -cmatch '[A-Z]' -and $s -cmatch '[a-z]' -and $s -cmatch '[0-9]' -and $s -notmatch 'rpa|runner|admin')
  } finally { $rng.Dispose() }
  $s
}

# Reads -User: a bare name, .\name and <this computer>\name are local users, any other DOMAIN\name is a domain user.
# Qualified is the form Windows takes everywhere (tasks, permissions); Display is the form shown and kept in
# install.json.
function Get-RpaAccount {
  param(
    [Parameter(Mandatory = $true)][string]$User,
    [Parameter(Mandatory = $true)][string]$ComputerName
  )
  $domain = ''
  $name = $User
  $at = $User.IndexOf('\')
  if ($at -ge 0) {
    $domain = $User.Substring(0, $at)
    $name = $User.Substring($at + 1)
  }
  if ($domain -eq '' -or $domain -eq '.' -or $domain -eq $ComputerName) {
    return @{ Name = $name; Domain = $ComputerName; IsDomain = $false; Qualified = ('{0}\{1}' -f $ComputerName, $name); Display = $name }
  }
  @{ Name = $name; Domain = $domain; IsDomain = $true; Qualified = ('{0}\{1}' -f $domain, $name); Display = ('{0}\{1}' -f $domain, $name) }
}

# ---------------------------------------------------------------------------------------------------------------------
# Everything below runs on Windows only.
# ---------------------------------------------------------------------------------------------------------------------

# Where things are: the same paths as the test bed. Program Files keeps its default permissions (users read and run,
# only administrators change), so the bot user cannot replace what it runs.
function Get-RpaLayout {
  $installDir = Join-Path $env:ProgramFiles 'RPA Runner'
  $dataDir = Join-Path $env:ProgramData 'RPA Runner'
  @{
    InstallDir  = $installDir
    InstallFile = Join-Path $installDir 'install.json'
    DataDir     = $dataDir
    LogDir      = Join-Path $dataDir 'logs'
  }
}

function Test-RpaAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# install.json as an object, or nothing when there is no install.
function Read-RpaInstallFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
}

# The facts Get-RpaInstallPlan judges. Changes nothing.
function Get-RpaMachineFacts {
  param([Parameter(Mandatory = $true)][hashtable]$Parameters)
  $ErrorActionPreference = 'Stop'
  $layout = Get-RpaLayout
  $account = Get-RpaAccount -User $Parameters.User -ComputerName $env:COMPUTERNAME
  $facts = @{
    IsAdmin             = Test-RpaAdministrator
    Is64Bit             = [Environment]::Is64BitOperatingSystem
    OsBuild             = [Environment]::OSVersion.Version.Build
    UserExists          = $false
    UserIsDomain        = $account.IsDomain
    UserPasswordExpires = $false
    PortsInUse          = @{}
    Installed           = Test-Path -LiteralPath $layout.InstallFile
    RunnerRunning       = [bool](Get-Process -Name 'RpaRunner' -ErrorAction SilentlyContinue)
  }
  # The plan refuses on these before it reads the rest, and an older Windows lacks the commands used below.
  if (-not $facts.IsAdmin -or -not $facts.Is64Bit -or $facts.OsBuild -lt $script:MinimumBuild) { return $facts }

  if ($account.IsDomain) {
    try {
      [void](New-Object Security.Principal.NTAccount($account.Qualified)).Translate([Security.Principal.SecurityIdentifier])
      $facts.UserExists = $true
    } catch { $facts.UserExists = $false }
    if ($facts.UserExists) {
      # 0x10000: the account's "password never expires" flag. When the directory cannot be asked, no warning.
      try {
        $flags = ([ADSI]('WinNT://{0}/{1},user' -f $account.Domain, $account.Name)).UserFlags.Value
        $facts.UserPasswordExpires = -not ($flags -band 0x10000)
      } catch { $facts.UserPasswordExpires = $false }
    }
  } else {
    $local = Get-LocalUser -Name $account.Name -ErrorAction SilentlyContinue
    if ($local) {
      $facts.UserExists = $true
      $facts.UserPasswordExpires = $null -ne $local.PasswordExpires
    }
  }

  $ports = @([int]$Parameters.RunnerPort)
  if (-not $Parameters.NoBrowser) { $ports += [int]$Parameters.BrowserPort }
  foreach ($port in $ports) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
      if ($process) { $facts.PortsInUse[$port] = $process.ProcessName } else { $facts.PortsInUse[$port] = 'process {0}' -f $listener.OwningProcess }
    }
  }
  $facts
}

function Invoke-RpaNative([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ('{0} {1} failed with exit code {2}' -f $Exe, $Arguments[0], $LASTEXITCODE) }
}

function Set-RpaRegistryValue([string]$Key, [string]$Name, [string]$Type, [string]$Data) {
  Invoke-RpaNative reg.exe @('add', $Key, '/v', $Name, '/t', $Type, '/d', $Data, '/f')
}

function Get-RpaSid([hashtable]$Account) {
  try { (New-Object Security.Principal.NTAccount($Account.Qualified)).Translate([Security.Principal.SecurityIdentifier]).Value }
  catch { throw ('The Windows user {0} does not exist.' -f $Account.Display) }
}

# Ends the two tasks and everything started from the install directory: the runner, the browser host, its browser, the
# demo app, and the start scripts (also when someone started them by hand), which would otherwise start the programs
# again while their files are replaced. The tasks are switched off until they are registered again or removed.
function Stop-RpaServices([string]$InstallDir) {
  foreach ($name in $script:RunnerTask, $script:BrowserTask) {
    $task = Get-ScheduledTask -TaskPath $script:TaskPath -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
      $task | Stop-ScheduledTask
      $task | Disable-ScheduledTask | Out-Null
    }
  }
  $programs = $InstallDir.TrimEnd('\') + '\'
  $startScripts = Join-Path (Join-Path $InstallDir 'scripts') 'start-'
  $running = @()
  for ($try = 1; $try -le 20; $try++) {
    $running = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and (
          ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($programs, [StringComparison]::OrdinalIgnoreCase)) -or
          ($_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -and $_.CommandLine.IndexOf($startScripts, [StringComparison]::OrdinalIgnoreCase) -ge 0))
      })
    if ($running.Count -eq 0) { return }
    foreach ($process in $running) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }
  throw ('Could not stop {0}.' -f (($running | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', '))
}

# Replaces each file and folder of the package in the install directory. install.json is not in the package, so an
# upgrade keeps it until the last step writes the new one.
function Copy-RpaProgramFiles([string]$SourceDir, [string]$InstallDir) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $SourceDir -Force) {
    $target = Join-Path $InstallDir $item.Name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse -Force
  }
}

# A standard local user (member of Users only) whose password never expires. Without -UserPassword the password is
# random and is only ever stored for automatic sign-in (the plan refuses a new user with neither). Returns the password
# for that step.
function New-RpaUser([hashtable]$Account, [Security.SecureString]$Password) {
  if (-not $Password) {
    # Windows' complexity rule also refuses a password that holds a part of the account's own name.
    $parts = @($Account.Name -split '[^A-Za-z0-9]' | Where-Object { $_.Length -ge 3 })
    do { $plain = New-RpaSecret -Length 32 } while (@($parts | Where-Object { $plain.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0)
    $Password = ConvertTo-SecureString $plain -AsPlainText -Force
    $plain = $null
  }
  New-LocalUser -Name $Account.Name -Password $Password -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -FullName 'RPA Runner' -Description 'Runs the RPA desktop runner and browser' | Out-Null
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $Account.Name -ErrorAction SilentlyContinue
  $Password
}

# %ProgramData%\RPA Runner: administrators own it. The bot user may read, create files (the runner's and the browser
# host's certificates) and write logs, but cannot change or delete what it did not create: policy.json and the tokens.
# The owner is set because the runner refuses a policy whose folder anyone but administrators owns, and a folder made
# by an administrator can be owned by that person's own account. (The test bed's setup ran as SYSTEM.)
function Protect-RpaDataDirectory([hashtable]$Layout, [string]$Sid) {
  New-Item -ItemType Directory -Force -Path $Layout.DataDir, $Layout.LogDir | Out-Null
  $ref = '*{0}:' -f $Sid
  Invoke-RpaNative icacls.exe @($Layout.DataDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-3-0:(OI)(CI)(IO)F', "$($ref)(OI)(CI)RX")
  Invoke-RpaNative icacls.exe @($Layout.DataDir, '/grant', "$($ref)(AD,WD)")
  Invoke-RpaNative icacls.exe @($Layout.LogDir, '/grant', "$($ref)(OI)(CI)M")
  Invoke-RpaNative icacls.exe @($Layout.DataDir, '/setowner', '*S-1-5-32-544')
}

# Writes a file the bot user may only read, and only when it is missing: SYSTEM and Administrators in full, the bot
# user read, nothing inherited, owned by Administrators. Used for policy.json and both tokens.
function New-RpaProtectedFile([string]$Path, [string]$Text, [string]$Sid) {
  if (Test-Path -LiteralPath $Path) { return }
  [IO.File]::WriteAllText($Path, $Text, $script:Utf8)
  Invoke-RpaNative icacls.exe @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', ('*{0}:R' -f $Sid))
  Invoke-RpaNative icacls.exe @($Path, '/setowner', '*S-1-5-32-544')
}

function Set-RpaFirewallRule([string]$Name, [string]$DisplayName, [int]$Port) {
  Remove-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue
  New-NetFirewallRule -Name $Name -DisplayName $DisplayName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
}

# A task that runs a start script in the bot user's session at its logon: interactive (so it can drive the desktop),
# not elevated, no time limit. The start script starts its program again whenever it exits.
function Register-RpaTask([string]$Name, [string]$ScriptPath, [string]$Account) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $ScriptPath)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Account
  $principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskPath $script:TaskPath -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Unregister-RpaTask([string]$Name) {
  Unregister-ScheduledTask -TaskPath $script:TaskPath -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
}

# Stores and removes an LSA private secret, the way Windows itself keeps the auto-logon password (LSA secret
# DefaultPassword). Store is the test bed's; Remove passes no data, which deletes the secret.
function Add-RpaLsaSecretType {
  if ('RpaLsaSecret' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RpaLsaSecret {
  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct ObjectAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr systemName, ref ObjectAttributes attributes, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr policy, ref UnicodeString key, ref UnicodeString data);
  [DllImport("advapi32.dll", EntryPoint = "LsaStorePrivateData")] static extern uint LsaRemovePrivateData(IntPtr policy, ref UnicodeString key, IntPtr data);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  const uint PolicyCreateSecret = 0x20;
  const uint StatusObjectNameNotFound = 0xC0000034;
  static UnicodeString Make(string s) {
    UnicodeString u = new UnicodeString();
    u.Buffer = Marshal.StringToHGlobalUni(s);
    u.Length = (ushort)(s.Length * 2);
    u.MaximumLength = (ushort)(s.Length * 2 + 2);
    return u;
  }
  public static void Store(string key, string value) {
    ObjectAttributes attributes = new ObjectAttributes();
    attributes.Length = Marshal.SizeOf(typeof(ObjectAttributes));
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyCreateSecret, out policy);
    if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    UnicodeString k = Make(key);
    UnicodeString v = Make(value);
    try {
      status = LsaStorePrivateData(policy, ref k, ref v);
      if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    } finally {
      Marshal.ZeroFreeGlobalAllocUnicode(v.Buffer);
      Marshal.FreeHGlobal(k.Buffer);
      LsaClose(policy);
    }
  }
  public static void Remove(string key) {
    ObjectAttributes attributes = new ObjectAttributes();
    attributes.Length = Marshal.SizeOf(typeof(ObjectAttributes));
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyCreateSecret, out policy);
    if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    UnicodeString k = Make(key);
    try {
      status = LsaRemovePrivateData(policy, ref k, IntPtr.Zero);
      if (status != 0 && status != StatusObjectNameNotFound) throw new Win32Exception(LsaNtStatusToWinError(status));
    } finally {
      Marshal.FreeHGlobal(k.Buffer);
      LsaClose(policy);
    }
  }
}
'@
}

# Winlogon reads the password from the LSA secret DefaultPassword; the registry value DefaultPassword is never written.
function Set-RpaSignInPassword([Security.SecureString]$Password) {
  if (-not $Password) { throw 'There is no password to store for automatic sign-in.' }
  Add-RpaLsaSecretType
  [RpaLsaSecret]::Store('DefaultPassword', (New-Object Net.NetworkCredential('', $Password)).Password)
}

function Enable-RpaAutoSignIn([hashtable]$Account) {
  Set-RpaRegistryValue $script:Winlogon 'AutoAdminLogon' 'REG_SZ' '1'
  Set-RpaRegistryValue $script:Winlogon 'ForceAutoLogon' 'REG_SZ' '1'
  Set-RpaRegistryValue $script:Winlogon 'DefaultUserName' 'REG_SZ' $Account.Name
  Set-RpaRegistryValue $script:Winlogon 'DefaultDomainName' 'REG_SZ' $Account.Domain
  Remove-ItemProperty -Path $script:WinlogonPath -Name 'DefaultPassword', 'AutoLogonCount' -ErrorAction SilentlyContinue
}

# Turns automatic sign-in off and removes the stored password, unless someone has pointed automatic sign-in at another
# account since the install. Returns whether it turned it off.
function Disable-RpaAutoSignIn([string]$UserName) {
  $current = (Get-ItemProperty -Path $script:WinlogonPath -Name 'DefaultUserName' -ErrorAction SilentlyContinue).DefaultUserName
  if ($current -ne $UserName) { return $false }
  Set-RpaRegistryValue $script:Winlogon 'AutoAdminLogon' 'REG_SZ' '0'
  Remove-ItemProperty -Path $script:WinlogonPath -Name 'ForceAutoLogon' -ErrorAction SilentlyContinue
  Add-RpaLsaSecretType
  [RpaLsaSecret]::Remove('DefaultPassword')
  $true
}

# Nothing may lock or cover the desktop: no lock screen, no inactivity lock, no screen saver, no Lock command, no
# Server Manager or network prompt at logon, display never off. The first group is for the whole machine. The user's
# own settings go into that user's registry: the loaded one when the user is signed in, the profile's file when there
# is a profile, and otherwise the default profile, which the user's profile is copied from at its first logon (and so
# is the profile of any user created later).
function Set-RpaDesktopUnlocked([string]$Sid) {
  $policies = 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  Set-RpaRegistryValue 'HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization' 'NoLockScreen' 'REG_DWORD' '1'
  Set-RpaRegistryValue $policies 'InactivityTimeoutSecs' 'REG_DWORD' '0'
  Set-RpaRegistryValue $policies 'EnableFirstLogonAnimation' 'REG_DWORD' '0'
  if (Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\ServerManager') {
    Set-RpaRegistryValue 'HKLM\SOFTWARE\Microsoft\ServerManager' 'DoNotOpenServerManagerAtLogon' 'REG_DWORD' '1'
  }
  Invoke-RpaNative reg.exe @('add', 'HKLM\SYSTEM\CurrentControlSet\Control\Network\NewNetworkWindowOff', '/f')
  Get-ScheduledTask -TaskName 'ServerManager' -ErrorAction SilentlyContinue | Disable-ScheduledTask | Out-Null
  Invoke-RpaNative powercfg.exe @('/change', 'monitor-timeout-ac', '0')
  Invoke-RpaNative powercfg.exe @('/change', 'standby-timeout-ac', '0')

  $root = 'HKU\{0}' -f $Sid
  $loadedHere = $false
  if (-not (Test-Path -LiteralPath ('Registry::HKEY_USERS\{0}' -f $Sid))) {
    $profileList = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
    $profileDir = (Get-ItemProperty -LiteralPath ('{0}\{1}' -f $profileList, $Sid) -ErrorAction SilentlyContinue).ProfileImagePath
    if (-not $profileDir -or -not (Test-Path -LiteralPath (Join-Path $profileDir 'NTUSER.DAT'))) {
      $profileDir = (Get-ItemProperty -LiteralPath $profileList).Default
      if (-not $profileDir) { $profileDir = Join-Path $env:SystemDrive 'Users\Default' }
    }
    $root = 'HKU\RpaBotUser'
    Invoke-RpaNative reg.exe @('load', $root, (Join-Path $profileDir 'NTUSER.DAT'))
    $loadedHere = $true
  }
  try {
    foreach ($key in "$root\Control Panel\Desktop", "$root\Software\Policies\Microsoft\Windows\Control Panel\Desktop") {
      Set-RpaRegistryValue $key 'ScreenSaveActive' 'REG_SZ' '0'
      Set-RpaRegistryValue $key 'ScreenSaverIsSecure' 'REG_SZ' '0'
    }
    Set-RpaRegistryValue "$root\Software\Microsoft\Windows\CurrentVersion\Policies\System" 'DisableLockWorkstation' 'REG_DWORD' '1'
  } finally {
    if ($loadedHere) { Invoke-RpaNative reg.exe @('unload', $root) }
  }
}

# install.json: what the start scripts, Show-RpaConnection.ps1 and the uninstaller read. autoSignIn stays true on an
# upgrade run without -AutoSignIn, because it records that the installer turned automatic sign-in on.
function Write-RpaInstallFile([hashtable]$Layout, [hashtable]$Account, [hashtable]$Parameters, [bool]$AutoSignIn) {
  $previous = Read-RpaInstallFile $Layout.InstallFile
  $install = [ordered]@{
    version     = ([string](Get-Content -LiteralPath (Join-Path $Layout.InstallDir 'VERSION') -TotalCount 1)).Trim()
    user        = $Account.Display
    runnerPort  = [int]$Parameters.RunnerPort
    browserPort = [int]$Parameters.BrowserPort
    browser     = -not $Parameters.NoBrowser
    autoSignIn  = $AutoSignIn -or [bool]($previous -and $previous.autoSignIn -eq $true)
  }
  [IO.File]::WriteAllText($Layout.InstallFile, ($install | ConvertTo-Json), $script:Utf8)
}

# Starts the tasks again in the bot user's session after an upgrade. When that user is not signed in nothing starts,
# and the tasks start at its next logon as always.
function Start-RpaTasks {
  foreach ($name in $script:RunnerTask, $script:BrowserTask) {
    try { Get-ScheduledTask -TaskPath $script:TaskPath -TaskName $name -ErrorAction SilentlyContinue | Start-ScheduledTask } catch { }
  }
}

# Runs exactly the steps of the plan, in order, and names each as it starts. -SourceDir is the unpacked package (the
# folder Install-Rpa.ps1 is in). What can be checked without changing anything is checked first.
function Invoke-RpaInstallPlan {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Plan,
    [Parameter(Mandatory = $true)][hashtable]$Parameters,
    [Parameter(Mandatory = $true)][string]$SourceDir
  )
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  if (@($Plan.Refusals).Count -gt 0) { throw 'The plan has refusals; nothing was changed.' }
  $steps = @($Plan.Steps)
  $layout = Get-RpaLayout
  $account = Get-RpaAccount -User $Parameters.User -ComputerName $env:COMPUTERNAME
  $runnerPort = [int]$Parameters.RunnerPort
  $browserPort = [int]$Parameters.BrowserPort
  $scripts = Join-Path $layout.InstallDir 'scripts'

  $source = (Resolve-Path -LiteralPath $SourceDir).ProviderPath.TrimEnd('\')
  if ($source -eq $layout.InstallDir) { throw 'Run Install-Rpa.ps1 from the unpacked package, not from the install directory.' }
  $needed = @('VERSION', 'runner\RpaRunner.exe', 'scripts\start-runner.ps1', 'scripts\Show-RpaConnection.ps1')
  if (-not $Parameters.NoBrowser) { $needed += 'browser\node.exe', 'browser\host\host.mjs', 'scripts\start-browser.ps1' }
  foreach ($file in $needed) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $file))) {
      throw ('{0} is missing from {1}. Unpack the whole package and run Install-Rpa.ps1 from that folder.' -f $file, $source)
    }
  }
  # The user's security identifier goes into permissions by number, so no name can be misread. A user that the plan
  # does not create must exist now (an upgrade keeps the user of the first install).
  $sid = $null
  if ($steps -notcontains 'create user') { $sid = Get-RpaSid $account }
  $password = $Parameters.UserPassword

  foreach ($step in $steps) {
    Write-Host ('  {0}' -f $step)
    try {
      switch ($step) {
        'stop running services' { Stop-RpaServices $layout.InstallDir }
        'copy program files' { Copy-RpaProgramFiles $source $layout.InstallDir }
        'create user' {
          $password = New-RpaUser $account $password
          $sid = Get-RpaSid $account
        }
        'protect the data directory' { Protect-RpaDataDirectory $layout $sid }
        'write policy' { New-RpaProtectedFile (Join-Path $layout.DataDir 'policy.json') $script:StarterPolicy $sid }
        'write token' { New-RpaProtectedFile (Join-Path $layout.DataDir 'token') (New-RpaSecret -Length 48) $sid }
        'write browser-token' { New-RpaProtectedFile (Join-Path $layout.DataDir 'browser-token') (New-RpaSecret -Length 48) $sid }
        'add the runner firewall rule' { Set-RpaFirewallRule $script:RunnerRule ('RPA desktop runner (TCP {0})' -f $runnerPort) $runnerPort }
        'add the browser firewall rule' { Set-RpaFirewallRule $script:BrowserRule ('RPA browser (TCP {0})' -f $browserPort) $browserPort }
        'remove the browser firewall rule' { Remove-NetFirewallRule -Name $script:BrowserRule -ErrorAction SilentlyContinue }
        'register the runner task' { Register-RpaTask $script:RunnerTask (Join-Path $scripts 'start-runner.ps1') $account.Qualified }
        'register the browser task' { Register-RpaTask $script:BrowserTask (Join-Path $scripts 'start-browser.ps1') $account.Qualified }
        'remove the browser task' { Unregister-RpaTask $script:BrowserTask }
        'store sign-in password' { Set-RpaSignInPassword $password }
        'turn on automatic sign-in' { Enable-RpaAutoSignIn $account }
        'keep the desktop unlocked' { Set-RpaDesktopUnlocked $sid }
        'write install.json' { Write-RpaInstallFile $layout $account $Parameters ($steps -contains 'turn on automatic sign-in') }
        'start tasks' { Start-RpaTasks }
        default { throw 'The installer has no such step.' }
      }
    } catch {
      throw ('The step "{0}" failed: {1}' -f $step, $_.Exception.Message)
    }
  }
}

# What Uninstall-Rpa.ps1 does: removes the tasks, the firewall rules and the install directory, and turns automatic
# sign-in off only when install.json says the installer turned it on. The data directory goes only with -RemoveData;
# the Windows user is never removed. Returns what the uninstaller reports: the user, and whether automatic sign-in was
# on and whether it was turned off.
function Invoke-RpaUninstall {
  param([switch]$RemoveData)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $layout = Get-RpaLayout
  $install = Read-RpaInstallFile $layout.InstallFile
  $result = @{ User = $null; AutoSignIn = $false; AutoSignInOff = $false; Layout = $layout }
  if ($install) {
    $result.User = [string]$install.user
    $result.AutoSignIn = $install.autoSignIn -eq $true
  }

  Write-Host '  stop running services'
  Stop-RpaServices $layout.InstallDir
  Write-Host '  remove the tasks'
  Unregister-RpaTask $script:RunnerTask
  Unregister-RpaTask $script:BrowserTask
  # The \RPA\ task folder goes too when nothing else is in it.
  try {
    $scheduler = New-Object -ComObject Schedule.Service
    $null = $scheduler.Connect()
    $null = $scheduler.GetFolder('\').DeleteFolder($script:TaskPath.Trim('\'), 0)
  } catch { }
  Write-Host '  remove the firewall rules'
  Remove-NetFirewallRule -Name $script:RunnerRule, $script:BrowserRule -ErrorAction SilentlyContinue
  if ($result.AutoSignIn) {
    Write-Host '  turn off automatic sign-in'
    $account = Get-RpaAccount -User $result.User -ComputerName $env:COMPUTERNAME
    $result.AutoSignInOff = Disable-RpaAutoSignIn $account.Name
  }
  Write-Host '  remove the program files'
  # A folder that is someone's current directory cannot be removed, and the uninstaller may be run from inside it.
  if ((Get-Location).ProviderPath.StartsWith($layout.InstallDir, [StringComparison]::OrdinalIgnoreCase)) { Set-Location -LiteralPath $env:SystemRoot }
  if ([Environment]::CurrentDirectory.StartsWith($layout.InstallDir, [StringComparison]::OrdinalIgnoreCase)) { [Environment]::CurrentDirectory = $env:SystemRoot }
  if (Test-Path -LiteralPath $layout.InstallDir) { Remove-Item -LiteralPath $layout.InstallDir -Recurse -Force }
  if ($RemoveData -and (Test-Path -LiteralPath $layout.DataDir)) {
    Write-Host '  remove the data directory'
    Remove-Item -LiteralPath $layout.DataDir -Recurse -Force
  }
  $result
}

Export-ModuleMember -Function Get-RpaInstallPlan, New-RpaSecret, Get-RpaAccount, Get-RpaLayout, Test-RpaAdministrator, Get-RpaMachineFacts, Invoke-RpaInstallPlan, Invoke-RpaUninstall
