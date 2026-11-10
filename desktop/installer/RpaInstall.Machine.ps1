# The installer's module, third of three files (RpaInstall.psd1 loads them into one module): what looks at and changes
# the machine, for Windows PowerShell 5.1. The facts the two plans judge, the data directory, the firewall rules, the
# scheduled tasks, the steps of an install, and the uninstall. Everything here runs on Windows only.
#
# The scheduled task settings and the access rules of the data directory come from the AWS test bed's first-boot
# script (deploy/terraform/modules/aws-ec2-desktop-runner/setup.ps1.tftpl).

$script:RunnerTask = 'RPA Runner'
$script:BrowserTask = 'RPA Browser'
$script:RunnerRule = 'RPA-Runner-In'
$script:BrowserRule = 'RPA-Browser-In'
$script:StarterPolicy = '{ "allowedApps": [], "maxFileBytes": 20971520 }'
$script:Utf8 = New-Object Text.UTF8Encoding $false
# Administrators and SYSTEM: the only owners the installer accepts for what it finds in the data directory.
$script:TrustedOwners = @('S-1-5-32-544', 'S-1-5-18')
$script:KnownSteps = @(
  'stop running services', 'copy program files', 'create user', 'protect the data directory', 'write policy',
  'write token', 'write browser-token', 'add the runner firewall rule', 'add the browser firewall rule',
  'remove the browser firewall rule', 'register the runner task', 'register the browser task',
  'remove the browser task', 'write install.json', 'store sign-in password', 'turn on automatic sign-in',
  'keep the desktop unlocked', 'start tasks')

# Where things are: the same paths as the test bed. Program Files keeps its default permissions (users read and run,
# only administrators change), so the bot user cannot replace what it runs.
function Get-RpaLayout {
  $installDir = Join-Path $env:ProgramFiles 'RPA Runner'
  $dataDir = Join-Path $env:ProgramData 'RPA Runner'
  @{
    InstallDir    = $installDir
    InstallFile   = Join-Path $installDir 'install.json'
    # What an uninstall could not put back. Under Program Files, where only administrators can create anything, and
    # not in the data directory, which -RemoveData removes.
    LeftoversFile = Join-Path $installDir 'uninstall-leftovers.json'
    DataDir       = $dataDir
    LogDir        = Join-Path $dataDir 'logs'
    BackupsDir    = Join-Path $dataDir 'policy-backups'
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

function Get-RpaAccountName([Security.Principal.SecurityIdentifier]$Sid) {
  try { $Sid.Translate([Security.Principal.NTAccount]).Value } catch { $Sid.Value }
}

# What is at a path, without following it: whether anything is there, whether it is a link or junction (a reparse
# point) or a folder, how many names it has (a file with more than one is hard linked), and who owns it. An owner
# that cannot be read is not trusted.
function Get-RpaPathState([string]$Path) {
  $state = @{ Exists = $false; IsLink = $false; IsFolder = $false; Links = 0; OwnerTrusted = $false; Owner = '' }
  try { $attributes = [IO.File]::GetAttributes($Path) }
  catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { return $state }
    throw
  }
  $state.Exists = $true
  $state.IsLink = [bool]($attributes -band [IO.FileAttributes]::ReparsePoint)
  $state.IsFolder = [bool]($attributes -band [IO.FileAttributes]::Directory)
  $state.Links = 1
  if (-not $state.IsFolder) {
    Add-RpaNativeTypes
    $state.Links = [RpaFiles]::LinkCount($Path)
  }
  try {
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier])
    $state.OwnerTrusted = $script:TrustedOwners -contains $owner.Value
    $state.Owner = Get-RpaAccountName $owner
  } catch { $state.Owner = 'someone whose name cannot be read' }
  $state
}

# The owner a security descriptor names when that is not Administrators or SYSTEM, else nothing.
function Get-RpaForeignOwner([string]$Sddl) {
  $security = New-Object Security.AccessControl.RawSecurityDescriptor $Sddl
  if (-not $security.Owner -or $script:TrustedOwners -contains $security.Owner.Value) { return $null }
  Get-RpaAccountName $security.Owner
}

# The owner of the scheduled task folder when it is there and that owner is not Administrators or SYSTEM, else nothing.
function Get-RpaTaskFolderOwner {
  $scheduler = New-Object -ComObject Schedule.Service
  $null = $scheduler.Connect()
  try { $sddl = [string]$scheduler.GetFolder($script:TaskPath.TrimEnd('\')).GetSecurityDescriptor(1) } catch { return $null }
  Get-RpaForeignOwner $sddl
}

# The owner of a task in the scheduled task folder when that owner is not Administrators or SYSTEM, else nothing. It
# is asked about a task that was just registered, so a task that cannot be read counts as someone else's.
function Get-RpaTaskOwner([string]$Name) {
  $scheduler = New-Object -ComObject Schedule.Service
  $null = $scheduler.Connect()
  try { $sddl = [string]$scheduler.GetFolder($script:TaskPath.TrimEnd('\')).GetTask($Name).GetSecurityDescriptor(1) }
  catch { return 'someone whose name cannot be read' }
  Get-RpaForeignOwner $sddl
}

# What is in the data directory, read without entering a link:
#   Link        the first link or junction, or file with a second name (a hard link), or nothing
#   Unreadable  the first folder that could not be listed, or file whose number of names could not be read, with its
#               owner's name (Path, Owner), or nothing. The bot user can make a folder that administrators cannot
#               list, and an entry can go away between the listing and the read. What is inside is then not known.
#   Owners      for each owner other than Administrators and SYSTEM: its SID and name, how many entries it owns
#               (Number), the first of them (First) and when the walk met it (Order)
#   Backups     the same for what is inside policy-backups\, where only Administrators and SYSTEM may own anything
#   Accounts    every owner other than Administrators and SYSTEM of anything in the tree, as SID = name
# policy.json, the tokens and the folder policy-backups\ are judged under their own names by the plan and are not
# counted in Owners; logs\ itself is taken over whoever owns it. An owner that cannot be read counts as an account
# without a SID.
function Get-RpaDataEntries([string]$DataDir) {
  Add-RpaNativeTypes
  $unknown = 'someone whose name cannot be read'
  $result = @{ Link = $null; Unreadable = $null; Owners = @(); Backups = @(); Accounts = @{} }
  $owners = [ordered]@{}
  $backups = [ordered]@{}
  $order = 0
  $pending = New-Object Collections.Generic.Stack[object]
  $pending.Push(@{ Path = $DataDir; InBackups = $false; Owner = $unknown })
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    try { $entries = @((New-Object IO.DirectoryInfo ('\\?\' + $directory.Path)).EnumerateFileSystemInfos()) }
    catch {
      if (-not $result.Unreadable) { $result.Unreadable = @{ Path = $directory.Path; Owner = $directory.Owner } }
      continue
    }
    foreach ($entry in $entries) {
      $order++
      $path = Join-Path $directory.Path $entry.Name
      $isLink = [bool]($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)
      $isFolder = [bool]($entry.Attributes -band [IO.FileAttributes]::Directory)
      $top = $directory.Path -eq $DataDir
      # Judged under its own name by the plan.
      $named = $top -and ((@($script:DataFiles.Keys) + 'policy-backups' + 'logs') -contains $entry.Name)
      $sid = ''
      $name = $unknown
      $trusted = $false
      try {
        if ($isFolder) { $security = [IO.Directory]::GetAccessControl('\\?\' + $path, 'Owner') } else { $security = [IO.File]::GetAccessControl('\\?\' + $path, 'Owner') }
        $owner = $security.GetOwner([Security.Principal.SecurityIdentifier])
        $sid = $owner.Value
        $trusted = $script:TrustedOwners -contains $sid
        $name = Get-RpaAccountName $owner
      } catch { $trusted = $false }
      if (-not $trusted -and $sid) { $result.Accounts[$sid] = $name }
      if ($isLink) {
        if (-not $named -and -not $result.Link) { $result.Link = @{ Path = $path; IsLink = $true; Links = 1 } }
        continue
      }
      if (-not $named) {
        if (-not $trusted) {
          $list = $owners
          if ($directory.InBackups) { $list = $backups }
          if (-not $list.Contains($sid)) { $list[$sid] = @{ Sid = $sid; Name = $name; Number = 0; First = $path; Order = $order } }
          $list[$sid].Number++
        }
        if (-not $isFolder) {
          $links = 0
          try { $links = [RpaFiles]::LinkCount($path) }
          catch { if (-not $result.Unreadable) { $result.Unreadable = @{ Path = $path; Owner = $name } } }
          if ($links -gt 1 -and -not $result.Link) { $result.Link = @{ Path = $path; IsLink = $false; Links = $links } }
        }
      }
      if ($isFolder) { $pending.Push(@{ Path = $path; InBackups = ($directory.InBackups -or ($top -and $entry.Name -eq 'policy-backups')); Owner = $name }) }
    }
  }
  $result.Owners = @($owners.Values)
  $result.Backups = @($backups.Values)
  $result
}

# The facts Get-RpaInstallPlan judges. Changes nothing.
function Get-RpaMachineFacts {
  param([Parameter(Mandatory = $true)][hashtable]$Parameters)
  $ErrorActionPreference = 'Stop'
  $layout = Get-RpaLayout
  $account = Get-RpaAccount -User $Parameters.User -ComputerName $env:COMPUTERNAME
  $facts = @{
    IsAdmin                    = Test-RpaAdministrator
    Is64Bit                    = [Environment]::Is64BitOperatingSystem
    OsBuild                    = [Environment]::OSVersion.Version.Build
    UserExists                 = $false
    UserIsDomain               = $account.IsDomain
    UserIsAdmin                = $false
    UserAdminUnknown           = $false
    UserPasswordExpires        = $false
    UserPasswordWrong          = $false
    UserPasswordProblem        = $null
    PortsInUse                 = @{}
    Installed                  = Test-Path -LiteralPath $layout.InstallFile
    InstalledRunnerPort        = $null
    InstalledBrowserPort       = $null
    InstalledBrowser           = $false
    InstalledAllowFrom         = $null
    InstalledPublicNetwork     = $false
    InstalledAutoSignInForUser = $false
    InstalledAutoSignInUser    = $null
    InstalledUser              = $null
    InstalledForUser           = $false
    UserSid                    = $null
    RunnerRunning              = $false
    DataDir                    = $layout.DataDir
    LogDir                     = $layout.LogDir
    PolicyBackupsDir           = $layout.BackupsDir
    DataDirState               = $null
    LogDirState                = $null
    PolicyBackupsState         = $null
    DataDirEntries             = $null
    DataFiles                  = @{}
    TaskFolderOwner            = $null
    PublicNetwork              = $false
    Leftovers                  = $null
  }
  # The plan refuses on these before it reads the rest, and an older Windows lacks the commands used below.
  if (-not $facts.IsAdmin -or -not $facts.Is64Bit -or $facts.OsBuild -lt $script:MinimumBuild) { return $facts }

  # The installed runner only: a runner someone runs from another folder is not touched by an upgrade.
  $runner = Join-Path (Join-Path $layout.InstallDir 'runner') 'RpaRunner.exe'
  $facts.RunnerRunning = [bool](Get-CimInstance -ClassName Win32_Process -Filter "Name='RpaRunner.exe'" | Where-Object { $_.ExecutablePath -eq $runner })

  $install = Read-RpaInstallFile $layout.InstallFile
  if ($install) {
    $facts.InstalledRunnerPort = [int]$install.runnerPort
    $facts.InstalledBrowserPort = [int]$install.browserPort
    $facts.InstalledBrowser = $install.browser -eq $true
    if ($install.allowFrom) { $facts.InstalledAllowFrom = @($install.allowFrom) }
    $facts.InstalledPublicNetwork = $install.publicNetwork -eq $true
    # The user the install was made for and the user automatic sign-in was turned on for by the installer, and
    # whether that is the user of this run.
    $facts.InstalledUser = [string]$install.user
    $facts.InstalledForUser = [string]$install.user -eq $account.Display
    if ($install.autoSignIn -eq $true) { $facts.InstalledAutoSignInUser = [string]$install.user }
    $facts.InstalledAutoSignInForUser = ($install.autoSignIn -eq $true) -and $facts.InstalledForUser
  }

  if ($account.IsDomain) {
    try {
      [void](New-Object Security.Principal.NTAccount($account.Qualified)).Translate([Security.Principal.SecurityIdentifier])
      $facts.UserExists = $true
    } catch { $facts.UserExists = $false }
    if ($facts.UserExists) {
      # 0x10000: the account's "password never expires" flag. When the directory does not say, no warning.
      try {
        $flags = ([ADSI]('WinNT://{0}/{1},user' -f $account.Domain, $account.Name)).UserFlags.Value
        if ($null -ne $flags) { $facts.UserPasswordExpires = -not ([int]$flags -band 0x10000) }
      } catch { $facts.UserPasswordExpires = $false }
    }
  } else {
    $local = Get-LocalUser -Name $account.Name -ErrorAction SilentlyContinue
    if ($local) {
      $facts.UserExists = $true
      $facts.UserPasswordExpires = $null -ne $local.PasswordExpires
    }
  }
  if ($facts.UserExists) {
    Add-RpaNativeTypes
    $facts.UserSid = Get-RpaSid $account
    # A member of Administrators, directly or through a group that is a member.
    try {
      $administrators = ((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value -split '\\')[-1]
      $name = $account.Name
      if ($account.IsDomain) { $name = $account.Qualified }
      $facts.UserIsAdmin = @([RpaAccounts]::LocalGroups($name)) -contains $administrators
    } catch { $facts.UserAdminUnknown = $true }
    # A password that would be stored for automatic sign-in is tried first. 1326 is Windows' "the user name or
    # password is incorrect"; 1385 means the password is right and only this kind of logon is not allowed.
    if ($Parameters.AutoSignIn -and $Parameters.UserPassword) {
      $domain = '.'
      if ($account.IsDomain) { $domain = $account.Domain }
      $code = [RpaAccounts]::CheckPassword($domain, $account.Name, $Parameters.UserPassword)
      if ($code -eq 1326) { $facts.UserPasswordWrong = $true }
      elseif ($code -ne 0 -and $code -ne 1385) { $facts.UserPasswordProblem = (New-Object ComponentModel.Win32Exception $code).Message }
    }
  }

  foreach ($port in @([int]$Parameters.RunnerPort, [int]$Parameters.BrowserPort)) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
      if ($process) { $facts.PortsInUse[$port] = $process.ProcessName } else { $facts.PortsInUse[$port] = 'process {0}' -f $listener.OwningProcess }
    }
  }

  $facts.DataDirState = Get-RpaPathState $layout.DataDir
  $facts.LogDirState = Get-RpaPathState $layout.LogDir
  $facts.PolicyBackupsState = Get-RpaPathState $layout.BackupsDir
  foreach ($name in $script:DataFiles.Keys) { $facts.DataFiles[$name] = Get-RpaPathState (Join-Path $layout.DataDir $name) }
  # Everything else that is in a data directory that is there already.
  if ($facts.DataDirState.Exists -and -not $facts.DataDirState.IsLink -and $facts.DataDirState.OwnerTrusted) {
    $facts.DataDirEntries = Get-RpaDataEntries $layout.DataDir
  }
  $facts.Leftovers = @{ File = $layout.LeftoversFile; State = (Read-RpaLeftovers $layout.LeftoversFile).State }
  $facts.TaskFolderOwner = Get-RpaTaskFolderOwner
  $facts.PublicNetwork = [bool](Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
  $facts
}

# The full path of a tool that ships with Windows (icacls, reg, powercfg, robocopy, cmd). The installer runs as an
# administrator, so it does not look these up along PATH, where a folder other users can write to may come first.
function Get-RpaSystemTool([string]$Name) {
  Join-Path ([Environment]::SystemDirectory) $Name
}

# Runs a Windows tool and fails when its exit code says so, with what the tool wrote. What a tool writes to its error
# stream does not end the run by itself (it would, when the installer's output is redirected). No secret is ever an
# argument of one of these tools.
function Invoke-RpaNative([string]$Exe, [string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  $tool = Get-RpaSystemTool $Exe
  $output = @(& $tool @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    # An empty line a tool writes to its error stream arrives as an error record that shows only its type's name.
    $said = (@($output | ForEach-Object { "$_".Trim() } | Where-Object { $_ -and $_ -ne 'System.Management.Automation.RemoteException' }) -join ' ')
    throw ('{0} {1} failed with exit code {2}: {3}' -f $Exe, $Arguments[0], $LASTEXITCODE, $said)
  }
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

# Deletes a folder and everything in it with cmd's rd, which removes a link or junction inside without entering it
# (Remove-Item in Windows PowerShell 5.1 enters it and deletes what it points at). The \\?\ form lets rd reach paths
# longer than 260 characters. A folder that is itself a link is refused. rd reports success also when it left
# something behind, so the result is checked.
function Remove-RpaTree([string]$Path) {
  $state = Get-RpaPathState $Path
  if (-not $state.Exists) { return }
  if ($state.IsLink) { throw ('{0} is a link or junction. Remove it and run this again.' -f $Path) }
  # What rd writes about a file it could not delete must not end this function; the check below decides.
  $ErrorActionPreference = 'Continue'
  & (Get-RpaSystemTool 'cmd.exe') /d /c ('rd /s /q "\\?\{0}"' -f $Path) 2>&1 | Out-Null
  if ((Get-RpaPathState $Path).Exists) { throw ('Could not remove {0}. Close what is using it and run this again.' -f $Path) }
}

# Replaces each file and folder of the package in the install directory. install.json is not in the package, so an
# upgrade keeps it. Folders are copied with robocopy, which copies paths longer than 260 characters (Copy-Item in
# Windows PowerShell 5.1 does not) and takes the destination folder's access rules for what it writes.
function Copy-RpaProgramFiles([string]$SourceDir, [string]$InstallDir) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $SourceDir -Force) {
    $target = Join-Path $InstallDir $item.Name
    if ($item.PSIsContainer) {
      Remove-RpaTree $target
      & (Get-RpaSystemTool 'robocopy.exe') $item.FullName $target /E /XJ /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
      # robocopy: 8 and above mean that something was not copied.
      if ($LASTEXITCODE -ge 8) { throw ('Could not copy {0} (robocopy exit code {1}).' -f $item.Name, $LASTEXITCODE) }
    } else {
      Copy-Item -LiteralPath $item.FullName -Destination $target -Force
    }
  }
}

# The compiled helpers: the LSA secret Windows itself reads the automatic sign-in password from (Store is the test
# bed's; Remove passes no data, which deletes the secret), a password check, the local groups of a user, the creation
# of a user's profile, the account a process runs as, the number of names a file has, and the creation of a file that follows no link. A password
# goes in as a SecureString and is turned into plain text only in unmanaged memory that is wiped afterwards.
function Add-RpaNativeTypes {
  if ('RpaLsaSecret' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class RpaFiles {
  [StructLayout(LayoutKind.Sequential)]
  struct FileInformation {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Created;
    public System.Runtime.InteropServices.ComTypes.FILETIME Accessed;
    public System.Runtime.InteropServices.ComTypes.FILETIME Written;
    public uint VolumeSerialNumber; public uint SizeHigh; public uint SizeLow; public uint NumberOfLinks; public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
  [StructLayout(LayoutKind.Sequential)]
  struct SecurityAttributes { public int Length; public IntPtr Descriptor; public bool Inherit; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFile")]
  static extern SafeFileHandle CreateFileSecured(string name, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  // Creates a file that is not there yet, with its owner and access rules (SDDL) from the first moment, and writes
  // its content. Nothing may be at the path: a file, a folder or a link there makes this fail. A link is not
  // followed (FILE_FLAG_OPEN_REPARSE_POINT), so no file appears where a link points.
  public static void CreateNew(string path, string sddl, byte[] content) {
    IntPtr descriptor;
    uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      SecurityAttributes security = new SecurityAttributes();
      security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
      security.Descriptor = descriptor;
      using (SafeFileHandle handle = CreateFileSecured(@"\\?\" + path, 0x40000000, 0, ref security, 1, 0x80 | 0x00200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        using (System.IO.FileStream stream = new System.IO.FileStream(handle, System.IO.FileAccess.Write)) { stream.Write(content, 0, content.Length); }
      }
    } finally {
      LocalFree(descriptor);
    }
  }
  // How many names a file has; more than one means it is hard linked. A link at the path is opened itself, not
  // followed, and only the file's attributes are read.
  public static int LinkCount(string path) {
    using (SafeFileHandle handle = CreateFile(@"\\?\" + path, 0x80, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInformation information;
      if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return (int)information.NumberOfLinks;
    }
  }
}
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
  static IntPtr Open() {
    ObjectAttributes attributes = new ObjectAttributes();
    attributes.Length = Marshal.SizeOf(typeof(ObjectAttributes));
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyCreateSecret, out policy);
    if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    return policy;
  }
  public static void Store(string key, SecureString value) {
    IntPtr policy = Open();
    UnicodeString k = Make(key);
    UnicodeString v = new UnicodeString();
    v.Buffer = Marshal.SecureStringToGlobalAllocUnicode(value);
    v.Length = (ushort)(value.Length * 2);
    v.MaximumLength = (ushort)(value.Length * 2 + 2);
    try {
      uint status = LsaStorePrivateData(policy, ref k, ref v);
      if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    } finally {
      Marshal.ZeroFreeGlobalAllocUnicode(v.Buffer);
      Marshal.FreeHGlobal(k.Buffer);
      LsaClose(policy);
    }
  }
  public static void Remove(string key) {
    IntPtr policy = Open();
    UnicodeString k = Make(key);
    try {
      uint status = LsaRemovePrivateData(policy, ref k, IntPtr.Zero);
      if (status != 0 && status != StatusObjectNameNotFound) throw new Win32Exception(LsaNtStatusToWinError(status));
    } finally {
      Marshal.FreeHGlobal(k.Buffer);
      LsaClose(policy);
    }
  }
}
public static class RpaAccounts {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LogonUser(string user, string domain, IntPtr password, int logonType, int logonProvider, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
  static extern int NetUserGetLocalGroups(string server, string user, int level, int flags, out IntPtr buffer, int preferredLength, out int entriesRead, out int totalEntries);
  [DllImport("netapi32.dll")] static extern int NetApiBufferFree(IntPtr buffer);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int CreateProfile(string sid, string userName, StringBuilder path, uint pathLength);
  const int LogonNetwork = 3;
  const int IncludeIndirect = 1;
  const int ProfileExists = unchecked((int)0x800700B7);
  // 0 when Windows accepts the password for a network logon, else the Windows error code. Nothing is started.
  public static int CheckPassword(string domain, string user, SecureString password) {
    IntPtr plain = Marshal.SecureStringToGlobalAllocUnicode(password);
    try {
      IntPtr token;
      if (LogonUser(user, domain, plain, LogonNetwork, 0, out token)) { CloseHandle(token); return 0; }
      return Marshal.GetLastWin32Error();
    } finally {
      Marshal.ZeroFreeGlobalAllocUnicode(plain);
    }
  }
  // The local groups a user is in, directly or through a group that is a member of one.
  public static string[] LocalGroups(string user) {
    IntPtr buffer;
    int read;
    int total;
    int status = NetUserGetLocalGroups(null, user, 0, IncludeIndirect, out buffer, -1, out read, out total);
    if (status != 0) throw new Win32Exception(status);
    try {
      string[] names = new string[read];
      for (int i = 0; i < read; i++) names[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, i * IntPtr.Size));
      return names;
    } finally {
      NetApiBufferFree(buffer);
    }
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessBasicInformation { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int informationClass, out ProcessBasicInformation information, int length, out int returned);
  const uint ProcessQueryLimitedInformation = 0x1000;
  const uint TokenQuery = 0x8;
  const int NoSuchProcess = 87;
  // The SID of the account a process runs as, read from the process's token. An empty text for a process that has
  // ended, and for one of Windows' kernel that runs no program (it has no memory for one: System, Registry, ...),
  // whose token an administrator may not read. Nothing when Windows does not say: the process cannot be opened, or
  // its token cannot (a process can take Administrators and SYSTEM off its token's access rules).
  public static string ProcessOwner(int id) {
    IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, id);
    if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == NoSuchProcess ? "" : null;
    try {
      IntPtr token;
      if (OpenProcessToken(process, TokenQuery, out token)) {
        try { using (System.Security.Principal.WindowsIdentity identity = new System.Security.Principal.WindowsIdentity(token)) { return identity.User.Value; } }
        finally { CloseHandle(token); }
      }
      ProcessBasicInformation basic;
      int returned;
      if (NtQueryInformationProcess(process, 0, out basic, Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned) == 0 && basic.PebBaseAddress == IntPtr.Zero) return "";
      return null;
    } finally {
      CloseHandle(process);
    }
  }
  // Makes the profile of a user that has never signed in. A profile that is there already is left alone.
  public static void CreateUserProfile(string sid, string userName) {
    StringBuilder path = new StringBuilder(260);
    int result = CreateProfile(sid, userName, path, (uint)path.Capacity);
    if (result != 0 && result != ProfileExists) Marshal.ThrowExceptionForHR(result);
  }
}
'@
}

# A standard local user (member of Users only) whose password never expires. Without -UserPassword the password is
# random, is made here and is only ever stored for automatic sign-in (the plan refuses a new user with neither).
# Returns the password as a SecureString for that step.
function New-RpaUser([hashtable]$Account, [Security.SecureString]$Password) {
  if (-not $Password) {
    # Windows' complexity rule also refuses a password that holds a part of the account's own name.
    $parts = @($Account.Name -split '[^A-Za-z0-9]')
    do {
      $plain = New-RpaSecret -Length 32
      $clash = $false
      foreach ($part in $parts) {
        if ($part.Length -ge 3 -and $plain.IndexOf($part, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $clash = $true }
      }
    } while ($clash)
    $Password = New-Object Security.SecureString
    foreach ($char in $plain.ToCharArray()) { $Password.AppendChar($char) }
    $Password.MakeReadOnly()
    $plain = $null
  }
  New-LocalUser -Name $Account.Name -Password $Password -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -FullName 'RPA Runner' -Description 'Runs the RPA desktop runner and browser' | Out-Null
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $Account.Name -ErrorAction SilentlyContinue
  $Password
}

# Removes a user this run created, with the profile a sign-in step may have made for it.
function Remove-RpaUser([hashtable]$Account, [string]$Sid) {
  Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID='{0}'" -f $Sid) -ErrorAction SilentlyContinue | Remove-CimInstance -ErrorAction SilentlyContinue
  Remove-LocalUser -Name $Account.Name
}

# The access rules of the data directory, in the form Windows writes them (SDDL), each protected from inheriting:
#   the directory  SYSTEM and Administrators in full; the bot user may read, and create files and folders (the
#                  certificates, exports\), which it then owns; it cannot change or delete what it did not create
#   logs\          the same, and the bot user may change and delete what is in it
#   a file         SYSTEM and Administrators in full; the bot user may read (policy.json and the tokens)
#   backups        SYSTEM and Administrators in full and nobody else (policy-backups\, which the policy tool uses);
#                  the same for a file only administrators may read (the list the uninstaller leaves)
# The first three give the same rights as the test bed's icacls commands. Administrators own all of them: the runner refuses a
# policy whose file or folder anyone else owns.
function Get-RpaAccessRules([string]$Kind, [string]$Sid) {
  switch ($Kind) {
    'directory' { 'D:PAI(A;OICIIO;FA;;;CO)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;{0})(A;;DCLC;;;{0})' -f $Sid }
    'logs' { 'D:PAI(A;OICIIO;FA;;;CO)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;{0})' -f $Sid }
    'file' { 'D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{0})' -f $Sid }
    'backups' { 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' }
    'administrators file' { 'D:PAI(A;;FA;;;SY)(A;;FA;;;BA)' }
  }
}

# Gives something that is already there its owner (Administrators) and its access rules, replacing the rules whole:
# an entry someone added for itself is gone afterwards. icacls /restore is the one icacls form that replaces instead
# of merging. With /L icacls works on a link itself, not on what it points at, should one be swapped in after the
# checks. The rules file is written to the install directory, which only administrators can write to.
function Set-RpaAccessRules([string]$Path, [string]$Rules, [string]$WorkDir) {
  $file = Join-Path $WorkDir ('access-{0}.tmp' -f [guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllText($file, ("{0}`r`n{1}`r`n" -f (Split-Path -Leaf $Path), $Rules), [Text.Encoding]::Unicode)
  try {
    Invoke-RpaNative icacls.exe @($Path, '/setowner', '*S-1-5-32-544', '/L')
    Invoke-RpaNative icacls.exe @((Split-Path -Parent $Path), '/restore', $file, '/L')
  } finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

# Looks again, just before it is used, at something the plan already judged: the facts can be minutes old.
function Assert-RpaPathUsable([string]$Path, [bool]$CheckOwner) {
  $refusal = Get-RpaPathRefusal $Path (Get-RpaPathState $Path) $CheckOwner
  if ($refusal) { throw $refusal }
}

# A folder that is missing is created in one call with its owner (Administrators) and its access rules, so there is
# no moment in which it has others.
function New-RpaProtectedFolder([string]$Path, [string]$Rules) {
  if ((Get-RpaPathState $Path).Exists) { return }
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetSecurityDescriptorSddlForm('O:BA' + $Rules)
  [void][IO.Directory]::CreateDirectory($Path, $security)
}

# %ProgramData%\RPA Runner, logs\ and policy-backups\. One that is missing is created with its owner and rules. One
# that is there is used only when it is no link and, for the data directory and policy-backups\, Administrators or
# SYSTEM own it; the rules of the data directory and of logs\ are then replaced, and policy-backups\ is left to the
# policy tool. With -Judge (the user of the install is new to the data directory) everything that was in it already
# is looked at again, once only administrators and the bot user can put anything into it; -OwnSid is that user when
# it was there before this run. policy.json and the tokens get their rules again on every run, which also gives
# another -User its read access.
function Protect-RpaDataDirectory([hashtable]$Layout, [string]$Sid, [bool]$Judge, [string]$OwnSid) {
  foreach ($folder in @(@{ Path = $Layout.DataDir; Kind = 'directory'; CheckOwner = $true }, @{ Path = $Layout.LogDir; Kind = 'logs'; CheckOwner = $false })) {
    $rules = Get-RpaAccessRules $folder.Kind $Sid
    New-RpaProtectedFolder $folder.Path $rules
    # Also after creating it: CreateDirectory does not say when someone else made the folder a moment earlier.
    Assert-RpaPathUsable $folder.Path $folder.CheckOwner
    Set-RpaAccessRules $folder.Path $rules $Layout.InstallDir
    if ($Judge -and $folder.Kind -eq 'directory') {
      $refusals = @(Get-RpaDataEntryRefusals $Layout.DataDir (Get-RpaDataEntries $Layout.DataDir) $OwnSid)
      if ($refusals.Count -gt 0) { throw $refusals[0] }
    }
  }
  New-RpaProtectedFolder $Layout.BackupsDir (Get-RpaAccessRules 'backups' $Sid)
  Assert-RpaPathUsable $Layout.BackupsDir $true
  foreach ($name in $script:DataFiles.Keys) {
    $path = Join-Path $Layout.DataDir $name
    if (-not (Get-RpaPathState $path).Exists) { continue }
    Assert-RpaPathUsable $path $true
    Set-RpaAccessRules $path (Get-RpaAccessRules 'file' $Sid) $Layout.InstallDir
  }
}

# Writes a new file the bot user may only read (or, with -AdministratorsOnly, nobody but SYSTEM and Administrators):
# created with its owner and access rules in one call, and only when nothing is there (a file someone put there in
# the meantime makes this fail). A link in the file's place is refused, and the create does not follow one that gets
# there after that look: an ordinary create would make the file where a symbolic link points. With -SecretLength the
# content is a new secret made here; the text is UTF-8 without a byte order mark and without a line break at the end.
function New-RpaProtectedFile {
  param([string]$Path, [string]$Sid, [string]$Text, [int]$SecretLength, [switch]$AdministratorsOnly)
  $rules = Get-RpaAccessRules 'file' $Sid
  if ($AdministratorsOnly) { $rules = Get-RpaAccessRules 'administrators file' '' }
  if ((Get-RpaPathState $Path).IsLink) { throw ('{0} is a link or junction. Remove it and run the installer again.' -f $Path) }
  if ($SecretLength -gt 0) { $Text = New-RpaSecret -Length $SecretLength }
  Add-RpaNativeTypes
  try { [RpaFiles]::CreateNew($Path, 'O:BA' + $rules, $script:Utf8.GetBytes($Text)) }
  catch { throw ('{0} could not be created: {1}' -f $Path, $_.Exception.GetBaseException().Message) }
}

# The kinds of network a firewall rule applies on, as Windows names them.
function Get-RpaFirewallProfiles([bool]$PublicNetwork) {
  if ($PublicNetwork) { return @('Domain', 'Private', 'Public') }
  @('Domain', 'Private')
}

# Inbound, for the one program on the one port, from the given addresses only (or from any), on Domain and Private
# networks, and on Public networks too with -PublicNetwork.
function Set-RpaFirewallRule([string]$Name, [string]$DisplayName, [int]$Port, [string]$Program, [string[]]$AllowFrom, [bool]$PublicNetwork) {
  Remove-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue
  $remote = $AllowFrom
  if (@($AllowFrom).Count -eq 1 -and $AllowFrom[0] -eq 'any') { $remote = 'Any' }
  New-NetFirewallRule -Name $Name -DisplayName $DisplayName -Direction Inbound -Protocol TCP -LocalPort $Port -Program $Program -RemoteAddress $remote -Action Allow -Profile (Get-RpaFirewallProfiles $PublicNetwork) | Out-Null
}

# Windows PowerShell by its full path. A scheduled task finds a bare powershell.exe along PATH when the bot user signs
# in, and a folder another user can write to may come first there.
function Get-RpaWindowsPowerShell {
  Join-Path (Join-Path (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell') 'v1.0') 'powershell.exe'
}

# A task that runs a start script in the bot user's session at its logon: interactive (so it can drive the desktop),
# not elevated, no time limit. The start script starts its program again whenever it exits.
function Register-RpaScheduledTask([string]$Name, [string]$ScriptPath, [string]$Account) {
  $action = New-ScheduledTaskAction -Execute (Get-RpaWindowsPowerShell) -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $ScriptPath)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Account
  $principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskPath $script:TaskPath -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}

# Registers one of the two tasks. A task of that name that is already there is removed first and not overwritten: an
# overwritten task keeps its owner and access rules, and a standard user can make one before the installer does. A
# standard user can also make the task folder first, and whoever owns the folder can change what is in it. So the
# owner of the folder is looked at directly before (the plan saw it before the question -AutoSignIn asks), and the
# owners of the folder and of the new task are read once more after the registration, because the folder can still
# have been made between that look and the registration; a task that is then not in the hands of Administrators or
# SYSTEM is removed again.
function Register-RpaTask([string]$Name, [string]$ScriptPath, [string]$Account) {
  $folderText = 'The scheduled task folder {0} exists and is owned by {1}. Check what is in it, remove it, and run the installer again.'
  $owner = Get-RpaTaskFolderOwner
  if ($owner) { throw ($folderText -f $script:TaskPath, $owner) }
  Unregister-RpaTask $Name
  Register-RpaScheduledTask $Name $ScriptPath $Account
  $refusal = $null
  $owner = Get-RpaTaskFolderOwner
  if ($owner) { $refusal = $folderText -f $script:TaskPath, $owner }
  else {
    $owner = Get-RpaTaskOwner $Name
    if ($owner) { $refusal = 'The scheduled task {0}{1} is owned by {2}. Check what is in the scheduled task folder {0}, remove it, and run the installer again.' -f $script:TaskPath, $Name, $owner }
  }
  if ($refusal) {
    Unregister-RpaTask $Name
    throw $refusal
  }
}

function Unregister-RpaTask([string]$Name) {
  Unregister-ScheduledTask -TaskPath $script:TaskPath -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
}

# What install.json holds. autoSignIn says that the installer turned automatic sign-in on, in this run or an earlier
# one (it is written before the sign-in steps run). allowFrom is what the firewall rules let in (a list of addresses
# and ranges, or the word any) and publicNetwork whether they also apply on Public networks; a run that makes no rule
# keeps what an earlier run recorded, and records the word none when no run has made a rule (-NoFirewall).
# signInChanges are the records of what -AutoSignIn changed; -Leftovers is the list an earlier uninstall left of what
# it could not put back, or nothing.
function New-RpaInstallRecord {
  param([string]$Version, [hashtable]$Account, [hashtable]$Parameters, [hashtable]$Plan, $Previous, $Leftovers)
  $allowFrom = 'none'
  $publicNetwork = $false
  if ($Previous -and $Previous.allowFrom) {
    $allowFrom = $Previous.allowFrom
    $publicNetwork = $Previous.publicNetwork -eq $true
  }
  if ($Plan.AllowFrom) {
    $allowFrom = @($Plan.AllowFrom)
    if ($allowFrom.Count -eq 1 -and $allowFrom[0] -eq 'any') { $allowFrom = 'any' }
    $publicNetwork = [bool]$Plan.PublicNetwork
  }
  $changes = @()
  if ($Previous -and $Previous.signInChanges) { $changes = @($Previous.signInChanges) }
  # What an earlier uninstall could not put back is still changed on this machine. Its records, which say what each
  # setting was before the earlier install, come before anything this install records, so that a sign-in step does
  # not record the changed setting as the one to go back to.
  $known = @($changes | ForEach-Object { Get-RpaChangeId $_ })
  if ($Leftovers) {
    foreach ($entry in @($Leftovers.notPutBack)) {
      if (-not $entry -or -not $entry.kind -or $entry.kind -eq 'other') { continue }
      $id = Get-RpaChangeId $entry
      if ($known -contains $id) { continue }
      $record = [ordered]@{}
      foreach ($property in $entry.PSObject.Properties) { if (@('reason', 'user', 'at') -notcontains $property.Name) { $record[$property.Name] = $property.Value } }
      $changes += New-Object psobject -Property $record
      $known += $id
    }
  }
  [ordered]@{
    version       = $Version
    user          = $Account.Display
    runnerPort    = [int]$Parameters.RunnerPort
    browserPort   = [int]$Parameters.BrowserPort
    browser       = -not $Parameters.NoBrowser
    autoSignIn    = (@($Plan.Steps) -contains 'turn on automatic sign-in') -or [bool]($Previous -and $Previous.autoSignIn -eq $true)
    allowFrom     = $allowFrom
    publicNetwork = $publicNetwork
    signInChanges = $changes
  }
}

# Writes install.json from the run's state: what the start scripts, Show-RpaConnection.ps1 and the uninstaller read.
function Save-RpaInstallFile([hashtable]$Run) {
  [IO.File]::WriteAllText($Run.Layout.InstallFile, ($Run.Install | ConvertTo-Json -Depth 5), $script:Utf8)
}

# Starts the tasks again in the bot user's session after an upgrade. When that user is not signed in nothing starts,
# and the tasks start at its next logon as always.
function Start-RpaTasks {
  foreach ($name in $script:RunnerTask, $script:BrowserTask) {
    try { Get-ScheduledTask -TaskPath $script:TaskPath -TaskName $name -ErrorAction SilentlyContinue | Start-ScheduledTask } catch { }
  }
}

# After a failed step: puts back the sign-in changes this run made and removes a user this run created, so that the
# installer can be run again with the same parameters. A first install that got as far as install.json loses it again;
# an upgrade keeps it, without this run's sign-in records.
# When a change cannot be put back, nothing more is removed: install.json stays and keeps the records of what could
# not be put back (and says that automatic sign-in is not on), so that Uninstall-Rpa.ps1 and a later run still know
# what was there before; and a user this run created stays, because those records and what is left in Windows name it.
# Returns the lines that name what could not be put back (NotPutBack) and the user that was kept (UserKept).
function Undo-RpaFailedRun([hashtable]$Run) {
  $failed = @()
  if (@($Run.NewChanges).Count -gt 0) {
    Write-Host '  undo: put back the sign-in settings this run changed'
    $failed = @(Restore-RpaSignInChanges $Run.NewChanges $false)
  }
  $result = @{ NotPutBack = @($failed | ForEach-Object { $_.Text }); UserKept = $null }
  $newIds = @($Run.NewChanges | ForEach-Object { Get-RpaChangeId $_ })
  if ($failed.Count -gt 0) {
    $leftIds = @($failed | Where-Object { $_.Change } | ForEach-Object { Get-RpaChangeId $_.Change })
    $Run.Install.signInChanges = @($Run.Install.signInChanges | Where-Object { $id = Get-RpaChangeId $_; ($newIds -notcontains $id) -or ($leftIds -contains $id) })
    $Run.Install.autoSignIn = $Run.AutoSignInBefore
    Save-RpaInstallFile $Run
    if ($Run.CreatedUser) {
      Write-Host ('  undo: the user {0}, which this run created, is kept' -f $Run.Account.Display)
      $result.UserKept = $Run.Account.Display
    }
    return $result
  }
  if ($Run.WroteInstallFile) {
    if ($Run.Upgrade) {
      $Run.Install.signInChanges = @($Run.Install.signInChanges | Where-Object { $newIds -notcontains (Get-RpaChangeId $_) })
      $Run.Install.autoSignIn = $Run.AutoSignInBefore
      Save-RpaInstallFile $Run
    } else {
      Remove-Item -LiteralPath $Run.Layout.InstallFile -Force -ErrorAction SilentlyContinue
    }
  }
  if ($Run.CreatedUser) {
    Write-Host ('  undo: remove the user {0}, which this run created' -f $Run.Account.Display)
    try { Remove-RpaUser $Run.Account $Run.Sid } catch { Write-Host ('    could not remove {0}: {1}' -f $Run.Account.Display, $_.Exception.Message) }
  }
  $result
}

# Runs exactly the steps of the plan, in order, and names each as it starts. -SourceDir is the unpacked package (the
# folder Install-Rpa.ps1 is in). What can be checked without changing anything is checked first: the plan, every step
# name, the package and the user. When a step fails, the sign-in changes and the user of this run are undone, and the
# error that is thrown carries, in its Data, what could not be put back (NotPutBack) and a user that was kept for that
# reason (UserKept).
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
  foreach ($step in $steps) {
    if ($script:KnownSteps -notcontains $step) { throw ('The installer has no step "{0}"; nothing was changed.' -f $step) }
  }
  $layout = Get-RpaLayout
  $account = Get-RpaAccount -User $Parameters.User -ComputerName $env:COMPUTERNAME
  $runnerPort = [int]$Parameters.RunnerPort
  $browserPort = [int]$Parameters.BrowserPort
  $scripts = Join-Path $layout.InstallDir 'scripts'

  $source = (Resolve-Path -LiteralPath $SourceDir).ProviderPath.TrimEnd('\')
  if ($source -eq $layout.InstallDir) { throw 'Run Install-Rpa.ps1 from the unpacked package, not from the install directory.' }
  $needed = @('VERSION', 'runner\RpaRunner.exe', 'scripts\start-loop.ps1', 'scripts\start-runner.ps1', 'scripts\Show-RpaConnection.ps1')
  if (-not $Parameters.NoBrowser) { $needed += 'browser\node.exe', 'browser\host\host.mjs', 'scripts\start-browser.ps1' }
  foreach ($file in $needed) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $file))) {
      throw ('{0} is missing from {1}. Unpack the whole package and run Install-Rpa.ps1 from that folder.' -f $file, $source)
    }
  }

  $previous = Read-RpaInstallFile $layout.InstallFile
  $run = @{
    Layout           = $layout
    Account          = $account
    Sid              = $null
    Password         = $Parameters.UserPassword
    Upgrade          = [bool]$previous
    AutoSignInBefore = [bool]($previous -and $previous.autoSignIn -eq $true)
    Install          = $null
    NewChanges       = @()
    CreatedUser      = $false
    WroteInstallFile = $false
    LeftoversRead    = $false
  }
  # The user's security identifier goes into permissions by number, so no name can be misread. A user that the plan
  # does not create must exist now (an upgrade keeps the user of the first install).
  if ($steps -notcontains 'create user') { $run.Sid = Get-RpaSid $account }
  # As in the plan: what is in the data directory is judged when the user of the install is new to it, and only a
  # user that was there before this run can own anything in it.
  $judge = (-not $previous) -or ($steps -contains 'create user') -or ([string]$previous.user -ne $account.Display)
  $ownSid = $run.Sid

  foreach ($step in $steps) {
    Write-Host ('  {0}' -f $step)
    try {
      switch ($step) {
        'stop running services' { Stop-RpaServices $layout.InstallDir }
        'copy program files' { Copy-RpaProgramFiles $source $layout.InstallDir }
        'create user' {
          $run.Password = New-RpaUser $account $run.Password
          $run.CreatedUser = $true
          $run.Sid = Get-RpaSid $account
        }
        'protect the data directory' { Protect-RpaDataDirectory $layout $run.Sid $judge $ownSid }
        'write policy' { New-RpaProtectedFile -Path (Join-Path $layout.DataDir 'policy.json') -Sid $run.Sid -Text $script:StarterPolicy }
        'write token' { New-RpaProtectedFile -Path (Join-Path $layout.DataDir 'token') -Sid $run.Sid -SecretLength 48 }
        'write browser-token' { New-RpaProtectedFile -Path (Join-Path $layout.DataDir 'browser-token') -Sid $run.Sid -SecretLength 48 }
        'add the runner firewall rule' { Set-RpaFirewallRule $script:RunnerRule ('RPA desktop runner (TCP {0})' -f $runnerPort) $runnerPort (Join-Path (Join-Path $layout.InstallDir 'runner') 'RpaRunner.exe') $Plan.AllowFrom ([bool]$Plan.PublicNetwork) }
        'add the browser firewall rule' { Set-RpaFirewallRule $script:BrowserRule ('RPA browser (TCP {0})' -f $browserPort) $browserPort (Join-Path (Join-Path $layout.InstallDir 'browser') 'node.exe') $Plan.AllowFrom ([bool]$Plan.PublicNetwork) }
        'remove the browser firewall rule' { Remove-NetFirewallRule -Name $script:BrowserRule -ErrorAction SilentlyContinue }
        'register the runner task' { Register-RpaTask $script:RunnerTask (Join-Path $scripts 'start-runner.ps1') $account.Qualified }
        'register the browser task' { Register-RpaTask $script:BrowserTask (Join-Path $scripts 'start-browser.ps1') $account.Qualified }
        'remove the browser task' { Unregister-RpaTask $script:BrowserTask }
        'write install.json' {
          $version = ([string](Get-Content -LiteralPath (Join-Path $layout.InstallDir 'VERSION') -TotalCount 1)).Trim()
          # What an earlier uninstall could not put back becomes the first records, when its list can be trusted.
          $leftovers = Read-RpaLeftovers $layout.LeftoversFile
          $run.LeftoversRead = $leftovers.State -eq 'trusted'
          $run.Install = New-RpaInstallRecord -Version $version -Account $account -Parameters $Parameters -Plan $Plan -Previous $previous -Leftovers $leftovers.List
          Save-RpaInstallFile $run
          $run.WroteInstallFile = $true
        }
        'store sign-in password' { Set-RpaSignInPassword $run }
        'turn on automatic sign-in' { Enable-RpaAutoSignIn $run }
        'keep the desktop unlocked' { Set-RpaDesktopUnlocked $run }
        'start tasks' { Start-RpaTasks }
      }
    } catch {
      $failure = New-Object InvalidOperationException ('The step "{0}" failed: {1}' -f $step, $_.Exception.Message)
      $undone = Undo-RpaFailedRun $run
      $failure.Data['NotPutBack'] = [string[]]@($undone.NotPutBack)
      $failure.Data['UserKept'] = $undone.UserKept
      throw $failure
    }
  }
  # install.json holds the records of the list by now, and the install has finished: the list has done its work. (A
  # failed first install loses its install.json again, so the list stays until an install finishes.)
  if ($run.LeftoversRead) { Remove-Item -LiteralPath $layout.LeftoversFile -Force -ErrorAction SilentlyContinue }
}

# The accounts whose running process stands in the way of removing the data directory, as SID and name: the bot user
# install.json names, whoever the data directory's access rules name besides SYSTEM and Administrators (install.json
# is gone after an uninstall that kept the data), and whoever owns anything in the data directory. -Entries is what
# Get-RpaDataEntries returned for the data directory, or nothing when it is not there or is a link.
# Bot marks the bot user: the user install.json names, or, without that record, the accounts the access rules name.
function Get-RpaDataAccounts([hashtable]$Layout, $Install, $Entries) {
  $accounts = [ordered]@{}
  $bots = @{}
  if ($Install -and $Install.user) {
    $account = Get-RpaAccount -User ([string]$Install.user) -ComputerName $env:COMPUTERNAME
    # A recorded user that is no longer there has no SID to look for; what it owns is found below.
    try {
      $sid = Get-RpaSid $account
      $accounts[$sid] = $account.Display
      $bots[$sid] = $true
    } catch { }
  }
  if ($Entries) {
    $named = @()
    $security = [IO.Directory]::GetAccessControl($Layout.DataDir, 'Access')
    foreach ($rule in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow') { $named += $rule.IdentityReference.Value }
    }
    $recorded = $bots.Count -gt 0
    foreach ($sid in ($named + @($Entries.Accounts.Keys))) {
      # S-1-3-0 is "whoever creates it", not an account.
      if ($accounts.Contains($sid) -or $script:TrustedOwners -contains $sid -or $sid -eq 'S-1-3-0') { continue }
      $name = Get-RpaAccountName (New-Object Security.Principal.SecurityIdentifier $sid)
      $accounts[$sid] = (Get-RpaAccount -User $name -ComputerName $env:COMPUTERNAME).Display
      if (-not $recorded -and $named -contains $sid) { $bots[$sid] = $true }
    }
  }
  @($accounts.Keys | ForEach-Object { @{ Sid = $_; Name = $accounts[$_]; Bot = [bool]$bots[$_] } })
}

# The accounts the running processes belong to: their SIDs (Sids), read from each process's own token, which also
# gives the SID of an account that was removed while its process goes on (Windows' management interface gives
# nothing then). Unknown names the processes whose account cannot be read: a process can take Administrators and
# SYSTEM off the access rules of its token. Left out are the idle process, a process that has ended meanwhile, and
# the processes of Windows' kernel that run no program (System, Registry, ...).
function Get-RpaProcessOwners {
  Add-RpaNativeTypes
  # Reading the token of another account's process takes the "Debug programs" privilege. An elevated Windows
  # PowerShell has it switched on; this asks for it where it is not. Without it those processes count as unknown.
  try { [Diagnostics.Process]::EnterDebugMode() } catch { }
  $sids = @{}
  $unknown = @()
  foreach ($process in [Diagnostics.Process]::GetProcesses()) {
    if ($process.Id -eq 0) { continue }
    $owner = [RpaAccounts]::ProcessOwner($process.Id)
    if ($null -eq $owner) { $unknown += '{0} (process {1})' -f $process.ProcessName, $process.Id }
    elseif ($owner) { $sids[$owner] = $true }
  }
  @{ Sids = @($sids.Keys); Unknown = $unknown }
}

# The facts Get-RpaUninstallPlan judges. Changes nothing.
function Get-RpaUninstallFacts {
  $ErrorActionPreference = 'Stop'
  $layout = Get-RpaLayout
  $install = Read-RpaInstallFile $layout.InstallFile
  $state = Get-RpaPathState $layout.DataDir
  $entries = $null
  if ($state.Exists -and -not $state.IsLink) { $entries = Get-RpaDataEntries $layout.DataDir }
  $facts = @{
    DataDir           = $layout.DataDir
    DataDirState      = $state
    DataDirUnreadable = $null
    Accounts          = @(Get-RpaDataAccounts $layout $install $entries)
    RunningSids       = @()
    UnknownProcesses  = @()
    AutoSignInSid     = $null
  }
  if ($entries) { $facts.DataDirUnreadable = $entries.Unreadable }
  if ($facts.Accounts.Count -gt 0) {
    $owners = Get-RpaProcessOwners
    $facts.RunningSids = @($owners.Sids)
    $facts.UnknownProcesses = @($owners.Unknown)
  }
  if ($install -and $install.autoSignIn -eq $true) {
    try { $facts.AutoSignInSid = Get-RpaSid (Get-RpaAccount -User ([string]$install.user) -ComputerName $env:COMPUTERNAME) } catch { }
  }
  $facts
}

# Switches the two tasks on again and starts them, after a stop that is not followed by an upgrade or a removal.
function Resume-RpaServices {
  foreach ($name in $script:RunnerTask, $script:BrowserTask) {
    Get-ScheduledTask -TaskPath $script:TaskPath -TaskName $name -ErrorAction SilentlyContinue | Enable-ScheduledTask | Out-Null
  }
  Start-RpaTasks
}

# Removes the install directory. A list of what an uninstall could not put back stays, alone in the directory, for
# the next install to read (and so does anything else that stands in the list's place).
function Remove-RpaProgramFiles([hashtable]$Layout) {
  # A folder that is someone's current directory cannot be removed, and the uninstaller may be run from inside it.
  if ((Get-Location).ProviderPath.StartsWith($Layout.InstallDir, [StringComparison]::OrdinalIgnoreCase)) { Set-Location -LiteralPath $env:SystemRoot }
  if ([Environment]::CurrentDirectory.StartsWith($Layout.InstallDir, [StringComparison]::OrdinalIgnoreCase)) { [Environment]::CurrentDirectory = $env:SystemRoot }
  if (-not (Get-RpaPathState $Layout.LeftoversFile).Exists) {
    Remove-RpaTree $Layout.InstallDir
    return
  }
  foreach ($item in Get-ChildItem -LiteralPath $Layout.InstallDir -Force) {
    # Also when something else stands in the list's place: it is left as it is.
    if ($item.FullName -eq $Layout.LeftoversFile) { continue }
    if ($item.PSIsContainer) { Remove-RpaTree $item.FullName } else { Remove-Item -LiteralPath $item.FullName -Force }
  }
}

# The profile folder Windows records for an account, by its SID, or nothing when the account has no profile on this
# machine (it has never signed in here).
function Get-RpaProfileFolder([string]$Sid) {
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $Sid)
  if (-not $key) { return $null }
  try { $folder = [string]$key.GetValue('ProfileImagePath') } finally { $key.Dispose() }
  if (-not $folder -or -not [IO.Path]::IsPathRooted($folder)) { return $null }
  $folder.TrimEnd('\')
}

# Removes what the browser host keeps in the local application data of the bot user: the folder RPA Runner there,
# which holds browser-temp, the temp folder of the browser server. A host that was ended without a chance to stop
# leaves a session's trace in it, with what was typed into pages, until its next start. -Accounts, -RunningSids and
# -UnknownProcesses are what Get-RpaUninstallFacts returned; only an account marked Bot is looked at. The profile is
# found by the account's SID, and the local application data is taken to be AppData\Local in it, where Windows
# puts it. The folder is left as it is, with the reason:
#   - while a process of that account is running, or one whose account cannot be read: the host may be using the
#     folder, and the account could put a link in the place of a folder while the tree is removed;
#   - when the profile folder, AppData, Local or RPA Runner is a link or junction, or is no folder: they belong to
#     the bot user, and nothing is removed where a link points;
#   - when it cannot be read or removed.
# The tree is removed with Remove-RpaTree, which does not enter a link inside it. Returns, for each folder found,
# Path, Name (the account), Removed and Why (a sentence for the person, when it was left).
function Remove-RpaBrowserTemp([object[]]$Accounts, [string[]]$RunningSids, [object[]]$UnknownProcesses) {
  $results = @()
  $unknown = @($UnknownProcesses | Where-Object { $_ })
  foreach ($account in @($Accounts | Where-Object { $_ -and $_.Bot })) {
    $userFolder = Get-RpaProfileFolder $account.Sid
    if (-not $userFolder) { continue }
    $folders = @($userFolder)
    foreach ($part in 'AppData', 'Local', 'RPA Runner') { $folders += Join-Path $folders[-1] $part }
    $result = @{ Path = $folders[-1]; Name = $account.Name; Removed = $false; Why = '' }
    $missing = $false
    try {
      foreach ($folder in $folders) {
        $state = Get-RpaPathState $folder
        if (-not $state.Exists) { $missing = $true; break }
        if ($state.IsLink -or -not $state.IsFolder) {
          $result.Why = '{0} is a link or junction, so nothing was removed there. Check it and remove the folder.' -f $folder
          break
        }
      }
      if ($missing) { continue }
      if (-not $result.Why) {
        if (@($RunningSids) -contains $account.Sid) {
          $result.Why = '{0} is signed in. Sign {0} out, then run Uninstall-Rpa.ps1 again from the unpacked package, or remove the folder.' -f $account.Name
        } elseif ($unknown.Count -gt 0) {
          $result.Why = 'The owner of {0} cannot be read; it may be a process of {1}. End it, then run Uninstall-Rpa.ps1 again from the unpacked package, or remove the folder.' -f $unknown[0], $account.Name
        } else {
          Remove-RpaTree $result.Path
          $result.Removed = $true
        }
      }
    } catch { $result.Why = $_.Exception.GetBaseException().Message }
    $results += $result
  }
  $results
}

# What Uninstall-Rpa.ps1 does: removes the tasks, the firewall rules and the install directory, and puts back what
# -AutoSignIn changed, from the records in install.json. The data directory goes only with -RemoveData; the Windows
# user is never removed. -Plan is what Get-RpaUninstallPlan returned.
# Every refusal comes before anything is removed. With -RemoveData the data directory goes first, directly after a
# second look at who has a process running (the plan looked before the programs were stopped); when that look
# refuses, the tasks are switched on and started again, and the error that is thrown has Refused in its Data.
# What the browser left in the bot user's local application data goes when that user has no process running; it is
# looked for before the data directory goes, whose access rules name the bot user when install.json is gone.
# Each setting that cannot be put back is printed when that happens and listed at once in uninstall-leftovers.json
# in the install directory, which then stays with that one file. Returns what the uninstaller reports.
function Invoke-RpaUninstall {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Plan,
    [switch]$RemoveData
  )
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  if (@($Plan.Refusals).Count -gt 0) { throw 'The plan has refusals; nothing was changed.' }
  $layout = Get-RpaLayout
  $install = Read-RpaInstallFile $layout.InstallFile
  $result = @{
    User = $null; UserKept = $false; AutoSignIn = $false; SignInKept = $false; SignInFailed = $false; HadChanges = $false; NotRestored = @()
    LeftoversFile = $null; LeftoversProblem = $null; DataRemoved = $false; DataKept = $false; BrowserTemp = @(); Layout = $layout
  }
  if ($install) {
    $result.User = [string]$install.user
    $result.AutoSignIn = $install.autoSignIn -eq $true
    # The uninstaller removes no Windows user; whether the recorded one is still there is for the closing text.
    try { $null = Get-RpaSid (Get-RpaAccount -User $result.User -ComputerName $env:COMPUTERNAME); $result.UserKept = $true } catch { }
  }

  Write-Host '  stop running services'
  Stop-RpaServices $layout.InstallDir
  # Who has a process running now that the programs are stopped.
  $facts = Get-RpaUninstallFacts
  if ($RemoveData) {
    $late = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts
    if ($late.Refusals.Count -gt 0) {
      Resume-RpaServices
      $refused = New-Object InvalidOperationException ($late.Refusals -join "`n")
      $refused.Data['Refused'] = $true
      throw $refused
    }
  }
  $result.BrowserTemp = @(Remove-RpaBrowserTemp $facts.Accounts $facts.RunningSids $facts.UnknownProcesses)
  foreach ($entry in $result.BrowserTemp) {
    if ($entry.Removed) { Write-Host ("  remove the browser's temp folder of {0}" -f $entry.Name) }
  }
  if ($RemoveData) {
    Write-Host '  remove the data directory'
    $result.DataRemoved = (Get-RpaPathState $layout.DataDir).Exists
    Remove-RpaTree $layout.DataDir
  }
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
  if ($install -and @($install.signInChanges).Count -gt 0) {
    Write-Host '  put back what -AutoSignIn changed'
    $result.HadChanges = $true
    # Unless someone has pointed automatic sign-in at another account since the install.
    $account = Get-RpaAccount -User $result.User -ComputerName $env:COMPUTERNAME
    $current = (Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE{0}' -f $script:Winlogon.Substring(4)) -Name 'DefaultUserName' -ErrorAction SilentlyContinue).DefaultUserName
    $result.SignInKept = $result.AutoSignIn -and ($current -ne $account.Name)
    $failed = @(Restore-RpaSignInChanges @($install.signInChanges) $result.SignInKept)
    $result.NotRestored = @($failed | ForEach-Object { $_.Text })
    $result.SignInFailed = [bool]($failed | Where-Object { $_.Change -and ($_.Change.kind -eq 'secret' -or [string]$_.Change.key -eq $script:Winlogon) })
    # install.json goes with the program files, so the record of what was not put back is written now, before
    # anything else can stop the run.
    if ($failed.Count -gt 0) {
      try {
        $result.LeftoversFile = Save-RpaLeftovers $layout $failed $result.User
        Write-Host ('    listed in {0}' -f $result.LeftoversFile)
      } catch {
        $result.LeftoversProblem = $_.Exception.GetBaseException().Message
        Write-Host ('    this list could not be kept in {0}: {1}' -f $layout.LeftoversFile, $result.LeftoversProblem)
      }
    }
  }
  Write-Host '  remove the program files'
  Remove-RpaProgramFiles $layout
  $result.DataKept = (Get-RpaPathState $layout.DataDir).Exists
  $result
}

# What Uninstall-Rpa.ps1 prints at its end, from what Invoke-RpaUninstall returned: only what was done.
function Get-RpaUninstallSummary([hashtable]$Result) {
  $lines = @('RPA is removed.')
  $failed = @($Result.NotRestored)
  if ($Result.AutoSignIn) {
    if ($Result.SignInKept) { $lines += '  Automatic sign-in now names another user, so it and the stored password were left as they are.' }
    elseif ($Result.SignInFailed) { $lines += '  Automatic sign-in of {0} could not be turned off completely: see the list below.' -f $Result.User }
    else { $lines += '  Automatic sign-in of {0} is off and the stored password is removed.' -f $Result.User }
  }
  if ($Result.HadChanges) {
    if ($failed.Count -eq 0) {
      if ($Result.SignInKept) { $lines += '  The other settings -AutoSignIn changed are back to what they were before.' }
      else { $lines += '  The settings -AutoSignIn changed are back to what they were before.' }
    } else {
      $lines += '  Of the settings -AutoSignIn changed, these could not be put back:'
      foreach ($line in $failed) { $lines += '    {0}' -f $line }
      if ($Result.LeftoversFile) {
        $lines += '  This list, with what each setting was before, is kept in {0},' -f $Result.LeftoversFile
        $lines += '  a file only administrators can read or change. The next install reads it, so that a later uninstall'
        $lines += '  tries these settings again.'
      } else { $lines += '  This list could not be kept in {0}: {1}' -f $Result.Layout.LeftoversFile, $Result.LeftoversProblem }
    }
  }
  foreach ($entry in @($Result.BrowserTemp | Where-Object { $_ })) {
    if ($entry.Removed) { $lines += "  Removed:   {0} (the browser's temp folder of {1})" -f $entry.Path, $entry.Name }
    else {
      $lines += "  Kept:      {0} (the browser's temp folder of {1}; it can hold" -f $entry.Path, $entry.Name
      $lines += '             what was typed into pages).'
      $lines += '             {0}' -f $entry.Why
    }
  }
  if ($Result.DataRemoved) { $lines += '  Removed:   {0}' -f $Result.Layout.DataDir }
  elseif ($Result.DataKept) {
    $lines += '  Kept:      {0} (remove it with -RemoveData)' -f $Result.Layout.DataDir
    if ($Result.User) {
      $lines += '             A later install for {0} takes it over when everything in it belongs to Administrators,' -f $Result.User
      $lines += '             SYSTEM or {0}, and keeps the policy, the tokens and the certificates. An install for another' -f $Result.User
      $lines += '             user refuses what {0} left there, and so does one for a user of that name that was' -f $Result.User
      $lines += '             removed and created again.'
    } else {
      $lines += '             A later install takes it over when everything in it belongs to Administrators, SYSTEM or the'
      $lines += '             user it installs for, and that user was there before.'
    }
  }
  if ($Result.User -and $Result.UserKept) { $lines += '  Kept:      the Windows user {0}' -f $Result.User }
  $lines
}
