# The installer's module, third of three files (RpaInstall.psd1 loads them into one module): what looks at and changes
# the machine, for Windows PowerShell 5.1. The facts the two plans judge, the data directory, the firewall rules, the
# scheduled tasks, the steps of an install, and the uninstall. Everything here runs on Windows only.

$script:RunnerTask = 'RPA Runner'
$script:BrowserTask = 'RPA Browser'
$script:RunnerRule = 'RPA-Runner-In'
$script:BrowserRule = 'RPA-Browser-In'
# The Windows service of -Unattended (desktop/runner/src/Rpa.Supervisor), also the name of its event source.
$script:SupervisorService = 'RPA Supervisor'
# The group whose members may sign in through Remote Desktop (BUILTIN\Remote Desktop Users).
$script:RemoteDesktopUsers = 'S-1-5-32-555'
# Where Windows keeps whether Remote Desktop is on: fDenyTSConnections 0 is on.
$script:TerminalServer = 'HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server'
# How long the installer waits for the first sign-in through the RPA Supervisor, which creates the bot user's profile.
$script:FirstSignInSeconds = 120
$script:StarterPolicy = '{ "allowedApps": [], "maxFileBytes": 20971520 }'
$script:Utf8 = New-Object Text.UTF8Encoding $false
# Administrators and SYSTEM: the only owners the installer accepts for what it finds in the data directory.
$script:TrustedOwners = @('S-1-5-32-544', 'S-1-5-18')
$script:KnownSteps = @(
  'stop running services', 'copy program files', 'create user', 'remove the old tokens', 'protect the data directory',
  'write policy', 'write token', 'write browser-token', 'add the runner firewall rule', 'add the browser firewall rule',
  'remove the browser firewall rule', 'register the runner task', 'register the browser task',
  'remove the browser task', 'write install.json', 'put back what -Unattended changed', 'store sign-in password',
  'turn on automatic sign-in', 'keep the desktop unlocked', 'keep the automatic sign-in password for the supervisor',
  'turn off automatic sign-in', 'allow the bot user to sign in through Remote Desktop', 'turn on Remote Desktop',
  "store the bot user's password for the supervisor", 'sign the bot user out', 'register the supervisor service',
  'point the firewall rules at the supervisor', 'start tasks')

# Where things are. Program Files keeps its default permissions (users read and run, only administrators change), so
# the bot user cannot replace what it runs.
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
    # The RPA Supervisor's log and state: SYSTEM and Administrators only.
    SupervisorDir = Join-Path $dataDir 'supervisor'
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
    EarlierUsers               = @()
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
    IsServer                   = $false
    RemoteDesktopDenied        = $false
    RemoteDesktopServiceDisabled = $false
    InstalledMode              = $null
    InstalledSupervisorSecret  = $false
    InstalledIdleSeconds       = $null
    AutoSignInPassword         = $null
    AutoSignInPasswordProblem  = $null
    RemoteDesktopPort          = $null
    InstalledUnattendedChanges = $false
    SupervisorDir              = $layout.SupervisorDir
    SupervisorDirState         = $null
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
    $facts.InstalledMode = [string]$install.mode
    if ($null -ne $install.idleSeconds) { $facts.InstalledIdleSeconds = [int]$install.idleSeconds }
    # What install.json records of -Unattended: the stored password (a failed run may have removed it again), and
    # anything an install with -Unattended:$false has to put back (also after a first attempt failed).
    $records = @($install.signInChanges | Where-Object { $_ -and (Test-RpaUnattendedChange $_) })
    $facts.InstalledSupervisorSecret = [bool]($records | Where-Object { $_.kind -eq 'secret' })
    $facts.InstalledUnattendedChanges = $records.Count -gt 0
  }
  # A product type of 1 is a desktop edition (Windows 10 or 11); 2 and 3 are Windows Server.
  $facts.IsServer = (Get-CimInstance -ClassName Win32_OperatingSystem).ProductType -ne 1
  $denied = (Get-RpaRegistryRecord $script:TerminalServer 'fDenyTSConnections')
  $facts.RemoteDesktopDenied = $denied.existed -and $denied.type -eq 'REG_DWORD' -and $denied.value -eq '1'
  $port = Get-RpaRegistryRecord ($script:TerminalServer + '\WinStations\RDP-Tcp') 'PortNumber'
  if ($port.existed) { $facts.RemoteDesktopPort = [int]$port.value }
  $termService = Get-Service -Name TermService -ErrorAction SilentlyContinue
  $facts.RemoteDesktopServiceDisabled = [bool]$termService -and [string]$termService.StartType -eq 'Disabled'

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
    # An upgrade of an unattended install stays unattended without -Unattended (unless -Unattended:$false).
    $keepsUnattended = $install -and $install.mode -eq 'unattended' -and -not $Parameters.UnattendedGiven
    if (($Parameters.AutoSignIn -or $Parameters.Unattended -or $keepsUnattended) -and $Parameters.UserPassword) {
      $domain = '.'
      if ($account.IsDomain) { $domain = $account.Domain }
      $code = [RpaAccounts]::CheckPassword($domain, $account.Name, $Parameters.UserPassword)
      if ($code -eq 1326) { $facts.UserPasswordWrong = $true }
      elseif ($code -ne 0 -and $code -ne 1385) { $facts.UserPasswordProblem = (New-Object ComponentModel.Win32Exception $code).Message }
    }
    # Moving an install with automatic sign-in for this user to -Unattended without -UserPassword: the password stored
    # for automatic sign-in is read into memory and tried the same way; only the outcome is kept here.
    $moving = ($Parameters.Unattended -or $keepsUnattended) -and $install -and $install.autoSignIn -eq $true -and $facts.InstalledForUser
    if ($moving -and -not $Parameters.UserPassword) {
      $stored = Read-RpaAutoSignInPassword
      if (-not $stored) { $facts.AutoSignInPassword = 'missing' }
      else {
        try {
          $domain = '.'
          if ($account.IsDomain) { $domain = $account.Domain }
          $code = [RpaAccounts]::CheckPassword($domain, $account.Name, $stored)
        } finally { $stored.Dispose() }
        if ($code -eq 1326) { $facts.AutoSignInPassword = 'wrong' }
        else {
          $facts.AutoSignInPassword = 'ok'
          if ($code -ne 0 -and $code -ne 1385) { $facts.AutoSignInPasswordProblem = (New-Object ComponentModel.Win32Exception $code).Message }
        }
      }
    }
  }

  $ports = @([int]$Parameters.RunnerPort, [int]$Parameters.BrowserPort)
  # With -Unattended the runner and the browser listen behind the RPA Supervisor, at their port + 10000.
  if ($Parameters.Unattended -or ($install -and $install.mode -eq 'unattended' -and -not $Parameters.UnattendedGiven)) { $ports += @($ports | ForEach-Object { $_ + $script:InnerPortOffset } | Where-Object { $_ -le 65535 }) }
  foreach ($port in $ports) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
      if ($process) { $facts.PortsInUse[$port] = $process.ProcessName } else { $facts.PortsInUse[$port] = 'process {0}' -f $listener.OwningProcess }
    }
  }

  $facts.DataDirState = Get-RpaPathState $layout.DataDir
  $facts.LogDirState = Get-RpaPathState $layout.LogDir
  $facts.PolicyBackupsState = Get-RpaPathState $layout.BackupsDir
  $facts.SupervisorDirState = Get-RpaPathState $layout.SupervisorDir
  foreach ($name in $script:DataFiles.Keys) { $facts.DataFiles[$name] = Get-RpaPathState (Join-Path $layout.DataDir $name) }
  # Everything else that is in a data directory that is there already.
  if ($facts.DataDirState.Exists -and -not $facts.DataDirState.IsLink -and $facts.DataDirState.OwnerTrusted) {
    $facts.DataDirEntries = Get-RpaDataEntries $layout.DataDir
    # Without an install, the bot user of an earlier one is the user the data directory's access rules name, as the
    # uninstaller takes it when install.json is gone.
    if (-not $install) {
      $facts.EarlierUsers = @(Get-RpaDataAccounts $layout $null $facts.DataDirEntries | Where-Object { $_.Bot } | ForEach-Object { @{ Sid = $_.Sid; Name = $_.Name } })
    }
  }
  $facts.Leftovers = @{ File = $layout.LeftoversFile; State = (Read-RpaLeftovers $layout.LeftoversFile).State }
  $facts.TaskFolderOwner = Get-RpaTaskFolderOwner
  $facts.PublicNetwork = [bool](Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
  $facts
}

# The full path of a tool that ships with Windows (icacls, reg, powercfg, robocopy). The installer runs as an
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

# Ends the two tasks and everything started from the install directory: the RPA Supervisor (when its service runs this
# install's program, stopped as a service first, which signs its session out; a process ended otherwise would be started again by Windows a minute later), the
# runner, the browser host, its browser, the demo app, and the start scripts (also when someone started them by hand),
# which would otherwise start the programs again while their files are replaced. The tasks are switched off until they
# are registered again or removed; the service stays stopped until it is registered again or removed.
function Stop-RpaServices([string]$InstallDir) {
  if ((Get-RpaServicePath $script:SupervisorService) -ieq (Get-RpaSupervisorPath $InstallDir)) { Stop-Service -Name $script:SupervisorService -Force }
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

# Deletes the folder -Path and everything in it, through handles (RpaTree): the folders from -From (an existing folder
# above -Path, or -Path itself when not given) down to -Path are held open without delete sharing until the end
# (Windows then refuses another open of them with delete access, which a rename or a move needs); each entry is
# opened inside the folder that holds it, not by a path; a link or junction inside is removed as the link itself and
# not entered. Paths of any length. -From is the highest folder that someone other than an administrator may change
# (the bot user's profile folder for its temp folder); its own path is not checked here. Nothing when -Path is not
# there. A folder on the way that is a link, or that cannot be held open, ends the removal before anything is deleted.
# What cannot be opened or deleted is left and the rest removed, in one pass; then the text names the first entry left.
# -BeforeOpen is for tests only: it runs between the listing of a folder and the opening of each entry, with that
# entry's path.
function Remove-RpaTree([string]$Path, [string]$From, [scriptblock]$BeforeOpen) {
  $Path = $Path.TrimEnd('\')
  if ($From) { $From = $From.TrimEnd('\') } else { $From = $Path }
  if ($Path -ne $From -and -not $Path.StartsWith($From + '\', [StringComparison]::OrdinalIgnoreCase)) { throw ('{0} is not inside {1}.' -f $Path, $From) }
  $below = @()
  if ($Path.Length -gt $From.Length) { $below = @($Path.Substring($From.Length + 1).Split('\')) }
  # Each name is opened inside the folder above it; an empty name would open that folder itself.
  if (@($below | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) { throw ('{0} is not inside {1}.' -f $Path, $From) }
  Add-RpaNativeTypes
  $hook = $null
  if ($BeforeOpen) { $hook = [Action[string]]$BeforeOpen }
  $outcome = [RpaTree]::Remove($From, [string[]]$below, $hook)
  $again = 'Close what is using it and run this again.'
  if ($outcome.Missing) { return }
  if ($outcome.Link) { throw ('{0} is a link or junction. Remove it and run this again.' -f $outcome.Link) }
  if ($outcome.NotFolder) { throw ('Could not remove {0}: {1} is not a folder. Check it and run this again.' -f $Path, $outcome.NotFolder) }
  if ($outcome.Unheld -eq $Path) { throw ('Could not remove {0} ({1}). {2}' -f $Path, $outcome.Reason, $again) }
  if ($outcome.Unheld) { throw ('Could not remove {0}: {1} could not be opened ({2}). {3}' -f $Path, $outcome.Unheld, $outcome.Reason, $again) }
  if ($outcome.Left.Count -gt 0) { throw ('Could not remove {0} ({1}). {2}' -f $outcome.Left[0].Path, $outcome.Left[0].Reason, $again) }
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

# The compiled helpers: LSA secrets, such as the one Windows itself reads the automatic sign-in password from and the
# one the RPA Supervisor reads the bot user's password from (Store writes one; Remove passes no data, which deletes
# it), a password check, the local groups of a user, the creation of a user's profile, the account a process runs as,
# the number of names a file has, the creation of a file that follows no link, and the removal of a folder tree through
# handles (RpaTree, used by Remove-RpaTree). A password goes in as a SecureString and is turned into plain text only in
# unmanaged memory that is wiped afterwards.
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
// What RpaTree.Remove did: Missing when the folder (or one held above it) is not there; else the first folder held
// that is a link (Link) or no folder (NotFolder), or could not be opened (Unheld, Reason), in which case nothing was
// deleted; else what was left (Left: path and reason, deepest first), empty when everything went.
public sealed class RpaTreeEntry {
  public string Path;
  public string Reason;
}
public sealed class RpaTreeOutcome {
  public bool Missing;
  public string Link;
  public string NotFolder;
  public string Unheld;
  public string Reason;
  public System.Collections.Generic.List<RpaTreeEntry> Left = new System.Collections.Generic.List<RpaTreeEntry>();
}
// Removes a folder tree through handles. The folders from the top one down to the one removed are opened one inside
// the other, without following a link, with list access and without delete sharing, and stay open until the end:
// while they are held, Windows refuses another open of them with delete access, which a rename or a move needs (on
// Windows Server 2022 it also refused a rename of a folder above an open one; the removal does not rely on that).
// Each entry of a held folder is opened by its name inside that folder's handle (not by a path), the same way and
// with delete access; its attributes are read from the handle. A link (junction, symbolic link, mount point) is
// deleted as the link itself and not entered; a folder is walked while it is held, then deleted; a file is deleted.
// What cannot be opened or deleted, a folder not empty at the end, and a folder more than MaxDepth below the one
// removed are left, and the walk goes on.
public static class RpaTree {
  public const int MaxDepth = 128;
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct ObjectAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)]
  struct IoStatusBlock { public IntPtr Status; public IntPtr Information; }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicInfo { public long Created; public long Accessed; public long Written; public long Changed; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  struct FileInformation {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Created;
    public System.Runtime.InteropServices.ComTypes.FILETIME Accessed;
    public System.Runtime.InteropServices.ComTypes.FILETIME Written;
    public uint VolumeSerialNumber; public uint SizeHigh; public uint SizeLow; public uint NumberOfLinks; public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out IntPtr handle, uint access, ref ObjectAttributes attributes, out IoStatusBlock status, IntPtr allocationSize, uint fileAttributes, uint share, uint disposition, uint options, IntPtr eaBuffer, uint eaLength);
  [DllImport("ntdll.dll")] static extern int RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetFileInformationByHandleEx")]
  static extern bool GetDirectoryInfo(SafeFileHandle file, int infoClass, IntPtr buffer, uint size);
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetFileInformationByHandle")]
  static extern bool SetBasicInfo(SafeFileHandle file, int infoClass, ref BasicInfo info, uint size);
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetFileInformationByHandle")]
  static extern bool SetFlags(SafeFileHandle file, int infoClass, ref uint flags, uint size);
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetFileInformationByHandle")]
  static extern bool SetFlag(SafeFileHandle file, int infoClass, ref byte flag, uint size);
  const uint ListDirectory = 0x1, ReadAttributes = 0x80, WriteAttributes = 0x100, Delete = 0x10000, Synchronize = 0x100000;
  // Read and write sharing only: a handle held here keeps everyone else from opening the entry with delete access,
  // which a rename, a move and a delete need.
  const uint ShareReadWrite = 0x1 | 0x2;
  const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
  // NtCreateFile: open an existing entry, without following a link, for backup (any kind of entry), synchronous.
  const uint FileOpen = 1, OpenReparsePointOption = 0x00200000, OpenForBackupIntent = 0x4000, SynchronousIo = 0x20;
  const uint CaseInsensitive = 0x40;
  const uint ReadOnly = 0x1, Directory = 0x10, ReparsePoint = 0x400;
  // The attributes a file's basic information may set; FILE_ATTRIBUTE_NORMAL when none is left.
  const uint Settable = 0x2 | 0x4 | 0x20 | 0x100 | 0x1000 | 0x2000, Normal = 0x80;
  const int FileBasicInfo = 0, FileDispositionInfo = 4, FileFullDirectoryInfo = 14, FileFullDirectoryRestartInfo = 15, FileDispositionInfoEx = 21;
  const int NotFound = 2, PathNotFound = 3, NoMoreFiles = 18;

  // top: the highest folder to hold, by its full path; below: the names from there down to the folder to remove (none
  // when it is top). beforeOpen, for tests only: called with an entry's path between the listing and its opening.
  public static RpaTreeOutcome Remove(string top, string[] below, Action<string> beforeOpen) {
    RpaTreeOutcome outcome = new RpaTreeOutcome();
    System.Collections.Generic.List<SafeFileHandle> held = new System.Collections.Generic.List<SafeFileHandle>();
    try {
      string path = top;
      for (int i = 0; i <= below.Length; i++) {
        bool last = i == below.Length;
        uint access = ListDirectory | ReadAttributes | Synchronize;
        if (last) access |= WriteAttributes | Delete;
        SafeFileHandle handle;
        int error;
        if (i == 0) {
          handle = CreateFile(@"\\?\" + top, access, ShareReadWrite, IntPtr.Zero, 3, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
          error = 0;
          if (handle.IsInvalid) { error = Marshal.GetLastWin32Error(); handle.Dispose(); }
        } else {
          path = path + "\\" + below[i - 1];
          error = OpenInside(held[i - 1], below[i - 1], access, out handle);
        }
        if (error == NotFound || error == PathNotFound) { outcome.Missing = true; return outcome; }
        if (error != 0) { outcome.Unheld = path; outcome.Reason = Message(error); return outcome; }
        held.Add(handle);
        uint attributes, links;
        error = Read(handle, out attributes, out links);
        if (error != 0) { outcome.Unheld = path; outcome.Reason = Message(error); return outcome; }
        if ((attributes & ReparsePoint) != 0) { outcome.Link = path; return outcome; }
        if ((attributes & Directory) == 0) { outcome.NotFolder = path; return outcome; }
        if (last) {
          Walk(handle, path, 0, path, outcome.Left, beforeOpen);
          string problem = DeleteThrough(handle, attributes, links);
          if (problem != null) Leave(outcome.Left, path, problem);
        }
      }
      return outcome;
    } finally {
      for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
    }
  }

  static void Walk(SafeFileHandle folder, string path, int depth, string root, System.Collections.Generic.List<RpaTreeEntry> left, Action<string> beforeOpen) {
    System.Collections.Generic.List<string> names;
    int error = List(folder, out names);
    if (error != 0) { Leave(left, path, Message(error)); return; }
    foreach (string name in names) {
      string entry = path + "\\" + name;
      if (beforeOpen != null) beforeOpen(entry);
      SafeFileHandle handle;
      error = OpenInside(folder, name, ListDirectory | ReadAttributes | WriteAttributes | Delete | Synchronize, out handle);
      // Gone since the listing: nothing to remove.
      if (error == NotFound || error == PathNotFound) continue;
      if (error != 0) { Leave(left, entry, Message(error)); continue; }
      using (handle) {
        uint attributes, links;
        error = Read(handle, out attributes, out links);
        if (error != 0) { Leave(left, entry, Message(error)); continue; }
        if ((attributes & Directory) != 0 && (attributes & ReparsePoint) == 0) {
          if (depth + 1 > MaxDepth) { Leave(left, entry, "it is more than " + MaxDepth + " folders below " + root); continue; }
          Walk(handle, entry, depth + 1, root, left, beforeOpen);
        }
        string problem = DeleteThrough(handle, attributes, links);
        if (problem != null) Leave(left, entry, problem);
      }
    }
  }

  // Opens the entry name inside the folder held by parent; 0 or the Windows error code.
  static int OpenInside(SafeFileHandle parent, string name, uint access, out SafeFileHandle handle) {
    handle = null;
    UnicodeString text = new UnicodeString();
    text.Buffer = Marshal.StringToHGlobalUni(name);
    text.Length = (ushort)(name.Length * 2);
    text.MaximumLength = (ushort)(name.Length * 2);
    IntPtr textPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
    bool added = false;
    try {
      Marshal.StructureToPtr(text, textPointer, false);
      parent.DangerousAddRef(ref added);
      ObjectAttributes attributes = new ObjectAttributes();
      attributes.Length = Marshal.SizeOf(typeof(ObjectAttributes));
      attributes.RootDirectory = parent.DangerousGetHandle();
      attributes.ObjectName = textPointer;
      attributes.Attributes = CaseInsensitive;
      IntPtr raw;
      IoStatusBlock status;
      int result = NtCreateFile(out raw, access, ref attributes, out status, IntPtr.Zero, 0, ShareReadWrite, FileOpen, OpenReparsePointOption | OpenForBackupIntent | SynchronousIo, IntPtr.Zero, 0);
      if (result < 0) return RtlNtStatusToDosError(result);
      handle = new SafeFileHandle(raw, true);
      return 0;
    } finally {
      if (added) parent.DangerousRelease();
      Marshal.FreeHGlobal(textPointer);
      Marshal.FreeHGlobal(text.Buffer);
    }
  }

  // The attributes of the entry held by handle and how many names it has (more than one: a hard link).
  static int Read(SafeFileHandle handle, out uint attributes, out uint links) {
    FileInformation information;
    attributes = 0;
    links = 0;
    if (!GetFileInformationByHandle(handle, out information)) return Marshal.GetLastWin32Error();
    attributes = information.Attributes;
    links = information.NumberOfLinks;
    return 0;
  }

  // The names in a held folder, read from its handle.
  static int List(SafeFileHandle folder, out System.Collections.Generic.List<string> names) {
    names = new System.Collections.Generic.List<string>();
    const int size = 65536;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      int infoClass = FileFullDirectoryRestartInfo;
      while (true) {
        if (!GetDirectoryInfo(folder, infoClass, buffer, size)) {
          int error = Marshal.GetLastWin32Error();
          return error == NoMoreFiles ? 0 : error;
        }
        infoClass = FileFullDirectoryInfo;
        int offset = 0;
        while (true) {
          // FILE_FULL_DIR_INFO: NextEntryOffset at 0, FileNameLength (bytes) at 60, FileName at 68.
          int next = Marshal.ReadInt32(buffer, offset);
          int length = Marshal.ReadInt32(buffer, offset + 60);
          string name = Marshal.PtrToStringUni(new IntPtr(buffer.ToInt64() + offset + 68), length / 2);
          if (name != "." && name != "..") names.Add(name);
          if (next == 0) break;
          offset += next;
        }
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  // Deletes the entry held by handle when its last handle closes: a read-only attribute is cleared first, then the
  // entry is marked for deletion, with POSIX semantics where the file system has them (the name goes when this handle
  // closes, also while another program has the entry open). The attributes belong to the file, not to one of its
  // names, so they are not changed on a file with another name elsewhere. Nothing when that worked, else why not.
  static string DeleteThrough(SafeFileHandle handle, uint attributes, uint links) {
    if ((attributes & ReadOnly) != 0) {
      if (links > 1) return "it is read-only and has another name (a hard link), so its attributes were not changed";
      BasicInfo info = new BasicInfo();
      info.Attributes = attributes & Settable;
      if (info.Attributes == 0) info.Attributes = Normal;
      if (!SetBasicInfo(handle, FileBasicInfo, ref info, (uint)Marshal.SizeOf(typeof(BasicInfo)))) return Message(Marshal.GetLastWin32Error());
    }
    // FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
    uint flags = 0x1 | 0x2;
    if (SetFlags(handle, FileDispositionInfoEx, ref flags, 4)) return null;
    int error = Marshal.GetLastWin32Error();
    // A file system without the extended form: invalid function, not supported, invalid parameter.
    if (error == 1 || error == 50 || error == 87) {
      byte delete = 1;
      if (SetFlag(handle, FileDispositionInfo, ref delete, 1)) return null;
      error = Marshal.GetLastWin32Error();
    }
    return Message(error);
  }

  static void Leave(System.Collections.Generic.List<RpaTreeEntry> left, string path, string reason) {
    RpaTreeEntry entry = new RpaTreeEntry();
    entry.Path = path;
    entry.Reason = reason;
    left.Add(entry);
  }

  static string Message(int error) {
    return new Win32Exception(error).Message.TrimEnd('.', ' ', '\r', '\n');
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

# The installer's one connection through the RPA Supervisor (RpaProbe), compiled on its own: a PowerShell window that
# loaded the compiled helpers of an earlier installer has the other types already, without this one.
function Add-RpaProbeType {
  if ('RpaProbe' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
// The installer's one connection through the RPA Supervisor: to the runner's port on 127.0.0.1, a TLS handshake that
// takes any certificate (the runner's is its own; nothing is sent after the handshake, and the connection is closed).
// Null when it finished within the time, else why not.
public static class RpaProbe {
  public static string Handshake(int port, int milliseconds) {
    System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
    try {
      using (System.Net.Sockets.TcpClient client = new System.Net.Sockets.TcpClient()) {
        if (!client.ConnectAsync(System.Net.IPAddress.Loopback, port).Wait(milliseconds)) return "no connection within " + (milliseconds / 1000) + " s";
        int left = (int)Math.Max(1, milliseconds - watch.ElapsedMilliseconds);
        client.ReceiveTimeout = left;
        client.SendTimeout = left;
        using (System.Net.Security.SslStream tls = new System.Net.Security.SslStream(client.GetStream(), false, delegate { return true; })) {
          tls.AuthenticateAsClient("localhost", null, System.Security.Authentication.SslProtocols.Tls12, false);
        }
        return null;
      }
    } catch (Exception e) {
      return e.GetBaseException().Message.TrimEnd('.', ' ', '\r', '\n');
    }
  }
}
'@
}

# What moving from automatic sign-in to -Unattended needs, compiled on its own (a PowerShell window that loaded the
# helpers of an earlier installer has the other types already): reading an LSA secret into a SecureString (RpaLsaRead),
# and the Windows sessions of a user and their sign-out (RpaSessions).
function Add-RpaMoveTypes {
  if ('RpaSessions' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
public static class RpaLsaRead {
  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct ObjectAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr systemName, ref ObjectAttributes attributes, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaRetrievePrivateData(IntPtr policy, ref UnicodeString key, out IntPtr data);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr buffer);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  const uint PolicyGetPrivateInformation = 0x4;
  const uint StatusObjectNameNotFound = 0xC0000034;
  // The secret as a read-only SecureString, without a NUL at its end; null when it is missing or empty. The plain
  // text exists only in the memory LSA returns, which is wiped before it is freed.
  public static SecureString Read(string key) {
    ObjectAttributes attributes = new ObjectAttributes();
    attributes.Length = Marshal.SizeOf(typeof(ObjectAttributes));
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyGetPrivateInformation, out policy);
    if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    UnicodeString k = new UnicodeString();
    k.Buffer = Marshal.StringToHGlobalUni(key);
    k.Length = (ushort)(key.Length * 2);
    k.MaximumLength = (ushort)(key.Length * 2 + 2);
    IntPtr data = IntPtr.Zero;
    try {
      status = LsaRetrievePrivateData(policy, ref k, out data);
      if (status == StatusObjectNameNotFound) return null;
      if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
      if (data == IntPtr.Zero) return null;
      UnicodeString value = (UnicodeString)Marshal.PtrToStructure(data, typeof(UnicodeString));
      if (value.Buffer == IntPtr.Zero) return null;
      int count = value.Length / 2;
      while (count > 0 && Marshal.ReadInt16(value.Buffer, (count - 1) * 2) == 0) count--;
      SecureString secret = new SecureString();
      for (int i = 0; i < count; i++) secret.AppendChar((char)Marshal.ReadInt16(value.Buffer, i * 2));
      Marshal.Copy(new byte[value.Length], 0, value.Buffer, value.Length);
      secret.MakeReadOnly();
      if (secret.Length == 0) { secret.Dispose(); return null; }
      return secret;
    } finally {
      if (data != IntPtr.Zero) LsaFreeMemory(data);
      Marshal.FreeHGlobal(k.Buffer);
      LsaClose(policy);
    }
  }
}
public static class RpaSessions {
  [StructLayout(LayoutKind.Sequential)]
  struct SessionInfo { public int SessionId; public IntPtr WinStationName; public int State; }
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr info, out int count);
  [DllImport("wtsapi32.dll", SetLastError = true, EntryPoint = "WTSQuerySessionInformationW")] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSLogoffSession(IntPtr server, int session, bool wait);
  const int UserName = 5, DomainName = 7;
  // The ids of the sessions in which domain\user is signed in, in any state.
  public static int[] OfUser(string domain, string user) {
    IntPtr info;
    int count;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out info, out count)) throw new Win32Exception(Marshal.GetLastWin32Error());
    List<int> ids = new List<int>();
    try {
      int size = Marshal.SizeOf(typeof(SessionInfo));
      for (int i = 0; i < count; i++) {
        SessionInfo session = (SessionInfo)Marshal.PtrToStructure(new IntPtr(info.ToInt64() + i * size), typeof(SessionInfo));
        if (string.Equals(Query(session.SessionId, UserName), user, StringComparison.OrdinalIgnoreCase)
            && string.Equals(Query(session.SessionId, DomainName), domain, StringComparison.OrdinalIgnoreCase)) ids.Add(session.SessionId);
      }
    } finally {
      WTSFreeMemory(info);
    }
    return ids.ToArray();
  }
  static string Query(int session, int infoClass) {
    IntPtr buffer;
    int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, session, infoClass, out buffer, out bytes)) return "";
    try { return Marshal.PtrToStringUni(buffer) ?? ""; } finally { WTSFreeMemory(buffer); }
  }
  // Signs a session out and returns when it is gone.
  public static void SignOut(int session) {
    if (!WTSLogoffSession(IntPtr.Zero, session, true)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
}

# Signs every session of the bot user out (the console session automatic sign-in made, and any other), so that the
# RPA Supervisor, which refuses runs while a session it did not make is there, can sign it in for each run. Programs
# in those sessions end the way they end at any sign-out.
function Close-RpaBotSessions([hashtable]$Run) {
  Add-RpaMoveTypes
  foreach ($id in @([RpaSessions]::OfUser($Run.Account.Domain, $Run.Account.Name))) {
    Write-Host ('    sign out session {0}' -f $id)
    [RpaSessions]::SignOut($id)
  }
}

# A standard local user (member of Users only) whose password never expires. Without -UserPassword the password is
# random, is made here and is stored only for automatic sign-in or for the RPA Supervisor (the plan refuses a new user
# with none of the three).
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
  # New-LocalUser leaves "password not required" set; a password is required.
  Invoke-RpaNative net.exe @('user', $Account.Name, '/passwordreq:yes')
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
# Administrators own all of them: the runner refuses a policy whose file or folder anyone else owns.
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

# Looks again at everything in the data directory, directly before access rules are set that pass on to what is in
# it: the bot user can put a link, or a second name for another file, into it and into logs\ at any time, also after
# the plan looked. Refuses the first one with the plan's text, and so for policy.json and the two tokens.
function Assert-RpaDataUnlinked([hashtable]$Layout) {
  $refusal = Get-RpaDataLinkRefusal (Get-RpaDataEntries $Layout.DataDir)
  if ($refusal) { throw $refusal }
  foreach ($name in $script:DataFiles.Keys) { Assert-RpaPathUsable (Join-Path $Layout.DataDir $name) $true }
}

# %ProgramData%\RPA Runner, logs\ and policy-backups\. One that is missing is created with its owner and rules. One
# that is there is used only when it is no link and, for the data directory and policy-backups\, Administrators or
# SYSTEM own it; the rules of the data directory and of logs\ are then replaced, and policy-backups\ is left to the
# policy tool. Directly before each of these two is given its rules, everything in the data directory is looked at
# again for a link and a file with a second name, on every run. With -Judge (the user of the install is new to the
# data directory) everything that was in it already is also judged by owner, once only administrators and the bot
# user can put anything into it; -OwnSid is that user when it was there before this run. policy.json and the tokens
# get their rules again on every run, which also gives another -User its read access.
function Protect-RpaDataDirectory([hashtable]$Layout, [string]$Sid, [bool]$Judge, [string]$OwnSid) {
  foreach ($folder in @(@{ Path = $Layout.DataDir; Kind = 'directory'; CheckOwner = $true }, @{ Path = $Layout.LogDir; Kind = 'logs'; CheckOwner = $false })) {
    $rules = Get-RpaAccessRules $folder.Kind $Sid
    New-RpaProtectedFolder $folder.Path $rules
    # Also after creating it: CreateDirectory does not say when someone else made the folder a moment earlier.
    Assert-RpaPathUsable $folder.Path $folder.CheckOwner
    Assert-RpaDataUnlinked $Layout
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

# Removes the two token files on a change of user: the earlier bot user could read them, and the steps after this one
# write new ones. Each is looked at again first; a link or a file with a second name in its place is refused and not
# removed.
function Remove-RpaOldTokens([hashtable]$Layout) {
  foreach ($name in 'token', 'browser-token') {
    $path = Join-Path $Layout.DataDir $name
    if (-not (Get-RpaPathState $path).Exists) { continue }
    Assert-RpaPathUsable $path $true
    [IO.File]::Delete($path)
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
# mode is unattended for an install with -Unattended, else signedIn; with unattended the record also holds what the
# RPA Supervisor reads (desktop/runner/src/Rpa.Supervisor.Core/InstallFile.cs): the idle time, the ports the runner and
# the browser listen on behind it (their port + 10000, on 127.0.0.1), and the addresses it listens on, which are those
# the runner and the browser listen on in the signed-in mode; without a browser there is no browser port. The user is
# a local user's plain name there. signInChanges are the records of what -AutoSignIn and -Unattended changed;
# -Leftovers is the list an earlier uninstall left of what it could not put back, or nothing. No password goes in.
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
  $record = [ordered]@{
    version       = $Version
    user          = $Account.Display
    runnerPort    = [int]$Parameters.RunnerPort
    browserPort   = [int]$Parameters.BrowserPort
    browser       = -not $Parameters.NoBrowser
    autoSignIn    = (@($Plan.Steps) -contains 'turn on automatic sign-in') -or [bool]($Previous -and $Previous.autoSignIn -eq $true)
    allowFrom     = $allowFrom
    publicNetwork = $publicNetwork
    mode          = 'signedIn'
  }
  if ($Plan.Unattended) {
    $record.mode = 'unattended'
    $record.idleSeconds = [int]$Plan.IdleSeconds
    $record.runnerInnerPort = [int]$Parameters.RunnerPort + $script:InnerPortOffset
    if ($Parameters.NoBrowser) { $record.browserPort = $null }
    else { $record.browserInnerPort = [int]$Parameters.BrowserPort + $script:InnerPortOffset }
    $record.listenAddresses = @('0.0.0.0')
  }
  $record.signInChanges = $changes
  $record
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

# ---- What -Unattended changes. Each change is recorded in install.json before it is made (Add-RpaSignInChange), with
# what was there, so that a failed install, Uninstall-Rpa.ps1 and an install with -Unattended:$false put it back
# (Restore-RpaSignInChange). ----

# The bot user into Remote Desktop Users, which Windows' default rights let sign in through Remote Desktop, unless it
# is a member already, directly or through another group. Then only the membership this run added is recorded.
function Add-RpaRemoteDesktopUser([hashtable]$Run) {
  Add-RpaNativeTypes
  $group = (Get-RpaAccountName (New-Object Security.Principal.SecurityIdentifier $script:RemoteDesktopUsers)).Split('\')[-1]
  if (@([RpaAccounts]::LocalGroups($Run.Account.Name)) -contains $group) { return }
  Add-RpaSignInChange $Run ([ordered]@{ kind = 'group'; key = $script:RemoteDesktopUsers; name = $Run.Sid; value = $Run.Account.Display })
  Add-LocalGroupMember -SID $script:RemoteDesktopUsers -Member $Run.Sid
}

# On a change of bot user: takes an earlier bot user out of Remote Desktop Users when this installer put it there (its
# record is in install.json), and drops that record.
function Remove-RpaEarlierRemoteDesktopUsers([hashtable]$Run) {
  $earlier = @($Run.Install.signInChanges | Where-Object { $_ -and $_.kind -eq 'group' -and [string]$_.key -eq $script:RemoteDesktopUsers -and [string]$_.name -ne $Run.Sid })
  foreach ($record in $earlier) {
    Remove-RpaGroupMember $script:RemoteDesktopUsers ([string]$record.name)
    $id = Get-RpaChangeId $record
    $Run.Install.signInChanges = @($Run.Install.signInChanges | Where-Object { (Get-RpaChangeId $_) -ne $id })
    Save-RpaInstallFile $Run
  }
}

# Takes a member out of a local group, both named by SID. One that is not in it (any more) is no error: Windows takes a
# user that is removed out of its groups.
function Remove-RpaGroupMember([string]$Group, [string]$Member) {
  try { Remove-LocalGroupMember -SID $Group -Member $Member -ErrorAction Stop }
  catch { if ($_.FullyQualifiedErrorId -notmatch '^(MemberNotFound|PrincipalNotFound)') { throw } }
}

# Remote Desktop on, by the registry value alone and only when it is off (1), after recording that it was off. The
# value alone does not turn on Windows' firewall rules for Remote Desktop (Settings would): the RPA Supervisor connects
# from this machine to itself, and those rules stay as they are.
function Enable-RpaRemoteDesktop([hashtable]$Run) {
  $record = Get-RpaRegistryRecord $script:TerminalServer 'fDenyTSConnections'
  if (-not ($record.existed -and $record.type -eq 'REG_DWORD' -and $record.value -eq '1')) { return }
  Add-RpaSignInChange $Run $record
  Set-RpaRegistryValue $script:TerminalServer 'fDenyTSConnections' 'REG_DWORD' '0'
}

# Registers the service RPA Supervisor and starts it: first its folder, created in one call for SYSTEM and
# Administrators only (one that is there is used only when it is no link and Administrators or SYSTEM own it, as the
# plan judged); its event source in the Application log, where it says why it did not start when that folder is wrong;
# then the service: LocalSystem, started with Windows after the Remote Desktop service, started again a minute after
# a failure. A service of that name that is there is removed first, so that the one that runs is this one. The start
# also ends a block on sign-ins that a wrong password left (the supervisor tries no sign-in after one until it starts
# again), so it follows a newly stored password.
function Register-RpaSupervisor([hashtable]$Run) {
  $layout = $Run.Layout
  New-RpaProtectedFolder $layout.SupervisorDir (Get-RpaAccessRules 'backups' '')
  # Also after creating it: CreateDirectory does not say when someone else made the folder a moment earlier.
  Assert-RpaPathUsable $layout.SupervisorDir $true
  Add-RpaSignInChange $Run ([ordered]@{ kind = 'service'; key = $script:SupervisorService; name = '' })
  Remove-RpaSupervisorService
  if (-not [Diagnostics.EventLog]::SourceExists($script:SupervisorService)) { New-EventLog -LogName Application -Source $script:SupervisorService }
  # Quoted, because the path holds spaces: unquoted, Windows would try C:\Program.exe first.
  $exe = Get-RpaSupervisorPath $layout.InstallDir
  $description = 'Signs the RPA bot user in through a Remote Desktop connection from this machine to itself when n8n connects, and out again afterwards.'
  New-Service -Name $script:SupervisorService -BinaryPathName $exe -DisplayName $script:SupervisorService -Description $description -StartupType Automatic -DependsOn 'TermService' | Out-Null
  Invoke-RpaNative sc.exe @('failure', $script:SupervisorService, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/60000')
  Start-Service -Name $script:SupervisorService
}

# Stops and deletes the service RPA Supervisor when it is there (its stop signs its session out first), and waits until
# Windows has removed it. A program that holds the service open (the Services window) keeps it there until it lets go.
function Remove-RpaSupervisorService {
  if (-not (Get-Service -Name $script:SupervisorService -ErrorAction SilentlyContinue)) { return }
  Stop-Service -Name $script:SupervisorService -Force
  Invoke-RpaNative sc.exe @('delete', $script:SupervisorService)
  for ($try = 0; $try -lt 20; $try++) {
    if (-not (Get-Service -Name $script:SupervisorService -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw ('The service {0} is marked for deletion and still there. Close the Services window and any other program that has it open, and run this again.' -f $script:SupervisorService)
}

# The program path of a service as Windows keeps it (quotes included), or nothing when there is no such service.
function Get-RpaServicePath([string]$Name) {
  $service = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $Name) -ErrorAction SilentlyContinue
  if ($service) { [string]$service.PathName }
}

# The program path of this install's RPA Supervisor as Windows keeps it for the service, quotes included.
function Get-RpaSupervisorPath([string]$InstallDir) {
  '"{0}\runner\RpaSupervisor.exe"' -f $InstallDir.TrimEnd('\')
}

# Puts back what the step 'register the supervisor service' did: the service and its event source. Its folder stays
# with the data directory, as the logs do.
function Remove-RpaSupervisor {
  Remove-RpaSupervisorService
  if ([Diagnostics.EventLog]::SourceExists($script:SupervisorService)) { Remove-EventLog -Source $script:SupervisorService }
}

# One connection to the runner's port on this machine, through the RPA Supervisor, which signs the bot user in for it.
# The first sign-in of a user creates its profile and takes tens of seconds, which n8n's first run would otherwise
# wait for. The wait ends at the runner's answer (a TLS handshake; nothing is sent after it) or after 120 s, and says
# how long it took. Not answered is a warning with the supervisor's last failure, not a failed install: a later
# connection can still work. The supervisor signs the bot user out again after the idle time.
function Wait-RpaFirstSignIn([hashtable]$Run, [int]$Port) {
  # Whatever fails here is said in a warning; it does not fail the install.
  try {
    Write-Host ('    waiting for the first sign-in of {0} through the RPA Supervisor (up to {1} s)' -f $Run.Account.Display, $script:FirstSignInSeconds)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
      Add-RpaProbeType
      $problem = [RpaProbe]::Handshake($Port, $script:FirstSignInSeconds * 1000)
    } catch { $problem = $_.Exception.GetBaseException().Message }
    $seconds = [int]$watch.Elapsed.TotalSeconds
    if (-not $problem) {
      Write-Host ('    {0} was signed in, and the runner answered after {1} s' -f $Run.Account.Display, $seconds)
      return
    }
    $text = 'The runner did not answer through the RPA Supervisor within {0} s ({1}).' -f $seconds, $problem
    try {
      $failure = (Get-Content -Raw -LiteralPath (Join-Path $Run.Layout.SupervisorDir 'supervisor-state.json') -ErrorAction Stop | ConvertFrom-Json).lastFailure
      if ($failure) { $text += " The supervisor's last failure: $failure" }
    } catch { }
    Write-Warning ('{0} A later connection can still work; see Show-RpaConnection.ps1 and {1}.' -f $text, (Join-Path $Run.Layout.SupervisorDir 'supervisor.log'))
  } catch {
    Write-Warning ('The first sign-in through the RPA Supervisor could not be checked: {0} A later connection can still work; see Show-RpaConnection.ps1.' -f $_.Exception.GetBaseException().Message)
  }
}

# Points a firewall rule of the installer at another program; nothing when the rule is not there. Who may connect
# (the addresses and networks) stays as it is.
function Set-RpaFirewallRuleProgram([string]$Name, [string]$Program) {
  $rule = Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue
  if ($rule) { $rule | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $Program }
}

# The program a firewall rule of the installer is for in the signed-in mode: the runner, or the browser's node.exe.
function Get-RpaSignedInProgram([string]$Rule) {
  $installDir = (Get-RpaLayout).InstallDir
  if ($Rule -eq $script:BrowserRule) { return Join-Path (Join-Path $installDir 'browser') 'node.exe' }
  Join-Path (Join-Path $installDir 'runner') 'RpaRunner.exe'
}

# The rules for the runner's port and the browser's let connections in to the RPA Supervisor, which listens on both.
function Set-RpaSupervisorFirewall([hashtable]$Run, [bool]$Browser) {
  $exe = Join-Path (Join-Path $Run.Layout.InstallDir 'runner') 'RpaSupervisor.exe'
  $rules = @($script:RunnerRule)
  if ($Browser) { $rules += $script:BrowserRule }
  foreach ($rule in $rules) {
    Add-RpaSignInChange $Run ([ordered]@{ kind = 'firewall'; key = $rule; name = '' })
    Set-RpaFirewallRuleProgram $rule $exe
  }
}

# Whether a record in install.json is one of what -Unattended changed.
function Test-RpaUnattendedChange($Change) {
  switch ([string]$Change.kind) {
    { 'group', 'service', 'firewall' -contains $_ } { return $true }
    'secret' { return [string]$Change.key -eq $script:SupervisorSecret }
    'registry' { return [string]$Change.key -eq $script:TerminalServer -and [string]$Change.name -eq 'fDenyTSConnections' }
  }
  $false
}

# The step 'put back what -Unattended changed', for an install with -Unattended:$false over one with -Unattended: puts back what
# install.json records of -Unattended (the firewall rules, the service, the stored password, Remote Desktop, the group
# membership), the last first, and keeps in install.json only the records of what it could not put back. Those fail
# the step, so that the next run or Uninstall-Rpa.ps1 tries them again.
function Undo-RpaUnattended([hashtable]$Run) {
  $changes = @($Run.Install.signInChanges | Where-Object { $_ -and (Test-RpaUnattendedChange $_) })
  if ($changes.Count -eq 0) { return }
  $failed = @(Restore-RpaSignInChanges $changes $false)
  $left = @($failed | Where-Object { $_.Change } | ForEach-Object { Get-RpaChangeId $_.Change })
  $done = @($changes | ForEach-Object { Get-RpaChangeId $_ } | Where-Object { $left -notcontains $_ })
  $Run.Install.signInChanges = @($Run.Install.signInChanges | Where-Object { $done -notcontains (Get-RpaChangeId $_) })
  Save-RpaInstallFile $Run
  if ($failed.Count -gt 0) { throw ('Could not put back: {0}' -f (@($failed | ForEach-Object { $_.Text }) -join '; ')) }
}

# On a failed upgrade: install.json's mode, the RPA Supervisor's fields and the browser port go back to what the
# record before this run said (an older record without a mode was signed in), so that the start scripts do not move
# the runner and the browser behind a supervisor that the undo removed.
# Only when this run wrote unattended over a record that was not: a failed run with -Unattended:$false over an unattended
# install keeps the signed-in mode it wrote, because what the supervisor needs may be gone by then.
function Restore-RpaModeBefore([hashtable]$Run) {
  $before = $Run.Before
  if (-not $before -or $Run.Install.mode -ne 'unattended' -or [string]$before.mode -eq 'unattended') { return }
  foreach ($field in 'browserPort', 'mode', 'idleSeconds', 'runnerInnerPort', 'browserInnerPort', 'listenAddresses') {
    $property = $before.PSObject.Properties[$field]
    if ($property) { $Run.Install[$field] = $property.Value }
    elseif ($field -eq 'mode') { $Run.Install[$field] = 'signedIn' }
    elseif ($Run.Install.Contains($field)) { $Run.Install.Remove($field) }
  }
}

# After a failed step: puts back the sign-in changes this run made and removes a user this run created, so that the
# installer can be run again with the same parameters. A first install that got as far as install.json loses it again;
# an upgrade keeps it, without this run's sign-in records and with the mode it had before.
# When a change cannot be put back, nothing more is removed: install.json stays and keeps the records of what could
# not be put back (and says that automatic sign-in is not on), so that Uninstall-Rpa.ps1 and a later run still know
# what was there before; and a user this run created stays, because those records and what is left in Windows name it.
# Returns the lines that name what could not be put back (NotPutBack) and the user that was kept (UserKept).
function Undo-RpaFailedRun([hashtable]$Run) {
  $failed = @()
  if (@($Run.NewChanges).Count -gt 0) {
    Write-Host '  undo: put back the settings this run changed'
    $failed = @(Restore-RpaSignInChanges $Run.NewChanges $false)
  }
  $newIds = @($Run.NewChanges | ForEach-Object { Get-RpaChangeId $_ })
  # A run that moved from automatic sign-in turns it on again, with the password it kept in memory.
  if ($Run.AutoSignInTurnedOff) { $failed += @(Enable-RpaAutoSignInAgain $Run) }
  $result = @{ NotPutBack = @($failed | ForEach-Object { $_.Text }); UserKept = $null }
  if ($failed.Count -gt 0) {
    $leftIds = @($failed | Where-Object { $_.Change } | ForEach-Object { Get-RpaChangeId $_.Change })
    $Run.Install.signInChanges = @($Run.Install.signInChanges | Where-Object { $id = Get-RpaChangeId $_; ($newIds -notcontains $id) -or ($leftIds -contains $id) })
    $Run.Install.autoSignIn = $Run.AutoSignInBefore
    Restore-RpaModeBefore $Run
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
      Restore-RpaModeBefore $Run
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
  # The programs, the tools the closing lines name, and what the browser host loads.
  $needed = @('VERSION', 'runner\RpaRunner.exe', 'runner\RpaPolicy.exe', 'runner\RpaSupervisor.exe', 'scripts\start-loop.ps1', 'scripts\start-runner.ps1', 'scripts\Show-RpaConnection.ps1')
  if (-not $Parameters.NoBrowser) {
    $needed += 'browser\node.exe', 'browser\host\host.mjs', 'browser\host\run-server.mjs', 'browser\gate\gate.mjs', 'browser\node_modules\playwright\cli.js', 'scripts\start-browser.ps1'
  }
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
    # The record before this run, for the mode a failed upgrade goes back to.
    Before           = $previous
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
        'remove the old tokens' { Remove-RpaOldTokens $layout }
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
        'put back what -Unattended changed' { Undo-RpaUnattended $run }
        'store sign-in password' { Set-RpaSignInPassword $run }
        'turn on automatic sign-in' { Enable-RpaAutoSignIn $run }
        'keep the desktop unlocked' { Set-RpaDesktopUnlocked $run }
        'allow the bot user to sign in through Remote Desktop' {
          Remove-RpaEarlierRemoteDesktopUsers $run
          Add-RpaRemoteDesktopUser $run
        }
        'turn on Remote Desktop' { Enable-RpaRemoteDesktop $run }
        "store the bot user's password for the supervisor" { Set-RpaSupervisorPassword $run }
        'keep the automatic sign-in password for the supervisor' { Copy-RpaAutoSignInPassword $run }
        'turn off automatic sign-in' { Disable-RpaAutoSignIn $run }
        'sign the bot user out' { Close-RpaBotSessions $run }
        'register the supervisor service' {
          Register-RpaSupervisor $run
          Wait-RpaFirstSignIn $run $runnerPort
        }
        'point the firewall rules at the supervisor' { Set-RpaSupervisorFirewall $run (-not $Parameters.NoBrowser) }
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
    # The RPA Supervisor signs the bot user in on an install with -Unattended; stopping it signs that session out.
    Unattended        = [bool]($install -and $install.mode -eq 'unattended')
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

# Switches the two tasks on again and starts them, and the RPA Supervisor when its service runs this install's program,
# after a stop that is not followed by an upgrade or a removal.
function Resume-RpaServices {
  foreach ($name in $script:RunnerTask, $script:BrowserTask) {
    Get-ScheduledTask -TaskPath $script:TaskPath -TaskName $name -ErrorAction SilentlyContinue | Enable-ScheduledTask | Out-Null
  }
  Start-RpaTasks
  if ((Get-RpaServicePath $script:SupervisorService) -ieq (Get-RpaSupervisorPath (Get-RpaLayout).InstallDir)) { Start-Service -Name $script:SupervisorService }
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

# Who other than the account -Sid, Administrators and SYSTEM owns the folder -Path or may change it, by name: an
# allowing access rule of the folder itself (not one that applies only to what is created inside it) that lets write,
# add a file or folder, delete, delete what is inside, change the rules or take ownership. Read without following a
# link. Rules that cannot be read count as someone's whose name cannot be read.
function Get-RpaOtherWriters([string]$Path, [string]$Sid) {
  $trusted = @($script:TrustedOwners) + $Sid
  # Write data or add a file, append data or add a folder, write extended attributes, delete what is inside, write
  # attributes, delete, change the rules, take ownership; and generic write and all.
  $write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  try {
    $acl = Get-Acl -LiteralPath $Path
    $names = @()
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($trusted -notcontains $owner.Value) { $names += Get-RpaAccountName $owner }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
      if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      if ($trusted -contains $rule.IdentityReference.Value -or ([int]$rule.FileSystemRights -band $write) -eq 0) { continue }
      $names += Get-RpaAccountName $rule.IdentityReference
    }
    @($names | Select-Object -Unique)
  } catch { @('someone whose name cannot be read') }
}

# Removes what the browser host keeps in the local application data of the bot user: the folder RPA Runner there,
# which holds browser-temp, the temp folder of the browser server. A host that was ended without a chance to stop
# leaves a session's trace in it, with what was typed into pages, until its next start. -Accounts, -RunningSids and
# -UnknownProcesses are what Get-RpaUninstallFacts returned; only an account marked Bot is looked at. The profile is
# found by the account's SID in Windows' list of profiles (not by a name or a variable), and the local application
# data is taken to be AppData\Local in it, where Windows puts it.
# The folders belong to the bot user, which can put a link in the place of any of them, and the removal runs as an
# administrator. So the folder is left as it is, with the reason:
#   - while a process of that account is running, or one whose account cannot be read (the test -RemoveData uses:
#     owners read from the processes' tokens, matched by SID);
#   - when, directly before the removal, the profile folder, AppData, Local or RPA Runner is a link or junction or is
#     no folder: nothing is removed where a link points;
#   - when, in that same last look, anyone other than that account, Administrators and SYSTEM owns one of the four
#     folders or has an access rule on the folder itself that lets them change it (the bot user can give another
#     account that right). This look is an early refusal with a clear reason; it reads neither rules that apply only
#     to what is inside a folder nor conditional rules, and it says nothing about handles opened earlier;
#   - when it cannot be read or removed: Remove-RpaTree holds the four folders open without delete sharing while the
#     tree is removed (Windows refuses a rename or move of a folder held that way), and removes a link inside the
#     tree as the link itself, without entering it. A folder another process holds, or an entry it cannot open or
#     delete, is left.
# Returns, for each folder found, Path, Name (the account), Removed and Why (sentences for the person, when it was
# left).
function Remove-RpaBrowserTemp([object[]]$Accounts, [string[]]$RunningSids, [object[]]$UnknownProcesses) {
  $results = @()
  $unknown = @($UnknownProcesses | Where-Object { $_ })
  $later = 'then run Uninstall-Rpa.ps1 -RemoveData from the unpacked package, which removes it, or remove the folder.'
  foreach ($account in @($Accounts | Where-Object { $_ -and $_.Bot })) {
    $userFolder = Get-RpaProfileFolder $account.Sid
    if (-not $userFolder) { continue }
    $folders = @($userFolder)
    foreach ($part in 'AppData', 'Local', 'RPA Runner') { $folders += Join-Path $folders[-1] $part }
    $result = @{ Path = $folders[-1]; Name = $account.Name; Removed = $false; Why = '' }
    try {
      # Nothing there (the browser never ran as this user), or something in the place of a folder on the way.
      if (-not (Get-RpaPathState $result.Path).Exists) { continue }
      if (@($RunningSids) -contains $account.Sid) {
        $result.Why = '{0} is signed in. Sign {0} out, {1}' -f $account.Name, $later
      } elseif ($unknown.Count -gt 0) {
        $result.Why = 'The owner of {0} cannot be read; it may be a process of {1}. End it, {2}' -f $unknown[0], $account.Name, $later
      } else {
        # The last look before the removal, at each folder itself and not at what a link in its place points to, and
        # at who may change it.
        foreach ($folder in $folders) {
          $state = Get-RpaPathState $folder
          if (-not ($state.Exists -and -not $state.IsLink -and $state.IsFolder)) {
            $result.Why = '{0} is not a folder of its own (it is a link, a junction or a file), so nothing was removed there. Check it and remove the folder.' -f $folder
            break
          }
          $others = @(Get-RpaOtherWriters $folder $account.Sid)
          if ($others.Count -gt 0) {
            $result.Why = '{0} is owned or may be changed by {1}, not only by {2}, Administrators and SYSTEM, so nothing was removed there. Check who may change it and remove the folder.' -f $folder, ($others -join ', '), $account.Name
            break
          }
        }
        if (-not $result.Why) {
          Remove-RpaTree $result.Path -From $userFolder
          $result.Removed = $true
        }
      }
    } catch { $result.Why = $_.Exception.GetBaseException().Message }
    $results += $result
  }
  $results
}

# What Uninstall-Rpa.ps1 does: removes the tasks, the firewall rules and the install directory, and puts back what
# -AutoSignIn or -Unattended changed (with -Unattended: the service RPA Supervisor, the stored password, the group
# membership and Remote Desktop), from the records in install.json. The data directory goes only with -RemoveData;
# the Windows user is never removed. -Plan is what Get-RpaUninstallPlan returned.
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
    Switch = '-AutoSignIn'; RemoteDesktopOff = $false
  }
  if ($install) {
    $result.User = [string]$install.user
    $result.AutoSignIn = $install.autoSignIn -eq $true
    # Records of -Unattended are there also after an install without it could not put them all back.
    if ($install.mode -eq 'unattended' -or @($install.signInChanges | Where-Object { $_ -and (Test-RpaUnattendedChange $_) }).Count -gt 0) { $result.Switch = '-Unattended' }
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
    Write-Host ('  put back what {0} changed' -f $result.Switch)
    $result.HadChanges = $true
    # Unless someone has pointed automatic sign-in at another account since the install.
    $account = Get-RpaAccount -User $result.User -ComputerName $env:COMPUTERNAME
    $current = (Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE{0}' -f $script:Winlogon.Substring(4)) -Name 'DefaultUserName' -ErrorAction SilentlyContinue).DefaultUserName
    $result.SignInKept = $result.AutoSignIn -and ($current -ne $account.Name)
    $failed = @(Restore-RpaSignInChanges @($install.signInChanges) $result.SignInKept)
    $result.NotRestored = @($failed | ForEach-Object { $_.Text })
    $result.SignInFailed = [bool]($failed | Where-Object { $_.Change -and (($_.Change.kind -eq 'secret' -and [string]$_.Change.key -eq $script:AutoSignInSecret) -or [string]$_.Change.key -eq $script:Winlogon) })
    # Remote Desktop was off before -Unattended turned it on, and is off again now: an administrator may use it since.
    $remoteDesktop = @($install.signInChanges | Where-Object { $_ -and $_.kind -eq 'registry' -and [string]$_.key -eq $script:TerminalServer -and $_.name -eq 'fDenyTSConnections' })
    $result.RemoteDesktopOff = $remoteDesktop.Count -gt 0 -and -not ($failed | Where-Object { $_.Change -and [string]$_.Change.key -eq $script:TerminalServer })
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
  # The RPA Supervisor when install.json does not record it (it is gone, or older): the service only when it runs this
  # install's RpaSupervisor.exe, with its event source. A recorded one was put back above, or is listed as not put
  # back (for example while the Services window holds it) and is not tried again. The stored password by its name,
  # the product's own.
  if (-not ($install -and @($install.signInChanges | Where-Object { $_ -and $_.kind -eq 'service' }).Count -gt 0)) {
    $path = Get-RpaServicePath $script:SupervisorService
    if ($path -and $path -ieq (Get-RpaSupervisorPath $layout.InstallDir)) { Remove-RpaSupervisor }
    elseif ($path) { Write-Host ('  left: the service {0}, which runs {1}, not this install''s program' -f $script:SupervisorService, $path) }
  }
  Remove-RpaLsaSecret $script:SupervisorSecret
  Write-Host '  remove the program files'
  Remove-RpaProgramFiles $layout
  $result.DataKept = (Get-RpaPathState $layout.DataDir).Exists
  $result
}

# What Uninstall-Rpa.ps1 prints at its end, from what Invoke-RpaUninstall returned: only what was done.
function Get-RpaUninstallSummary([hashtable]$Result) {
  $lines = @('RPA is removed.')
  $failed = @($Result.NotRestored)
  # The switch whose changes were put back: -Unattended for an install made with it.
  $switch = '-AutoSignIn'
  if ($Result.Switch) { $switch = $Result.Switch }
  if ($Result.AutoSignIn) {
    if ($Result.SignInKept) { $lines += '  Automatic sign-in now names another user, so it and the stored password were left as they are.' }
    elseif ($Result.SignInFailed) { $lines += '  Automatic sign-in of {0} could not be turned off completely: see the list below.' -f $Result.User }
    else { $lines += '  Automatic sign-in of {0} is off and the stored password is removed.' -f $Result.User }
  }
  if ($Result.RemoteDesktopOff) { $lines += '  Remote Desktop is off again, as it was before -Unattended turned it on.' }
  if ($Result.HadChanges) {
    if ($failed.Count -eq 0) {
      if ($Result.SignInKept) { $lines += '  The other settings {0} changed are back to what they were before.' -f $switch }
      else { $lines += '  The settings {0} changed are back to what they were before.' -f $switch }
    } else {
      $lines += '  Of the settings {0} changed, these could not be put back:' -f $switch
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
