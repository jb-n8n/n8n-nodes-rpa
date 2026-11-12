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
# the data directory, logs\, policy-backups\, policy-changes\, policy.json or a token, refuses one of those that someone
# other than Administrators or SYSTEM owns (logs\ it takes over instead) and a file of those names that has a second
# name (a hard link), passes /L to every icacls call, and removes folders through handles (Remove-RpaTree), which
# removes a link or junction inside as the link itself and does not enter it. A data directory that is there when the
# user of the install is new to it (a first install, another -User) is used only when everything in it belongs to
# Administrators, to SYSTEM or to that user, which must have been there already.
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
# What the browser package (rpa-browser-windows-x64.zip, unpacked into the package folder) adds to the package: the
# files an install with the browser needs, below the package folder. browser\VERSION is the version it was built for.
$script:BrowserFiles = @('browser\VERSION', 'browser\node.exe', 'browser\host\host.mjs', 'browser\host\run-server.mjs', 'browser\gate\gate.mjs', 'browser\node_modules\playwright\cli.js', 'scripts\start-browser.ps1')
# With -Unattended the runner and the browser listen on 127.0.0.1 at their port plus this, behind the RPA Supervisor.
$script:InnerPortOffset = 10000

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

# The refusal for the first link or junction, or file with a second name (a hard link), that the walk of the data
# directory found (-Entries is what Get-RpaDataEntries returns), or nothing. It is made on every run: the installer
# sets access rules that pass on to what is inside the data directory and logs\, and through a second name they would
# reach another file.
function Get-RpaDataLinkRefusal($Entries) {
  if (-not $Entries -or -not $Entries.Link) { return $null }
  if ($Entries.Link.IsLink) { return ('{0} is a link or junction. Remove it and run the installer again.' -f $Entries.Link.Path) }
  '{0} has more than one name (a hard link). Check what it is, remove it, and run the installer again.' -f $Entries.Link.Path
}

# The refusals for what else is in a data directory that an install takes over (one that an uninstall kept, or that
# someone made by hand). -Entries is what Get-RpaDataEntries returns; -OwnSid is the account the run installs for when
# that account was there before the run, else nothing. A link and a file with a second name are refused, the first of
# them by name, and so is the first entry that could not be read (a folder that cannot be listed: what is in it is not
# known). Everything else must belong to Administrators, to SYSTEM or to that account (its logs, certificates and
# exports), and in policy-backups\ and policy-changes\ to Administrators or SYSTEM only; what does not is refused once,
# with the number of entries and the first of them.
function Get-RpaDataEntryRefusals([string]$DataDir, $Entries, [string]$OwnSid) {
  $refusals = @()
  if (-not $Entries) { return $refusals }
  $link = Get-RpaDataLinkRefusal $Entries
  if ($link) { $refusals += $link }
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

# What -Unattended changes, in words, for the installer to show before it changes anything: one line for each of its
# steps in -Steps and for what the bot user then has to know. -BrowserPort is 0 with -NoBrowser. No secret goes in.
function Get-RpaUnattendedNotice([string]$User, [int]$RunnerPort, [int]$BrowserPort, [int]$IdleSeconds, [string[]]$Steps) {
  $ports = '{0}' -f $RunnerPort
  $inner = 'The runner listens on 127.0.0.1 only, at port {0}.' -f ($RunnerPort + $script:InnerPortOffset)
  if ($BrowserPort) {
    $ports = '{0} and {1}' -f $RunnerPort, $BrowserPort
    $inner = 'The runner and the browser listen on 127.0.0.1 only,'
  }
  $lines = @(
    '-Unattended changes how this machine works:'
    ('  - The service RPA Supervisor (RpaSupervisor.exe, running as SYSTEM, started with Windows) listens on port {0}.' -f $ports)
    ('    When n8n connects, it signs {0} in through a Remote Desktop connection from this machine to itself,' -f $User)
    ('    and signs it out again {0} s after the last connection. {1}' -f $IdleSeconds, $inner)
  )
  if ($BrowserPort) { $lines += '    at port {0} and {1}.' -f ($RunnerPort + $script:InnerPortOffset), ($BrowserPort + $script:InnerPortOffset) }
  if ($Steps -contains 'turn off automatic sign-in') {
    $lines += '  - Automatic sign-in of {0} is turned off, and the settings -AutoSignIn changed go back to what they were.' -f $User
  }
  if ($Steps -contains 'keep the automatic sign-in password for the supervisor') {
    $lines += '  - The password of {0} stays the same: the one stored for automatic sign-in is stored for the RPA Supervisor' -f $User
    $lines += '    instead, so no program of {0} loses data it protects with that password.' -f $User
  }
  $lines += '  - {0} is added to the group Remote Desktop Users, unless it is a member already.' -f $User
  if ($Steps -contains 'turn on Remote Desktop') {
    $lines += '  - Remote Desktop is turned on (it is off now). The installer turns on no firewall rule for Remote Desktop: the RPA'
    $lines += '    Supervisor connects from this machine to itself. Where a firewall rule that is on already, or a firewall that'
    $lines += '    is off, lets connections to port 3389 in, Remote Desktop can then be reached from the network.'
    $lines += '    Uninstall-Rpa.ps1 turns it off again.'
  }
  if ($Steps -contains "store the bot user's password for the supervisor") {
    $lines += '  - The password of {0} is stored on this machine for the RPA Supervisor. An administrator of this machine' -f $User
    $lines += '    can read it.'
  }
  if ($Steps -contains 'point the firewall rules at the supervisor' -or $Steps -contains 'point the firewall rule at the supervisor') {
    if ($BrowserPort) {
      $lines += '  - The firewall rules for port {0} let connections in to the RPA Supervisor instead of the runner and the' -f $ports
      $lines += '    browser.'
    } else { $lines += '  - The firewall rule for port {0} lets connections in to the RPA Supervisor instead of the runner.' -f $ports }
  }
  if ($Steps -contains 'sign the bot user out') {
    $lines += '  - {0} is signed out now (every session of {0}), so that the RPA Supervisor can sign it in for each run.' -f $User
  }
  $lines += '  - While someone is signed in as {0}, at the console or over Remote Desktop, runs are refused.' -f $User
  $lines += '  Uninstall-Rpa.ps1 puts these settings back to what they were.'
  $lines
}

# Whether Install-Rpa.ps1 was given no sign-in mode: none of -Unattended (also not -Unattended:$false), -AutoSignIn
# and -UserPassword. A first install for a new local bot user on Windows Server is then an unattended install.
function Test-RpaNoModeGiven([hashtable]$Parameters) {
  -not $Parameters.Unattended -and -not $Parameters.UnattendedGiven -and -not $Parameters.AutoSignIn -and $null -eq $Parameters.UserPassword
}

# Why the install cannot have the browser that -WithBrowser or the install asks for, or nothing: the package folder
# (-Facts.PackageDir) lacks the browser files, or holds them for another version. -Kept says that the browser is there
# because the install has it (no -WithBrowser), which -NoBrowser would remove.
function Get-RpaBrowserFilesRefusal([hashtable]$Facts, [bool]$Kept) {
  $folder = [string]$Facts.PackageDir
  $version = [string]$Facts.PackageVersion
  if ($Facts.BrowserFiles -ne 'present') {
    if ($Kept) { return ('This install has the browser, and its files are not in {0}: run Get-Rpa.ps1 -WithBrowser, unpack rpa-browser-windows-x64.zip into that folder (Expand-Archive <path of the zip> -DestinationPath "{0}") and run this again, or remove the browser with -NoBrowser.' -f $folder) }
    return ('The browser files are not in {0}: run Get-Rpa.ps1 -WithBrowser, or unpack rpa-browser-windows-x64.zip into that folder (Expand-Archive <path of the zip> -DestinationPath "{0}") and run this again.' -f $folder)
  }
  if ([string]$Facts.BrowserVersion -eq $version) { return $null }
  if ($Kept) { return ('This install has the browser, and the browser files in {0} are of version {1}, and the package is version {2}: unpack the rpa-browser-windows-x64.zip of version {2} into that folder, or remove the browser with -NoBrowser.' -f $folder, $Facts.BrowserVersion, $version) }
  'The browser files in {0} are of version {1}, and the package is version {2}: unpack the rpa-browser-windows-x64.zip of version {2} into that folder.' -f $folder, $Facts.BrowserVersion, $version
}

# Decides what an install does. -Parameters holds Install-Rpa.ps1's parameters (User, UserPassword, RunnerPort,
# BrowserPort, NoBrowser, WithBrowser, NoFirewall, AllowFrom, AllowFromAnyAddress, IncludePublicNetwork, AutoSignIn,
# Unattended, UnattendedGiven, IdleSeconds, IdleSecondsGiven, Force); -Facts is what Get-RpaMachineFacts returns. With a
# refusal there are no steps: the installer changes nothing. Questions are what the installer has confirmed with YES before the
# first step (with -Force they are warnings). AllowFrom in the result is what the firewall rules let in: addresses and
# ranges, or the one word any, or nothing without rules; PublicNetwork says whether the rules also apply on networks
# Windows treats as Public. Notice is what -Unattended changes, in lines to show and confirm before the first step, when
# an earlier run has not set it up already; without a sign-in mode its first two lines say that the install is
# unattended for that reason. Unattended and IdleSeconds are the mode and idle time the install gets: an upgrade keeps
# them from the record unless -Unattended or -IdleSeconds is given. Browser says whether the install has the browser:
# -WithBrowser adds it, an upgrade without -WithBrowser or -NoBrowser keeps what the install has (as it keeps the
# sign-in mode), and -NoBrowser leaves it out, or removes it from an install that has it. Install-Rpa.ps1 hands it on
# to Invoke-RpaInstallPlan as NoBrowser.
function Get-RpaInstallPlan {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Parameters,
    [Parameter(Mandatory = $true)][hashtable]$Facts
  )
  $user = [string]$Parameters.User
  $hasPassword = $null -ne $Parameters.UserPassword
  $upgrade = [bool]$Facts.Installed
  $installedBrowser = $upgrade -and [bool]$Facts.InstalledBrowser
  $browser = [bool]$Parameters.WithBrowser -or ($installedBrowser -and -not $Parameters.NoBrowser)
  # powershell -File hands a,b over as one string, so every -AllowFrom value is split at its commas.
  $given = @($Parameters.AllowFrom | ForEach-Object { ([string]$_).Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $any = [bool]$Parameters.AllowFromAnyAddress
  $includePublic = [bool]$Parameters.IncludePublicNetwork
  $firewall = -not $Parameters.NoFirewall
  # An install made with -NoFirewall stays without rules when an upgrade says nothing about the firewall.
  $noRulesRecorded = [bool]$Facts.Installed -and (@($Facts.InstalledAllowFrom) -contains 'none')
  if ($noRulesRecorded -and $given.Count -eq 0 -and -not $any -and -not $includePublic) { $firewall = $false }
  $autoSignIn = [bool]$Parameters.AutoSignIn
  $runnerPort = [int]$Parameters.RunnerPort
  $browserPort = [int]$Parameters.BrowserPort
  # An install that an earlier run made with -Unattended.
  $wasUnattended = $upgrade -and [string]$Facts.InstalledMode -eq 'unattended'
  # An upgrade keeps the recorded mode, as it keeps automatic sign-in: only -Unattended:$false goes back to the
  # signed-in mode. The idle time stays what the install recorded unless -IdleSeconds is given.
  $unattended = [bool]$Parameters.Unattended -or ($wasUnattended -and -not $Parameters.UnattendedGiven)
  # Without a mode, a first install for a new local bot user on Windows Server is unattended; on Windows 10 or 11 it is
  # refused, with the sentence that names -AutoSignIn.
  $defaultMode = (Test-RpaNoModeGiven $Parameters) -and -not $upgrade -and -not $Facts.UserExists -and -not $Facts.UserIsDomain -and [bool]$Facts.IsServer
  if ($defaultMode) { $unattended = $true }
  $idleSeconds = [int]$Parameters.IdleSeconds
  if ($wasUnattended -and -not $Parameters.IdleSecondsGiven -and $null -ne $Facts.InstalledIdleSeconds) { $idleSeconds = [int]$Facts.InstalledIdleSeconds }
  # An install with automatic sign-in for this same bot user moves to -Unattended with the password it has: the one
  # stored for automatic sign-in (or -UserPassword), so that no program of the bot user loses what it protects with it.
  $convert = $unattended -and $upgrade -and [bool]$Facts.InstalledAutoSignInForUser -and [bool]$Facts.UserExists
  # The way back, -Unattended:$false -AutoSignIn for the same bot user, keeps the password the same way: the one stored
  # for the RPA Supervisor (or -UserPassword) becomes the automatic sign-in password before the supervisor goes.
  $back = $autoSignIn -and -not $unattended -and $upgrade -and [bool]$Facts.InstalledSupervisorSecret -and [bool]$Facts.InstalledForUser -and [bool]$Facts.UserExists
  # The password an earlier run with -Unattended stored for this same user stays, while install.json records it.
  $secretKept = $unattended -and $wasUnattended -and [bool]$Facts.InstalledForUser -and [bool]$Facts.UserExists -and [bool]$Facts.InstalledSupervisorSecret
  # A local user that does not exist is created, on a first install and on an upgrade (someone removed it since).
  $createUser = -not $Facts.UserExists -and -not $Facts.UserIsDomain
  # Automatic sign-in that an earlier run turned on for this same user stays as it is.
  $signInKept = $autoSignIn -and $upgrade -and [bool]$Facts.InstalledAutoSignInForUser -and [bool]$Facts.UserExists
  # An upgrade that names another user than the one install.json records.
  $userChanged = $upgrade -and [bool]$Facts.InstalledUser -and -not $Facts.InstalledForUser
  # A first install over a data directory whose access rules name another user: the bot user of an earlier install
  # (the uninstaller takes the bot user from these rules too, when install.json is gone).
  $earlier = @($Facts.EarlierUsers | Where-Object { $_ -and $_.Sid -ne [string]$Facts.UserSid })
  $previousUser = $null
  if ($userChanged) { $previousUser = [string]$Facts.InstalledUser }
  elseif (-not $upgrade -and $earlier.Count -gt 0) { $previousUser = [string]$earlier[0].Name }
  # That user could read both tokens, so a change of user replaces them.
  $tokens = @('token', 'browser-token' | Where-Object { $Facts.DataFiles -and $Facts.DataFiles[$_] -and $Facts.DataFiles[$_].Exists })
  $replaceTokens = [bool]$previousUser -and $tokens.Count -gt 0
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
    if ($Parameters.WithBrowser -and $Parameters.NoBrowser) {
      $refusals.Add('-WithBrowser and -NoBrowser cannot be used together: -WithBrowser adds the browser, -NoBrowser leaves it out or removes it. Choose one.')
    } elseif ($browser) {
      $filesRefusal = Get-RpaBrowserFilesRefusal $Facts (-not $Parameters.WithBrowser)
      if ($filesRefusal) { $refusals.Add($filesRefusal) }
    }
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
      # Behind the RPA Supervisor the runner and the browser listen on their port + 10000, which must be free too (on
      # an upgrade of an unattended install, the installed ones hold those of the ports that stay).
      if ($unattended) {
        $inner = @()
        foreach ($service in @(@{ Name = 'RunnerPort'; What = 'the runner'; Port = $runnerPort; Installed = $Facts.InstalledRunnerPort }, @{ Name = 'BrowserPort'; What = 'the browser'; Port = $browserPort; Installed = $Facts.InstalledBrowserPort })) {
          if ($service.Name -eq 'BrowserPort' -and -not $browser) { continue }
          if ($service.Port + $script:InnerPortOffset -gt 65535) {
            $refusals.Add(('-{0} {1} is too high for -Unattended: {2} then listens on port {1} + {3} on 127.0.0.1, so the highest is {4}.' -f $service.Name, $service.Port, $service.What, $script:InnerPortOffset, (65535 - $script:InnerPortOffset)))
          } elseif (-not ($wasUnattended -and $service.Installed -eq $service.Port)) { $inner += $service.Port + $script:InnerPortOffset }
        }
        if ($browser -and ($browserPort -eq $runnerPort + $script:InnerPortOffset -or $runnerPort -eq $browserPort + $script:InnerPortOffset)) {
          $refusals.Add(('-RunnerPort {0} and -BrowserPort {1} do not work together with -Unattended: the runner and the browser then also listen on {2} and {3}, and all four ports must differ.' -f $runnerPort, $browserPort, ($runnerPort + $script:InnerPortOffset), ($browserPort + $script:InnerPortOffset)))
        }
        foreach ($port in $inner) {
          $process = $null
          if ($Facts.PortsInUse) { $process = $Facts.PortsInUse[$port] }
          if ($process) { $refusals.Add(('Port {0} is in use by {1}. With -Unattended the runner and the browser listen on their port + {2} on 127.0.0.1; choose another -RunnerPort or -BrowserPort.' -f $port, $process, $script:InnerPortOffset)) }
        }
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
      if ($back -and -not $hasPassword) {
        if ($Facts.SupervisorPassword -eq 'wrong') {
          $refusals.Add(('Windows does not accept the password stored for the RPA Supervisor of {0} any more, so -AutoSignIn cannot keep it. Give the password of {0} with -UserPassword, or install for a new bot user with -User.' -f $user))
        } elseif ($Facts.SupervisorPassword -ne 'ok') {
          $refusals.Add(('The RPA Supervisor of {0} has no stored password that the installer can read, so -AutoSignIn cannot keep it. Give the password of {0} with -UserPassword, or install for a new bot user with -User.' -f $user))
        }
      }
      elseif ($autoSignIn -and $Facts.UserExists -and -not $hasPassword -and -not $signInKept) {
        $refusals.Add(('-AutoSignIn for the existing user {0} needs -UserPassword. A password the installer generated earlier is not known to anyone: set a new password for {0} and pass it, or remove {0} so the installer creates it again. A new password makes what the programs of {0} protected with the old one unreadable (the entries of an authenticator application, the certificate of the runner), so where such data exists a new bot user (-User) is the safer way. After a new password the runner cannot read its certificate: remove it and put the new fingerprint into the n8n credential (docs/install/windows.md, section 10).' -f $user))
      }
      if ($autoSignIn -and $Facts.UserExists -and $hasPassword -and $Facts.UserPasswordWrong) {
        $refusals.Add(('The password given for {0} is not correct.' -f $user))
      }
    }
    # With -Unattended a user the installer creates gets a random password, which is stored for the RPA Supervisor.
    if ($createUser -and -not $autoSignIn -and -not $unattended -and -not $hasPassword) {
      $refusals.Add(('Give -UserPassword for the new user {0}, or use -AutoSignIn to have a random password stored for automatic sign-in.' -f $user))
    }

    if ($Parameters.IdleSecondsGiven -and -not $unattended) { $refusals.Add('-IdleSeconds is for -Unattended only.') }
    if ($unattended) {
      # Not tested on a desktop edition, which also allows one interactive session at a time.
      if (-not $Facts.IsServer) {
        $refusals.Add('-Unattended is for Windows Server 2019 or later. It was not tested on Windows 10 or 11, so the installer does not set it up there. Install without -Unattended, and have the bot user signed in (-AutoSignIn, or by hand).')
      }
      if ($autoSignIn -and -not $Parameters.Unattended) {
        $refusals.Add('This install was made with -Unattended, which an upgrade keeps. To use -AutoSignIn instead, run the installer with -Unattended:$false -AutoSignIn.')
      } elseif ($autoSignIn) {
        $refusals.Add('-Unattended and -AutoSignIn cannot be used together: -AutoSignIn keeps the bot user signed in, -Unattended signs it in only for the runs. Choose one.')
      }
      # The RPA Supervisor connects to the standard Remote Desktop port.
      if ($Facts.RemoteDesktopPort -and [int]$Facts.RemoteDesktopPort -ne 3389) {
        $refusals.Add(('-Unattended needs Remote Desktop on port 3389, where the RPA Supervisor connects, and this machine sets it to port {0} (PortNumber of RDP-Tcp).' -f $Facts.RemoteDesktopPort))
      }
      # The RPA Supervisor signs in a local user of this machine only.
      if ($Facts.UserIsDomain) {
        $refusals.Add(('-Unattended needs a local user of this machine as the bot user; {0} is a domain user.' -f $user))
      }
      # Windows would sign the bot user in by itself, and the supervisor refuses a session it did not create.
      elseif ($upgrade -and $Facts.InstalledAutoSignInUser -and $Facts.InstalledAutoSignInForUser -and -not $convert) {
        $refusals.Add(('Automatic sign-in is set up for {0}, and with -Unattended nobody may be signed in by Windows itself. Run Uninstall-Rpa.ps1 first, which turns automatic sign-in off, then install with -Unattended.' -f $Facts.InstalledAutoSignInUser))
      }
      elseif ($convert -and -not $hasPassword -and $Facts.AutoSignInPassword -eq 'missing') {
        $refusals.Add(('Automatic sign-in of {0} has no stored password that the installer can read, so -Unattended cannot keep it. Give the password of {0} with -UserPassword, or install for a new bot user with -User.' -f $user))
      }
      elseif ($convert -and -not $hasPassword -and $Facts.AutoSignInPassword -eq 'wrong') {
        $refusals.Add(('Windows does not accept the password stored for automatic sign-in of {0} any more, so -Unattended cannot keep it. Give the password of {0} with -UserPassword, or install for a new bot user with -User.' -f $user))
      }
      elseif ($Facts.UserExists -and -not $hasPassword -and -not $secretKept -and -not $convert) {
        $refusals.Add(('-Unattended for the existing user {0} needs -UserPassword: the RPA Supervisor signs {0} in with it. A password the installer generated earlier is not known to anyone: set a new password for {0} and pass it, or remove {0} so the installer creates it again. A new password makes what the programs of {0} protected with the old one unreadable (the entries of an authenticator application, the certificate of the runner), so where such data exists a new bot user (-User) is the safer way. After a new password the runner cannot read its certificate: remove it and put the new fingerprint into the n8n credential (docs/install/windows.md, section 10).' -f $user))
      }
      elseif ($Facts.UserExists -and $hasPassword -and $Facts.UserPasswordWrong -and -not $autoSignIn) {
        $refusals.Add(('The password given for {0} is not correct.' -f $user))
      }
      # The supervisor signs in through the Remote Desktop service, and depends on it: a disabled one cannot start.
      if ($Facts.RemoteDesktopServiceDisabled) {
        $refusals.Add('-Unattended needs the Remote Desktop service (TermService), which is disabled on this machine: set it to start (Set-Service TermService -StartupType Manual) and run the installer again.')
      }
      # The service's folder: it writes its log and state there as SYSTEM, and refuses to start in one it cannot trust.
      $supervisorRefusal = Get-RpaPathRefusal $Facts.SupervisorDir $Facts.SupervisorDirState $true
      if ($supervisorRefusal) { $refusals.Add($supervisorRefusal) }
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
          if ($browser) { $warnings.Add('This machine is on a network that Windows treats as Public. The firewall rules are for Domain and Private networks, so they let nothing in on that network.') }
          else { $warnings.Add('This machine is on a network that Windows treats as Public. The firewall rule is for Domain and Private networks, so it lets nothing in on that network.') }
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
      # The same for the folder it copies a change file into before it applies it.
      $changesRefusal = Get-RpaPathRefusal $Facts.PolicyChangesDir $Facts.PolicyChangesState $true
      if ($changesRefusal) { $refusals.Add($changesRefusal) }
      # The bot user keeps its own files in the data directory (logs, the certificates, exports), so an upgrade for
      # the same user does not judge who owns them; a link, or a file with a second name, is refused on every run.
      # Whenever the user of the install is new to the data directory (a first install, a user this run creates, an
      # upgrade for another user), everything in it is judged: only what Administrators, SYSTEM or that user own is
      # taken over, and a user this run creates owns nothing yet.
      if (-not $upgrade -or $createUser -or $userChanged) {
        $ownSid = $null
        if ($Facts.UserExists) { $ownSid = [string]$Facts.UserSid }
        foreach ($refusal in @(Get-RpaDataEntryRefusals $Facts.DataDir $Facts.DataDirEntries $ownSid)) { $refusals.Add($refusal) }
      } else {
        $linkRefusal = Get-RpaDataLinkRefusal $Facts.DataDirEntries
        if ($linkRefusal) { $refusals.Add($linkRefusal) }
      }
    }
    # A task folder a standard user made first stays that user's, also after the tasks in it are registered again.
    if ($Facts.TaskFolderOwner) {
      $refusals.Add(('The scheduled task folder {0} exists and is owned by {1}. Check what is in it, remove it, and run the installer again.' -f $script:TaskPath, $Facts.TaskFolderOwner))
    }

    # Nobody signed in, and no run holds the runner: the RPA Supervisor's session of the bot user stays for the idle
    # time after the last connection (the installer's own check of the runner is one), and the runner with it.
    if ($upgrade -and $Facts.RunnerRunning -and $Facts.RunnerIdle -and $Facts.InstalledMode -eq 'unattended') {
      $idleSeconds = 15
      if ($null -ne $Facts.InstalledIdleSeconds) { $idleSeconds = [int]$Facts.InstalledIdleSeconds }
      if (-not ($Parameters.Force -or $convert)) { $refusals.Add(('No run is in progress: the bot user is still signed in from the last connection to the runner, and the RPA Supervisor signs that session out by itself {0} s after that connection ended. Run this again then, or add -Force.' -f $idleSeconds)) }
    } elseif ($upgrade -and $Facts.RunnerRunning) {
      $text = 'The runner is running; a run in progress will fail.'
      # A move from automatic sign-in always finds the runner running (Windows signed the bot user in), and signs the
      # bot user out anyway, which its notice says: a refusal here would hide that notice and its question behind
      # -Force.
      if ($Parameters.Force -or $convert) { $warnings.Add($text) } else { $refusals.Add($text + ' Use -Force to continue.') }
    }
    # A mistyped -User would otherwise move the install to that name, or create a user of that name, without a word.
    if ($userChanged) {
      $text = '{0} is not the user this install was made for ({1}).' -f $user, $Facts.InstalledUser
      if ($Parameters.Force) { $warnings.Add($text) } else { $questions.Add($text) }
    }
    if ($replaceTokens) {
      if ($browser) { $text = '{0} could read the tokens in the data directory, so both are replaced; the n8n credentials then need the new tokens.' -f $previousUser }
      else { $text = '{0} could read the tokens in the data directory, so the runner token is replaced and the browser token removed; the n8n credentials then need the new runner token.' -f $previousUser }
      # Said with the question about the user where there is one, before anything changes.
      if ($userChanged -and -not $Parameters.Force) { $questions.Add($text) } else { $warnings.Add($text) }
    }
    if ($autoSignIn -and $Facts.UserExists -and $Facts.UserPasswordExpires) {
      $warnings.Add(("{0}'s password expires; automatic sign-in stops working when it does." -f $user))
    }
    if ($convert -and -not $hasPassword -and $Facts.AutoSignInPasswordProblem) {
      $warnings.Add(('The password stored for automatic sign-in of {0} could not be checked: {1}' -f $user, $Facts.AutoSignInPasswordProblem))
    }
    if ($unattended -and $Facts.UserExists -and $Facts.UserPasswordExpires) {
      $warnings.Add(("{0}'s password expires; when it does, the RPA Supervisor cannot sign {0} in until a new one is stored with Install-Rpa.ps1 -Unattended -UserPassword." -f $user))
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
    # which no step touches); what is missing of them is made again. A change of user removes both tokens before the
    # new user gets its access to the data directory, and new ones are written. The program files come before the
    # user, so that a failed copy leaves no new user behind.
    # install.json is written before the sign-in steps, so that the uninstaller knows about them even when one fails.
    if ($upgrade) { $steps.Add('stop running services') }
    $steps.Add('copy program files')
    if ($createUser) { $steps.Add('create user') }
    if ($replaceTokens) { $steps.Add('remove the old tokens') }
    $steps.Add('protect the data directory')
    # A file that is there is never written again; one that is missing is written, on a first install and on an upgrade.
    foreach ($name in $script:DataFiles.Keys) {
      if ($name -eq 'browser-token' -and -not $browser) { continue }
      $state = $null
      if ($Facts.DataFiles) { $state = $Facts.DataFiles[$name] }
      if (-not $state -or -not $state.Exists -or ($replaceTokens -and $tokens -contains $name)) { $steps.Add($script:DataFiles[$name]) }
    }
    if ($firewall) {
      $steps.Add('add the runner firewall rule')
      if ($browser) { $steps.Add('add the browser firewall rule') } elseif ($upgrade) { $steps.Add('remove the browser firewall rule') }
    }
    $steps.Add('register the runner task')
    if ($browser) { $steps.Add('register the browser task') } elseif ($upgrade) { $steps.Add('remove the browser task') }
    # An upgrade without the browser, of an install that had it (or that still holds its token): its token and
    # certificate go as well (its program files go with the copy).
    $browserToken = $Facts.DataFiles -and $Facts.DataFiles['browser-token'] -and $Facts.DataFiles['browser-token'].Exists
    if (-not $browser -and $upgrade -and ($installedBrowser -or $browserToken)) { $steps.Add('remove the browser token and certificate') }
    $steps.Add('write install.json')
    if ($back -and -not $hasPassword) { $steps.Add('keep the supervisor password for automatic sign-in') }
    if ($autoSignIn) {
      if (-not $signInKept) { foreach ($step in $script:SignInSteps) { $steps.Add($step) } }
      elseif ($hasPassword) { $steps.Add('store sign-in password') }
    }
    # An install with -Unattended:$false over one with -Unattended: the service, the stored password, the group
    # membership and Remote Desktop go back to what they were, from the records in install.json; also when a run
    # before tried that and could not put everything back. After automatic sign-in, which may take its password.
    if ($upgrade -and $Facts.InstalledUnattendedChanges -and -not $unattended) { $steps.Add('put back what -Unattended changed') }
    # After install.json, so that the uninstaller knows about each of them even when one fails. The service starts
    # once its folder, the group membership, Remote Desktop and the password are there.
    # Moving from automatic sign-in: the password is stored for the supervisor while Windows still has it, then
    # automatic sign-in goes off, and its console session is signed out before the supervisor's first sign-in.
    if ($unattended) {
      if ($convert) {
        if ($hasPassword) { $steps.Add("store the bot user's password for the supervisor") }
        else { $steps.Add('keep the automatic sign-in password for the supervisor') }
        $steps.Add('turn off automatic sign-in')
      }
      $steps.Add('allow the bot user to sign in through Remote Desktop')
      if ($Facts.RemoteDesktopDenied) { $steps.Add('turn on Remote Desktop') }
      if (-not $convert -and (-not $secretKept -or $hasPassword)) { $steps.Add("store the bot user's password for the supervisor") }
      if ($convert) { $steps.Add('sign the bot user out') }
      $steps.Add('register the supervisor service')
      if ($firewall -and $browser) { $steps.Add('point the firewall rules at the supervisor') }
      elseif ($firewall) { $steps.Add('point the firewall rule at the supervisor') }
    }
    $steps.Add('add the Start menu shortcut')
    if ($upgrade) { $steps.Add('start tasks') }
  }

  $notice = @()
  if ($unattended -and -not $wasUnattended -and $steps.Count -gt 0) {
    $shownBrowserPort = 0
    if ($browser) { $shownBrowserPort = $browserPort }
    $notice = @(Get-RpaUnattendedNotice $user $runnerPort $shownBrowserPort $idleSeconds $steps.ToArray())
    if ($defaultMode) {
      $notice = @(
        'No sign-in mode was given, so this install is unattended (-Unattended): the default on Windows Server for a new bot'
        'user. The other choices: -AutoSignIn (Windows keeps the bot user signed in), or -UserPassword (a person signs it in).'
      ) + $notice
    }
  } elseif ($back -and $steps.Count -gt 0) {
    $notice = @('-Unattended:$false changes how this machine works:')
    if ($steps -contains 'keep the supervisor password for automatic sign-in') {
      $notice += '  - The password of {0} stays the same: the one stored for the RPA Supervisor is stored for automatic' -f $user
      $notice += '    sign-in instead, so no program of {0} loses data it protects with that password.' -f $user
    }
    $notice += '  - The service RPA Supervisor, its stored password and the other settings -Unattended changed are removed or put'
    $notice += '    back, after automatic sign-in is set up.'
    $notice += '  - Windows signs {0} in at the next start of this machine (Restart-Computer).' -f $user
  }
  @{
    Refusals = $refusals.ToArray(); Warnings = $warnings.ToArray(); Questions = $questions.ToArray(); Steps = $steps.ToArray()
    AllowFrom = $allowFrom; PublicNetwork = $publicNetwork; Notice = $notice; Unattended = $unattended; IdleSeconds = $idleSeconds
    Browser = $browser
  }
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
      # With -Unattended the RPA Supervisor's session of the bot user goes when the service stops.
      if ($Facts.Unattended -and $account.Bot) {
        $refusals.Add(("{0} is signed in. Stop the RPA Supervisor, which signs its session of {0} out (Stop-Service 'RPA Supervisor'), sign out any other session of {0}, then run Uninstall-Rpa.ps1 -RemoveData again." -f $account.Name))
      } else { $refusals.Add(('{0} is signed in. Sign {0} out, then run Uninstall-Rpa.ps1 -RemoveData again.' -f $account.Name)) }
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
