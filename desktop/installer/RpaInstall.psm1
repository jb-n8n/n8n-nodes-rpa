# What Install-Rpa.ps1 and Uninstall-Rpa.ps1 do, for Windows PowerShell 5.1 (the PowerShell that ships with Windows).
#
# The installer works in three parts, so that what it decides can be tested without a Windows machine:
#   Get-RpaMachineFacts    looks at the machine (Windows only) and changes nothing
#   Get-RpaInstallPlan     turns the parameters and those facts into refusals, warnings and an ordered list of steps;
#                          it looks at nothing but its two arguments
#   Invoke-RpaInstallPlan  runs exactly the listed steps, in order (Windows only)
#
# The stored sign-in password, the registry values, the scheduled task settings and the access rules of the data
# directory come from the AWS test bed's first-boot script (deploy/terraform/modules/aws-ec2-desktop-runner/
# setup.ps1.tftpl).
#
# Who is not trusted: the bot user (and anything running as it) and every other standard user. The bot user can create
# files in the data directory and change what is in logs\. So the installer refuses a link or junction where it expects
# the data directory, logs\, policy-backups\, policy.json or a token, refuses one of those that someone other than
# Administrators or SYSTEM owns (logs\ it takes over instead) and a file of those names that has a second name (a
# hard link), passes /L to every icacls call, and deletes folders with rd, which does not enter a junction. A data
# directory that is there before the first install is used only when nothing in it belongs to someone else.
#
# Secrets: New-RpaSecret returns a new secret to its caller. No other function returns one in plain text, and none
# prints or logs one. A token is made inside the function that writes its file, and a generated password inside the
# function that creates the user; neither is ever a parameter of a command or goes through a pipeline, because
# PowerShell's module logging records both.

$script:MinimumBuild = 17763
$script:TaskPath = '\RPA\'
$script:RunnerTask = 'RPA Runner'
$script:BrowserTask = 'RPA Browser'
$script:RunnerRule = 'RPA-Runner-In'
$script:BrowserRule = 'RPA-Browser-In'
$script:StarterPolicy = '{ "allowedApps": [], "maxFileBytes": 20971520 }'
$script:Winlogon = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$script:Utf8 = New-Object Text.UTF8Encoding $false
# Administrators and SYSTEM: the only owners the installer accepts for what it finds in the data directory.
$script:TrustedOwners = @('S-1-5-32-544', 'S-1-5-18')
# The data directory's files the bot user may read and never change, and the step that writes each when it is missing.
$script:DataFiles = [ordered]@{ 'policy.json' = 'write policy'; 'token' = 'write token'; 'browser-token' = 'write browser-token' }
$script:SignInSteps = @('store sign-in password', 'turn on automatic sign-in', 'keep the desktop unlocked')
$script:KnownSteps = @(
  'stop running services', 'copy program files', 'create user', 'protect the data directory', 'write policy',
  'write token', 'write browser-token', 'add the runner firewall rule', 'add the browser firewall rule',
  'remove the browser firewall rule', 'register the runner task', 'register the browser task',
  'remove the browser task', 'write install.json', 'store sign-in password', 'turn on automatic sign-in',
  'keep the desktop unlocked', 'start tasks')
# Where a user's registry is loaded for a moment when that user is not signed in.
$script:HiveMount = 'HKU\RpaBotUser'
$script:MountedSid = $null

# ---------------------------------------------------------------------------------------------------------------------
# The plan (runs anywhere)
# ---------------------------------------------------------------------------------------------------------------------

# An IPv4 or IPv6 address, or a range in CIDR form (10.0.0.0/24). Nothing else: no name, no keyword, no list.
function Test-RpaAddress([string]$Text) {
  $address = $Text
  $prefix = $null
  $slash = $Text.IndexOf('/')
  if ($slash -ge 0) {
    $address = $Text.Substring(0, $slash)
    $prefix = $Text.Substring($slash + 1)
    if ($prefix -notmatch '^\d{1,3}$') { return $false }
  }
  if ($address -match '^\d{1,3}(\.\d{1,3}){3}$') {
    foreach ($part in $address.Split('.')) { if ([int]$part -gt 255) { return $false } }
    return ($null -eq $prefix -or [int]$prefix -le 32)
  }
  $parsed = $null
  if ($address -match '^[0-9A-Fa-f:]+$' -and $address.Contains(':') -and [Net.IPAddress]::TryParse($address, [ref]$parsed)) {
    return ($null -eq $prefix -or [int]$prefix -le 128)
  }
  $false
}

# The refusal for something found in the data directory that the installer will not use, or nothing. -State is what
# Get-RpaPathState returns. A link is refused always, and so is a file with more than one name: the installer gives
# what it finds under these names its own owner and access rules, and a second name for another file would hand that
# file to the bot user. An owner other than Administrators or SYSTEM is refused where -CheckOwner is given.
function Get-RpaPathRefusal([string]$Path, $State, [bool]$CheckOwner) {
  if (-not $State -or -not $State.Exists) { return $null }
  if ($State.IsLink) { return ('{0} is a link or junction. Remove it and run the installer again.' -f $Path) }
  if ($State.Links -gt 1) { return ('{0} has more than one name (a hard link). Check what it is, remove it, and run the installer again.' -f $Path) }
  if ($CheckOwner -and -not $State.OwnerTrusted) {
    return ('{0} exists and is owned by {1}. Check what is in it, remove it, and run the installer again.' -f $Path, $State.Owner)
  }
  $null
}

# The refusal for the first thing in a data directory, found before the first install, that is a link, has a second
# name or belongs to someone other than Administrators or SYSTEM. -Entry is what Find-RpaForeignEntry returns.
function Get-RpaForeignRefusal($Entry) {
  if ($Entry.IsLink) { return ('{0} is a link or junction. Remove it and run the installer again.' -f $Entry.Path) }
  if ($Entry.Links -gt 1) { return ('{0} has more than one name (a hard link). Check what it is, remove it, and run the installer again.' -f $Entry.Path) }
  '{0} exists and is owned by {1}. Check what is in the data directory, remove it, and run the installer again.' -f $Entry.Path, $Entry.Owner
}

# Decides what an install does. -Parameters holds Install-Rpa.ps1's parameters (User, UserPassword, RunnerPort,
# BrowserPort, NoBrowser, NoFirewall, AllowFrom, AllowFromAnyAddress, IncludePublicNetwork, AutoSignIn, Force); -Facts
# is what Get-RpaMachineFacts returns. With a refusal there are no steps: the installer changes nothing. AllowFrom in
# the result is what the firewall rules let in: addresses and ranges, or the one word any, or nothing without rules;
# PublicNetwork says whether the rules also apply on networks Windows treats as Public.
function Get-RpaInstallPlan {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Parameters,
    [Parameter(Mandatory = $true)][hashtable]$Facts
  )
  $user = [string]$Parameters.User
  $hasPassword = $null -ne $Parameters.UserPassword
  $browser = -not $Parameters.NoBrowser
  $firewall = -not $Parameters.NoFirewall
  $autoSignIn = [bool]$Parameters.AutoSignIn
  $upgrade = [bool]$Facts.Installed
  $runnerPort = [int]$Parameters.RunnerPort
  $browserPort = [int]$Parameters.BrowserPort
  # A local user that does not exist is created, on a first install and on an upgrade (someone removed it since).
  $createUser = -not $Facts.UserExists -and -not $Facts.UserIsDomain
  # Automatic sign-in that an earlier run turned on for this same user stays as it is.
  $signInKept = $autoSignIn -and $upgrade -and [bool]$Facts.InstalledAutoSignInForUser -and [bool]$Facts.UserExists
  $allowFrom = $null
  $publicNetwork = $false
  $refusals = New-Object Collections.Generic.List[string]
  $warnings = New-Object Collections.Generic.List[string]
  $steps = New-Object Collections.Generic.List[string]

  # Without these two nothing else can be judged (the other facts are not even gathered).
  if (-not $Facts.IsAdmin) { $refusals.Add('Run Install-Rpa.ps1 from an administrator PowerShell.') }
  if (-not $Facts.Is64Bit -or $Facts.OsBuild -lt $script:MinimumBuild) {
    $refusals.Add('Windows 10 1809, Windows 11 or Windows Server 2019 or later (64-bit) is required.')
  }

  if ($refusals.Count -eq 0) {
    if ($browser -and $runnerPort -eq $browserPort) {
      $refusals.Add(('-RunnerPort and -BrowserPort are both {0}. Give each its own port.' -f $runnerPort))
    } else {
      # On an upgrade the installed runner and browser hold their ports, so only a port that changes is checked.
      $ports = @()
      if (-not ($upgrade -and $Facts.InstalledRunnerPort -eq $runnerPort)) { $ports += $runnerPort }
      if ($browser -and -not ($upgrade -and $Facts.InstalledBrowser -and $Facts.InstalledBrowserPort -eq $browserPort)) { $ports += $browserPort }
      foreach ($port in $ports) {
        $process = $null
        if ($Facts.PortsInUse) { $process = $Facts.PortsInUse[$port] }
        if ($process) { $refusals.Add(('Port {0} is in use by {1}. Choose another with -RunnerPort or -BrowserPort.' -f $port, $process)) }
      }
    }

    if ($Facts.UserIsDomain -and -not $Facts.UserExists) {
      $refusals.Add(('{0} does not exist. Create it in your directory first; the installer only creates local users.' -f $user))
    }
    # The runner treats its own user as an administrator when it is one, so the bot user must not be.
    if ($Facts.UserExists -and $Facts.UserIsAdmin) {
      $refusals.Add(('{0} is an administrator. The bot user must be a standard user.' -f $user))
    }
    if ($upgrade -and $Facts.InstalledAutoSignInUser -and -not $Facts.InstalledAutoSignInForUser) {
      # Windows would go on signing the first user in, and install.json would name the new one: the uninstaller could
      # no longer tell whose sign-in it has to turn off.
      $refusals.Add(('Automatic sign-in is set up for {0}. Uninstall first, then install for {1}.' -f $Facts.InstalledAutoSignInUser, $user))
    } else {
      # An existing user's password is never changed, so automatic sign-in can only store one that is given.
      if ($autoSignIn -and $Facts.UserExists -and -not $hasPassword -and -not $signInKept) {
        $refusals.Add(('-AutoSignIn for the existing user {0} needs -UserPassword. A password the installer generated earlier is not known to anyone: set a new password for {0} and pass it, or remove {0} so the installer creates it again.' -f $user))
      }
      if ($autoSignIn -and $Facts.UserExists -and $hasPassword -and $Facts.UserPasswordWrong) {
        $refusals.Add(('The password given for {0} is not correct.' -f $user))
      }
    }
    if ($createUser -and -not $autoSignIn -and -not $hasPassword) {
      $refusals.Add(('Give -UserPassword for the new user {0}, or use -AutoSignIn to have a random password stored for automatic sign-in.' -f $user))
    }

    if ($firewall) {
      # powershell -File hands a,b over as one string, so every value is split at its commas.
      $given = @($Parameters.AllowFrom | ForEach-Object { ([string]$_).Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $any = [bool]$Parameters.AllowFromAnyAddress
      $includePublic = [bool]$Parameters.IncludePublicNetwork
      # Rules for given addresses apply on every network: the address list is what limits them. Rules for any address
      # apply on Domain and Private networks, and on Public ones only when that is asked for.
      if ($given.Count -gt 0 -and -not $any) { $allowFrom = $given; $publicNetwork = $true }
      elseif ($any -and $given.Count -eq 0) { $allowFrom = @('any'); $publicNetwork = $includePublic }
      elseif (-not $any -and $upgrade -and $Facts.InstalledAllowFrom) {
        $allowFrom = @($Facts.InstalledAllowFrom)
        $publicNetwork = ($allowFrom -notcontains 'any') -or $includePublic -or [bool]$Facts.InstalledPublicNetwork
      }
      else { $refusals.Add('Say which addresses may connect: -AllowFrom <n8n address>, or -AllowFromAnyAddress, or -NoFirewall.') }
      foreach ($address in $given) {
        if (-not (Test-RpaAddress $address)) { $refusals.Add(('-AllowFrom: {0} is not an IP address or a range such as 10.0.0.0/24.' -f $address)) }
      }
      if ($allowFrom -and -not $publicNetwork -and $Facts.PublicNetwork) {
        if ($upgrade) {
          $warnings.Add('This machine is on a network that Windows treats as Public. The firewall rules are for Domain and Private networks, so they let nothing in on that network.')
        } else {
          $refusals.Add("This machine's network is Public, and -AllowFromAnyAddress does not open the ports on a Public network. Use -AllowFrom <n8n address>, or add -IncludePublicNetwork, or use -NoFirewall.")
        }
      }
    }

    # What is already in the data directory: nothing a standard user could have put there is used.
    $dataRefusal = Get-RpaPathRefusal $Facts.DataDir $Facts.DataDirState $true
    if ($dataRefusal) { $refusals.Add($dataRefusal) }
    else {
      $logsRefusal = Get-RpaPathRefusal $Facts.LogDir $Facts.LogDirState $false
      if ($logsRefusal) { $refusals.Add($logsRefusal) }
      foreach ($name in $script:DataFiles.Keys) {
        $state = $null
        if ($Facts.DataFiles) { $state = $Facts.DataFiles[$name] }
        $fileRefusal = Get-RpaPathRefusal ('{0}\{1}' -f $Facts.DataDir, $name) $state $true
        if ($fileRefusal) { $refusals.Add($fileRefusal) }
      }
      # The policy tool keeps its backups here and trusts the folder; the bot user could have made it first.
      $backupsRefusal = Get-RpaPathRefusal $Facts.PolicyBackupsDir $Facts.PolicyBackupsState $true
      if ($backupsRefusal) { $refusals.Add($backupsRefusal) }
      # Before the first install nobody is entitled to anything in the data directory. Later the bot user keeps its
      # own files there (the certificates, exports), so an upgrade does not judge them.
      if (-not $upgrade -and $Facts.DataDirForeign) { $refusals.Add((Get-RpaForeignRefusal $Facts.DataDirForeign)) }
    }
    # A task folder a standard user made first stays that user's, also after the tasks in it are registered again.
    if ($Facts.TaskFolderOwner) {
      $refusals.Add(('The scheduled task folder {0} exists and is owned by {1}. Check what is in it, remove it, and run the installer again.' -f $script:TaskPath, $Facts.TaskFolderOwner))
    }

    if ($upgrade -and $Facts.RunnerRunning) {
      $text = 'The runner is running; a run in progress will fail. Use -Force to continue.'
      if ($Parameters.Force) { $warnings.Add($text) } else { $refusals.Add($text) }
    }
    if ($autoSignIn -and $Facts.UserExists -and $Facts.UserPasswordExpires) {
      $warnings.Add(("{0}'s password expires; automatic sign-in stops working when it does." -f $user))
    }
    if ($Facts.UserExists -and $Facts.UserAdminUnknown) {
      $warnings.Add(('Could not check whether {0} is an administrator. The bot user must be a standard user.' -f $user))
    }
    if ($Facts.UserPasswordProblem) {
      $warnings.Add(('The password given for {0} could not be checked: {1}' -f $user, $Facts.UserPasswordProblem))
    }
  }

  if ($refusals.Count -eq 0) {
    # An upgrade replaces the program files and keeps the user, the policy and both tokens (and the certificates,
    # which no step touches); what is missing of them is made again. The program files come before the user, so that
    # a failed copy leaves no new user behind.
    # install.json is written before the sign-in steps, so that the uninstaller knows about them even when one fails.
    if ($upgrade) { $steps.Add('stop running services') }
    $steps.Add('copy program files')
    if ($createUser) { $steps.Add('create user') }
    $steps.Add('protect the data directory')
    # A file that is there is never written again; one that is missing is written, on a first install and on an upgrade.
    foreach ($name in $script:DataFiles.Keys) {
      if ($name -eq 'browser-token' -and -not $browser) { continue }
      $state = $null
      if ($Facts.DataFiles) { $state = $Facts.DataFiles[$name] }
      if (-not $state -or -not $state.Exists) { $steps.Add($script:DataFiles[$name]) }
    }
    if ($firewall) {
      $steps.Add('add the runner firewall rule')
      if ($browser) { $steps.Add('add the browser firewall rule') } elseif ($upgrade) { $steps.Add('remove the browser firewall rule') }
    }
    $steps.Add('register the runner task')
    if ($browser) { $steps.Add('register the browser task') } elseif ($upgrade) { $steps.Add('remove the browser task') }
    $steps.Add('write install.json')
    if ($autoSignIn) {
      if (-not $signInKept) { foreach ($step in $script:SignInSteps) { $steps.Add($step) } }
      elseif ($hasPassword) { $steps.Add('store sign-in password') }
    }
    if ($upgrade) { $steps.Add('start tasks') }
  }

  @{ Refusals = $refusals.ToArray(); Warnings = $warnings.ToArray(); Steps = $steps.ToArray(); AllowFrom = $allowFrom; PublicNetwork = $publicNetwork }
}

# Decides whether an uninstall may run. -Parameters holds Uninstall-Rpa.ps1's parameters (RemoveData); -Facts is what
# Get-RpaUninstallFacts returns. Only -RemoveData can be refused: the data directory is deleted by path, so nobody
# who can write into it may still be signed in (a process of that user could swap a folder for a junction while the
# tree is being removed), and a data directory that is itself a link is not removed.
function Get-RpaUninstallPlan {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Parameters,
    [Parameter(Mandatory = $true)][hashtable]$Facts
  )
  $refusals = New-Object Collections.Generic.List[string]
  if ($Parameters.RemoveData) {
    if ($Facts.DataDirState -and $Facts.DataDirState.IsLink) {
      $refusals.Add(('{0} is a link or junction. Remove it and run this again.' -f $Facts.DataDir))
    }
    foreach ($user in @($Facts.SignedIn)) {
      $refusals.Add(('{0} is signed in. Sign {0} out, then run Uninstall-Rpa.ps1 -RemoveData again.' -f $user))
      if ($Facts.AutoSignInUser -and $Facts.AutoSignInUser -eq $user) {
        $refusals.Add(('Automatic sign-in is on for {0}, and Windows signs it in again after a sign-out. Run Uninstall-Rpa.ps1 without -RemoveData first, which turns that off; then sign {0} out and run Uninstall-Rpa.ps1 -RemoveData from the unpacked package.' -f $user))
      }
    }
  }
  @{ Refusals = $refusals.ToArray() }
}

# 64 symbols, so a random byte modulo 64 is uniform; retried until it has an upper, a lower and a digit and no part of
# an account or full name (Windows' complexity rule refuses a password containing rpa, runner or admin). Letters,
# digits, - and _ need no escaping in a header, a URL or a shell. No command and no pipeline touches the characters.
function New-RpaSecret {
  param([Parameter(Mandatory = $true)][ValidateRange(8, 1024)][int]$Length)
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $bytes = New-Object byte[] $Length
    $chars = New-Object char[] $Length
    do {
      $rng.GetBytes($bytes)
      for ($i = 0; $i -lt $Length; $i++) { $chars[$i] = $alphabet[$bytes[$i] % 64] }
      $s = -join $chars
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
    BackupsDir  = Join-Path $dataDir 'policy-backups'
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
# point), how many names it has (a file with more than one is hard linked), and who owns it. An owner that cannot be
# read is not trusted.
function Get-RpaPathState([string]$Path) {
  $state = @{ Exists = $false; IsLink = $false; Links = 0; OwnerTrusted = $false; Owner = '' }
  try { $attributes = [IO.File]::GetAttributes($Path) }
  catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { return $state }
    throw
  }
  $state.Exists = $true
  $state.IsLink = [bool]($attributes -band [IO.FileAttributes]::ReparsePoint)
  $state.Links = 1
  if (-not ($attributes -band [IO.FileAttributes]::Directory)) {
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

# The owner of the scheduled task folder when it is there and that owner is not Administrators or SYSTEM, else nothing.
function Get-RpaTaskFolderOwner {
  $scheduler = New-Object -ComObject Schedule.Service
  $null = $scheduler.Connect()
  try { $sddl = [string]$scheduler.GetFolder($script:TaskPath.TrimEnd('\')).GetSecurityDescriptor(1) } catch { return $null }
  $security = New-Object Security.AccessControl.RawSecurityDescriptor $sddl
  if (-not $security.Owner -or $script:TrustedOwners -contains $security.Owner.Value) { return $null }
  Get-RpaAccountName $security.Owner
}

# The first thing in the data directory that is a link, has a second name, or belongs to someone other than
# Administrators or SYSTEM, or nothing. Links are not entered. policy.json, the tokens and policy-backups\ are judged
# under their own names by the plan (what is inside policy-backups\ is judged here), and so is logs\ when it is a link.
function Find-RpaForeignEntry([string]$DataDir) {
  Add-RpaNativeTypes
  $named = @($script:DataFiles.Keys) + 'policy-backups'
  $pending = New-Object Collections.Generic.Stack[string]
  $pending.Push($DataDir)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in (New-Object IO.DirectoryInfo ('\\?\' + $directory)).EnumerateFileSystemInfos()) {
      $path = Join-Path $directory $entry.Name
      $isLink = [bool]($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)
      $isFolder = [bool]($entry.Attributes -band [IO.FileAttributes]::Directory)
      if ($directory -eq $DataDir) {
        if ($named -contains $entry.Name) {
          if ($isFolder -and -not $isLink) { $pending.Push($path) }
          continue
        }
        if ($entry.Name -eq 'logs' -and $isLink) { continue }
      }
      $found = @{ Path = $path; IsLink = $isLink; Links = 1; Owner = 'someone whose name cannot be read' }
      if ($isLink) { return $found }
      $trusted = $false
      try {
        if ($isFolder) { $security = [IO.Directory]::GetAccessControl('\\?\' + $path, 'Owner') } else { $security = [IO.File]::GetAccessControl('\\?\' + $path, 'Owner') }
        $owner = $security.GetOwner([Security.Principal.SecurityIdentifier])
        $trusted = $script:TrustedOwners -contains $owner.Value
        $found.Owner = Get-RpaAccountName $owner
      } catch { $trusted = $false }
      if (-not $trusted) { return $found }
      if ($isFolder) { $pending.Push($path) }
      else {
        $found.Links = [RpaFiles]::LinkCount($path)
        if ($found.Links -gt 1) { return $found }
      }
    }
  }
  $null
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
    RunnerRunning              = $false
    DataDir                    = $layout.DataDir
    LogDir                     = $layout.LogDir
    PolicyBackupsDir           = $layout.BackupsDir
    DataDirState               = $null
    LogDirState                = $null
    PolicyBackupsState         = $null
    DataDirForeign             = $null
    DataFiles                  = @{}
    TaskFolderOwner            = $null
    PublicNetwork              = $false
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
    # The user automatic sign-in was turned on for by the installer, and whether that is the user of this run.
    if ($install.autoSignIn -eq $true) { $facts.InstalledAutoSignInUser = [string]$install.user }
    $facts.InstalledAutoSignInForUser = ($install.autoSignIn -eq $true) -and ([string]$install.user -eq $account.Display)
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
  # Before the first install: everything else that is in a data directory someone made earlier.
  if (-not $facts.Installed -and $facts.DataDirState.Exists -and -not $facts.DataDirState.IsLink -and $facts.DataDirState.OwnerTrusted) {
    $facts.DataDirForeign = Find-RpaForeignEntry $layout.DataDir
  }
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
    $said = (@($output | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) -join ' ')
    throw ('{0} {1} failed with exit code {2}: {3}' -f $Exe, $Arguments[0], $LASTEXITCODE, $said)
  }
}

# ---------------------------------------------------------------------------------------------------------------------
# Registry values, read and written through .NET (not reg.exe: Windows PowerShell 5.1 leaves an empty string out of a
# tool's command line, and quotes in the data would need escaping). install.json keeps a value as its type (REG_SZ,
# REG_DWORD, ...) and its data: a string as it is (also an empty one), a number in decimal, a list of strings as a
# list, bytes as hex pairs.
# ---------------------------------------------------------------------------------------------------------------------

$script:RegistryKinds = @{
  REG_SZ = 'String'; REG_EXPAND_SZ = 'ExpandString'; REG_DWORD = 'DWord'; REG_QWORD = 'QWord'
  REG_MULTI_SZ = 'MultiString'; REG_BINARY = 'Binary'; REG_NONE = 'None'
}

# What the registry returned for a value, as the type and data install.json keeps. -Kind is the .NET kind's name.
function ConvertFrom-RpaRegistryData([string]$Kind, $Data) {
  switch ($Kind) {
    'String' { return @{ type = 'REG_SZ'; value = [string]$Data } }
    'ExpandString' { return @{ type = 'REG_EXPAND_SZ'; value = [string]$Data } }
    'DWord' { return @{ type = 'REG_DWORD'; value = [string][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$Data), 0) } }
    'QWord' { return @{ type = 'REG_QWORD'; value = [string][BitConverter]::ToUInt64([BitConverter]::GetBytes([long]$Data), 0) } }
    'MultiString' { return @{ type = 'REG_MULTI_SZ'; value = [string[]]@($Data) } }
    'Binary' { return @{ type = 'REG_BINARY'; value = -join (@($Data) | ForEach-Object { ([byte]$_).ToString('X2') }) } }
    'None' { return @{ type = 'REG_NONE'; value = -join (@($Data) | ForEach-Object { ([byte]$_).ToString('X2') }) } }
  }
  throw ('a registry value of the kind {0}, which the installer does not record' -f $Kind)
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
# of a user's profile, and the number of names a file has. A password goes in as a SecureString and is turned into
# plain text only in unmanaged memory that is wiped afterwards.
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
# policy tool. On a first install everything in a data directory that was there already is looked at again once
# only administrators and the bot user can put anything into it. policy.json and the tokens get their rules again on
# every run, which also gives another -User its read access.
function Protect-RpaDataDirectory([hashtable]$Layout, [string]$Sid, [bool]$FirstInstall) {
  foreach ($folder in @(@{ Path = $Layout.DataDir; Kind = 'directory'; CheckOwner = $true }, @{ Path = $Layout.LogDir; Kind = 'logs'; CheckOwner = $false })) {
    $rules = Get-RpaAccessRules $folder.Kind $Sid
    New-RpaProtectedFolder $folder.Path $rules
    # Also after creating it: CreateDirectory does not say when someone else made the folder a moment earlier.
    Assert-RpaPathUsable $folder.Path $folder.CheckOwner
    Set-RpaAccessRules $folder.Path $rules $Layout.InstallDir
    if ($FirstInstall -and $folder.Kind -eq 'directory') {
      $foreign = Find-RpaForeignEntry $Layout.DataDir
      if ($foreign) { throw (Get-RpaForeignRefusal $foreign) }
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
# the meantime makes this fail). With -SecretLength the content is a new secret made here; the text is UTF-8 without
# a byte order mark and without a line break at the end.
function New-RpaProtectedFile {
  param([string]$Path, [string]$Sid, [string]$Text, [int]$SecretLength, [switch]$AdministratorsOnly)
  $rules = Get-RpaAccessRules 'file' $Sid
  if ($AdministratorsOnly) { $rules = Get-RpaAccessRules 'administrators file' '' }
  $security = New-Object Security.AccessControl.FileSecurity
  $security.SetSecurityDescriptorSddlForm('O:BA' + $rules)
  if ($SecretLength -gt 0) { $Text = New-RpaSecret -Length $SecretLength }
  $bytes = $script:Utf8.GetBytes($Text)
  $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
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
# not elevated, no time limit. The start script starts its program again whenever it exits. A task of that name that
# is already there is removed first and not overwritten: an overwritten task keeps its owner and access rules, and a
# standard user can make one before the installer does. For the same reason the owner of the task folder is looked at
# again here: the plan saw it before the question -AutoSignIn asks.
function Register-RpaTask([string]$Name, [string]$ScriptPath, [string]$Account) {
  $owner = Get-RpaTaskFolderOwner
  if ($owner) { throw ('The scheduled task folder {0} exists and is owned by {1}. Check what is in it, remove it, and run the installer again.' -f $script:TaskPath, $owner) }
  Unregister-RpaTask $Name
  $action = New-ScheduledTaskAction -Execute (Get-RpaWindowsPowerShell) -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $ScriptPath)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Account
  $principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskPath $script:TaskPath -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}

function Unregister-RpaTask([string]$Name) {
  Unregister-ScheduledTask -TaskPath $script:TaskPath -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------------------------------------------------
# Automatic sign-in: every change is recorded in install.json before it is made, and put back by the uninstaller.
# ---------------------------------------------------------------------------------------------------------------------

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
    'secret' { return 'the password stored for automatic sign-in (it is still stored)' }
  }
  ('{0} {1} {2}' -f $Change.kind, $Change.key, $Change.name).Trim()
}

# The list Uninstall-Rpa.ps1 leaves behind when it could not put a setting back: what an earlier list held
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
    note       = 'Settings that Uninstall-Rpa.ps1 could not put back to what they were before Install-Rpa.ps1 -AutoSignIn changed them. Each entry is the record of what was there before, and why it was not put back.'
    notPutBack = $entries
  }
}

# What install.json holds. autoSignIn says that the installer turned automatic sign-in on, in this run or an earlier
# one (it is written before the sign-in steps run). allowFrom is what the firewall rules let in (a list of addresses
# and ranges, or the word any) and publicNetwork whether they also apply on Public networks; a run that makes no rule
# keeps what an earlier run recorded. signInChanges are the records of what -AutoSignIn changed.
function New-RpaInstallRecord {
  param([string]$Version, [hashtable]$Account, [hashtable]$Parameters, [hashtable]$Plan, $Previous)
  $allowFrom = $null
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
    $recorded = ConvertFrom-RpaRegistryData ([string]$open.GetValueKind($Name)) $data
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

# Makes the registry of a user reachable under HKU\<SID>: it is there while the user is signed in; otherwise it is
# loaded from the user's own profile until Dismount-RpaUserHive. Never from the default profile, which every later
# user of the machine would inherit. Returns whether it loaded the file.
function Mount-RpaUserHive([string]$Sid) {
  if (Test-Path -LiteralPath ('Registry::HKEY_USERS\{0}' -f $Sid)) { return $false }
  $profileKey = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{0}' -f $Sid
  $profileDir = (Get-ItemProperty -LiteralPath $profileKey -ErrorAction SilentlyContinue).ProfileImagePath
  if (-not $profileDir) { throw 'The user has no profile on this machine.' }
  $hive = Join-Path $profileDir 'NTUSER.DAT'
  $state = Get-RpaPathState $hive
  if (-not $state.Exists) { throw ('{0} is missing.' -f $hive) }
  if ($state.IsLink) { throw ('{0} is a link.' -f $hive) }
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
  Add-RpaSignInChange $Run ([ordered]@{ kind = 'secret'; key = 'DefaultPassword'; name = '' })
  [RpaLsaSecret]::Store('DefaultPassword', $Run.Password)
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
    'secret' {
      Add-RpaNativeTypes
      [RpaLsaSecret]::Remove('DefaultPassword')
    }
  }
}

# Puts recorded changes back, the last one first. The values of a user go into that user's registry, loaded from its
# profile when the user is not signed in. With -KeepWinlogon the automatic sign-in values and the stored password are
# left alone (someone has pointed automatic sign-in at another account since). Returns what could not be put back:
# for each, the record (Change; nothing when a user's registry could not be closed again) and a line that names it
# with the reason (Text).
function Restore-RpaSignInChanges([object[]]$Changes, [bool]$KeepWinlogon) {
  $failed = @()
  $ordered = @($Changes)
  [array]::Reverse($ordered)
  foreach ($change in $ordered) {
    $key = [string]$change.key
    if ($KeepWinlogon -and ($change.kind -eq 'secret' -or $key -eq $script:Winlogon)) { continue }
    $mounted = $false
    try {
      if ($change.kind -eq 'registry' -and $key -match '^HKU\\(S-[0-9-]+)\\') { $mounted = Mount-RpaUserHive $Matches[1] }
      Restore-RpaSignInChange $change
    } catch {
      $failed += @{ Change = $change; Text = ('{0}: {1}' -f (Get-RpaChangeText $change), $_.Exception.GetBaseException().Message) }
    } finally {
      try { Dismount-RpaUserHive $mounted } catch { $failed += @{ Change = $null; Text = $_.Exception.Message } }
    }
  }
  $failed
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
    foreach ($entry in $failed) { Write-Host ('    could not put back: {0}' -f $entry.Text) }
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
  }
  # The user's security identifier goes into permissions by number, so no name can be misread. A user that the plan
  # does not create must exist now (an upgrade keeps the user of the first install).
  if ($steps -notcontains 'create user') { $run.Sid = Get-RpaSid $account }

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
        'protect the data directory' { Protect-RpaDataDirectory $layout $run.Sid (-not $run.Upgrade) }
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
          $run.Install = New-RpaInstallRecord -Version $version -Account $account -Parameters $Parameters -Plan $Plan -Previous $previous
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
}

# The users that can write into the data directory and are signed in. They are the bot user install.json names and
# whoever the data directory's access rules name besides SYSTEM and Administrators (install.json is gone after an
# uninstall that kept the data). Signed in means that a process of the user is running, which is so while the user
# has a session, connected or not.
function Get-RpaSignedInUsers([hashtable]$Layout, $Install) {
  $users = @{}
  if ($Install -and $Install.user) {
    $account = Get-RpaAccount -User ([string]$Install.user) -ComputerName $env:COMPUTERNAME
    $users[$account.Qualified] = $account.Display
  }
  $state = Get-RpaPathState $Layout.DataDir
  if ($state.Exists -and -not $state.IsLink) {
    $security = [IO.Directory]::GetAccessControl($Layout.DataDir, 'Access')
    foreach ($rule in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      $sid = $rule.IdentityReference
      if ($rule.AccessControlType -ne 'Allow' -or $script:TrustedOwners -contains $sid.Value -or $sid.Value -eq 'S-1-3-0') { continue }
      try { $name = $sid.Translate([Security.Principal.NTAccount]).Value } catch { continue }
      $account = Get-RpaAccount -User $name -ComputerName $env:COMPUTERNAME
      $users[$account.Qualified] = $account.Display
    }
  }
  if ($users.Count -eq 0) { return @() }
  $running = @{}
  foreach ($process in Get-Process -IncludeUserName) { if ($process.UserName) { $running[$process.UserName] = $true } }
  @($users.Keys | Where-Object { $running.ContainsKey($_) } | ForEach-Object { $users[$_] } | Sort-Object)
}

# The facts Get-RpaUninstallPlan judges. Changes nothing.
function Get-RpaUninstallFacts {
  $ErrorActionPreference = 'Stop'
  $layout = Get-RpaLayout
  $install = Read-RpaInstallFile $layout.InstallFile
  $facts = @{
    DataDir        = $layout.DataDir
    DataDirState   = Get-RpaPathState $layout.DataDir
    SignedIn       = @(Get-RpaSignedInUsers $layout $install)
    AutoSignInUser = $null
  }
  if ($install -and $install.autoSignIn -eq $true) { $facts.AutoSignInUser = [string]$install.user }
  $facts
}

# Writes what the uninstaller could not put back to uninstall-leftovers.json in the data directory, which stays after
# an uninstall without -RemoveData, as a file only SYSTEM and Administrators can read or change. The bot user can
# create files in the data directory, so whatever has that name already is removed by name and never written
# through; a list an earlier uninstall left is read only when it is a plain file that Administrators or SYSTEM own.
# Returns the path.
function Save-RpaLeftovers([hashtable]$Layout, [object[]]$Failed, [string]$User) {
  $file = Join-Path $Layout.DataDir 'uninstall-leftovers.json'
  New-RpaProtectedFolder $Layout.DataDir (Get-RpaAccessRules 'backups' '')
  $folder = Get-RpaPathState $Layout.DataDir
  if ($folder.IsLink -or -not $folder.OwnerTrusted) { throw ('{0} is a link or belongs to {1}' -f $Layout.DataDir, $folder.Owner) }
  $existing = $null
  $state = Get-RpaPathState $file
  if ($state.Exists) {
    if (-not $state.IsLink -and $state.Links -eq 1 -and $state.OwnerTrusted) {
      try { $existing = Get-Content -Raw -LiteralPath $file -Encoding UTF8 | ConvertFrom-Json } catch { $existing = $null }
    }
    [IO.File]::Delete($file)
  }
  $list = Add-RpaLeftovers $existing $Failed $User ([DateTime]::UtcNow.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", [Globalization.CultureInfo]::InvariantCulture))
  New-RpaProtectedFile -Path $file -Text (ConvertTo-Json -InputObject $list -Depth 6) -AdministratorsOnly
  $file
}

# What Uninstall-Rpa.ps1 does: removes the tasks, the firewall rules and the install directory, and puts back what
# -AutoSignIn changed, from the records in install.json. The data directory goes only with -RemoveData; the Windows
# user is never removed. What could not be put back is listed in the data directory, unless that is removed too.
# Returns what the uninstaller reports.
function Invoke-RpaUninstall {
  param([switch]$RemoveData)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $layout = Get-RpaLayout
  $install = Read-RpaInstallFile $layout.InstallFile
  $result = @{
    User = $null; AutoSignIn = $false; SignInKept = $false; HadChanges = $false; NotRestored = @()
    LeftoversFile = $null; LeftoversProblem = $null; Layout = $layout
  }
  if ($install) {
    $result.User = [string]$install.user
    $result.AutoSignIn = $install.autoSignIn -eq $true
  }
  # Refused before anything is removed: rd would delete the link, and the data would stay where it points.
  if ($RemoveData -and (Get-RpaPathState $layout.DataDir).IsLink) {
    throw ('{0} is a link or junction. Remove it and run this again.' -f $layout.DataDir)
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
  if ($install -and @($install.signInChanges).Count -gt 0) {
    Write-Host '  put back what -AutoSignIn changed'
    $result.HadChanges = $true
    # Unless someone has pointed automatic sign-in at another account since the install.
    $account = Get-RpaAccount -User $result.User -ComputerName $env:COMPUTERNAME
    $current = (Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE{0}' -f $script:Winlogon.Substring(4)) -Name 'DefaultUserName' -ErrorAction SilentlyContinue).DefaultUserName
    $result.SignInKept = $result.AutoSignIn -and ($current -ne $account.Name)
    $failed = @(Restore-RpaSignInChanges @($install.signInChanges) $result.SignInKept)
    $result.NotRestored = @($failed | ForEach-Object { $_.Text })
    # install.json goes with the program files, so the record of what was not put back moves to the data directory
    # first. With -RemoveData that goes too, and the list is only printed.
    if ($failed.Count -gt 0 -and -not $RemoveData) {
      try { $result.LeftoversFile = Save-RpaLeftovers $layout $failed $result.User }
      catch { $result.LeftoversProblem = $_.Exception.GetBaseException().Message }
    }
  }
  Write-Host '  remove the program files'
  # A folder that is someone's current directory cannot be removed, and the uninstaller may be run from inside it.
  if ((Get-Location).ProviderPath.StartsWith($layout.InstallDir, [StringComparison]::OrdinalIgnoreCase)) { Set-Location -LiteralPath $env:SystemRoot }
  if ([Environment]::CurrentDirectory.StartsWith($layout.InstallDir, [StringComparison]::OrdinalIgnoreCase)) { [Environment]::CurrentDirectory = $env:SystemRoot }
  Remove-RpaTree $layout.InstallDir
  if ($RemoveData) {
    Write-Host '  remove the data directory'
    # Looked at again: the plan saw who was signed in before the steps above ran.
    $signedIn = @(Get-RpaSignedInUsers $layout $install)
    if ($signedIn.Count -gt 0) { throw ('{0} is signed in. Sign {0} out, then run Uninstall-Rpa.ps1 -RemoveData again.' -f $signedIn[0]) }
    Remove-RpaTree $layout.DataDir
  }
  $result
}

Export-ModuleMember -Function Get-RpaInstallPlan, Get-RpaUninstallPlan, New-RpaSecret, Get-RpaAccount, Get-RpaLayout, Test-RpaAdministrator, Get-RpaMachineFacts, Get-RpaUninstallFacts, Invoke-RpaInstallPlan, Invoke-RpaUninstall
