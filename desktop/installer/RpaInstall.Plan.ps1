# The installer's module, first of three files (RpaInstall.psd1 loads them into one module): what Install-Rpa.ps1 and
# Uninstall-Rpa.ps1 decide. Everything here runs on any platform and looks at nothing but its arguments, so that the
# rules can be tested without a Windows machine.
#
# The installer works in three parts:
#   Get-RpaMachineFacts    looks at the machine (Windows only; RpaInstall.Machine.ps1) and changes nothing
#   Get-RpaInstallPlan     turns the parameters and those facts into refusals, warnings, questions and an ordered
#                          list of steps (this file)
#   Invoke-RpaInstallPlan  runs exactly the listed steps, in order (Windows only; RpaInstall.Machine.ps1)
# The uninstaller has the same three: Get-RpaUninstallFacts, Get-RpaUninstallPlan (this file), Invoke-RpaUninstall.
# RpaInstall.SignIn.ps1 holds what -AutoSignIn changes, records and puts back.
#
# Who is not trusted: the bot user (and anything running as it) and every other standard user. The bot user can create
# files in the data directory and change what is in logs\. So the installer refuses a link or junction where it expects
# the data directory, logs\, policy-backups\, policy.json or a token, refuses one of those that someone other than
# Administrators or SYSTEM owns (logs\ it takes over instead) and a file of those names that has a second name (a
# hard link), passes /L to every icacls call, and deletes folders with rd, which does not enter a junction. A data
# directory that is there when the user of the install is new to it (a first install, another -User) is used only
# when everything in it belongs to Administrators, to SYSTEM or to that user, which must have been there already.
#
# Secrets: New-RpaSecret returns a new secret to its caller. No other function returns one in plain text, and none
# prints or logs one. A token is made inside the function that writes its file, and a generated password inside the
# function that creates the user; neither is ever a parameter of a command or goes through a pipeline, because
# PowerShell's module logging records both.

$script:MinimumBuild = 17763
$script:TaskPath = '\RPA\'
# The data directory's files the bot user may read and never change, and the step that writes each when it is missing.
$script:DataFiles = [ordered]@{ 'policy.json' = 'write policy'; 'token' = 'write token'; 'browser-token' = 'write browser-token' }
$script:SignInSteps = @('store sign-in password', 'turn on automatic sign-in', 'keep the desktop unlocked')

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

# The refusals for what else is in a data directory that an install takes over (one that an uninstall kept, or that
# someone made by hand). -Entries is what Get-RpaDataEntries returns; -OwnSid is the account the run installs for when
# that account was there before the run, else nothing. A link and a file with a second name are refused, the first of
# them by name, and so is the first entry that could not be read (a folder that cannot be listed: what is in it is not
# known). Everything else must belong to Administrators, to SYSTEM or to that account (its logs, certificates and
# exports), and in policy-backups\ to Administrators or SYSTEM only; what does not is refused once, with the number
# of entries and the first of them.
function Get-RpaDataEntryRefusals([string]$DataDir, $Entries, [string]$OwnSid) {
  $refusals = @()
  if (-not $Entries) { return $refusals }
  if ($Entries.Link) {
    if ($Entries.Link.IsLink) { $refusals += '{0} is a link or junction. Remove it and run the installer again.' -f $Entries.Link.Path }
    else { $refusals += '{0} has more than one name (a hard link). Check what it is, remove it, and run the installer again.' -f $Entries.Link.Path }
  }
  if ($Entries.Unreadable) {
    $refusals += '{0} exists and is owned by {1}. Check what is in it, remove it, and run the installer again.' -f $Entries.Unreadable.Path, $Entries.Unreadable.Owner
  }
  $others = @(@($Entries.Owners | Where-Object { $_ -and (-not $OwnSid -or $_.Sid -ne $OwnSid) }) + @($Entries.Backups | Where-Object { $_ }) | Sort-Object { $_.Order })
  if ($others.Count -gt 0) {
    $number = 0
    foreach ($owner in $others) { $number += $owner.Number }
    if ($number -eq 1) {
      $refusals += '1 entry in {0} belongs to another account ({1}, owned by {2}). Remove the data directory with Uninstall-Rpa.ps1 -RemoveData, or remove that entry, and run the installer again.' -f $DataDir, $others[0].First, $others[0].Name
    } else {
      $refusals += '{0} entries in {1} belong to other accounts (the first: {2}, owned by {3}). Remove the data directory with Uninstall-Rpa.ps1 -RemoveData, or remove those entries, and run the installer again.' -f $number, $DataDir, $others[0].First, $others[0].Name
    }
  }
  $refusals
}

# Decides what an install does. -Parameters holds Install-Rpa.ps1's parameters (User, UserPassword, RunnerPort,
# BrowserPort, NoBrowser, NoFirewall, AllowFrom, AllowFromAnyAddress, IncludePublicNetwork, AutoSignIn, Force); -Facts
# is what Get-RpaMachineFacts returns. With a refusal there are no steps: the installer changes nothing. Questions are
# what the installer has confirmed with YES before the first step (with -Force they are warnings). AllowFrom in the
# result is what the firewall rules let in: addresses and ranges, or the one word any, or nothing without rules;
# PublicNetwork says whether the rules also apply on networks Windows treats as Public.
function Get-RpaInstallPlan {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Parameters,
    [Parameter(Mandatory = $true)][hashtable]$Facts
  )
  $user = [string]$Parameters.User
  $hasPassword = $null -ne $Parameters.UserPassword
  $browser = -not $Parameters.NoBrowser
  # powershell -File hands a,b over as one string, so every -AllowFrom value is split at its commas.
  $given = @($Parameters.AllowFrom | ForEach-Object { ([string]$_).Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $any = [bool]$Parameters.AllowFromAnyAddress
  $includePublic = [bool]$Parameters.IncludePublicNetwork
  $firewall = -not $Parameters.NoFirewall
  # An install made with -NoFirewall stays without rules when an upgrade says nothing about the firewall.
  $noRulesRecorded = [bool]$Facts.Installed -and (@($Facts.InstalledAllowFrom) -contains 'none')
  if ($noRulesRecorded -and $given.Count -eq 0 -and -not $any -and -not $includePublic) { $firewall = $false }
  $autoSignIn = [bool]$Parameters.AutoSignIn
  $upgrade = [bool]$Facts.Installed
  $runnerPort = [int]$Parameters.RunnerPort
  $browserPort = [int]$Parameters.BrowserPort
  # A local user that does not exist is created, on a first install and on an upgrade (someone removed it since).
  $createUser = -not $Facts.UserExists -and -not $Facts.UserIsDomain
  # Automatic sign-in that an earlier run turned on for this same user stays as it is.
  $signInKept = $autoSignIn -and $upgrade -and [bool]$Facts.InstalledAutoSignInForUser -and [bool]$Facts.UserExists
  # An upgrade that names another user than the one install.json records.
  $userChanged = $upgrade -and [bool]$Facts.InstalledUser -and -not $Facts.InstalledForUser
  $allowFrom = $null
  $publicNetwork = $false
  $refusals = New-Object Collections.Generic.List[string]
  $warnings = New-Object Collections.Generic.List[string]
  $questions = New-Object Collections.Generic.List[string]
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
      $refusals.Add(('Automatic sign-in is set up for {0}. Uninstall with -RemoveData first, then install for {1}.' -f $Facts.InstalledAutoSignInUser, $user))
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
      # Rules for given addresses apply on every network: the address list is what limits them. Rules for any address
      # apply on Domain and Private networks, and on Public ones only when that is asked for.
      if ($given.Count -gt 0 -and -not $any) { $allowFrom = $given; $publicNetwork = $true }
      elseif ($any -and $given.Count -eq 0) { $allowFrom = @('any'); $publicNetwork = $includePublic }
      elseif (-not $any -and $upgrade -and $Facts.InstalledAllowFrom -and -not $noRulesRecorded) {
        $allowFrom = @($Facts.InstalledAllowFrom)
        $publicNetwork = ($allowFrom -notcontains 'any') -or $includePublic -or [bool]$Facts.InstalledPublicNetwork
      }
      else { $refusals.Add('Say which addresses may connect: -AllowFrom <n8n address>, or -AllowFromAnyAddress, or -NoFirewall.') }
      foreach ($address in $given) {
        if (-not (Test-RpaAddress $address)) { $refusals.Add(('-AllowFrom: {0} is not an IP address or a range such as 10.0.0.0/24.' -f $address)) }
        # A range of every address would open the ports on every network without the two switches meant for that.
        elseif ($address -match '/0+$') { $refusals.Add(('-AllowFrom {0} means every address. Use -AllowFromAnyAddress for that.' -f $address)) }
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
      # The bot user keeps its own files in the data directory (logs, the certificates, exports), so an upgrade for
      # the same user does not judge them. Whenever the user of the install is new to the data directory (a first
      # install, a user this run creates, an upgrade for another user), everything in it is judged: only what
      # Administrators, SYSTEM or that user own is taken over, and a user this run creates owns nothing yet.
      if (-not $upgrade -or $createUser -or $userChanged) {
        $ownSid = $null
        if ($Facts.UserExists) { $ownSid = [string]$Facts.UserSid }
        foreach ($refusal in @(Get-RpaDataEntryRefusals $Facts.DataDir $Facts.DataDirEntries $ownSid)) { $refusals.Add($refusal) }
      }
    }
    # A task folder a standard user made first stays that user's, also after the tasks in it are registered again.
    if ($Facts.TaskFolderOwner) {
      $refusals.Add(('The scheduled task folder {0} exists and is owned by {1}. Check what is in it, remove it, and run the installer again.' -f $script:TaskPath, $Facts.TaskFolderOwner))
    }

    if ($upgrade -and $Facts.RunnerRunning) {
      $text = 'The runner is running; a run in progress will fail. Use -Force to continue.'
      if ($Parameters.Force) { $warnings.Add($text) } else { $refusals.Add($text) }
    }
    # A mistyped -User would otherwise move the install to that name, or create a user of that name, without a word.
    if ($userChanged) {
      $text = '{0} is not the user this install was made for ({1}).' -f $user, $Facts.InstalledUser
      if ($Parameters.Force) { $warnings.Add($text) } else { $questions.Add($text) }
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
    if ($Facts.Leftovers -and $Facts.Leftovers.State -eq 'untrusted') {
      $warnings.Add(('{0} is not a list that Administrators or SYSTEM own, so the installer does not read it. An earlier uninstall keeps there what it could not put back; without it, a setting that is still changed is recorded as it is now, and a later uninstall leaves it that way. Check the file and remove it.' -f $Facts.Leftovers.File))
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

  @{ Refusals = $refusals.ToArray(); Warnings = $warnings.ToArray(); Questions = $questions.ToArray(); Steps = $steps.ToArray(); AllowFrom = $allowFrom; PublicNetwork = $publicNetwork }
}

# Decides whether an uninstall may run. -Parameters holds Uninstall-Rpa.ps1's parameters (RemoveData); -Facts is what
# Get-RpaUninstallFacts returns. Only -RemoveData can be refused: the data directory is deleted by path, so no
# process may be running of an account that can write into it or owns something in it (such a process could swap a
# folder for a junction while the tree is being removed), and a data directory that is itself a link is not removed.
# Nor is one that holds something the uninstaller cannot read (a folder that cannot be listed): who owns what is
# inside is not known, and the removal would stop there with part of the directory gone.
# Accounts are matched by their SID: an account that only has the name of the bot user is not the bot user. A
# process whose account Windows does not give is refused too.
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
    if ($Facts.DataDirUnreadable) {
      $refusals.Add(('{0} exists and is owned by {1}. Check what is in it, remove it, and run Uninstall-Rpa.ps1 -RemoveData again.' -f $Facts.DataDirUnreadable.Path, $Facts.DataDirUnreadable.Owner))
    }
    foreach ($account in @($Facts.Accounts)) {
      if (-not $account -or @($Facts.RunningSids) -notcontains $account.Sid) { continue }
      $refusals.Add(('{0} is signed in. Sign {0} out, then run Uninstall-Rpa.ps1 -RemoveData again.' -f $account.Name))
      if ($Facts.AutoSignInSid -and $Facts.AutoSignInSid -eq $account.Sid) {
        $refusals.Add(('Automatic sign-in is on for {0}, and Windows signs it in again after a sign-out. Run Uninstall-Rpa.ps1 without -RemoveData first, which turns that off; then sign {0} out and run Uninstall-Rpa.ps1 -RemoveData from the unpacked package.' -f $account.Name))
      }
    }
    # A process can take Administrators and SYSTEM off the access rules of its own token, and Windows then tells
    # nobody which account it runs as. Such a process counts as one of an account in question.
    $unknown = @($Facts.UnknownProcesses | Where-Object { $_ })
    if ($unknown.Count -gt 0 -and @($Facts.Accounts | Where-Object { $_ }).Count -gt 0) {
      $more = ''
      if ($unknown.Count -eq 2) { $more = ', nor that of 1 more process' }
      if ($unknown.Count -gt 2) { $more = ', nor that of {0} more processes' -f ($unknown.Count - 1) }
      $refusals.Add(('The owner of {0} cannot be read{1}; it may belong to an account that can change what is in {2}. End it, then run Uninstall-Rpa.ps1 -RemoveData again.' -f $unknown[0], $more, $Facts.DataDir))
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
