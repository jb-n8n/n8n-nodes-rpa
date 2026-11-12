# Pester tests for the Windows installer (desktop/installer). They cover what runs anywhere: the plans the installer and
# the uninstaller make from their parameters and hand-made facts about the machine (they touch nothing), the secret
# generator, how a user name is read, Show-RpaConnection.ps1 against a made-up install, and that every script still
# parses as Windows PowerShell 5.1. A few tests need Windows and are skipped elsewhere. The install itself (users,
# permissions, tasks, firewall) runs only on Windows and is driven end to end by the desktop workflow.
#
#   Invoke-Pester desktop/installer/test

BeforeDiscovery {
  # The connection lines the installer and the node's credentials share (packages/n8n-nodes-rpa/test/fixtures).
  $script:LineSamples = @((Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../../../packages/n8n-nodes-rpa/test/fixtures/connection-lines.json') | ConvertFrom-Json).samples |
      ForEach-Object { @{ description = $_.description; kind = $_.kind; address = $_.address; port = $_.port; token = $_.token; fingerprint = $_.fingerprint; line = $_.line } })
}

BeforeAll {
  $script:InstallerDir = Split-Path -Parent $PSScriptRoot
  $script:LinesFile = Join-Path $PSScriptRoot '../../../packages/n8n-nodes-rpa/test/fixtures/connection-lines.json'
  Import-Module (Join-Path $script:InstallerDir 'RpaInstall.psd1') -Force
  # The module is three script files that its manifest loads into one module.
  $script:ModuleFiles = @('RpaInstall.psd1', 'RpaInstall.Plan.ps1', 'RpaInstall.SignIn.ps1', 'RpaInstall.Machine.ps1')
  # With Unix line ends, whatever the checkout has (a Windows checkout has CRLF): the tests match across lines.
  $script:ModuleSource = (($script:ModuleFiles | ForEach-Object { Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir $_) }) -join "`n") -replace "`r`n", "`n"
  $script:DataDir = 'C:\ProgramData\RPA Runner'

  # Install-Rpa.ps1 -AllowFrom 10.0.0.5 -WithBrowser and nothing else. Without -WithBrowser a first install has no
  # browser (Context 'the browser').
  function New-TestParameters([hashtable]$Change = @{}) {
    $parameters = @{
      User = 'rpa-runner'; UserPassword = $null; RunnerPort = 8765; BrowserPort = 3000
      AllowFrom = @('10.0.0.5'); AllowFromAnyAddress = $false; IncludePublicNetwork = $false
      NoBrowser = $false; WithBrowser = $true; NoFirewall = $false; AutoSignIn = $false; Unattended = $false; IdleSeconds = 15; Force = $false
    }
    foreach ($key in $Change.Keys) { $parameters[$key] = $Change[$key] }
    $parameters
  }

  # What Get-RpaMachineFacts says about one path in the data directory.
  function New-PathState([string]$Kind = 'ours') {
    switch ($Kind) {
      'missing' { @{ Exists = $false; IsLink = $false; Links = 0; OwnerTrusted = $false; Owner = '' } }
      'ours' { @{ Exists = $true; IsLink = $false; Links = 1; OwnerTrusted = $true; Owner = 'BUILTIN\Administrators' } }
      'link' { @{ Exists = $true; IsLink = $true; Links = 1; OwnerTrusted = $true; Owner = 'BUILTIN\Administrators' } }
      'theirs' { @{ Exists = $true; IsLink = $false; Links = 1; OwnerTrusted = $false; Owner = 'BOT-PC\mallory' } }
      # A second name for a file that Administrators own: a hard link.
      'hardlink' { @{ Exists = $true; IsLink = $false; Links = 2; OwnerTrusted = $true; Owner = 'BUILTIN\Administrators' } }
    }
  }

  # A clean, supported machine: an administrator on 64-bit Windows Server 2022, nothing installed, no such user, no
  # data directory; the package folder holds the browser files of its own version.
  function New-TestFacts([hashtable]$Change = @{}) {
    $facts = @{
      IsAdmin = $true; Is64Bit = $true; OsBuild = 20348
      UserExists = $false; UserIsDomain = $false; UserIsAdmin = $false; UserAdminUnknown = $false
      UserPasswordExpires = $false; UserPasswordWrong = $false; UserPasswordProblem = $null
      PortsInUse = @{}; Installed = $false; RunnerRunning = $false
      InstalledRunnerPort = $null; InstalledBrowserPort = $null; InstalledBrowser = $false
      InstalledAllowFrom = $null; InstalledPublicNetwork = $false
      InstalledAutoSignInForUser = $false; InstalledAutoSignInUser = $null; InstalledUser = $null; InstalledForUser = $false
      UserSid = $null; EarlierUsers = @()
      DataDir = $script:DataDir; LogDir = "$($script:DataDir)\logs"; PolicyBackupsDir = "$($script:DataDir)\policy-backups"
      PolicyChangesDir = "$($script:DataDir)\policy-changes"
      DataDirState = New-PathState 'missing'; LogDirState = New-PathState 'missing'; PolicyBackupsState = New-PathState 'missing'; PolicyChangesState = New-PathState 'missing'
      DataDirEntries = $null
      DataFiles = @{ 'policy.json' = New-PathState 'missing'; 'token' = New-PathState 'missing'; 'browser-token' = New-PathState 'missing' }
      TaskFolderOwner = $null; PublicNetwork = $false
      AutoSignInPassword = $null; SupervisorPassword = $null; IsServer = $true; RemoteDesktopDenied = $false; RemoteDesktopServiceDisabled = $false; RemoteDesktopPort = 3389; InstalledIdleSeconds = $null; InstalledMode = $null; InstalledSupervisorSecret = $false; InstalledUnattendedChanges = $false
      SupervisorDir = "$($script:DataDir)\supervisor"; SupervisorDirState = New-PathState 'missing'
      PackageDir = 'C:\Program Files\RPA package\0.3.0\rpa-windows-x64'; PackageVersion = '0.3.0'; BrowserFiles = 'present'; BrowserVersion = '0.3.0'
    }
    foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
    $facts
  }

  # The same machine after Install-Rpa.ps1 -AllowFrom 10.0.0.5 -WithBrowser -UserPassword ... ran on it.
  function New-InstalledFacts([hashtable]$Change = @{}) {
    $facts = New-TestFacts @{
      Installed = $true; UserExists = $true; UserSid = $script:BotSid; InstalledUser = 'rpa-runner'; InstalledForUser = $true
      InstalledRunnerPort = 8765; InstalledBrowserPort = 3000; InstalledBrowser = $true; InstalledAllowFrom = @('10.0.0.5')
      DataDirState = New-PathState 'ours'; LogDirState = New-PathState 'ours'; PolicyBackupsState = New-PathState 'ours'; PolicyChangesState = New-PathState 'ours'
      DataFiles = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'ours' }
    }
    foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
    $facts
  }

  # What Get-RpaMachineFacts says about everything else in a data directory that is there already: the first link or
  # file with a second name, and, by owner, what does not belong to Administrators or SYSTEM (outside and inside
  # policy-backups\).
  $script:BotSid = 'S-1-5-21-1-2-3-1001'
  function New-DataEntries([hashtable]$Change = @{}) {
    $entries = @{ Link = $null; Unreadable = $null; Owners = @(); Backups = @(); Accounts = @{} }
    foreach ($key in $Change.Keys) { $entries[$key] = $Change[$key] }
    $entries
  }
  function New-OwnerEntry([string]$Sid, [string]$Name, [int]$Number, [string]$First, [int]$Order) {
    @{ Sid = $Sid; Name = $Name; Number = $Number; First = "$($script:DataDir)\$First"; Order = $Order }
  }

  # Stands for a -UserPassword value. The plan only looks at whether one was given, so it is empty: no secret here.
  function New-TestPassword { New-Object Security.SecureString }

  $script:SignInSteps = @('store sign-in password', 'turn on automatic sign-in', 'keep the desktop unlocked')
  $script:UnattendedSteps = @(
    'allow the bot user to sign in through Remote Desktop', 'turn on Remote Desktop', "store the bot user's password for the supervisor",
    'register the supervisor service', 'point the firewall rules at the supervisor')

  # The same machine after Install-Rpa.ps1 -Unattended -AllowFrom 10.0.0.5 ran on it.
  function New-UnattendedFacts([hashtable]$Change = @{}) {
    $facts = New-InstalledFacts @{ InstalledMode = 'unattended'; InstalledSupervisorSecret = $true; InstalledUnattendedChanges = $true; SupervisorDirState = New-PathState 'ours' }
    foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
    $facts
  }

  # A password made at run time, as a SecureString, and its text, to look for in what the installer prints and writes.
  function New-MadeUpPassword {
    $text = 'made-up-' + [guid]::NewGuid().ToString('N')
    $secure = New-Object Security.SecureString
    foreach ($char in $text.ToCharArray()) { $secure.AppendChar($char) }
    @{ Text = $text; Secure = $secure }
  }
}

Describe 'Get-RpaInstallPlan' {
  Context 'refusals' {
    It 'refuses when not an administrator' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts @{ IsAdmin = $false })
      $plan.Refusals | Should -BeExactly @('Run Install-Rpa.ps1 from an administrator PowerShell.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses 32-bit Windows' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts @{ Is64Bit = $false })
      $plan.Refusals | Should -BeExactly @('Windows 10 1809, Windows 11 or Windows Server 2019 or later (64-bit) is required.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses a build below 17763 and accepts 17763' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ OsBuild = 17134 })
      $plan.Refusals | Should -BeExactly @('Windows 10 1809, Windows 11 or Windows Server 2019 or later (64-bit) is required.')
      (Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ OsBuild = 17763 })).Refusals.Count | Should -Be 0
    }

    It 'refuses a port another program uses, on a first install' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PortsInUse = @{ 3000 = 'node' } })
      $plan.Refusals | Should -BeExactly @('Port 3000 is in use by node. Choose another with -RunnerPort or -BrowserPort.')
      $plan.Steps.Count | Should -Be 0

      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; RunnerPort = 9000 }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PortsInUse = @{ 9000 = 'httpd' } })
      $plan.Refusals | Should -BeExactly @('Port 9000 is in use by httpd. Choose another with -RunnerPort or -BrowserPort.')
    }

    It 'does not refuse a port in use on an upgrade (the installed runner and browser hold them)' {
      $facts = New-InstalledFacts @{ PortsInUse = @{ 8765 = 'RpaRunner'; 3000 = 'node' } }
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts).Refusals.Count | Should -Be 0
    }

    It 'on an upgrade that changes a port, refuses the new port when a program uses it' {
      $facts = New-InstalledFacts @{ PortsInUse = @{ 8765 = 'RpaRunner'; 3000 = 'node'; 9000 = 'httpd' } }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ RunnerPort = 9000 }) -Facts $facts
      $plan.Refusals | Should -BeExactly @('Port 9000 is in use by httpd. Choose another with -RunnerPort or -BrowserPort.')

      # The browser was not installed before, so its port is new too.
      $facts = New-InstalledFacts @{ InstalledBrowser = $false; PortsInUse = @{ 3000 = 'node' } }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals | Should -BeExactly @('Port 3000 is in use by node. Choose another with -RunnerPort or -BrowserPort.')
    }

    It 'refuses the same port for the runner and the browser' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; RunnerPort = 9000; BrowserPort = 9000 }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('-RunnerPort and -BrowserPort are both 9000. Give each its own port.')
      $plan.Steps.Count | Should -Be 0

      $parameters.NoBrowser = $true
      $parameters.WithBrowser = $false
      (Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)).Refusals.Count | Should -Be 0
    }

    It 'refuses a domain user that does not exist' {
      $parameters = New-TestParameters @{ User = 'CORP\svc-rpa'; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ UserIsDomain = $true })
      $plan.Refusals | Should -BeExactly @('CORP\svc-rpa does not exist. Create it in your directory first; the installer only creates local users.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses an existing user that is an administrator' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts @{ UserExists = $true; UserIsAdmin = $true })
      $plan.Refusals | Should -BeExactly @('rpa-runner is an administrator. The bot user must be a standard user.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses -AutoSignIn for an existing user without -UserPassword' {
      $text = '-AutoSignIn for the existing user rpa-runner needs -UserPassword. A password the installer generated earlier is not known to anyone: set a new password for rpa-runner and pass it, or remove rpa-runner so the installer creates it again. A new password makes what the programs of rpa-runner protected with the old one unreadable (the entries of an authenticator application, the certificate of the runner), so where such data exists a new bot user (-User) is the safer way. After a new password the runner cannot read its certificate: remove it and put the new fingerprint into the n8n credential (docs/install/windows.md, section 10).'
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true }) -Facts (New-TestFacts @{ UserExists = $true })
      $plan.Refusals | Should -BeExactly @($text)
      $plan.Steps.Count | Should -Be 0

      # Also on an upgrade of an install that did not turn automatic sign-in on for this user.
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true }) -Facts (New-InstalledFacts)
      $plan.Refusals | Should -BeExactly @($text)
    }

    It 'refuses a -UserPassword that is not the password of the existing user' {
      $parameters = New-TestParameters @{ AutoSignIn = $true; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ UserExists = $true; UserPasswordWrong = $true })
      $plan.Refusals | Should -BeExactly @('The password given for rpa-runner is not correct.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses an upgrade for another user while automatic sign-in is set up for the first one' {
      $facts = New-InstalledFacts @{ InstalledAutoSignInUser = 'rpa-runner'; InstalledForUser = $false }
      $text = 'Automatic sign-in is set up for rpa-runner. Uninstall with -RemoveData first, then install for bot2.'
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2' }) -Facts $facts
      $plan.Refusals | Should -BeExactly @($text)
      $plan.Steps.Count | Should -Be 0

      # Also when automatic sign-in is asked for the new user, with or without its password.
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; AutoSignIn = $true }) -Facts $facts
      $plan.Refusals | Should -BeExactly @($text)
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; AutoSignIn = $true; UserPassword = New-TestPassword }) -Facts $facts
      $plan.Refusals | Should -BeExactly @($text)

      # The same user: no refusal.
      $facts = New-InstalledFacts @{ InstalledAutoSignInUser = 'rpa-runner'; InstalledAutoSignInForUser = $true }
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts).Refusals.Count | Should -Be 0
    }

    # On Windows Server such an install is unattended (Context 'without a sign-in mode').
    It 'refuses a new local user without -AutoSignIn and without -UserPassword on Windows 10 or 11' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts @{ IsServer = $false })
      $plan.Refusals | Should -BeExactly @('Give -UserPassword for the new user rpa-runner, or use -AutoSignIn to have a random password stored for automatic sign-in.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'on an upgrade with the runner running, refuses without -Force and warns with it' {
      $facts = New-InstalledFacts @{ RunnerRunning = $true }
      $text = 'The runner is running; a run in progress will fail.'

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals | Should -BeExactly @("$text Use -Force to continue.")
      $plan.Steps.Count | Should -Be 0

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Force = $true }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @($text)
      $plan.Steps[0] | Should -BeExactly 'stop running services'
    }
  }

  Context 'who may connect' {
    BeforeAll { $script:SayWhich = 'Say which addresses may connect: -AllowFrom <n8n address>, or -AllowFromAnyAddress, or -NoFirewall.' }

    It 'refuses a first install with firewall rules and neither -AllowFrom nor -AllowFromAnyAddress' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @() }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @($script:SayWhich)
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses -AllowFrom together with -AllowFromAnyAddress' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFromAnyAddress = $true }
      (Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)).Refusals | Should -BeExactly @($script:SayWhich)
    }

    It 'refuses <Value>, which is not an IP address or range' -ForEach @(
      @{ Value = 'n8n.example.com' }, @{ Value = 'LocalSubnet' }, @{ Value = '10.0.0.256' }, @{ Value = '10.0.0.0/33' }
      @{ Value = '10.0.0' }, @{ Value = '7' }, @{ Value = '10.0.0.5-10.0.0.9' }, @{ Value = 'fd00::/129' }, @{ Value = '10.0.0.5/' }
    ) {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @('10.0.0.5', $Value) }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @("-AllowFrom: $Value is not an IP address or a range such as 10.0.0.0/24.")
      $plan.Steps.Count | Should -Be 0
    }

    It 'takes IPv4 and IPv6 addresses and ranges, and hands them to the firewall steps' {
      $given = @('10.0.0.5', '10.0.0.0/24', 'fd00::1', 'fd00::/8')
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = $given }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeExactly $given
    }

    # powershell -File ... -AllowFrom 10.0.0.5,10.0.0.6 hands the installer one string, not two.
    It 'takes several addresses in one string, separated by commas' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @('10.0.0.5,10.0.0.6') }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeExactly @('10.0.0.5', '10.0.0.6')

      $parameters.AllowFrom = @(' 10.0.0.5 , 10.1.0.0/16,', 'fd00::1')
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeExactly @('10.0.0.5', '10.1.0.0/16', 'fd00::1')

      $parameters.AllowFrom = @('10.0.0.5,n8n.example.com')
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('-AllowFrom: n8n.example.com is not an IP address or a range such as 10.0.0.0/24.')
    }

    # A range of every address would get round the two switches that stand in front of "any address".
    It 'refuses <Value>, a range with a prefix of 0, which is every address' -ForEach @(
      @{ Value = '0.0.0.0/0' }, @{ Value = '::/0' }, @{ Value = '10.0.0.0/0' }, @{ Value = 'fd00::/00' }
    ) {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @('10.0.0.5', $Value) }
      foreach ($public in $false, $true) {
        $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PublicNetwork = $public })
        $plan.Refusals | Should -BeExactly @("-AllowFrom $Value means every address. Use -AllowFromAnyAddress for that.")
        $plan.Steps.Count | Should -Be 0
      }
    }

    It '-AllowFromAnyAddress lets any address in' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @(); AllowFromAnyAddress = $true }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeExactly @('any')
    }

    It 'an upgrade without either parameter keeps the recorded choice' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AllowFrom = @() }) -Facts (New-InstalledFacts @{ InstalledAllowFrom = @('10.1.2.3', '10.9.0.0/16') })
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeExactly @('10.1.2.3', '10.9.0.0/16')

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AllowFrom = @() }) -Facts (New-InstalledFacts @{ InstalledAllowFrom = 'any' })
      $plan.AllowFrom | Should -BeExactly @('any')

      # An install whose record says nothing about the firewall (an earlier version made it): the upgrade has to say.
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AllowFrom = @() }) -Facts (New-InstalledFacts @{ InstalledAllowFrom = $null })
      $plan.Refusals | Should -BeExactly @($script:SayWhich)
    }

    It 'an upgrade without firewall parameters of an install made with -NoFirewall leaves the firewall alone again' {
      $facts = New-InstalledFacts @{ InstalledAllowFrom = @('none'); PublicNetwork = $true }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AllowFrom = @() }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings.Count | Should -Be 0
      $plan.AllowFrom | Should -BeNullOrEmpty
      @($plan.Steps | Where-Object { $_ -match 'firewall' }).Count | Should -Be 0

      # With addresses the upgrade makes the rules.
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeExactly @('10.0.0.5')
      $plan.Steps | Should -Contain 'add the runner firewall rule'

      # -IncludePublicNetwork alone still does not say who may connect.
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AllowFrom = @(); IncludePublicNetwork = $true }) -Facts $facts
      $plan.Refusals | Should -BeExactly @($script:SayWhich)
    }

    It '-NoFirewall needs neither and makes no rule' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @(); NoFirewall = $true }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeNullOrEmpty
    }
  }

  Context 'on which networks the firewall rules apply' {
    BeforeAll {
      $script:PublicRefusal = "This machine's network is Public, and -AllowFromAnyAddress does not open the ports on a Public network. Use -AllowFrom <n8n address>, or add -IncludePublicNetwork, or use -NoFirewall."
      $script:PublicWarning = 'This machine is on a network that Windows treats as Public. The firewall rules are for Domain and Private networks, so they let nothing in on that network.'
    }

    It 'with -AllowFrom addresses the rules apply on every network, also a Public one' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword }
      foreach ($public in $false, $true) {
        $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PublicNetwork = $public })
        $plan.Refusals.Count | Should -Be 0
        $plan.Warnings.Count | Should -Be 0
        $plan.PublicNetwork | Should -BeTrue
      }
    }

    It 'with -AllowFromAnyAddress the rules apply on Domain and Private networks only, unless -IncludePublicNetwork is given' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @(); AllowFromAnyAddress = $true }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.PublicNetwork | Should -BeFalse

      $parameters.IncludePublicNetwork = $true
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeExactly @('any')
      $plan.PublicNetwork | Should -BeTrue
    }

    It 'refuses a first install with -AllowFromAnyAddress on a Public network without -IncludePublicNetwork' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @(); AllowFromAnyAddress = $true }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PublicNetwork = $true })
      $plan.Refusals | Should -BeExactly @($script:PublicRefusal)
      $plan.Steps.Count | Should -Be 0

      $parameters.IncludePublicNetwork = $true
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PublicNetwork = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings.Count | Should -Be 0
      $plan.PublicNetwork | Should -BeTrue
    }

    It '-NoFirewall on a Public network is not refused and not warned about' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @(); AllowFromAnyAddress = $true; NoFirewall = $true }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PublicNetwork = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings.Count | Should -Be 0
      $plan.PublicNetwork | Should -BeFalse
    }

    It 'an upgrade without firewall parameters keeps the recorded choice of networks' {
      $none = New-TestParameters @{ AllowFrom = @() }
      $plan = Get-RpaInstallPlan -Parameters $none -Facts (New-InstalledFacts @{ InstalledAllowFrom = 'any'; InstalledPublicNetwork = $true; PublicNetwork = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings.Count | Should -Be 0
      $plan.PublicNetwork | Should -BeTrue

      $plan = Get-RpaInstallPlan -Parameters $none -Facts (New-InstalledFacts @{ InstalledAllowFrom = 'any'; InstalledPublicNetwork = $false })
      $plan.PublicNetwork | Should -BeFalse

      # Recorded addresses: every network, whatever an earlier version recorded.
      $plan = Get-RpaInstallPlan -Parameters $none -Facts (New-InstalledFacts @{ InstalledAllowFrom = @('10.1.2.3'); InstalledPublicNetwork = $false })
      $plan.PublicNetwork | Should -BeTrue
    }

    It 'an upgrade with only -IncludePublicNetwork adds Public networks to a recorded any address' {
      $parameters = New-TestParameters @{ AllowFrom = @(); IncludePublicNetwork = $true }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-InstalledFacts @{ InstalledAllowFrom = 'any'; InstalledPublicNetwork = $false; PublicNetwork = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeExactly @('any')
      $plan.PublicNetwork | Should -BeTrue
    }

    It 'an upgrade that leaves any address on Domain and Private networks warns on a Public network' {
      $facts = New-InstalledFacts @{ InstalledAllowFrom = 'any'; InstalledPublicNetwork = $false; PublicNetwork = $true }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AllowFrom = @() }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @($script:PublicWarning)

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AllowFrom = @(); AllowFromAnyAddress = $true }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @($script:PublicWarning)
    }

    It '-IncludePublicNetwork alone does not say which addresses may connect' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @(); IncludePublicNetwork = $true }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('Say which addresses may connect: -AllowFrom <n8n address>, or -AllowFromAnyAddress, or -NoFirewall.')
    }

    It 'a rule for every network names all three kinds; one without Public names Domain and Private' {
      InModuleScope RpaInstall { Get-RpaFirewallProfiles $true } | Should -BeExactly @('Domain', 'Private', 'Public')
      InModuleScope RpaInstall { Get-RpaFirewallProfiles $false } | Should -BeExactly @('Domain', 'Private')
    }
  }

  Context 'what is already in the data directory' {
    BeforeAll { $script:Parameters = New-TestParameters @{ UserPassword = New-TestPassword } }

    It 'refuses a data directory that is a link or junction' {
      $plan = Get-RpaInstallPlan -Parameters $script:Parameters -Facts (New-TestFacts @{ DataDirState = New-PathState 'link' })
      $plan.Refusals | Should -BeExactly @('C:\ProgramData\RPA Runner is a link or junction. Remove it and run the installer again.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses a data directory that someone else owns' {
      $plan = Get-RpaInstallPlan -Parameters $script:Parameters -Facts (New-TestFacts @{ DataDirState = New-PathState 'theirs' })
      $plan.Refusals | Should -BeExactly @('C:\ProgramData\RPA Runner exists and is owned by BOT-PC\mallory. Check what is in it, remove it, and run the installer again.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses logs that is a link or junction, on a first install and on an upgrade' {
      $text = 'C:\ProgramData\RPA Runner\logs is a link or junction. Remove it and run the installer again.'
      $facts = New-TestFacts @{ DataDirState = New-PathState 'ours'; LogDirState = New-PathState 'link' }
      (Get-RpaInstallPlan -Parameters $script:Parameters -Facts $facts).Refusals | Should -BeExactly @($text)

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ LogDirState = New-PathState 'link' })
      $plan.Refusals | Should -BeExactly @($text)
      $plan.Steps.Count | Should -Be 0
    }

    It 'takes over a logs folder that is no link, whoever owns it (the bot user may have made it again)' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ LogDirState = New-PathState 'theirs' })
      $plan.Refusals.Count | Should -Be 0
    }

    It 'refuses an existing <Name> that someone else owns' -ForEach @(@{ Name = 'policy.json' }, @{ Name = 'token' }, @{ Name = 'browser-token' }) {
      $files = @{ 'policy.json' = New-PathState 'missing'; 'token' = New-PathState 'missing'; 'browser-token' = New-PathState 'missing' }
      $files[$Name] = New-PathState 'theirs'
      $plan = Get-RpaInstallPlan -Parameters $script:Parameters -Facts (New-TestFacts @{ DataDirState = New-PathState 'ours'; DataFiles = $files })
      $plan.Refusals | Should -BeExactly @("C:\ProgramData\RPA Runner\$Name exists and is owned by BOT-PC\mallory. Check what is in it, remove it, and run the installer again.")
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses an existing <Name> that is a link' -ForEach @(@{ Name = 'policy.json' }, @{ Name = 'token' }, @{ Name = 'browser-token' }) {
      $files = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'ours' }
      $files[$Name] = New-PathState 'link'
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ DataFiles = $files })
      $plan.Refusals | Should -BeExactly @("C:\ProgramData\RPA Runner\$Name is a link or junction. Remove it and run the installer again.")
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses an existing <Name> that has a second name (a hard link)' -ForEach @(@{ Name = 'policy.json' }, @{ Name = 'token' }, @{ Name = 'browser-token' }) {
      $files = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'ours' }
      $files[$Name] = New-PathState 'hardlink'
      $text = "C:\ProgramData\RPA Runner\$Name has more than one name (a hard link). Check what it is, remove it, and run the installer again."
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ DataFiles = $files })
      $plan.Refusals | Should -BeExactly @($text)
      $plan.Steps.Count | Should -Be 0

      $facts = New-TestFacts @{ DataDirState = New-PathState 'ours'; DataFiles = $files }
      (Get-RpaInstallPlan -Parameters $script:Parameters -Facts $facts).Refusals | Should -BeExactly @($text)
    }

    It 'on a first install, refuses a data directory that holds <Why>' -ForEach @(
      @{ Why = 'a link or junction'; Link = @{ Path = 'C:\ProgramData\RPA Runner\exports'; IsLink = $true; Links = 1 }
        Text = 'C:\ProgramData\RPA Runner\exports is a link or junction. Remove it and run the installer again.' }
      @{ Why = 'a file with a second name'; Link = @{ Path = 'C:\ProgramData\RPA Runner\logs\runner.out.log'; IsLink = $false; Links = 2 }
        Text = 'C:\ProgramData\RPA Runner\logs\runner.out.log has more than one name (a hard link). Check what it is, remove it, and run the installer again.' }
    ) {
      # Also when everything in it belongs to the user of this run.
      $entries = New-DataEntries @{ Link = $Link; Owners = @(New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 4 'exports' 1) }
      $facts = New-TestFacts @{ UserExists = $true; UserSid = $script:BotSid; DataDirState = New-PathState 'ours'; DataDirEntries = $entries }
      $plan = Get-RpaInstallPlan -Parameters $script:Parameters -Facts $facts
      $plan.Refusals | Should -BeExactly @($Text)
      $plan.Steps.Count | Should -Be 0
    }

    # The bot user can make a folder that administrators cannot list; what is in it cannot be judged.
    It 'on a first install, refuses a data directory that holds something the installer cannot read, and names it' {
      $entries = New-DataEntries @{
        Unreadable = @{ Path = 'C:\ProgramData\RPA Runner\exports\closed'; Owner = 'BOT-PC\rpa-runner' }
        Owners     = @(New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 4 'exports' 1)
      }
      $facts = New-TestFacts @{ UserExists = $true; UserSid = $script:BotSid; DataDirState = New-PathState 'ours'; DataDirEntries = $entries }
      $plan = Get-RpaInstallPlan -Parameters $script:Parameters -Facts $facts
      $plan.Refusals | Should -BeExactly @('C:\ProgramData\RPA Runner\exports\closed exists and is owned by BOT-PC\rpa-runner. Check what is in it, remove it, and run the installer again.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'on an upgrade for the same user, does not mind something in the data directory that it cannot read' {
      $entries = New-DataEntries @{ Unreadable = @{ Path = 'C:\ProgramData\RPA Runner\exports\closed'; Owner = 'BOT-PC\rpa-runner' } }
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ DataDirEntries = $entries })).Refusals.Count | Should -Be 0
    }

    # What an uninstall kept: the bot user's logs, certificates and exports are its own.
    It 'a first install for a user that exists takes a data directory in which everything belongs to Administrators, SYSTEM or that user' {
      $files = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'ours' }
      $entries = New-DataEntries @{ Owners = @(New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 12 'exports' 1) }
      $facts = New-TestFacts @{
        UserExists = $true; UserSid = $script:BotSid; DataDirEntries = $entries; DataFiles = $files
        DataDirState = New-PathState 'ours'; LogDirState = New-PathState 'ours'; PolicyBackupsState = New-PathState 'ours'
      }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions.Count | Should -Be 0
      foreach ($step in 'write policy', 'write token', 'write browser-token', 'create user') { $plan.Steps | Should -Not -Contain $step }
      $plan.Steps | Should -Contain 'protect the data directory'
    }

    It 'refuses once, with their number and the first of them, what belongs to other accounts' {
      $entries = New-DataEntries @{ Owners = @(
          (New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 12 'exports' 1)
          (New-OwnerEntry 'S-1-5-21-1-2-3-1002' 'BOT-PC\mallory' 2 'browser-key.pem' 7)
          (New-OwnerEntry 'S-1-5-21-1-2-3-1003' 'BOT-PC\bot2' 1 'logs\old.log' 3)
        ) }
      $facts = New-TestFacts @{ UserExists = $true; UserSid = $script:BotSid; DataDirState = New-PathState 'ours'; DataDirEntries = $entries }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals | Should -BeExactly @('3 entries in C:\ProgramData\RPA Runner belong to other accounts (the first: C:\ProgramData\RPA Runner\logs\old.log, owned by BOT-PC\bot2). Remove the data directory with Uninstall-Rpa.ps1 -RemoveData, or remove those entries, and run the installer again.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'says it in the singular for one entry' {
      $entries = New-DataEntries @{ Owners = @(New-OwnerEntry 'S-1-5-21-1-2-3-1002' 'BOT-PC\mallory' 1 'browser-key.pem' 7) }
      $facts = New-TestFacts @{ UserExists = $true; UserSid = $script:BotSid; DataDirState = New-PathState 'ours'; DataDirEntries = $entries }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals | Should -BeExactly @('1 entry in C:\ProgramData\RPA Runner belongs to another account (C:\ProgramData\RPA Runner\browser-key.pem, owned by BOT-PC\mallory). Remove the data directory with Uninstall-Rpa.ps1 -RemoveData, or remove that entry, and run the installer again.')
    }

    # An account of the same name made earlier has another SID; and a user this run creates did not exist when the
    # entries were made.
    It 'when this run creates the user, nothing in the data directory is its own' {
      $entries = New-DataEntries @{ Owners = @(New-OwnerEntry 'S-1-5-21-1-2-3-1001' 'S-1-5-21-1-2-3-1001' 9 'exports' 1) }
      $facts = New-TestFacts @{ DataDirState = New-PathState 'ours'; DataDirEntries = $entries }
      $plan = Get-RpaInstallPlan -Parameters $script:Parameters -Facts $facts
      $plan.Refusals | Should -BeExactly @('9 entries in C:\ProgramData\RPA Runner belong to other accounts (the first: C:\ProgramData\RPA Runner\exports, owned by S-1-5-21-1-2-3-1001). Remove the data directory with Uninstall-Rpa.ps1 -RemoveData, or remove those entries, and run the installer again.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'counts everything in policy-backups that Administrators or SYSTEM do not own, also what belongs to the user of this run' {
      $entries = New-DataEntries @{
        Owners  = @(New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 12 'exports' 1)
        Backups = @(New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 2 'policy-backups\policy-1.json' 5)
      }
      $facts = New-TestFacts @{ UserExists = $true; UserSid = $script:BotSid; DataDirState = New-PathState 'ours'; DataDirEntries = $entries }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals | Should -BeExactly @('2 entries in C:\ProgramData\RPA Runner belong to other accounts (the first: C:\ProgramData\RPA Runner\policy-backups\policy-1.json, owned by BOT-PC\rpa-runner). Remove the data directory with Uninstall-Rpa.ps1 -RemoveData, or remove those entries, and run the installer again.')
    }

    It 'on an upgrade for the same user, does not judge who owns what is in the data directory' {
      $entries = New-DataEntries @{
        Owners = @((New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 12 'exports' 1), (New-OwnerEntry 'S-1-5-21-1-2-3-1002' 'BOT-PC\mallory' 2 'browser-key.pem' 7))
      }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ DataDirEntries = $entries })
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions.Count | Should -Be 0
    }

    # The installer sets the rules of the data directory and of logs\ on every run, and they pass on to what is inside:
    # through a second name, to another file.
    It 'on an upgrade for the same user, refuses <Why> anywhere in the data directory' -ForEach @(
      @{ Why = 'a file with a second name'; Link = @{ Path = 'C:\ProgramData\RPA Runner\logs\planted.log'; IsLink = $false; Links = 2 }
        Text = 'C:\ProgramData\RPA Runner\logs\planted.log has more than one name (a hard link). Check what it is, remove it, and run the installer again.' }
      @{ Why = 'a link or junction'; Link = @{ Path = 'C:\ProgramData\RPA Runner\exports\x'; IsLink = $true; Links = 1 }
        Text = 'C:\ProgramData\RPA Runner\exports\x is a link or junction. Remove it and run the installer again.' }
    ) {
      $entries = New-DataEntries @{ Link = $Link; Owners = @(New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 12 'logs\runner.out.log' 1) }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ DataDirEntries = $entries })
      $plan.Refusals | Should -BeExactly @($Text)
      $plan.Steps.Count | Should -Be 0
    }

    It 'on an upgrade for another user, what the user before left there belongs to another account' {
      $entries = New-DataEntries @{ Owners = @((New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 12 'exports' 1), (New-OwnerEntry 'S-1-5-21-1-2-3-1003' 'BOT-PC\bot2' 1 'logs\x.log' 2)) }
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserSid = 'S-1-5-21-1-2-3-1003'; DataDirEntries = $entries }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2' }) -Facts $facts
      $plan.Refusals | Should -BeExactly @('12 entries in C:\ProgramData\RPA Runner belong to other accounts (the first: C:\ProgramData\RPA Runner\exports, owned by BOT-PC\rpa-runner). Remove the data directory with Uninstall-Rpa.ps1 -RemoveData, or remove those entries, and run the installer again.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'on an upgrade that creates the user again, what the removed user left there belongs to another account' {
      $entries = New-DataEntries @{ Owners = @(New-OwnerEntry $script:BotSid $script:BotSid 12 'exports' 1) }
      $facts = New-InstalledFacts @{ UserExists = $false; UserSid = $null; DataDirEntries = $entries }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts $facts
      $plan.Refusals | Should -BeExactly @("12 entries in C:\ProgramData\RPA Runner belong to other accounts (the first: C:\ProgramData\RPA Runner\exports, owned by $($script:BotSid)). Remove the data directory with Uninstall-Rpa.ps1 -RemoveData, or remove those entries, and run the installer again.")
    }

    It 'refuses a policy-backups folder that is a link, or that someone else owns, on a first install and on an upgrade' {
      $link = 'C:\ProgramData\RPA Runner\policy-backups is a link or junction. Remove it and run the installer again.'
      $owned = 'C:\ProgramData\RPA Runner\policy-backups exists and is owned by BOT-PC\mallory. Check what is in it, remove it, and run the installer again.'
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ PolicyBackupsState = New-PathState 'link' })
      $plan.Refusals | Should -BeExactly @($link)
      $plan.Steps.Count | Should -Be 0
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ PolicyBackupsState = New-PathState 'theirs' })).Refusals | Should -BeExactly @($owned)

      $facts = New-TestFacts @{ DataDirState = New-PathState 'ours'; PolicyBackupsState = New-PathState 'theirs' }
      (Get-RpaInstallPlan -Parameters $script:Parameters -Facts $facts).Refusals | Should -BeExactly @($owned)
      # One that is missing is no reason to refuse: the step that protects the data directory makes it.
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ PolicyBackupsState = New-PathState 'missing' })).Refusals.Count | Should -Be 0
    }

    # The policy tool copies a change file into policy-changes\ before it applies it, and trusts the folder as it trusts
    # policy-backups\: the bot user could have made it first.
    It 'refuses a policy-changes folder that is a link, or that someone else owns, on a first install and on an upgrade' {
      $link = 'C:\ProgramData\RPA Runner\policy-changes is a link or junction. Remove it and run the installer again.'
      $owned = 'C:\ProgramData\RPA Runner\policy-changes exists and is owned by BOT-PC\mallory. Check what is in it, remove it, and run the installer again.'
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ PolicyChangesState = New-PathState 'link' })
      $plan.Refusals | Should -BeExactly @($link)
      $plan.Steps.Count | Should -Be 0
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ PolicyChangesState = New-PathState 'theirs' })).Refusals | Should -BeExactly @($owned)

      $facts = New-TestFacts @{ DataDirState = New-PathState 'ours'; PolicyChangesState = New-PathState 'theirs' }
      (Get-RpaInstallPlan -Parameters $script:Parameters -Facts $facts).Refusals | Should -BeExactly @($owned)
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ PolicyChangesState = New-PathState 'missing' })).Refusals.Count | Should -Be 0
    }

    It 'judges policy-changes as it judges policy-backups: the folder under its own name, what is in it owned by Administrators or SYSTEM only, created with the same rules' {
      $script:ModuleSource | Should -Match ([regex]::Escape("ChangesDir    = Join-Path `$dataDir 'policy-changes'"))
      $source = $script:ModuleSource
      $source | Should -Match ([regex]::Escape("(@(`$script:DataFiles.Keys) + 'policy-backups' + 'policy-changes' + 'logs') -contains `$entry.Name"))
      $source | Should -Match ([regex]::Escape("InBackups = (`$directory.InBackups -or (`$top -and @('policy-backups', 'policy-changes') -contains `$entry.Name))"))
      $source | Should -Match ([regex]::Escape("New-RpaProtectedFolder `$Layout.ChangesDir (Get-RpaAccessRules 'backups' `$Sid)`n  Assert-RpaPathUsable `$Layout.ChangesDir `$true"))
      $source | Should -Match ([regex]::Escape("`$facts.PolicyChangesState = Get-RpaPathState `$layout.ChangesDir"))
    }

    It 'a first install over a data directory that Administrators or SYSTEM own keeps its files and writes what is missing' {
      $files = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'missing' }
      $facts = New-TestFacts @{ DataDirState = New-PathState 'ours'; LogDirState = New-PathState 'ours'; DataFiles = $files }
      $plan = Get-RpaInstallPlan -Parameters $script:Parameters -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -Contain 'write browser-token'
      foreach ($step in 'write policy', 'write token') { $plan.Steps | Should -Not -Contain $step }
    }

    It 'refuses a scheduled task folder that someone else owns' {
      $plan = Get-RpaInstallPlan -Parameters $script:Parameters -Facts (New-TestFacts @{ TaskFolderOwner = 'BOT-PC\mallory' })
      $plan.Refusals | Should -BeExactly @('The scheduled task folder \RPA\ exists and is owned by BOT-PC\mallory. Check what is in it, remove it, and run the installer again.')
      $plan.Steps.Count | Should -Be 0
    }
  }

  Context 'an upgrade with another -User' {
    BeforeAll {
      $script:NotTheUser = 'bot2 is not the user this install was made for (rpa-runner).'
      $script:TokensReplaced = 'rpa-runner could read the tokens in the data directory, so both are replaced; the n8n credentials then need the new tokens.'
    }

    It 'says so and has it confirmed: a question without -Force, a warning with it' {
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserSid = 'S-1-5-21-1-2-3-1003' }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2' }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions | Should -BeExactly @($script:NotTheUser, $script:TokensReplaced)
      $plan.Warnings.Count | Should -Be 0
      $plan.Steps | Should -Not -Contain 'create user'

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; Force = $true }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @($script:NotTheUser, $script:TokensReplaced)
    }

    # A mistyped name: the user does not exist and would be created.
    It 'says so before it creates a user of that name' {
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserExists = $false; UserSid = $null }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; UserPassword = New-TestPassword }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions | Should -BeExactly @($script:NotTheUser, $script:TokensReplaced)
      $plan.Steps | Should -Contain 'create user'
    }

    It 'asks nothing for the user of the install, on a first install, or when the recorded user is created again' {
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts)).Questions.Count | Should -Be 0
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-TestFacts)).Questions.Count | Should -Be 0
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-InstalledFacts @{ UserExists = $false; UserSid = $null })
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions.Count | Should -Be 0
    }
  }

  # The user the install was made for before could read both tokens.
  Context 'a change of user replaces the tokens' {
    BeforeAll {
      $script:Replaced = '{0} could read the tokens in the data directory, so both are replaced; the n8n credentials then need the new tokens.'
      $script:OtherSid = 'S-1-5-21-1-2-3-1003'
      $script:Kept = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'ours' }
      # A data directory an uninstall kept, with no install: its access rules name the bot user of that install.
      function New-KeptDataFacts([hashtable]$Change = @{}) {
        $facts = New-TestFacts @{
          DataDirState = New-PathState 'ours'; LogDirState = New-PathState 'ours'; PolicyBackupsState = New-PathState 'ours'
          DataFiles = $script:Kept; DataDirEntries = New-DataEntries
          EarlierUsers = @(@{ Sid = $script:BotSid; Name = 'rpa-runner' })
        }
        foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
        $facts
      }
    }

    It 'an upgrade for another user removes both tokens before that user gets its access, writes new ones and says so with the question' {
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserSid = $script:OtherSid }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2' }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions | Should -BeExactly @('bot2 is not the user this install was made for (rpa-runner).', ($script:Replaced -f 'rpa-runner'))
      $plan.Warnings.Count | Should -Be 0
      $plan.Steps | Should -BeExactly @(
        'stop running services'
        'copy program files'
        'remove the old tokens'
        'protect the data directory'
        'write token'
        'write browser-token'
        'add the runner firewall rule'
        'add the browser firewall rule'
        'register the runner task'
        'register the browser task'
        'write install.json'
        'add the Start menu shortcut'
        'start tasks'
      )
    }

    It 'with -Force the same lines are warnings' {
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserSid = $script:OtherSid }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; Force = $true }) -Facts $facts
      $plan.Questions.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @('bot2 is not the user this install was made for (rpa-runner).', ($script:Replaced -f 'rpa-runner'))
      $plan.Steps | Should -Contain 'remove the old tokens'
    }

    It 'an upgrade for another user with -NoBrowser removes both tokens and writes the runner token only' {
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserSid = $script:OtherSid }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; NoBrowser = $true; WithBrowser = $false }) -Facts $facts
      $plan.Questions | Should -BeExactly @('bot2 is not the user this install was made for (rpa-runner).', 'rpa-runner could read the tokens in the data directory, so the runner token is replaced and the browser token removed; the n8n credentials then need the new runner token.')
      $plan.Steps | Should -Contain 'remove the old tokens'
      $plan.Steps | Should -Contain 'write token'
      $plan.Steps | Should -Not -Contain 'write browser-token'
    }

    It 'an upgrade that creates another user replaces the tokens too' {
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserExists = $false; UserSid = $null }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; UserPassword = New-TestPassword }) -Facts $facts
      $plan.Steps[0..3] | Should -BeExactly @('stop running services', 'copy program files', 'create user', 'remove the old tokens')
      $plan.Questions[1] | Should -BeExactly ($script:Replaced -f 'rpa-runner')
    }

    It 'a first install over a data directory whose access rules name another user replaces the tokens and warns' {
      $facts = New-KeptDataFacts @{ UserExists = $true; UserSid = $script:OtherSid }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2' }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @($script:Replaced -f 'rpa-runner')
      $plan.Steps | Should -BeExactly @(
        'copy program files'
        'remove the old tokens'
        'protect the data directory'
        'write token'
        'write browser-token'
        'add the runner firewall rule'
        'add the browser firewall rule'
        'register the runner task'
        'register the browser task'
        'write install.json'
        'add the Start menu shortcut'
      )
    }

    It 'a first install that creates the user over such a data directory replaces the tokens' {
      $facts = New-KeptDataFacts
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @($script:Replaced -f 'rpa-runner')
      $plan.Steps[0..2] | Should -BeExactly @('copy program files', 'create user', 'remove the old tokens')
    }

    It 'keeps the tokens for <Why>' -ForEach @(
      @{ Why = 'an upgrade for the same user'; Kind = 'upgrade' }
      @{ Why = 'a first install for the user the access rules name'; Kind = 'same' }
      @{ Why = 'a first install over a data directory whose rules name nobody'; Kind = 'nobody' }
      @{ Why = 'a change of user with no token there'; Kind = 'none' }
    ) {
      switch ($Kind) {
        'upgrade' { $parameters = New-TestParameters; $facts = New-InstalledFacts }
        'same' { $parameters = New-TestParameters; $facts = New-KeptDataFacts @{ UserExists = $true; UserSid = $script:BotSid } }
        'nobody' { $parameters = New-TestParameters @{ User = 'bot2' }; $facts = New-KeptDataFacts @{ UserExists = $true; UserSid = $script:OtherSid; EarlierUsers = @() } }
        'none' {
          $parameters = New-TestParameters @{ User = 'bot2'; Force = $true }
          $missing = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'missing'; 'browser-token' = New-PathState 'missing' }
          $facts = New-InstalledFacts @{ InstalledForUser = $false; UserSid = $script:OtherSid; DataFiles = $missing }
        }
      }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -Not -Contain 'remove the old tokens'
      @($plan.Warnings + $plan.Questions | Where-Object { $_ -like '*could read the tokens*' }).Count | Should -Be 0
      if ($Kind -ne 'none') { foreach ($step in 'write token', 'write browser-token') { $plan.Steps | Should -Not -Contain $step } }
    }
  }

  Context 'warnings' {
    It "warns when the user's password expires and automatic sign-in is asked for" {
      $parameters = New-TestParameters @{ AutoSignIn = $true; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ UserExists = $true; UserPasswordExpires = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @("rpa-runner's password expires; automatic sign-in stops working when it does.")
    }

    It 'gives no warning on a clean first install' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword }
      (Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)).Warnings.Count | Should -Be 0
    }

    It 'warns when it could not be checked whether the user is an administrator' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts @{ UserExists = $true; UserAdminUnknown = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @('Could not check whether rpa-runner is an administrator. The bot user must be a standard user.')
    }

    It 'warns when the given password could not be checked' {
      $parameters = New-TestParameters @{ AutoSignIn = $true; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ UserExists = $true; UserPasswordProblem = 'The account is disabled.' })
      $plan.Refusals.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @('The password given for rpa-runner could not be checked: The account is disabled.')
    }

  }

  Context 'steps' {
    It 'a first install on a clean machine lists every step in order' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true }) -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -BeExactly @(
        'copy program files'
        'create user'
        'protect the data directory'
        'write policy'
        'write token'
        'write browser-token'
        'add the runner firewall rule'
        'add the browser firewall rule'
        'register the runner task'
        'register the browser task'
        'write install.json'
        'store sign-in password'
        'turn on automatic sign-in'
        'keep the desktop unlocked'
        'add the Start menu shortcut'
      )
    }

    It 'an upgrade keeps the policy, tokens and user' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts)
      $plan.Refusals.Count | Should -Be 0
      foreach ($step in 'write policy', 'write token', 'write browser-token', 'create user') { $plan.Steps | Should -Not -Contain $step }
      $plan.Steps | Should -BeExactly @(
        'stop running services'
        'copy program files'
        'protect the data directory'
        'add the runner firewall rule'
        'add the browser firewall rule'
        'register the runner task'
        'register the browser task'
        'write install.json'
        'add the Start menu shortcut'
        'start tasks'
      )
    }

    It 'an upgrade writes a file that is missing: browser-token after an install with -NoBrowser' {
      $files = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'missing' }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ InstalledBrowser = $false; DataFiles = $files })
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -Contain 'write browser-token'
      foreach ($step in 'write policy', 'write token', 'create user') { $plan.Steps | Should -Not -Contain $step }
      [array]::IndexOf($plan.Steps, 'write browser-token') | Should -BeGreaterThan ([array]::IndexOf($plan.Steps, 'protect the data directory'))
    }

    It 'an upgrade creates a local user that is missing, as a first install does' {
      $facts = New-InstalledFacts @{ UserExists = $false }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps[0..2] | Should -BeExactly @('stop running services', 'copy program files', 'create user')

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals | Should -BeExactly @('Give -UserPassword for the new user rpa-runner, or use -AutoSignIn to have a random password stored for automatic sign-in.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'a domain user that exists gets tasks and no create user step' {
      $parameters = New-TestParameters @{ User = 'CORP\svc-rpa' }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ UserIsDomain = $true; UserExists = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -Contain 'register the runner task'
      $plan.Steps | Should -Contain 'register the browser task'
      $plan.Steps | Should -Not -Contain 'create user'
    }

    It "an existing local user is taken as it is, also when -UserPassword is given (its password is never changed)" {
      $parameters = New-TestParameters @{ AutoSignIn = $true; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ UserExists = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -Not -Contain 'create user'
      $plan.Steps | Should -Contain 'store sign-in password'
    }

    It '-NoBrowser leaves out the browser task, port check and firewall rule' {
      $parameters = New-TestParameters @{ NoBrowser = $true; WithBrowser = $false; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PortsInUse = @{ 3000 = 'node' } })
      $plan.Refusals.Count | Should -Be 0
      foreach ($step in 'register the browser task', 'add the browser firewall rule', 'write browser-token') { $plan.Steps | Should -Not -Contain $step }
      foreach ($step in 'register the runner task', 'add the runner firewall rule', 'write token') { $plan.Steps | Should -Contain $step }
    }

    It '-NoBrowser on an upgrade removes the browser task and firewall rule of the earlier install' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ NoBrowser = $true; WithBrowser = $false }) -Facts (New-InstalledFacts)
      $plan.Steps | Should -Contain 'remove the browser firewall rule'
      $plan.Steps | Should -Contain 'remove the browser task'
      foreach ($step in 'register the browser task', 'add the browser firewall rule') { $plan.Steps | Should -Not -Contain $step }
    }

    It '-NoFirewall leaves the firewall alone' {
      $parameters = New-TestParameters @{ NoFirewall = $true; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      @($plan.Steps | Where-Object { $_ -match 'firewall' }).Count | Should -Be 0
      $plan.Steps | Should -Contain 'register the browser task'
    }

    It '-AutoSignIn adds the three sign-in steps, in order, after install.json is written' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true }) -Facts (New-TestFacts)
      @($plan.Steps | Where-Object { $script:SignInSteps -contains $_ }) | Should -BeExactly $script:SignInSteps
      [array]::IndexOf($plan.Steps, 'write install.json') | Should -BeLessThan ([array]::IndexOf($plan.Steps, 'store sign-in password'))
    }

    It 'without -AutoSignIn no sign-in step is listed' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      foreach ($step in $script:SignInSteps) { $plan.Steps | Should -Not -Contain $step }
      $plan.Steps | Should -Contain 'create user'
    }

    It 'an upgrade with -AutoSignIn keeps automatic sign-in an earlier run turned on for the same user: no -UserPassword, no sign-in step' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true }) -Facts (New-InstalledFacts @{ InstalledAutoSignInForUser = $true })
      $plan.Refusals.Count | Should -Be 0
      foreach ($step in $script:SignInSteps) { $plan.Steps | Should -Not -Contain $step }
    }

    It 'an upgrade with -AutoSignIn whose recorded user is missing creates it and sets automatic sign-in up again' {
      $facts = New-InstalledFacts @{ UserExists = $false; InstalledAutoSignInForUser = $true }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -Contain 'create user'
      @($plan.Steps | Where-Object { $script:SignInSteps -contains $_ }) | Should -BeExactly $script:SignInSteps
    }

    It 'that upgrade with -UserPassword stores the password again and changes nothing else about sign-in' {
      $parameters = New-TestParameters @{ AutoSignIn = $true; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-InstalledFacts @{ InstalledAutoSignInForUser = $true })
      $plan.Refusals.Count | Should -Be 0
      @($plan.Steps | Where-Object { $script:SignInSteps -contains $_ }) | Should -BeExactly @('store sign-in password')
    }
  }

  # The browser is added with -WithBrowser. An upgrade keeps what the install has; -NoBrowser removes it.
  Context 'the browser' {
    BeforeAll {
      $script:BrowserSteps = @('write browser-token', 'add the browser firewall rule', 'register the browser task')
      $script:RemoveSteps = @('remove the browser firewall rule', 'remove the browser task', 'remove the browser token and certificate')
      $script:Missing = 'The browser files are not in C:\Program Files\RPA package\0.3.0\rpa-windows-x64: run Get-Rpa.ps1 -WithBrowser, or unpack rpa-browser-windows-x64.zip into that folder.'
      $script:KeptMissing = 'This install has the browser, and its files are not in C:\Program Files\RPA package\0.3.0\rpa-windows-x64: run Get-Rpa.ps1 -WithBrowser, unpack rpa-browser-windows-x64.zip into that folder, or remove the browser with -NoBrowser.'
    }

    It 'a first install without -WithBrowser has no browser: no token, firewall rule, task or port check for it' {
      $parameters = New-TestParameters @{ WithBrowser = $false; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PortsInUse = @{ 3000 = 'node' }; BrowserFiles = 'missing'; BrowserVersion = $null })
      $plan.Refusals.Count | Should -Be 0
      $plan.Browser | Should -BeFalse
      foreach ($step in $script:BrowserSteps + $script:RemoveSteps) { $plan.Steps | Should -Not -Contain $step }
      foreach ($step in 'write token', 'add the runner firewall rule', 'register the runner task') { $plan.Steps | Should -Contain $step }
    }

    It 'a first install with -WithBrowser has the browser' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.Browser | Should -BeTrue
      foreach ($step in $script:BrowserSteps) { $plan.Steps | Should -Contain $step }
    }

    It 'refuses -WithBrowser together with -NoBrowser' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ NoBrowser = $true; UserPassword = New-TestPassword }) -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('-WithBrowser and -NoBrowser cannot be used together: -WithBrowser adds the browser, -NoBrowser leaves it out or removes it. Choose one.')
      $plan.Steps.Count | Should -Be 0
    }

    It '-WithBrowser without the browser files in the package folder is refused before the first step, in one sentence that says how to get them' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-TestFacts @{ BrowserFiles = 'missing'; BrowserVersion = $null })
      $plan.Refusals | Should -BeExactly @($script:Missing)
      $plan.Steps.Count | Should -Be 0
      # The same on an upgrade of an install without the browser, which -WithBrowser adds it to.
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ InstalledBrowser = $false; BrowserFiles = 'missing'; BrowserVersion = $null })
      $plan.Refusals | Should -BeExactly @($script:Missing)
    }

    It 'refuses browser files of another version than the package' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-TestFacts @{ BrowserVersion = '0.2.0' })
      $plan.Refusals | Should -BeExactly @('The browser files in C:\Program Files\RPA package\0.3.0\rpa-windows-x64 are of version 0.2.0, and the package is version 0.3.0: unpack the rpa-browser-windows-x64.zip of version 0.3.0 into that folder.')
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ WithBrowser = $false }) -Facts (New-InstalledFacts @{ BrowserVersion = '0.2.0' })
      $plan.Refusals | Should -BeExactly @('This install has the browser, and the browser files in C:\Program Files\RPA package\0.3.0\rpa-windows-x64 are of version 0.2.0, and the package is version 0.3.0: unpack the rpa-browser-windows-x64.zip of version 0.3.0 into that folder, or remove the browser with -NoBrowser.')
    }

    It 'an upgrade of an install with the browser keeps it without either switch, and then needs its files' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ WithBrowser = $false }) -Facts (New-InstalledFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.Browser | Should -BeTrue
      foreach ($step in 'add the browser firewall rule', 'register the browser task') { $plan.Steps | Should -Contain $step }
      foreach ($step in $script:RemoveSteps) { $plan.Steps | Should -Not -Contain $step }

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ WithBrowser = $false }) -Facts (New-InstalledFacts @{ BrowserFiles = 'missing'; BrowserVersion = $null })
      $plan.Refusals | Should -BeExactly @($script:KeptMissing)
      $plan.Steps.Count | Should -Be 0
    }

    It 'an upgrade of an install without the browser stays without it, and does not ask for its files' {
      $files = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'missing' }
      $facts = New-InstalledFacts @{ InstalledBrowser = $false; DataFiles = $files; BrowserFiles = 'missing'; BrowserVersion = $null; PortsInUse = @{ 3000 = 'node' } }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ WithBrowser = $false }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Browser | Should -BeFalse
      foreach ($step in $script:BrowserSteps + 'remove the browser token and certificate') { $plan.Steps | Should -Not -Contain $step }
    }

    It '-NoBrowser on an upgrade of an install with the browser removes its task, firewall rule, token and certificate, and does not ask for its files' {
      $facts = New-InstalledFacts @{ BrowserFiles = 'missing'; BrowserVersion = $null }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ NoBrowser = $true; WithBrowser = $false }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Browser | Should -BeFalse
      @($plan.Steps | Where-Object { $script:RemoveSteps -contains $_ }) | Should -BeExactly $script:RemoveSteps
      foreach ($step in $script:BrowserSteps) { $plan.Steps | Should -Not -Contain $step }
      [array]::IndexOf($plan.Steps, 'remove the browser token and certificate') | Should -BeLessThan ([array]::IndexOf($plan.Steps, 'write install.json'))
    }

    It 'with -Unattended and without the browser names only the runner port' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; WithBrowser = $false }) -Facts (New-TestFacts @{ PortsInUse = @{ 13000 = 'node' } })
      $plan.Refusals.Count | Should -Be 0
      $plan.Notice[1] | Should -BeExactly '  - The service RPA Supervisor (RpaSupervisor.exe, running as SYSTEM, started with Windows) listens on port 8765.'
      $plan.Notice | Should -Contain '  - The firewall rule for port 8765 lets connections in to the RPA Supervisor instead of the runner.'
    }
  }

  # A first install for a new bot user on Windows Server, given none of -Unattended, -AutoSignIn and -UserPassword.
  Context 'without a sign-in mode' {
    BeforeAll {
      $script:DefaultModeLines = @(
        'No sign-in mode was given, so this install is unattended (-Unattended): the default on Windows Server for a new bot'
        'user. The other choices: -AutoSignIn (Windows keeps the bot user signed in), or -UserPassword (a person signs it in).'
      )
    }

    It 'is an unattended install, and its notice says so in its first lines and names the other choices' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.Unattended | Should -BeTrue
      $plan.IdleSeconds | Should -Be 15
      $explicit = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts)
      $plan.Steps | Should -BeExactly $explicit.Steps
      $plan.Notice | Should -BeExactly (@($script:DefaultModeLines) + @($explicit.Notice))
      # Given explicitly, the notice is what it was.
      $explicit.Notice[0] | Should -BeExactly '-Unattended changes how this machine works:'
    }

    It 'takes -IdleSeconds, which is for -Unattended' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ IdleSeconds = 60; IdleSecondsGiven = $true }) -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.IdleSeconds | Should -Be 60
    }

    It 'refuses on Windows 10 or 11 as before, with the sentence that names -AutoSignIn' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts @{ IsServer = $false })
      $plan.Refusals | Should -BeExactly @('Give -UserPassword for the new user rpa-runner, or use -AutoSignIn to have a random password stored for automatic sign-in.')
      $plan.Unattended | Should -BeFalse
    }

    It 'is not the default when <Why>' -ForEach @(
      @{ Why = '-UserPassword is given (a person signs the bot user in)'; Parameters = @{ UserPassword = 'password' }; Facts = @{} }
      @{ Why = '-AutoSignIn is given'; Parameters = @{ AutoSignIn = $true }; Facts = @{} }
      @{ Why = '-Unattended:$false is given'; Parameters = @{ UnattendedGiven = $true }; Facts = @{} }
      @{ Why = 'the user exists'; Parameters = @{}; Facts = @{ UserExists = $true; UserSid = 'S-1-5-21-1-2-3-1001' } }
      @{ Why = 'the user is a domain user'; Parameters = @{ User = 'CORP\svc-rpa' }; Facts = @{ UserIsDomain = $true; UserExists = $true } }
      @{ Why = 'it is an upgrade (of an install whose user is gone)'; Parameters = @{}; Facts = @{ Installed = $true; UserExists = $false } }
    ) {
      $change = @{}
      foreach ($key in $Parameters.Keys) { $change[$key] = $Parameters[$key] }
      if ($change.UserPassword) { $change.UserPassword = New-TestPassword }
      $facts = if ($Facts.Installed) { New-InstalledFacts $Facts } else { New-TestFacts $Facts }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters $change) -Facts $facts
      $plan.Unattended | Should -BeFalse
      ($plan.Notice -join "`n") | Should -Not -Match 'No sign-in mode was given'
    }

    It 'gathers the ports behind the RPA Supervisor too when no mode is given' {
      InModuleScope RpaInstall -Parameters @{ P = (New-TestParameters) } { Test-RpaNoModeGiven $P } | Should -BeTrue
      foreach ($change in @(@{ UserPassword = New-TestPassword }, @{ AutoSignIn = $true }, @{ UnattendedGiven = $true })) {
        InModuleScope RpaInstall -Parameters @{ P = (New-TestParameters $change) } { Test-RpaNoModeGiven $P } | Should -BeFalse
      }
      $script:ModuleSource | Should -Match ([regex]::Escape("if (`$Parameters.Unattended -or (Test-RpaNoModeGiven `$Parameters) -or (`$install -and `$install.mode -eq 'unattended' -and -not `$Parameters.UnattendedGiven))"))
    }
  }

  Context '-Unattended' {
    It 'adds the five steps in order after install.json is written, and none of the automatic sign-in steps' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ RemoteDesktopDenied = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -BeExactly @(
        'copy program files'
        'create user'
        'protect the data directory'
        'write policy'
        'write token'
        'write browser-token'
        'add the runner firewall rule'
        'add the browser firewall rule'
        'register the runner task'
        'register the browser task'
        'write install.json'
        'allow the bot user to sign in through Remote Desktop'
        'turn on Remote Desktop'
        "store the bot user's password for the supervisor"
        'register the supervisor service'
        'point the firewall rules at the supervisor'
        'add the Start menu shortcut'
      )
      foreach ($step in $script:SignInSteps) { $plan.Steps | Should -Not -Contain $step }
    }

    It 'turns Remote Desktop on only when it is off, and points no firewall rule anywhere with -NoFirewall' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts)
      $plan.Steps | Should -Not -Contain 'turn on Remote Desktop'
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; NoFirewall = $true; AllowFrom = @() }) -Facts (New-TestFacts @{ RemoteDesktopDenied = $true })
      $plan.Refusals.Count | Should -Be 0
      @($plan.Steps | Where-Object { $script:UnattendedSteps -contains $_ }) | Should -BeExactly $script:UnattendedSteps[0..3]
    }

    It 'every step it lists is a step the installer has' {
      $plans = @(
        (Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ RemoteDesktopDenied = $true }))
        (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-UnattendedFacts))
        (Get-RpaInstallPlan -Parameters (New-TestParameters @{ UnattendedGiven = $true }) -Facts (New-UnattendedFacts))
      )
      $known = InModuleScope RpaInstall { $script:KnownSteps }
      foreach ($plan in $plans) { foreach ($step in $plan.Steps) { $known | Should -Contain $step } }
    }

    It 'refuses -Unattended with -AutoSignIn before anything changes' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; AutoSignIn = $true }) -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('-Unattended and -AutoSignIn cannot be used together: -AutoSignIn keeps the bot user signed in, -Unattended signs it in only for the runs. Choose one.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses -Unattended on a desktop edition of Windows, and says that it was not tested there' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ IsServer = $false })
      $plan.Refusals | Should -BeExactly @('-Unattended is for Windows Server 2019 or later. It was not tested on Windows 10 or 11, so the installer does not set it up there. Install without -Unattended, and have the bot user signed in (-AutoSignIn, or by hand).')
      $plan.Steps.Count | Should -Be 0
      # Without -Unattended a desktop edition is fine.
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-TestFacts @{ IsServer = $false })).Refusals.Count | Should -Be 0
    }

    It 'refuses a domain user: the RPA Supervisor signs in a local user of this machine' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; User = 'CORP\svc-rpa' }) -Facts (New-TestFacts @{ UserIsDomain = $true; UserExists = $true })
      $plan.Refusals | Should -BeExactly @('-Unattended needs a local user of this machine as the bot user; CORP\svc-rpa is a domain user.')
    }

    It 'refuses it over an install that turned automatic sign-in on for another user' {
      $facts = New-InstalledFacts @{ InstalledAutoSignInUser = 'rpa-runner'; InstalledAutoSignInForUser = $false; InstalledForUser = $false; UserExists = $true }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; Unattended = $true; UserPassword = New-TestPassword }) -Facts $facts
      $plan.Refusals | Should -BeExactly @('Automatic sign-in is set up for rpa-runner. Uninstall with -RemoveData first, then install for bot2.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'makes a random password for a user it creates, and needs -UserPassword for an existing user' {
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts)).Refusals.Count | Should -Be 0

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ UserExists = $true })
      $plan.Refusals | Should -BeExactly @('-Unattended for the existing user rpa-runner needs -UserPassword: the RPA Supervisor signs rpa-runner in with it. A password the installer generated earlier is not known to anyone: set a new password for rpa-runner and pass it, or remove rpa-runner so the installer creates it again. A new password makes what the programs of rpa-runner protected with the old one unreadable (the entries of an authenticator application, the certificate of the runner), so where such data exists a new bot user (-User) is the safer way. After a new password the runner cannot read its certificate: remove it and put the new fingerprint into the n8n credential (docs/install/windows.md, section 10).')
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; UserPassword = New-TestPassword }) -Facts (New-TestFacts @{ UserExists = $true; UserPasswordWrong = $true })
      $plan.Refusals | Should -BeExactly @('The password given for rpa-runner is not correct.')
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; UserPassword = New-TestPassword }) -Facts (New-TestFacts @{ UserExists = $true })
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -Contain "store the bot user's password for the supervisor"
    }

    It 'on an upgrade of an unattended install keeps the stored password unless -UserPassword is given' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-UnattendedFacts)
      $plan.Refusals.Count | Should -Be 0
      @($plan.Steps | Where-Object { $script:UnattendedSteps -contains $_ }) | Should -BeExactly @($script:UnattendedSteps[0], $script:UnattendedSteps[3], $script:UnattendedSteps[4])
      $plan.Steps[-1] | Should -BeExactly 'start tasks'
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; UserPassword = New-TestPassword }) -Facts (New-UnattendedFacts)
      $plan.Steps | Should -Contain "store the bot user's password for the supervisor"
      # A failed run before took the stored password away again: it is not kept.
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-UnattendedFacts @{ InstalledSupervisorSecret = $false })
      $plan.Refusals | Should -BeExactly @('-Unattended for the existing user rpa-runner needs -UserPassword: the RPA Supervisor signs rpa-runner in with it. A password the installer generated earlier is not known to anyone: set a new password for rpa-runner and pass it, or remove rpa-runner so the installer creates it again. A new password makes what the programs of rpa-runner protected with the old one unreadable (the entries of an authenticator application, the certificate of the runner), so where such data exists a new bot user (-User) is the safer way. After a new password the runner cannot read its certificate: remove it and put the new fingerprint into the n8n credential (docs/install/windows.md, section 10).')
    }

    It 'refuses -IdleSeconds without -Unattended' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword; IdleSeconds = 60; IdleSecondsGiven = $true }) -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('-IdleSeconds is for -Unattended only.')
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; IdleSeconds = 60; IdleSecondsGiven = $true }) -Facts (New-TestFacts)).Refusals.Count | Should -Be 0
    }

    It 'an upgrade without -Unattended over an unattended install stays unattended and keeps idleSeconds' {
      $facts = New-UnattendedFacts @{ InstalledIdleSeconds = 60 }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Unattended | Should -BeTrue
      $plan.IdleSeconds | Should -Be 60
      $plan.Steps | Should -Not -Contain 'put back what -Unattended changed'
      # The stored password is kept, as with -Unattended and no -UserPassword; nothing is asked again.
      @($plan.Steps | Where-Object { $script:UnattendedSteps -contains $_ }) | Should -BeExactly @($script:UnattendedSteps[0], $script:UnattendedSteps[3], $script:UnattendedSteps[4])
      @($plan.Notice).Count | Should -Be 0
      # -IdleSeconds given: that one.
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ IdleSeconds = 30; IdleSecondsGiven = $true }) -Facts $facts).IdleSeconds | Should -Be 30
      # A first install takes the parameter's value (15 by default).
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts)).IdleSeconds | Should -Be 15
    }

    It 'refuses -AutoSignIn over an unattended install, and says that -Unattended:$false -AutoSignIn goes back' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true; UserPassword = New-TestPassword }) -Facts (New-UnattendedFacts)
      $plan.Refusals | Should -BeExactly @('This install was made with -Unattended, which an upgrade keeps. To use -AutoSignIn instead, run the installer with -Unattended:$false -AutoSignIn.')
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true; UserPassword = New-TestPassword; UnattendedGiven = $true }) -Facts (New-UnattendedFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.Steps | Should -Contain 'put back what -Unattended changed'
      @($plan.Steps | Where-Object { $script:SignInSteps -contains $_ }) | Should -BeExactly $script:SignInSteps
    }

    It '-Unattended:$false puts back what -Unattended changed, after install.json is written' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $false; UnattendedGiven = $true }) -Facts (New-UnattendedFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.Unattended | Should -BeFalse
      foreach ($step in $script:UnattendedSteps) { $plan.Steps | Should -Not -Contain $step }
      $plan.Steps | Should -Contain 'put back what -Unattended changed'
      [array]::IndexOf($plan.Steps, 'put back what -Unattended changed') | Should -Be ([array]::IndexOf($plan.Steps, 'write install.json') + 1)
      # A signed-in install has nothing of that to put back.
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts)).Steps | Should -Not -Contain 'put back what -Unattended changed'
      # A run before that could not put everything back left mode signedIn and some records: the next run tries again.
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-UnattendedFacts @{ InstalledMode = 'signedIn' })).Steps | Should -Contain 'put back what -Unattended changed'
    }

    It 'refuses a port that is too high for the port behind the supervisor, two ports that would meet, and an inner port in use' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; RunnerPort = 60000 }) -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('-RunnerPort 60000 is too high for -Unattended: the runner then listens on port 60000 + 10000 on 127.0.0.1, so the highest is 55535.')
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; BrowserPort = 55536 }) -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('-BrowserPort 55536 is too high for -Unattended: the browser then listens on port 55536 + 10000 on 127.0.0.1, so the highest is 55535.')
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; RunnerPort = 8000; BrowserPort = 18000 }) -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('-RunnerPort 8000 and -BrowserPort 18000 do not work together with -Unattended: the runner and the browser then also listen on 18000 and 28000, and all four ports must differ.')
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ PortsInUse = @{ 18765 = 'httpd' } })
      $plan.Refusals | Should -BeExactly @('Port 18765 is in use by httpd. With -Unattended the runner and the browser listen on their port + 10000 on 127.0.0.1; choose another -RunnerPort or -BrowserPort.')
      # The installed runner and browser hold those ports on an upgrade of an unattended install.
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-UnattendedFacts @{ PortsInUse = @{ 18765 = 'RpaRunner'; 13000 = 'node' } })).Refusals.Count | Should -Be 0
    }

    It 'refuses a supervisor folder that is a link or that someone other than Administrators or SYSTEM owns' {
      $folder = "$($script:DataDir)\supervisor"
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ SupervisorDirState = New-PathState 'link' })
      $plan.Refusals | Should -BeExactly @("$folder is a link or junction. Remove it and run the installer again.")
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ SupervisorDirState = New-PathState 'theirs' })
      $plan.Refusals | Should -BeExactly @("$folder exists and is owned by BOT-PC\mallory. Check what is in it, remove it, and run the installer again.")
      # Without -Unattended the folder is not used.
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-TestFacts @{ SupervisorDirState = New-PathState 'theirs' })).Refusals.Count | Should -Be 0
    }

    It 'refuses it while the Remote Desktop service is disabled, before anything changes' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ RemoteDesktopServiceDisabled = $true })
      $plan.Refusals | Should -BeExactly @('-Unattended needs the Remote Desktop service (TermService), which is disabled on this machine: set it to start (Set-Service TermService -StartupType Manual) and run the installer again.')
      $plan.Steps.Count | Should -Be 0
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-TestFacts @{ RemoteDesktopServiceDisabled = $true })).Refusals.Count | Should -Be 0
    }

    It 'refuses it when Remote Desktop listens on another port than 3389' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ RemoteDesktopPort = 3390 })
      $plan.Refusals | Should -BeExactly @('-Unattended needs Remote Desktop on port 3389, where the RPA Supervisor connects, and this machine sets it to port 3390 (PortNumber of RDP-Tcp).')
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-TestFacts @{ RemoteDesktopPort = 3389 })).Refusals.Count | Should -Be 0
    }

    It "warns that an expiring password stops the supervisor's sign-ins" {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; UserPassword = New-TestPassword }) -Facts (New-TestFacts @{ UserExists = $true; UserPasswordExpires = $true })
      $plan.Warnings | Should -BeExactly @("rpa-runner's password expires; when it does, the RPA Supervisor cannot sign rpa-runner in until a new one is stored with Install-Rpa.ps1 -Unattended -UserPassword.")
    }

    It 'shows what it changes before anything changes, the first time only, and never the password' {
      $password = New-MadeUpPassword
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; UserPassword = $password.Secure }) -Facts (New-TestFacts @{ UserExists = $true; RemoteDesktopDenied = $true })
      $plan.Notice | Should -BeExactly @(
        '-Unattended changes how this machine works:'
        '  - The service RPA Supervisor (RpaSupervisor.exe, running as SYSTEM, started with Windows) listens on port 8765 and 3000.'
        '    When n8n connects, it signs rpa-runner in through a Remote Desktop connection from this machine to itself,'
        '    and signs it out again 15 s after the last connection. The runner and the browser listen on 127.0.0.1 only,'
        '    at port 18765 and 13000.'
        '  - rpa-runner is added to the group Remote Desktop Users, unless it is a member already.'
        '  - Remote Desktop is turned on (it is off now). The installer turns on no firewall rule for Remote Desktop: the RPA'
        '    Supervisor connects from this machine to itself. Where a firewall rule that is on already, or a firewall that'
        '    is off, lets connections to port 3389 in, Remote Desktop can then be reached from the network.'
        '    Uninstall-Rpa.ps1 turns it off again.'
        '  - The password of rpa-runner is stored on this machine for the RPA Supervisor. An administrator of this machine'
        '    can read it.'
        '  - The firewall rules for port 8765 and 3000 let connections in to the RPA Supervisor instead of the runner and the'
        '    browser.'
        '  - While someone is signed in as rpa-runner, at the console or over Remote Desktop, runs are refused.'
        '  Uninstall-Rpa.ps1 puts these settings back to what they were.'
      )
      ($plan.Notice -join "`n").Contains($password.Text) | Should -BeFalse
      ($plan.Steps -join "`n").Contains($password.Text) | Should -BeFalse
      # An upgrade of an unattended install has said it all before; a signed-in install says nothing of it.
      @((Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-UnattendedFacts)).Notice).Count | Should -Be 0
      @((Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts (New-TestFacts)).Notice).Count | Should -Be 0
    }

    Context 'over an install with automatic sign-in for the same bot user' {
      BeforeAll {
        # A 0.2.0 install with -AutoSignIn: no mode recorded, the password only in the secret for automatic sign-in.
        function New-AutoSignInFacts([hashtable]$Change = @{}) {
          $facts = New-InstalledFacts @{ InstalledAutoSignInUser = 'rpa-runner'; InstalledAutoSignInForUser = $true; AutoSignInPassword = 'ok'; RemoteDesktopDenied = $true }
          foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
          $facts
        }
      }

      It 'keeps the password stored for automatic sign-in, turns automatic sign-in off and signs the bot user out, in this order' {
        $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-AutoSignInFacts)
        $plan.Refusals.Count | Should -Be 0
        $plan.Steps | Should -BeExactly @(
          'stop running services'
          'copy program files'
          'protect the data directory'
          'add the runner firewall rule'
          'add the browser firewall rule'
          'register the runner task'
          'register the browser task'
          'write install.json'
          'keep the automatic sign-in password for the supervisor'
          'turn off automatic sign-in'
          'allow the bot user to sign in through Remote Desktop'
          'turn on Remote Desktop'
          'sign the bot user out'
          'register the supervisor service'
          'point the firewall rules at the supervisor'
          'add the Start menu shortcut'
          'start tasks'
        )
        $plan.Steps | Should -Not -Contain "store the bot user's password for the supervisor"
        $known = InModuleScope RpaInstall { $script:KnownSteps }
        foreach ($step in $plan.Steps) { $known | Should -Contain $step }
      }

      It 'with -UserPassword stores the given password, and still turns automatic sign-in off' {
        $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; UserPassword = New-TestPassword }) -Facts (New-AutoSignInFacts @{ AutoSignInPassword = $null })
        $plan.Refusals.Count | Should -Be 0
        $plan.Steps[8..9] | Should -BeExactly @("store the bot user's password for the supervisor", 'turn off automatic sign-in')
        $plan.Steps | Should -Not -Contain 'keep the automatic sign-in password for the supervisor'
        $plan.Steps | Should -Contain 'sign the bot user out'
        $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; UserPassword = New-TestPassword }) -Facts (New-AutoSignInFacts @{ UserPasswordWrong = $true })
        $plan.Refusals | Should -BeExactly @('The password given for rpa-runner is not correct.')
      }

      It 'refuses before anything changes when the stored password is <Why>' -ForEach @(
        @{ Why = 'missing or empty'; State = 'missing'; Text = 'Automatic sign-in of rpa-runner has no stored password that the installer can read, so -Unattended cannot keep it. Give the password of rpa-runner with -UserPassword, or install for a new bot user with -User.' }
        @{ Why = 'not accepted'; State = 'wrong'; Text = 'Windows does not accept the password stored for automatic sign-in of rpa-runner any more, so -Unattended cannot keep it. Give the password of rpa-runner with -UserPassword, or install for a new bot user with -User.' }
      ) {
        $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-AutoSignInFacts @{ AutoSignInPassword = $State })
        $plan.Refusals | Should -BeExactly @($Text)
        $plan.Steps.Count | Should -Be 0
      }

      It 'says that automatic sign-in goes off, that the password stays the same and that the bot user is signed out, and never the password' {
        $password = New-MadeUpPassword
        $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-AutoSignInFacts)
        $plan.Notice | Should -Contain '  - Automatic sign-in of rpa-runner is turned off, and the settings -AutoSignIn changed go back to what they were.'
        $plan.Notice | Should -Contain '  - The password of rpa-runner stays the same: the one stored for automatic sign-in is stored for the RPA Supervisor'
        $plan.Notice | Should -Contain '    instead, so no program of rpa-runner loses data it protects with that password.'
        $plan.Notice | Should -Contain '  - rpa-runner is signed out now (every session of rpa-runner), so that the RPA Supervisor can sign it in for each run.'
        ($plan.Notice -join "`n") | Should -Not -Match 'An administrator of this machine'
        $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; UserPassword = $password.Secure }) -Facts (New-AutoSignInFacts)
        (($plan.Notice + $plan.Steps + $plan.Refusals + $plan.Warnings) -join "`n").Contains($password.Text) | Should -BeFalse
      }

      It 'a move from automatic sign-in without -Force shows its notice and question while the runner runs' {
        $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true }) -Facts (New-AutoSignInFacts @{ RunnerRunning = $true })
        $plan.Refusals.Count | Should -Be 0
        $plan.Warnings | Should -Contain 'The runner is running; a run in progress will fail.'
        @($plan.Notice).Count | Should -BeGreaterThan 0
        # Not on other upgrades.
        (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ RunnerRunning = $true })).Refusals | Should -BeExactly @('The runner is running; a run in progress will fail. Use -Force to continue.')
      }

      It 'leaves an upgrade without -Unattended as it is: automatic sign-in stays' {
        $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-AutoSignInFacts)
        $plan.Refusals.Count | Should -Be 0
        foreach ($step in 'turn off automatic sign-in', 'keep the automatic sign-in password for the supervisor', 'sign the bot user out') { $plan.Steps | Should -Not -Contain $step }
        $plan.Unattended | Should -BeFalse
      }
    }

    Context 'back to automatic sign-in (-Unattended:$false -AutoSignIn) for the same bot user' {
      BeforeAll {
        function New-BackParameters([hashtable]$Change = @{}) {
          $parameters = New-TestParameters @{ Unattended = $false; UnattendedGiven = $true; AutoSignIn = $true }
          foreach ($key in $Change.Keys) { $parameters[$key] = $Change[$key] }
          $parameters
        }
      }

      It 'keeps the password the supervisor has, turns automatic sign-in on with it, and then puts back what -Unattended changed' {
        $plan = Get-RpaInstallPlan -Parameters (New-BackParameters) -Facts (New-UnattendedFacts @{ SupervisorPassword = 'ok' })
        $plan.Refusals.Count | Should -Be 0
        $at = [array]::IndexOf($plan.Steps, 'write install.json')
        $plan.Steps[($at + 1)..($plan.Steps.Count - 1)] | Should -BeExactly @(
          'keep the supervisor password for automatic sign-in'
          'store sign-in password'
          'turn on automatic sign-in'
          'keep the desktop unlocked'
          'put back what -Unattended changed'
          'add the Start menu shortcut'
          'start tasks'
        )
        $known = InModuleScope RpaInstall { $script:KnownSteps }
        foreach ($step in $plan.Steps) { $known | Should -Contain $step }
      }

      It 'with -UserPassword uses the given password, and still puts back what -Unattended changed after automatic sign-in is on' {
        $plan = Get-RpaInstallPlan -Parameters (New-BackParameters @{ UserPassword = New-TestPassword }) -Facts (New-UnattendedFacts)
        $plan.Refusals.Count | Should -Be 0
        $plan.Steps | Should -Not -Contain 'keep the supervisor password for automatic sign-in'
        [array]::IndexOf($plan.Steps, 'put back what -Unattended changed') | Should -BeGreaterThan ([array]::IndexOf($plan.Steps, 'keep the desktop unlocked'))
      }

      It 'refuses before anything changes when the supervisor password is <Why>' -ForEach @(
        @{ Why = 'missing or empty'; State = 'missing'; Text = 'The RPA Supervisor of rpa-runner has no stored password that the installer can read, so -AutoSignIn cannot keep it. Give the password of rpa-runner with -UserPassword, or install for a new bot user with -User.' }
        @{ Why = 'not accepted'; State = 'wrong'; Text = 'Windows does not accept the password stored for the RPA Supervisor of rpa-runner any more, so -AutoSignIn cannot keep it. Give the password of rpa-runner with -UserPassword, or install for a new bot user with -User.' }
      ) {
        $plan = Get-RpaInstallPlan -Parameters (New-BackParameters) -Facts (New-UnattendedFacts @{ SupervisorPassword = $State })
        $plan.Refusals | Should -BeExactly @($Text)
        $plan.Steps.Count | Should -Be 0
      }

      It 'says that the password stays the same, that the supervisor goes and when Windows signs the bot user in, and never the password' {
        $plan = Get-RpaInstallPlan -Parameters (New-BackParameters) -Facts (New-UnattendedFacts @{ SupervisorPassword = 'ok' })
        $plan.Notice | Should -BeExactly @(
          '-Unattended:$false changes how this machine works:'
          '  - The password of rpa-runner stays the same: the one stored for the RPA Supervisor is stored for automatic'
          '    sign-in instead, so no program of rpa-runner loses data it protects with that password.'
          '  - The service RPA Supervisor, its stored password and the other settings -Unattended changed are removed or put'
          '    back, after automatic sign-in is set up.'
          '  - Windows signs rpa-runner in at the next start of this machine (Restart-Computer).'
        )
        $password = New-MadeUpPassword
        $plan = Get-RpaInstallPlan -Parameters (New-BackParameters @{ UserPassword = $password.Secure }) -Facts (New-UnattendedFacts)
        (($plan.Notice + $plan.Steps + $plan.Refusals + $plan.Warnings) -join "`n").Contains($password.Text) | Should -BeFalse
      }
    }

    It 'with -NoBrowser names only the runner port' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ Unattended = $true; NoBrowser = $true; WithBrowser = $false }) -Facts (New-TestFacts)
      $plan.Notice[1] | Should -BeExactly '  - The service RPA Supervisor (RpaSupervisor.exe, running as SYSTEM, started with Windows) listens on port 8765.'
      $plan.Notice[3] | Should -BeExactly '    and signs it out again 15 s after the last connection. The runner listens on 127.0.0.1 only, at port 18765.'
    }
  }
}

Describe 'Remove-RpaOldTokens' {
  It 'removes both token files, and refuses a token that has a second name without removing it' -Skip:($env:OS -ne 'Windows_NT') {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('rpa-tokens-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root | Out-Null
    try {
      InModuleScope RpaInstall -Parameters @{ Root = $root } {
        param($Root)
        foreach ($name in 'token', 'browser-token') { Set-Content -LiteralPath (Join-Path $Root $name) -Value 'made up' -NoNewline }
        Remove-RpaOldTokens @{ DataDir = $Root }
        Join-Path $Root 'token' | Should -Not -Exist
        Join-Path $Root 'browser-token' | Should -Not -Exist

        $token = Join-Path $Root 'token'
        Set-Content -LiteralPath $token -Value 'made up' -NoNewline
        New-Item -ItemType HardLink -Path (Join-Path $Root 'second-name') -Target $token | Out-Null
        { Remove-RpaOldTokens @{ DataDir = $Root } } | Should -Throw -ExpectedMessage "$token has more than one name (a hard link). Check what it is, remove it, and run the installer again."
        $token | Should -Exist
      }
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Describe 'Remove-RpaBrowserData' {
  It 'removes the browser token, certificate and key, a link in their place as the link itself, and refuses a folder' -Skip:($env:OS -ne 'Windows_NT') {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('rpa-browser-data-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $root 'elsewhere') | Out-Null
    try {
      InModuleScope RpaInstall -Parameters @{ Root = $root } {
        param($Root)
        foreach ($name in 'token', 'browser-token', 'browser-cert.pem', 'browser-key.pem') { Set-Content -LiteralPath (Join-Path $Root $name) -Value 'made up' -NoNewline }
        Remove-RpaBrowserData @{ DataDir = $Root }
        foreach ($name in 'browser-token', 'browser-cert.pem', 'browser-key.pem') { Join-Path $Root $name | Should -Not -Exist }
        Join-Path $Root 'token' | Should -Exist
        # Nothing there: nothing to do.
        { Remove-RpaBrowserData @{ DataDir = $Root } } | Should -Not -Throw

        $kept = Join-Path (Join-Path $Root 'elsewhere') 'kept.txt'
        Set-Content -LiteralPath $kept -Value 'made up' -NoNewline
        & (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') /d /c ('mklink /J "{0}" "{1}"' -f (Join-Path $Root 'browser-cert.pem'), (Join-Path $Root 'elsewhere')) | Out-Null
        Remove-RpaBrowserData @{ DataDir = $Root }
        Join-Path $Root 'browser-cert.pem' | Should -Not -Exist
        $kept | Should -Exist

        $folder = Join-Path $Root 'browser-key.pem'
        New-Item -ItemType Directory -Path $folder | Out-Null
        { Remove-RpaBrowserData @{ DataDir = $Root } } | Should -Throw -ExpectedMessage "$folder is a folder. Check what it is, remove it, and run the installer again."
      }
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Describe 'The browser files of a package' {
  It 'are present when the package folder holds every file the browser needs, with the version of browser\VERSION' {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('rpa-browser-package-' + [guid]::NewGuid().ToString('N'))
    try {
      $files = InModuleScope RpaInstall { $script:BrowserFiles }
      foreach ($name in @('VERSION') + $files) {
        $path = Join-Path $root ($name -replace '\\', [IO.Path]::DirectorySeparatorChar)
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        if ($name -like '*VERSION') { Set-Content -LiteralPath $path -Value '0.3.0' } else { Set-Content -LiteralPath $path -Value 'made up' }
      }
      Set-Content -LiteralPath (Join-Path (Join-Path $root 'browser') 'VERSION') -Value '0.2.0'
      $facts = InModuleScope RpaInstall -Parameters @{ Root = $root } { param($Root) Get-RpaBrowserPackageFacts $Root }
      $facts.PackageDir | Should -BeExactly $root
      $facts.PackageVersion | Should -BeExactly '0.3.0'
      $facts.BrowserFiles | Should -BeExactly 'present'
      $facts.BrowserVersion | Should -BeExactly '0.2.0'

      Remove-Item -LiteralPath (Join-Path (Join-Path $root 'scripts') 'start-browser.ps1')
      $facts = InModuleScope RpaInstall -Parameters @{ Root = $root } { param($Root) Get-RpaBrowserPackageFacts $Root }
      $facts.BrowserFiles | Should -BeExactly 'missing'
      $facts.BrowserVersion | Should -BeNullOrEmpty
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It 'the installer needs the same files that the browser package holds' {
    $files = InModuleScope RpaInstall { $script:BrowserFiles }
    $files | Should -Contain 'browser\VERSION'
    $files | Should -Contain 'scripts\start-browser.ps1'
    @($files | Where-Object { $_ -notlike 'browser\*' -and $_ -ne 'scripts\start-browser.ps1' }).Count | Should -Be 0
  }
}

Describe 'Copy-RpaProgramFiles' {
  It 'without the browser copies no browser file and removes the one an earlier install left; with it copies them' -Skip:($env:OS -ne 'Windows_NT') {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('rpa-copy-' + [guid]::NewGuid().ToString('N'))
    $source = Join-Path $root 'package'
    $target = Join-Path $root 'install'
    try {
      foreach ($name in 'VERSION', 'runner\RpaRunner.exe', 'scripts\start-runner.ps1', 'scripts\start-browser.ps1', 'browser\node.exe') {
        $path = Join-Path $source $name
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        Set-Content -LiteralPath $path -Value 'made up'
      }
      InModuleScope RpaInstall -Parameters @{ Source = $source; Target = $target } { param($Source, $Target) Copy-RpaProgramFiles $Source $Target $true }
      Join-Path $target 'browser\node.exe' | Should -Exist
      Join-Path $target 'scripts\start-browser.ps1' | Should -Exist
      InModuleScope RpaInstall -Parameters @{ Source = $source; Target = $target } { param($Source, $Target) Copy-RpaProgramFiles $Source $Target $false }
      Join-Path $target 'browser' | Should -Not -Exist
      Join-Path $target 'scripts\start-browser.ps1' | Should -Not -Exist
      Join-Path $target 'scripts\start-runner.ps1' | Should -Exist
      Join-Path $target 'runner\RpaRunner.exe' | Should -Exist
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Describe 'Protect-RpaDataDirectory' {
  # A data directory, logs\, policy-backups\ and policy-changes\ in a temporary folder, and a file outside it that the bot user may only
  # read; the rules name the Users group in place of a bot user.
  It 'on a run that does not judge the data directory, refuses a second name in logs\ and leaves the other file as it was' -Skip:($env:OS -ne 'Windows_NT') {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('rpa-protect-' + [guid]::NewGuid().ToString('N'))
    $layout = @{ InstallDir = Join-Path $root 'install'; DataDir = Join-Path $root 'data'; LogDir = Join-Path (Join-Path $root 'data') 'logs'; BackupsDir = Join-Path (Join-Path $root 'data') 'policy-backups'; ChangesDir = Join-Path (Join-Path $root 'data') 'policy-changes' }
    New-Item -ItemType Directory -Path $layout.InstallDir, $layout.LogDir, (Join-Path $root 'elsewhere') | Out-Null
    try {
      $other = Join-Path (Join-Path $root 'elsewhere') 'other.txt'
      Set-Content -LiteralPath $other -Value 'not the installer''s' -NoNewline
      & icacls.exe $other /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-32-545:R' | Out-Null
      $before = (Get-Acl -LiteralPath $other).Sddl
      $planted = Join-Path $layout.LogDir 'planted.log'
      New-Item -ItemType HardLink -Path $planted -Target $other | Out-Null
      InModuleScope RpaInstall -Parameters @{ Layout = $layout; Planted = $planted } {
        param($Layout, $Planted)
        { Protect-RpaDataDirectory $Layout 'S-1-5-32-545' $false '' } | Should -Throw -ExpectedMessage "$Planted has more than one name (a hard link). Check what it is, remove it, and run the installer again."
      }
      (Get-Acl -LiteralPath $other).Sddl | Should -BeExactly $before
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Describe 'Invoke-RpaInstallPlan' {
  It 'checks every step name before it runs the first step' {
    $plan = @{ Refusals = @(); Warnings = @(); Steps = @('copy program files', 'make coffee') }
    { Invoke-RpaInstallPlan -Plan $plan -Parameters (New-TestParameters) -SourceDir $script:InstallerDir } |
      Should -Throw -ExpectedMessage 'The installer has no step "make coffee"; nothing was changed.'
  }

  # A step name the plan may list but the switch has no case for would print its name and do nothing.
  It 'has a case for every step it knows, and knows every step it has a case for' {
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $script:InstallerDir 'RpaInstall.Machine.ps1'), [ref]$null, [ref]$null)
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-RpaInstallPlan' }, $false)
    $switch = $function.Find({ param($node) $node -is [Management.Automation.Language.SwitchStatementAst] -and $node.Condition.Extent.Text -eq '$step' }, $true)
    $cases = @($switch.Clauses | ForEach-Object { $_.Item1.Value })
    $known = InModuleScope RpaInstall { $script:KnownSteps }
    $cases.Count | Should -Be $known.Count
    @($cases | Sort-Object) | Should -BeExactly @($known | Sort-Object)
  }

  # The question -AutoSignIn asks can sit between the plan and the steps, and a standard user can make the folder.
  It 'looks at the owner of the scheduled task folder again directly before it registers a task' {
    Mock -ModuleName RpaInstall Get-RpaTaskFolderOwner { 'BOT-PC\mallory' }
    Mock -ModuleName RpaInstall Unregister-RpaTask { }
    { InModuleScope RpaInstall { Register-RpaTask 'RPA Runner' 'C:\Program Files\RPA Runner\scripts\start-runner.ps1' 'BOT-PC\rpa-runner' } } |
      Should -Throw -ExpectedMessage 'The scheduled task folder \RPA\ exists and is owned by BOT-PC\mallory. Check what is in it, remove it, and run the installer again.'
    Should -Invoke -ModuleName RpaInstall Unregister-RpaTask -Times 0 -Exactly
  }

  # A standard user can still make the folder between that look and the registration, and the task then lies in a
  # folder that user owns. So the owners are read once more, after the registration.
  Context 'after a task is registered' {
    BeforeEach {
      $env:RPA_TEST_TASK_REGISTERED = ''
      Mock -ModuleName RpaInstall Unregister-RpaTask { }
      Mock -ModuleName RpaInstall Register-RpaScheduledTask { $env:RPA_TEST_TASK_REGISTERED = '1' }
    }
    AfterEach { $env:RPA_TEST_TASK_REGISTERED = $null }

    It 'removes the task again and stops when the folder is not owned by Administrators or SYSTEM by then' {
      Mock -ModuleName RpaInstall Get-RpaTaskFolderOwner { if ($env:RPA_TEST_TASK_REGISTERED) { 'BOT-PC\mallory' } }
      Mock -ModuleName RpaInstall Get-RpaTaskOwner { }
      { InModuleScope RpaInstall { Register-RpaTask 'RPA Runner' 'C:\Program Files\RPA Runner\scripts\start-runner.ps1' 'BOT-PC\rpa-runner' } } |
        Should -Throw -ExpectedMessage 'The scheduled task folder \RPA\ exists and is owned by BOT-PC\mallory. Check what is in it, remove it, and run the installer again.'
      Should -Invoke -ModuleName RpaInstall Register-RpaScheduledTask -Times 1 -Exactly
      # Once before the registration (a task of that name is never overwritten), once to take the new task away.
      Should -Invoke -ModuleName RpaInstall Unregister-RpaTask -Times 2 -Exactly
    }

    It 'removes the task again and stops when the task is not owned by Administrators or SYSTEM' {
      Mock -ModuleName RpaInstall Get-RpaTaskFolderOwner { }
      Mock -ModuleName RpaInstall Get-RpaTaskOwner { 'BOT-PC\mallory' }
      { InModuleScope RpaInstall { Register-RpaTask 'RPA Runner' 'C:\Program Files\RPA Runner\scripts\start-runner.ps1' 'BOT-PC\rpa-runner' } } |
        Should -Throw -ExpectedMessage 'The scheduled task \RPA\RPA Runner is owned by BOT-PC\mallory. Check what is in the scheduled task folder \RPA\, remove it, and run the installer again.'
      Should -Invoke -ModuleName RpaInstall Unregister-RpaTask -Times 2 -Exactly
    }

    It 'leaves the task when Administrators or SYSTEM own the folder and the task' {
      Mock -ModuleName RpaInstall Get-RpaTaskFolderOwner { }
      Mock -ModuleName RpaInstall Get-RpaTaskOwner { }
      { InModuleScope RpaInstall { Register-RpaTask 'RPA Runner' 'C:\Program Files\RPA Runner\scripts\start-runner.ps1' 'BOT-PC\rpa-runner' } } | Should -Not -Throw
      Should -Invoke -ModuleName RpaInstall Register-RpaScheduledTask -Times 1 -Exactly
      Should -Invoke -ModuleName RpaInstall Unregister-RpaTask -Times 1 -Exactly
      Should -Invoke -ModuleName RpaInstall Get-RpaTaskOwner -Times 1 -Exactly
    }
  }

  # A file symbolic link that points at a path that does not exist: an ordinary "create new" follows it and makes the
  # file where the link points.
  It 'creates no file through a link that stands where the file is to be: <Kind>' -Skip:($env:OS -ne 'Windows_NT') -ForEach @(
    @{ Kind = 'a file symbolic link'; Make = 'mklink "{0}" "{1}"' }
    @{ Kind = 'a junction'; Make = 'mklink /J "{0}" "{1}"' }
  ) {
    $dir = Join-Path $TestDrive ('link-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $slot = Join-Path $dir 'token'
    $target = Join-Path $dir 'where-the-link-points'
    & (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') /d /c ($Make -f $slot, $target) | Out-Null
    [bool]([IO.File]::GetAttributes($slot) -band [IO.FileAttributes]::ReparsePoint) | Should -BeTrue
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

    { InModuleScope RpaInstall -Parameters @{ Path = $slot; Sid = $sid } { New-RpaProtectedFile -Path $Path -Sid $Sid -SecretLength 48 } } |
      Should -Throw -ExpectedMessage "$slot is a link or junction. Remove it and run the installer again."
    $target | Should -Not -Exist

    # Also when the link gets there after that look: the create itself does not follow it.
    { InModuleScope RpaInstall -Parameters @{ Path = $slot } { Add-RpaNativeTypes; [RpaFiles]::CreateNew($Path, 'O:BAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)', [byte[]]@(120)) } } | Should -Throw
    $target | Should -Not -Exist
  }

  It 'writes a new file with its owner, its access rules and its text in one call, and never over a file that is there' -Skip:($env:OS -ne 'Windows_NT') {
    $file = Join-Path $TestDrive ('new-' + [guid]::NewGuid().ToString('N'))
    $sid = 'S-1-5-32-545'
    InModuleScope RpaInstall -Parameters @{ Path = $file; Sid = $sid } { New-RpaProtectedFile -Path $Path -Sid $Sid -Text '{ "a": 1 }' }
    [IO.File]::ReadAllBytes($file) | Should -BeExactly ([Text.Encoding]::ASCII.GetBytes('{ "a": 1 }'))
    $acl = Get-Acl -LiteralPath $file
    $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value | Should -BeExactly 'S-1-5-32-544'
    $acl.AreAccessRulesProtected | Should -BeTrue
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { '{0}={1}' -f $_.IdentityReference.Value, [int]$_.FileSystemRights } | Sort-Object)
    # SYSTEM and Administrators in full (0x1f01ff), the given account may read (0x120089).
    $rules | Should -BeExactly @('S-1-5-18=2032127', 'S-1-5-32-544=2032127', 'S-1-5-32-545=1179785')
    { InModuleScope RpaInstall -Parameters @{ Path = $file; Sid = $sid } { New-RpaProtectedFile -Path $Path -Sid $Sid -Text 'again' } } | Should -Throw -ExpectedMessage "$file could not be created:*"
    [IO.File]::ReadAllText($file) | Should -BeExactly '{ "a": 1 }'
  }

  # A package that was unpacked only in part would install, and then point the user to a tool that is not there.
  Context 'the files a package must hold' {
    BeforeAll {
      $script:Needed = @('VERSION', 'runner\RpaRunner.exe', 'runner\RpaPolicy.exe', 'runner\RpaSupervisor.exe', 'recorder\RpaRecorder.exe', 'scripts\start-loop.ps1', 'scripts\start-runner.ps1', 'scripts\Show-RpaConnection.ps1', 'rpa.cmd', 'scripts\rpa.ps1')
      $script:BrowserNeeded = @('browser\VERSION', 'browser\node.exe', 'browser\host\host.mjs', 'browser\host\run-server.mjs', 'browser\gate\gate.mjs', 'browser\node_modules\playwright\cli.js', 'scripts\start-browser.ps1')
      # Invoke-RpaInstallPlan reads these; elsewhere than on Windows they are not set.
      $script:Places = @{ ProgramFiles = $env:ProgramFiles; ProgramData = $env:ProgramData; ComputerName = $env:COMPUTERNAME }
      if (-not $env:ProgramFiles) { $env:ProgramFiles = Join-Path $TestDrive 'Program Files' }
      if (-not $env:ProgramData) { $env:ProgramData = Join-Path $TestDrive 'ProgramData' }
      if (-not $env:COMPUTERNAME) { $env:COMPUTERNAME = 'BOT-PC' }
      function New-TestPackage([string[]]$Leave) {
        $root = Join-Path $TestDrive ('package-' + [guid]::NewGuid().ToString('N'))
        foreach ($name in $script:Needed + $script:BrowserNeeded) {
          if ($Leave -contains $name) { continue }
          $path = Join-Path $root ($name -replace '\\', [IO.Path]::DirectorySeparatorChar)
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
          Set-Content -LiteralPath $path -Value 'made up'
        }
        $root
      }
    }
    AfterAll { $env:ProgramFiles = $script:Places.ProgramFiles; $env:ProgramData = $script:Places.ProgramData; $env:COMPUTERNAME = $script:Places.ComputerName }

    It 'refuses a package without <Name> before the first step' -ForEach @(
      @{ Name = 'runner\RpaPolicy.exe' }, @{ Name = 'runner\RpaSupervisor.exe' }, @{ Name = 'recorder\RpaRecorder.exe' }, @{ Name = 'rpa.cmd' }, @{ Name = 'scripts\rpa.ps1' }, @{ Name = 'browser\host\run-server.mjs' }, @{ Name = 'browser\gate\gate.mjs' }, @{ Name = 'browser\node_modules\playwright\cli.js' }
    ) {
      $package = New-TestPackage @($Name)
      Mock -ModuleName RpaInstall Copy-RpaProgramFiles { }
      $plan = @{ Refusals = @(); Warnings = @(); Steps = @('copy program files') }
      $source = (Resolve-Path -LiteralPath $package).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
      { Invoke-RpaInstallPlan -Plan $plan -Parameters (New-TestParameters) -SourceDir $package } |
        Should -Throw -ExpectedMessage "$Name is missing from $source. Unpack the whole package and run Install-Rpa.ps1 from that folder."
      Should -Invoke -ModuleName RpaInstall Copy-RpaProgramFiles -Times 0 -Exactly
    }

    # 'stop running services' switched the tasks off and stopped the RPA Supervisor; the undo of a failed upgrade
    # switches the tasks on again, and starts the supervisor where the install stays unattended.
    It 'a failed upgrade of an unattended install starts the supervisor again (and a signed-in one only its tasks): <Mode>' -ForEach @(
      @{ Mode = 'unattended'; Starts = 1 }
      @{ Mode = 'signedIn'; Starts = 0 }
    ) {
      if (-not (Get-Command Start-Service -ErrorAction SilentlyContinue)) { function global:Start-Service { [CmdletBinding()] param([string]$Name) } }
      $package = New-TestPackage @()
      $env:RPA_TEST_MODE = $Mode
      $env:RPA_TEST_PATH = InModuleScope RpaInstall { Get-RpaSupervisorPath (Get-RpaLayout).InstallDir }
      Mock -ModuleName RpaInstall Read-RpaInstallFile { [pscustomobject]@{ user = 'rpa-runner'; autoSignIn = $false; mode = $env:RPA_TEST_MODE } }
      Mock -ModuleName RpaInstall Get-RpaSid { 'S-1-5-21-1-2-3-1001' }
      Mock -ModuleName RpaInstall Write-Host { }
      Mock -ModuleName RpaInstall Stop-RpaServices { }
      Mock -ModuleName RpaInstall Copy-RpaProgramFiles { throw 'Access is denied.' }
      Mock -ModuleName RpaInstall Undo-RpaFailedRun { @{ NotPutBack = @(); UserKept = $null } }
      Mock -ModuleName RpaInstall Enable-RpaTasks { }
      Mock -ModuleName RpaInstall Start-RpaTasks { }
      Mock -ModuleName RpaInstall Get-RpaServicePath { $env:RPA_TEST_PATH }
      Mock -ModuleName RpaInstall Start-Service { }
      $plan = @{ Refusals = @(); Warnings = @(); Steps = @('stop running services', 'copy program files') }
      try {
        { Invoke-RpaInstallPlan -Plan $plan -Parameters (New-TestParameters) -SourceDir $package } | Should -Throw -ExpectedMessage 'The step "copy program files" failed: Access is denied.'
      } finally { $env:RPA_TEST_MODE = $null; $env:RPA_TEST_PATH = $null }
      Should -Invoke -ModuleName RpaInstall Enable-RpaTasks -Times 1 -Exactly
      Should -Invoke -ModuleName RpaInstall Start-RpaTasks -Times 1 -Exactly
      Should -Invoke -ModuleName RpaInstall Start-Service -Times $Starts -Exactly -ParameterFilter { $Name -eq 'RPA Supervisor' }
    }

    It 'a supervisor that does not start again after a failed upgrade is one line, not a second error' {
      $env:RPA_TEST_PATH = InModuleScope RpaInstall { Get-RpaSupervisorPath (Get-RpaLayout).InstallDir }
      if (-not (Get-Command Start-Service -ErrorAction SilentlyContinue)) { function global:Start-Service { [CmdletBinding()] param([string]$Name) } }
      Mock -ModuleName RpaInstall Enable-RpaTasks { }
      Mock -ModuleName RpaInstall Start-RpaTasks { }
      Mock -ModuleName RpaInstall Get-RpaServicePath { $env:RPA_TEST_PATH }
      Mock -ModuleName RpaInstall Start-Service { throw 'Cannot start service.' }
      try {
        $said = @(InModuleScope RpaInstall { Resume-RpaAfterFailedRun @{ Layout = (Get-RpaLayout); Install = @{ mode = 'unattended' } } 6>&1 })
      } finally { $env:RPA_TEST_PATH = $null }
      ($said -join "`n") | Should -BeExactly '  undo: could not start the service RPA Supervisor again: Cannot start service.'
    }

    It 'with -NoBrowser does not ask for the files of the browser' {
      $package = New-TestPackage $script:BrowserNeeded
      Mock -ModuleName RpaInstall Copy-RpaProgramFiles { }
      Mock -ModuleName RpaInstall Read-RpaInstallFile { }
      Mock -ModuleName RpaInstall Get-RpaSid { 'S-1-5-21-1-2-3-1001' }
      # The step's name, which the installer prints as it starts it.
      Mock -ModuleName RpaInstall Write-Host { }
      $plan = @{ Refusals = @(); Warnings = @(); Steps = @('copy program files') }
      { Invoke-RpaInstallPlan -Plan $plan -Parameters (New-TestParameters @{ NoBrowser = $true }) -SourceDir $package } | Should -Not -Throw
      Should -Invoke -ModuleName RpaInstall Copy-RpaProgramFiles -Times 1 -Exactly
    }
  }

  It 'runs no plan that has a refusal' {
    $plan = @{ Refusals = @('no'); Warnings = @(); Steps = @() }
    { Invoke-RpaInstallPlan -Plan $plan -Parameters (New-TestParameters) -SourceDir $script:InstallerDir } |
      Should -Throw -ExpectedMessage 'The plan has refusals; nothing was changed.'
  }
}

Describe 'Get-RpaUninstallPlan' {
  BeforeAll {
    # What Get-RpaUninstallFacts says on a machine where rpa-runner is the bot user and no process of it is running.
    # Accounts are the recorded bot user, the accounts on the data directory's access rules and the owners of
    # everything in it; RunningSids are the owners of the processes that are running.
    function New-UninstallFacts([hashtable]$Change = @{}) {
      $facts = @{
        DataDir = $script:DataDir; DataDirState = New-PathState 'ours'
        Accounts = @(@{ Sid = $script:BotSid; Name = 'rpa-runner' }); RunningSids = @('S-1-5-18', 'S-1-5-21-1-2-3-500'); UnknownProcesses = @(); AutoSignInSid = $null
      }
      foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
      $facts
    }
  }

  It 'refuses -RemoveData while a process of the bot user is running' {
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts (New-UninstallFacts @{ RunningSids = @('S-1-5-18', $script:BotSid) })
    $plan.Refusals | Should -BeExactly @('rpa-runner is signed in. Sign rpa-runner out, then run Uninstall-Rpa.ps1 -RemoveData again.')
  }

  It 'without -RemoveData works as before while the bot user is signed in' {
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $false } -Facts (New-UninstallFacts @{ RunningSids = @($script:BotSid) })
    $plan.Refusals.Count | Should -Be 0
  }

  It 'takes -RemoveData when no process of the bot user is running' {
    (Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts (New-UninstallFacts)).Refusals.Count | Should -Be 0
  }

  # An account is the bot user by its SID: another account that has the same name now is not it.
  It 'matches accounts by SID, not by name' {
    $facts = New-UninstallFacts @{ Accounts = @(@{ Sid = $script:BotSid; Name = 'rpa-runner' }); RunningSids = @('S-1-5-21-9-9-9-1001') }
    (Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts).Refusals.Count | Should -Be 0
  }

  It 'refuses -RemoveData while a process of any account that owns something in the data directory is running' {
    $accounts = @(@{ Sid = $script:BotSid; Name = 'rpa-runner' }, @{ Sid = 'S-1-5-21-1-2-3-1002'; Name = 'mallory' }, @{ Sid = 'S-1-5-21-1-2-3-1003'; Name = 'bot2' })
    $facts = New-UninstallFacts @{ Accounts = $accounts; RunningSids = @('S-1-5-21-1-2-3-1002', 'S-1-5-21-1-2-3-1003', 'S-1-5-18') }
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts
    $plan.Refusals | Should -BeExactly @(
      'mallory is signed in. Sign mallory out, then run Uninstall-Rpa.ps1 -RemoveData again.'
      'bot2 is signed in. Sign bot2 out, then run Uninstall-Rpa.ps1 -RemoveData again.'
    )
  }

  # A process can take Administrators and SYSTEM off the access rules of its own token; Windows then tells nobody
  # which account it runs as. It may be the bot user's.
  It 'refuses -RemoveData while a process is running whose owner cannot be read' {
    $facts = New-UninstallFacts @{ UnknownProcesses = @('powershell (process 5184)') }
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts
    $plan.Refusals | Should -BeExactly @('The owner of powershell (process 5184) cannot be read; it may belong to an account that can change what is in C:\ProgramData\RPA Runner. End it, then run Uninstall-Rpa.ps1 -RemoveData again.')

    $facts = New-UninstallFacts @{ UnknownProcesses = @('powershell (process 5184)', 'cmd (process 77)', 'node (process 78)'); RunningSids = @($script:BotSid) }
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts
    $plan.Refusals | Should -BeExactly @(
      'rpa-runner is signed in. Sign rpa-runner out, then run Uninstall-Rpa.ps1 -RemoveData again.'
      'The owner of powershell (process 5184) cannot be read, nor that of 2 more processes; it may belong to an account that can change what is in C:\ProgramData\RPA Runner. End it, then run Uninstall-Rpa.ps1 -RemoveData again.'
    )
  }

  It 'does not mind such a process without -RemoveData, or when no account can change what is in the data directory' {
    $facts = New-UninstallFacts @{ UnknownProcesses = @('powershell (process 5184)') }
    (Get-RpaUninstallPlan -Parameters @{ RemoveData = $false } -Facts $facts).Refusals.Count | Should -Be 0
    $facts = New-UninstallFacts @{ UnknownProcesses = @('powershell (process 5184)'); Accounts = @() }
    (Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts).Refusals.Count | Should -Be 0
  }

  It 'reads the account of a process from the process itself' -Skip:($env:OS -ne 'Windows_NT') {
    InModuleScope RpaInstall {
      Add-RpaNativeTypes
      [RpaAccounts]::ProcessOwner($PID) | Should -BeExactly ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
      # The System process runs no program: its account is SYSTEM where Windows says so, and nobody's otherwise.
      @('', 'S-1-5-18') | Should -Contain ([RpaAccounts]::ProcessOwner(4))
      $owners = Get-RpaProcessOwners
      $owners.Sids | Should -Contain ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
      $owners.Sids | Should -Contain 'S-1-5-18'
    }
  }

  It 'names the RPA Supervisor when its session of the bot user is still there' {
    $facts = New-UninstallFacts @{ Accounts = @(@{ Sid = $script:BotSid; Name = 'rpa-runner'; Bot = $true }); RunningSids = @($script:BotSid); Unattended = $true }
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts
    $plan.Refusals | Should -BeExactly @("rpa-runner is signed in. Stop the RPA Supervisor, which signs its session of rpa-runner out (Stop-Service 'RPA Supervisor'), sign out any other session of rpa-runner, then run Uninstall-Rpa.ps1 -RemoveData again.")
  }

  It 'says how to get there when Windows signs the bot user in again by itself' {
    $facts = New-UninstallFacts @{ RunningSids = @($script:BotSid); AutoSignInSid = $script:BotSid }
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts
    $plan.Refusals | Should -BeExactly @(
      'rpa-runner is signed in. Sign rpa-runner out, then run Uninstall-Rpa.ps1 -RemoveData again.'
      'Automatic sign-in is on for rpa-runner, and Windows signs it in again after a sign-out. Run Uninstall-Rpa.ps1 without -RemoveData first, which turns that off; then sign rpa-runner out and run Uninstall-Rpa.ps1 -RemoveData from the unpacked package.'
    )
  }

  # Who owns what is inside cannot be read, and the removal would stop there.
  It 'refuses -RemoveData for a data directory that holds something the uninstaller cannot read, and names it' {
    $facts = New-UninstallFacts @{ DataDirUnreadable = @{ Path = 'C:\ProgramData\RPA Runner\exports\closed'; Owner = 'BOT-PC\rpa-runner' } }
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts
    $plan.Refusals | Should -BeExactly @('C:\ProgramData\RPA Runner\exports\closed exists and is owned by BOT-PC\rpa-runner. Check what is in it, remove it, and run Uninstall-Rpa.ps1 -RemoveData again.')
    (Get-RpaUninstallPlan -Parameters @{ RemoveData = $false } -Facts $facts).Refusals.Count | Should -Be 0
  }

  # The bot user can make such a folder: one that administrators cannot list. An entry that went away between the
  # listing and the read is noted the same way.
  It 'walks a data directory that holds a folder it cannot list without an error, and names the folder' -Skip:($env:OS -ne 'Windows_NT') {
    $dir = Join-Path $TestDrive ('walk-' + [guid]::NewGuid().ToString('N'))
    $closed = Join-Path (Join-Path $dir 'exports') 'closed'
    New-Item -ItemType Directory -Path $closed, (Join-Path $dir 'logs') | Out-Null
    Set-Content -LiteralPath (Join-Path $closed 'inside.txt') -Value 'x'
    Set-Content -LiteralPath (Join-Path (Join-Path $dir 'exports') 'beside.txt') -Value 'x'
    $icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'
    # No access rule at all: nobody may list it, administrators and SYSTEM included.
    & $icacls $closed /inheritance:r | Out-Null
    try {
      { [IO.Directory]::GetFileSystemEntries($closed) } | Should -Throw
      $entries = InModuleScope RpaInstall -Parameters @{ Dir = $dir } { Get-RpaDataEntries $Dir }
      $entries.Unreadable.Path | Should -BeExactly $closed
      $entries.Unreadable.Owner | Should -Not -BeNullOrEmpty
      $entries.Link | Should -BeNullOrEmpty
      $refusals = @(InModuleScope RpaInstall -Parameters @{ Dir = $dir; Entries = $entries } { Get-RpaDataEntryRefusals $Dir $Entries '' })
      $refusals | Should -Contain ('{0} exists and is owned by {1}. Check what is in it, remove it, and run the installer again.' -f $closed, $entries.Unreadable.Owner)
    } finally { & $icacls $closed /reset | Out-Null }
  }

  It 'refuses -RemoveData for a data directory that is a link or junction' {
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts (New-UninstallFacts @{ DataDirState = New-PathState 'link' })
    $plan.Refusals | Should -BeExactly @('C:\ProgramData\RPA Runner is a link or junction. Remove it and run this again.')
    (Get-RpaUninstallPlan -Parameters @{ RemoveData = $false } -Facts (New-UninstallFacts @{ DataDirState = New-PathState 'link' })).Refusals.Count | Should -Be 0
  }
}

Describe 'Invoke-RpaUninstall' {
  It 'runs no plan that has a refusal' {
    { Invoke-RpaUninstall -Plan @{ Refusals = @('no') } -RemoveData } | Should -Throw -ExpectedMessage 'The plan has refusals; nothing was changed.'
  }

  # The plan saw who was signed in before the programs were stopped; the look directly before the data directory goes
  # is the last refusal, and it comes before anything is removed.
  It 'with -RemoveData looks again before it removes anything, and removes nothing when the bot user has signed in' {
    Mock -ModuleName RpaInstall Get-RpaLayout { @{ InstallDir = 'C:\Program Files\RPA Runner'; InstallFile = (Join-Path $TestDrive 'none.json'); DataDir = 'C:\ProgramData\RPA Runner' } }
    Mock -ModuleName RpaInstall Stop-RpaServices { }
    Mock -ModuleName RpaInstall Resume-RpaServices { }
    Mock -ModuleName RpaInstall Remove-RpaTree { }
    Mock -ModuleName RpaInstall Unregister-RpaTask { }
    Mock -ModuleName RpaInstall Remove-RpaProgramFiles { }
    Mock -ModuleName RpaInstall Remove-RpaBrowserTemp { }
    Mock -ModuleName RpaInstall Get-RpaUninstallFacts {
      @{ DataDir = 'C:\ProgramData\RPA Runner'; DataDirState = @{ Exists = $true; IsLink = $false }; Accounts = @(@{ Sid = 'S-1-5-21-1-2-3-1001'; Name = 'rpa-runner' }); RunningSids = @('S-1-5-21-1-2-3-1001'); UnknownProcesses = @(); AutoSignInSid = $null }
    }
    $failure = $null
    try { Invoke-RpaUninstall -Plan @{ Refusals = @() } -RemoveData 6>$null } catch { $failure = $_.Exception }
    $failure.Message | Should -BeExactly 'rpa-runner is signed in. Sign rpa-runner out, then run Uninstall-Rpa.ps1 -RemoveData again.'
    $failure.Data['Refused'] | Should -BeTrue
    Should -Invoke -ModuleName RpaInstall Stop-RpaServices -Times 1 -Exactly
    Should -Invoke -ModuleName RpaInstall Resume-RpaServices -Times 1 -Exactly
    Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 0 -Exactly
    Should -Invoke -ModuleName RpaInstall Unregister-RpaTask -Times 0 -Exactly
    Should -Invoke -ModuleName RpaInstall Remove-RpaProgramFiles -Times 0 -Exactly
    Should -Invoke -ModuleName RpaInstall Remove-RpaBrowserTemp -Times 0 -Exactly
  }

  # The data directory's access rules name the bot user when install.json is gone, so the browser's temp folder is
  # looked for before the data directory goes.
  It 'removes the browser temp folder of the bot user on <Case>, before anything else is removed' -ForEach @(
    @{ Case = 'a plain uninstall'; RemoveData = $false; Order = 'browser-temp;' }
    @{ Case = 'an uninstall with -RemoveData'; RemoveData = $true; Order = 'browser-temp;C:\ProgramData\RPA Runner;' }
  ) {
    $env:RPA_TEST_ORDER = ''
    Mock -ModuleName RpaInstall Get-RpaLayout { @{ InstallDir = 'C:\Program Files\RPA Runner'; InstallFile = (Join-Path $TestDrive 'none.json'); DataDir = 'C:\ProgramData\RPA Runner' } }
    Mock -ModuleName RpaInstall Stop-RpaServices { }
    Mock -ModuleName RpaInstall Get-RpaUninstallFacts {
      @{ DataDir = 'C:\ProgramData\RPA Runner'; DataDirState = @{ Exists = $true; IsLink = $false }; Accounts = @(@{ Sid = 'S-1-5-21-1-2-3-1001'; Name = 'rpa-runner'; Bot = $true }); RunningSids = @('S-1-5-18'); UnknownProcesses = @(); AutoSignInSid = $null }
    }
    Mock -ModuleName RpaInstall Remove-RpaBrowserTemp { $env:RPA_TEST_ORDER += 'browser-temp;' }
    Mock -ModuleName RpaInstall Remove-RpaTree { $env:RPA_TEST_ORDER += $Path + ';' }
    # The steps after these remove the tasks and the firewall rules; the test ends at the first of them.
    Mock -ModuleName RpaInstall Unregister-RpaTask { throw 'the end of this test' }
    try {
      { Invoke-RpaUninstall -Plan @{ Refusals = @() } -RemoveData:$RemoveData 6>$null } | Should -Throw -ExpectedMessage 'the end of this test'
      $env:RPA_TEST_ORDER | Should -BeExactly $Order
      Should -Invoke -ModuleName RpaInstall Remove-RpaBrowserTemp -Times 1 -Exactly -ParameterFilter {
        @($Accounts).Count -eq 1 -and $Accounts[0].Sid -eq 'S-1-5-21-1-2-3-1001' -and (@($RunningSids) -join ',') -eq 'S-1-5-18' -and @($UnknownProcesses).Count -eq 0
      }
    } finally { $env:RPA_TEST_ORDER = $null }
  }
}

# The browser host keeps the browser server's temp folder in the bot user's local application data
# (%LOCALAPPDATA%\RPA Runner\browser-temp). A host that was ended without a chance to stop leaves a session's trace
# there, with what was typed into pages.
Describe 'What the browser left in the local application data of the bot user' {
  BeforeAll {
    $script:Bot = @{ Sid = $script:BotSid; Name = 'rpa-runner'; Bot = $true }
    # Stands for C:\Users\rpa-runner; a path that Join-Path takes on every platform.
    $script:Folders = @(Join-Path $TestDrive 'rpa-runner')
    $env:RPA_TEST_PROFILE = $script:Folders[0]
    foreach ($part in 'AppData', 'Local', 'RPA Runner') { $script:Folders += Join-Path $script:Folders[-1] $part }
    $script:Temp = $script:Folders[-1]
    function Invoke-RemoveBrowserTemp([object[]]$Accounts, [string[]]$RunningSids = @(), [object[]]$UnknownProcesses = @()) {
      # The comma keeps a list of one entry a list.
      , @(InModuleScope RpaInstall -Parameters @{ Accounts = $Accounts; RunningSids = $RunningSids; UnknownProcesses = $UnknownProcesses } {
          Remove-RpaBrowserTemp $Accounts $RunningSids $UnknownProcesses
        })
    }
  }
  AfterAll { $env:RPA_TEST_PROFILE = $null }

  Context 'what is removed and what is left' {
    BeforeEach {
      $env:RPA_TEST_LINK = ''
      $env:RPA_TEST_MISSING = ''
      $env:RPA_TEST_WRITABLE = ''
      Mock -ModuleName RpaInstall Get-RpaProfileFolder { if ($Sid -eq 'S-1-5-21-1-2-3-1001') { $env:RPA_TEST_PROFILE } }
      Mock -ModuleName RpaInstall Get-RpaPathState {
        @{ Exists = ($Path -ne $env:RPA_TEST_MISSING); IsLink = ($Path -eq $env:RPA_TEST_LINK); IsFolder = $true; Links = 1; OwnerTrusted = $false; Owner = 'BOT-PC\rpa-runner' }
      }
      Mock -ModuleName RpaInstall Get-RpaOtherWriters { if ($Path -eq $env:RPA_TEST_WRITABLE) { @('BOT-PC\mallory', 'BUILTIN\Users') } }
      Mock -ModuleName RpaInstall Remove-RpaTree { }
    }
    AfterEach { $env:RPA_TEST_LINK = $null; $env:RPA_TEST_MISSING = $null; $env:RPA_TEST_WRITABLE = $null }

    It 'removes RPA Runner in the local application data of the profile Windows records for the bot user' {
      $results = Invoke-RemoveBrowserTemp @($script:Bot) @('S-1-5-18')
      $results.Count | Should -Be 1
      $results[0].Path | Should -BeExactly $script:Temp
      $results[0].Name | Should -BeExactly 'rpa-runner'
      $results[0].Removed | Should -BeTrue
      # The folders from the profile folder down are held open while the tree is removed.
      Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 1 -Exactly -ParameterFilter { $Path -eq $script:Temp -and $From -eq $script:Folders[0] }
      # Who else may change each of the four folders, asked about the bot user.
      foreach ($folder in $script:Folders) {
        Should -Invoke -ModuleName RpaInstall Get-RpaOtherWriters -Times 1 -Exactly -ParameterFilter { $Path -eq $folder -and $Sid -eq 'S-1-5-21-1-2-3-1001' }
      }
    }

    # With no process of the bot user running, only another account that may change a folder on the way could put a
    # link in its place between the last look and the removal. The bot user can give another account that right.
    It 'removes nothing when someone other than the bot user, Administrators and SYSTEM owns folder <Index> or may change it, and names them' -ForEach @(@{ Index = 0 }, @{ Index = 1 }, @{ Index = 2 }, @{ Index = 3 }) {
      $env:RPA_TEST_WRITABLE = $script:Folders[$Index]
      $results = Invoke-RemoveBrowserTemp @($script:Bot)
      $results[0].Removed | Should -BeFalse
      $results[0].Why | Should -BeExactly ('{0} is owned or may be changed by BOT-PC\mallory, BUILTIN\Users, not only by rpa-runner, Administrators and SYSTEM, so nothing was removed there. Check who may change it and remove the folder.' -f $script:Folders[$Index])
      Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 0 -Exactly
    }

    It 'leaves it while a process of the bot user is running, and says so' {
      $results = Invoke-RemoveBrowserTemp @($script:Bot) @('S-1-5-18', $script:BotSid)
      $results[0].Removed | Should -BeFalse
      $results[0].Why | Should -BeExactly 'rpa-runner is signed in. Sign rpa-runner out, then run Uninstall-Rpa.ps1 -RemoveData from the unpacked package, which removes it, or remove the folder.'
      Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 0 -Exactly
    }

    It 'leaves it while a process is running whose owner cannot be read' {
      $results = Invoke-RemoveBrowserTemp @($script:Bot) @('S-1-5-18') @('powershell (process 5184)')
      $results[0].Removed | Should -BeFalse
      $results[0].Why | Should -BeExactly 'The owner of powershell (process 5184) cannot be read; it may be a process of rpa-runner. End it, then run Uninstall-Rpa.ps1 -RemoveData from the unpacked package, which removes it, or remove the folder.'
      Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 0 -Exactly
    }

    # The folders belong to the bot user, which can put a link in the place of any of them.
    It 'looks at each folder on the way directly before the removal: removes nothing when folder <Index> is a link or junction, and names it' -ForEach @(@{ Index = 0 }, @{ Index = 1 }, @{ Index = 2 }, @{ Index = 3 }) {
      $env:RPA_TEST_LINK = $script:Folders[$Index]
      $results = Invoke-RemoveBrowserTemp @($script:Bot)
      $results[0].Removed | Should -BeFalse
      $results[0].Why | Should -BeExactly ('{0} is not a folder of its own (it is a link, a junction or a file), so nothing was removed there. Check it and remove the folder.' -f $script:Folders[$Index])
      Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 0 -Exactly
    }

    It 'removes nothing when a folder on the way is a file' {
      Mock -ModuleName RpaInstall Get-RpaPathState { @{ Exists = $true; IsLink = $false; IsFolder = ($Path -ne $env:RPA_TEST_LINK); Links = 1; OwnerTrusted = $false; Owner = 'BOT-PC\rpa-runner' } }
      $env:RPA_TEST_LINK = $script:Folders[2]
      $results = Invoke-RemoveBrowserTemp @($script:Bot)
      $results[0].Removed | Should -BeFalse
      $results[0].Why | Should -BeExactly ('{0} is not a folder of its own (it is a link, a junction or a file), so nothing was removed there. Check it and remove the folder.' -f $script:Folders[2])
      Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 0 -Exactly
    }

    # While the bot user has a process running, that process could change the folders after any look at them.
    It 'does not judge the folders while a process of the bot user is running: it leaves the folder for that reason' {
      $env:RPA_TEST_LINK = $script:Folders[2]
      $results = Invoke-RemoveBrowserTemp @($script:Bot) @($script:BotSid)
      $results[0].Why | Should -BeLike 'rpa-runner is signed in.*'
      Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 0 -Exactly
    }

    It 'says so when the folder could not be removed' {
      Mock -ModuleName RpaInstall Remove-RpaTree { throw ('Could not remove {0}. Close what is using it and run this again.' -f $Path) }
      $results = Invoke-RemoveBrowserTemp @($script:Bot)
      $results[0].Removed | Should -BeFalse
      $results[0].Why | Should -BeExactly ('Could not remove {0}. Close what is using it and run this again.' -f $script:Temp)
    }

    It 'does nothing for <Case>' -ForEach @(
      @{ Case = 'an account that is not the bot user'; Accounts = @(@{ Sid = 'S-1-5-21-1-2-3-1001'; Name = 'rpa-runner'; Bot = $false }); Missing = -1 }
      @{ Case = 'a bot user without a profile on this machine'; Accounts = @(@{ Sid = 'S-1-5-21-1-2-3-1002'; Name = 'bot2'; Bot = $true }); Missing = -1 }
      @{ Case = 'a profile without the folder'; Accounts = @(@{ Sid = 'S-1-5-21-1-2-3-1001'; Name = 'rpa-runner'; Bot = $true }); Missing = 3 }
      @{ Case = 'no account'; Accounts = @(); Missing = -1 }
    ) {
      if ($Missing -ge 0) { $env:RPA_TEST_MISSING = $script:Folders[$Missing] }
      (Invoke-RemoveBrowserTemp $Accounts).Count | Should -Be 0
      Should -Invoke -ModuleName RpaInstall Remove-RpaTree -Times 0 -Exactly
    }
  }

  It 'on Windows: removes the folder with a junction in it and not what the junction points at; with a junction on the way, removes nothing' -Skip:($env:OS -ne 'Windows_NT') {
    $root = Join-Path $TestDrive ('profile-' + [guid]::NewGuid().ToString('N'))
    $userFolder = Join-Path $root 'bot'
    $local = Join-Path (Join-Path $userFolder 'AppData') 'Local'
    $temp = Join-Path (Join-Path $local 'RPA Runner') 'browser-temp'
    $elsewhere = Join-Path $root 'elsewhere'
    New-Item -ItemType Directory -Path $temp, (Join-Path $elsewhere 'RPA Runner') | Out-Null
    Set-Content -LiteralPath (Join-Path $temp 'trace.zip') -Value 'x'
    Set-Content -LiteralPath (Join-Path $elsewhere 'canary.txt') -Value 'x'
    Set-Content -LiteralPath (Join-Path (Join-Path $elsewhere 'RPA Runner') 'canary.txt') -Value 'x'
    $cmd = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    & $cmd /d /c ('mklink /J "{0}" "{1}"' -f (Join-Path $temp 'link'), $elsewhere) | Out-Null
    Mock -ModuleName RpaInstall Get-RpaProfileFolder { $env:RPA_TEST_PROFILE }
    $before = $env:RPA_TEST_PROFILE
    $env:RPA_TEST_PROFILE = $userFolder
    try {
      $results = Invoke-RemoveBrowserTemp @($script:Bot)
      $results[0].Removed | Should -BeTrue
      Join-Path $local 'RPA Runner' | Should -Not -Exist
      $local | Should -Exist
      Join-Path $elsewhere 'canary.txt' | Should -Exist

      # Local application data that is a junction to another place which holds a folder named RPA Runner.
      & $cmd /d /c ('rd "{0}"' -f $local) | Out-Null
      & $cmd /d /c ('mklink /J "{0}" "{1}"' -f $local, $elsewhere) | Out-Null
      $results = Invoke-RemoveBrowserTemp @($script:Bot)
      $results[0].Removed | Should -BeFalse
      $results[0].Why | Should -BeExactly ('{0} is not a folder of its own (it is a link, a junction or a file), so nothing was removed there. Check it and remove the folder.' -f $local)
      Join-Path (Join-Path $elsewhere 'RPA Runner') 'canary.txt' | Should -Exist
    } finally {
      $env:RPA_TEST_PROFILE = $before
      & $cmd /d /c ('rd "{0}"' -f $local) 2>$null | Out-Null
    }
  }

  It 'on Windows: names who other than the bot user, Administrators and SYSTEM owns a folder or may change it' -Skip:($env:OS -ne 'Windows_NT') {
    $dir = Join-Path $TestDrive ('writers-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'
    # The account that runs the test stands for the bot user, Guests for another account.
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $guests = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-546').Translate([Security.Principal.NTAccount]).Value
    function Get-Writers { @(InModuleScope RpaInstall -Parameters @{ Dir = $dir; Sid = $me } { Get-RpaOtherWriters $Dir $Sid }) }
    # As in a profile: the user, Administrators and SYSTEM, nothing inherited. Reading, and a rule that applies only
    # to what is created inside the folder, do not count.
    & $icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${me}:(OI)(CI)F" | Out-Null
    & $icacls $dir /grant '*S-1-5-32-546:(RX)' | Out-Null
    & $icacls $dir /grant '*S-1-5-32-546:(OI)(CI)(IO)(M)' | Out-Null
    Get-Writers | Should -BeNullOrEmpty
    & $icacls $dir /grant '*S-1-5-32-546:(AD)' | Out-Null
    Get-Writers | Should -BeExactly @($guests)
    & $icacls $dir /remove:g '*S-1-5-32-546' | Out-Null
    Get-Writers | Should -BeNullOrEmpty
    & $icacls $dir /setowner '*S-1-5-32-546' | Out-Null
    Get-Writers | Should -BeExactly @($guests)
  }

  It 'on Windows: finds the profile folder of an account by its SID, and none for an account without one' -Skip:($env:OS -ne 'Windows_NT') {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    InModuleScope RpaInstall -Parameters @{ Sid = $sid } { Get-RpaProfileFolder $Sid } | Should -Be $env:USERPROFILE.TrimEnd('\')
    InModuleScope RpaInstall { Get-RpaProfileFolder 'S-1-5-21-1-2-3-1001' } | Should -BeNullOrEmpty
  }

  # After an uninstall that kept the data directory install.json is gone; the directory's access rules still name
  # the bot user.
  It 'on Windows: the bot user is the recorded user, or without a record whoever the access rules of the data directory name' -Skip:($env:OS -ne 'Windows_NT') {
    $dir = Join-Path $TestDrive ('data-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    # Guests stands for the bot user of an earlier install.
    & (Join-Path ([Environment]::SystemDirectory) 'icacls.exe') $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-546:(OI)(CI)RX' | Out-Null
    $accounts = @(InModuleScope RpaInstall -Parameters @{ Dir = $dir } { Get-RpaDataAccounts @{ DataDir = $Dir } $null (Get-RpaDataEntries $Dir) })
    @($accounts | Where-Object { $_.Sid -eq 'S-1-5-32-546' })[0].Bot | Should -BeTrue

    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    $install = New-Object psobject -Property @{ user = $me.Name }
    $accounts = @(InModuleScope RpaInstall -Parameters @{ Dir = $dir; Install = $install } { Get-RpaDataAccounts @{ DataDir = $Dir } $Install (Get-RpaDataEntries $Dir) })
    @($accounts | Where-Object { $_.Sid -eq $me.User.Value })[0].Bot | Should -BeTrue
    @($accounts | Where-Object { $_.Sid -eq 'S-1-5-32-546' })[0].Bot | Should -BeFalse
  }
}

# The installer removes, as an administrator, trees that other accounts may write into (the bot user's temp folder,
# the data directory). Remove-RpaTree holds the folders from -From down to the one it removes open without delete
# sharing, opens each entry without following a link, and deletes through handles.
Describe 'Remove-RpaTree' {
  BeforeAll {
    $script:Cmd = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    function Invoke-RemoveTree([string]$Path, [string]$From, [scriptblock]$BeforeOpen) {
      InModuleScope RpaInstall -Parameters @{ Path = $Path; From = $From; BeforeOpen = $BeforeOpen } { Remove-RpaTree $Path $From $BeforeOpen }
    }
    function New-Folder([string]$Path) { [void][IO.Directory]::CreateDirectory('\\?\' + $Path); $Path }
    function New-TestBase([string]$Name) { New-Folder (Join-Path $TestDrive ($Name + '-' + [guid]::NewGuid().ToString('N'))) }
    # A folder outside the tree with files in it, which nothing may delete.
    function New-Victim([string]$Path) {
      New-Folder (Join-Path $Path 'sub') | Out-Null
      Set-Content -LiteralPath (Join-Path $Path 'a.txt') -Value 'a'
      Set-Content -LiteralPath (Join-Path (Join-Path $Path 'sub') 'b.txt') -Value 'b'
      $Path
    }
    # Every file under a folder with its content, in one text.
    function Get-Contents([string]$Path) {
      @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File | Sort-Object FullName | ForEach-Object { '{0}={1}' -f $_.FullName.Substring($Path.Length), (Get-Content -Raw -LiteralPath $_.FullName).Trim() }) -join ';'
    }
    function Get-Failure([scriptblock]$Script) { try { & $Script; $null } catch { $_.Exception.Message } }
  }

  It 'refuses a folder that is not inside the folder to hold from' {
    { Invoke-RemoveTree (Join-Path $TestDrive 'a') (Join-Path $TestDrive 'b') $null } | Should -Throw -ExpectedMessage ('{0} is not inside {1}.' -f (Join-Path $TestDrive 'a'), (Join-Path $TestDrive 'b'))
  }

  # Each name below the folder to hold from is opened inside the folder above it; an empty name would open that one.
  It 'refuses a path with an empty name, . or .. below the folder to hold from: <Below>' -ForEach @(@{ Below = 'a\\b' }, @{ Below = 'a\.\b' }, @{ Below = 'a\..\b' }) {
    $from = 'C:\Users\bot'
    { Invoke-RemoveTree ('{0}\{1}' -f $from, $Below) $from $null } | Should -Throw -ExpectedMessage ('{0}\{1} is not inside {0}.' -f $from, $Below)
  }

  # The attributes belong to the file, not to one of its names: clearing read-only on a second name would change the
  # file outside the tree.
  It 'on Windows: leaves a read-only file that has another name outside the tree, and changes nothing on it' -Skip:($env:OS -ne 'Windows_NT') {
    $base = New-TestBase 'hardlink'
    $victim = New-Victim (Join-Path $base 'victim')
    $outside = Join-Path $victim 'a.txt'
    (Get-Item -LiteralPath $outside).Attributes = 'ReadOnly'
    $root = New-Folder (Join-Path $base 'root')
    $link = Join-Path $root 'second-name.txt'
    & $script:Cmd /d /c ('mklink /H "{0}" "{1}"' -f $link, $outside) | Out-Null
    # Making the second name sets Archive.
    $attributes = (Get-Item -LiteralPath $outside).Attributes
    [bool]($attributes -band [IO.FileAttributes]::ReadOnly) | Should -BeTrue
    Set-Content -LiteralPath (Join-Path $root 'other.txt') -Value 'x'
    $failure = Get-Failure { Invoke-RemoveTree $root $root $null }
    $failure | Should -BeExactly ('Could not remove {0} (it is read-only and has another name (a hard link), so its attributes were not changed). Close what is using it and run this again.' -f $link)
    (Get-Item -LiteralPath $outside).Attributes | Should -Be $attributes
    Join-Path $root 'other.txt' | Should -Not -Exist
    (Get-Item -LiteralPath $outside).Attributes = 'Normal'
  }

  It 'on Windows: an entry that goes away between the listing and its opening is not counted as left' -Skip:($env:OS -ne 'Windows_NT') {
    $root = New-TestBase 'gone'
    Set-Content -LiteralPath (Join-Path $root 'goes.txt') -Value 'x'
    Set-Content -LiteralPath (Join-Path $root 'stays.txt') -Value 'x'
    $hook = { param($entry) if ((Split-Path -Leaf $entry) -eq 'goes.txt') { [IO.File]::Delete($entry) } }
    Invoke-RemoveTree $root $root $hook
    $root | Should -Not -Exist
  }

  It 'on Windows: removes a junction, a folder symbolic link and a file symbolic link in the tree as links, and what they point at keeps every file' -Skip:($env:OS -ne 'Windows_NT') {
    $base = New-TestBase 'links'
    $victim = New-Victim (Join-Path $base 'victim')
    $root = New-Folder (Join-Path $base 'root')
    New-Folder (Join-Path $root 'sub\deeper') | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'sub\deeper\trace.zip') -Value 'x'
    $links = @((Join-Path $root 'sub\junction'), (Join-Path $root 'folder-link'), (Join-Path $root 'file-link'))
    & $script:Cmd /d /c ('mklink /J "{0}" "{1}"' -f $links[0], $victim) | Out-Null
    & $script:Cmd /d /c ('mklink /D "{0}" "{1}"' -f $links[1], $victim) | Out-Null
    & $script:Cmd /d /c ('mklink "{0}" "{1}"' -f $links[2], (Join-Path $victim 'a.txt')) | Out-Null
    foreach ($link in $links) { [bool]((Get-Item -LiteralPath $link -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) | Should -BeTrue }
    $before = Get-Contents $victim
    $before | Should -BeExactly '\a.txt=a;\sub\b.txt=b'
    Invoke-RemoveTree $root $root $null
    $root | Should -Not -Exist
    Get-Contents $victim | Should -BeExactly $before
  }

  It 'on Windows: a folder and a file swapped for links between the listing and their opening are removed as links; what the links point at keeps every file' -Skip:($env:OS -ne 'Windows_NT') {
    $base = New-TestBase 'swap'
    $victim = New-Victim (Join-Path $base 'victim')
    $root = New-Folder (Join-Path $base 'root')
    New-Folder (Join-Path $root 'swap') | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'swap\inside.txt') -Value 'x'
    Set-Content -LiteralPath (Join-Path $root 'swap-file.txt') -Value 'x'
    $before = Get-Contents $victim
    $cmd = $script:Cmd
    $swapped = @{}
    # Runs between the listing of a folder and the opening of each entry: another process (cmd) deletes the entry and
    # puts a link to the victim in its place. (What cmd writes to its error stream must not end the hook.)
    $hook = {
      param($entry)
      $ErrorActionPreference = 'Continue'
      $name = Split-Path -Leaf $entry
      if ($name -eq 'swap') {
        & $cmd /d /c ('rd /s /q "{0}" && mklink /J "{0}" "{1}"' -f $entry, $victim) 2>&1 | Out-Null
        $swapped[$name] = $LASTEXITCODE
      } elseif ($name -eq 'swap-file.txt') {
        & $cmd /d /c ('del /f /q "{0}" && mklink "{0}" "{1}"' -f $entry, (Join-Path $victim 'a.txt')) 2>&1 | Out-Null
        $swapped[$name] = $LASTEXITCODE
      }
    }.GetNewClosure()
    Invoke-RemoveTree $root $root $hook
    $swapped['swap'] | Should -Be 0
    $swapped['swap-file.txt'] | Should -Be 0
    $root | Should -Not -Exist
    Get-Contents $victim | Should -BeExactly $before
  }

  It 'on Windows: while the tree is removed another process can rename neither the folder removed nor a folder held above it, and afterwards it can' -Skip:($env:OS -ne 'Windows_NT') {
    $base = New-TestBase 'held'
    $top = New-Folder (Join-Path $base 'top')
    $root = New-Folder (Join-Path $top 'middle\root')
    Set-Content -LiteralPath (Join-Path $root 'file.txt') -Value 'x'
    $cmd = $script:Cmd
    $renames = [ordered]@{}
    $hook = {
      param($entry)
      # What cmd writes to its error stream is what this test reads; it must not end the hook.
      $ErrorActionPreference = 'Continue'
      if ($renames.Count -gt 0) { return }
      foreach ($folder in $root, (Split-Path $root), $top) {
        $said = (& $cmd /d /c ('ren "{0}" renamed' -f $folder) 2>&1 | ForEach-Object { "$_" }) -join ' '
        $renames[$folder] = 'exit {0}: {1}' -f $LASTEXITCODE, $said.Trim()
      }
    }.GetNewClosure()
    Invoke-RemoveTree $root $top $hook
    $renames.Count | Should -Be 3
    foreach ($folder in @($renames.Keys)) { $renames[$folder] | Should -BeExactly 'exit 1: The process cannot access the file because it is being used by another process.' }
    $root | Should -Not -Exist
    & $cmd /d /c ('ren "{0}" renamed' -f (Split-Path $root)) | Out-Null
    $LASTEXITCODE | Should -Be 0
    & $cmd /d /c ('ren "{0}" renamed' -f $top) | Out-Null
    $LASTEXITCODE | Should -Be 0
  }

  It 'on Windows: stops with the text when another process holds <What> with delete access, and removes nothing through it' -Skip:($env:OS -ne 'Windows_NT') -ForEach @(
    @{ What = 'a folder in the tree'; Inside = $true }
    @{ What = 'a folder held above the one removed'; Inside = $false }
  ) {
    $base = New-TestBase 'busy'
    $top = New-Folder (Join-Path $base 'top')
    $root = New-Folder (Join-Path $top 'way\root')
    New-Folder (Join-Path $root 'busy') | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'busy\inside.txt') -Value 'x'
    Set-Content -LiteralPath (Join-Path $root 'other.txt') -Value 'x'
    if ($Inside) { $held = Join-Path $root 'busy' } else { $held = Split-Path $root }
    # Another Windows PowerShell opens the folder with delete access and every kind of sharing, as a process that
    # means to rename it would, and holds it until told to stop.
    $holder = Join-Path $base 'hold.ps1'
    Set-Content -LiteralPath $holder -Value @'
param([string]$Folder, [string]$Signal)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public static class RpaTestHold { [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template); }'
$handle = [RpaTestHold]::CreateFile('\\?\' + $Folder, 0x10001, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
if ($handle.IsInvalid) { exit 2 }
Set-Content -LiteralPath "$Signal.ready" -Value 'x'
while (-not (Test-Path -LiteralPath "$Signal.stop")) { Start-Sleep -Milliseconds 100 }
$handle.Dispose()
'@
    $signal = Join-Path $base 'signal'
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $process = Start-Process -FilePath $powershell -WindowStyle Hidden -PassThru -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" "{1}" "{2}"' -f $holder, $held, $signal)
    try {
      for ($i = 0; $i -lt 300 -and -not (Test-Path -LiteralPath "$signal.ready") -and -not $process.HasExited; $i++) { Start-Sleep -Milliseconds 100 }
      "$signal.ready" | Should -Exist
      $failure = Get-Failure { Invoke-RemoveTree $root $top $null }
    } finally {
      Set-Content -LiteralPath "$signal.stop" -Value 'x'
      if (-not $process.WaitForExit(30000)) { Stop-Process -Id $process.Id -Force }
    }
    $busy = 'The process cannot access the file because it is being used by another process'
    if ($Inside) {
      $failure | Should -BeExactly ('Could not remove {0} ({1}). Close what is using it and run this again.' -f $held, $busy)
      Join-Path $root 'busy\inside.txt' | Should -Exist
      # The rest of the tree went in the same pass.
      Join-Path $root 'other.txt' | Should -Not -Exist
    } else {
      $failure | Should -BeExactly ('Could not remove {0}: {1} could not be opened ({2}). Close what is using it and run this again.' -f $root, $held, $busy)
      # Nothing was deleted.
      Join-Path $root 'busy\inside.txt' | Should -Exist
      Join-Path $root 'other.txt' | Should -Exist
    }
  }

  It 'on Windows: removes <What>' -Skip:($env:OS -ne 'Windows_NT') -ForEach @(
    @{ What = 'a read-only file'; Make = { param($root) $file = Join-Path $root 'read-only.txt'; Set-Content -LiteralPath $file -Value 'x'; (Get-Item -LiteralPath $file).Attributes = 'ReadOnly' } }
    @{ What = 'a hidden file'; Make = { param($root) $file = Join-Path $root 'hidden.txt'; Set-Content -LiteralPath $file -Value 'x'; (Get-Item -LiteralPath $file).Attributes = 'Hidden' } }
    @{ What = 'a read-only folder with a file in it'; Make = { param($root) $folder = New-Item -ItemType Directory -Path (Join-Path $root 'folder'); Set-Content -LiteralPath (Join-Path $folder.FullName 'file.txt') -Value 'x'; $folder.Attributes = $folder.Attributes -bor [IO.FileAttributes]::ReadOnly } }
    @{ What = 'a hidden folder with a read-only file in it'; Make = { param($root) $folder = New-Item -ItemType Directory -Path (Join-Path $root 'hidden'); $file = Join-Path $folder.FullName 'file.txt'; Set-Content -LiteralPath $file -Value 'x'; (Get-Item -LiteralPath $file).Attributes = 'ReadOnly, Hidden'; $folder.Attributes = $folder.Attributes -bor [IO.FileAttributes]::Hidden } }
    @{ What = 'a path longer than 260 characters'; Make = { param($root) $long = $root; while ($long.Length -le 300) { $long = Join-Path $long ('x' * 40) }; [void][IO.Directory]::CreateDirectory('\\?\' + $long); [IO.File]::WriteAllText('\\?\' + (Join-Path $long 'deep.txt'), 'x') } }
    @{ What = 'an empty tree'; Make = { param($root) } }
  ) {
    $root = New-TestBase 'kinds'
    & $Make $root
    Invoke-RemoveTree $root $root $null
    [IO.Directory]::Exists('\\?\' + $root) | Should -BeFalse
  }

  It 'on Windows: leaves a folder more than 128 folders below the one removed, names it, and removes the rest' -Skip:($env:OS -ne 'Windows_NT') {
    $root = New-TestBase 'deep'
    $deep = $root
    for ($i = 1; $i -le 129; $i++) { $deep = Join-Path $deep 'd' }
    New-Folder $deep | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'other.txt') -Value 'x'
    try {
      $failure = Get-Failure { Invoke-RemoveTree $root $root $null }
      $failure | Should -BeExactly ('Could not remove {0} (it is more than 128 folders below {1}). Close what is using it and run this again.' -f $deep, $root)
      [IO.Directory]::Exists('\\?\' + $deep) | Should -BeTrue
      Join-Path $root 'other.txt' | Should -Not -Exist
    } finally { & $script:Cmd /d /c ('rd /s /q "\\?\{0}"' -f $root) | Out-Null }
  }
}

Describe 'What the uninstaller reports' {
  BeforeAll {
    function New-UninstallResult([hashtable]$Change = @{}) {
      $result = @{
        User = 'rpa-runner'; UserKept = $true; AutoSignIn = $true; SignInKept = $false; SignInFailed = $false; HadChanges = $true; NotRestored = @()
        LeftoversFile = $null; LeftoversProblem = $null; DataRemoved = $false; DataKept = $true; BrowserTemp = @()
        Layout = @{ InstallDir = 'C:\Program Files\RPA Runner'; DataDir = $script:DataDir; LeftoversFile = 'C:\Program Files\RPA Runner\uninstall-leftovers.json' }
      }
      foreach ($key in $Change.Keys) { $result[$key] = $Change[$key] }
      $result
    }
    function Get-Summary([hashtable]$Result) { @(InModuleScope RpaInstall -Parameters @{ Result = $Result } { Get-RpaUninstallSummary $Result }) }
  }

  It 'says that the settings are back when all of them were put back' {
    $lines = Get-Summary (New-UninstallResult)
    $lines[0] | Should -BeExactly 'RPA is removed.'
    $lines | Should -Contain '  Automatic sign-in of rpa-runner is off and the stored password is removed.'
    $lines | Should -Contain '  The settings -AutoSignIn changed are back to what they were before.'
  }

  # Automatic sign-in names another user by now: the sign-in values and the stored password were not touched.
  It 'says only what was put back when it left automatic sign-in as it is' {
    $lines = Get-Summary (New-UninstallResult @{ SignInKept = $true })
    $lines | Should -Contain '  Automatic sign-in now names another user, so it and the stored password were left as they are.'
    $lines | Should -Contain '  The other settings -AutoSignIn changed are back to what they were before.'
    $lines | Should -Not -Contain '  The settings -AutoSignIn changed are back to what they were before.'
    ($lines -join "`n") | Should -Not -Match 'is off and the stored password is removed'
  }

  It 'does not say that automatic sign-in is off when one of its settings could not be put back' {
    $failed = 'the password stored for automatic sign-in (it is still stored): Access is denied.'
    $lines = Get-Summary (New-UninstallResult @{ SignInFailed = $true; NotRestored = @($failed); LeftoversFile = 'C:\Program Files\RPA Runner\uninstall-leftovers.json' })
    ($lines -join "`n") | Should -Not -Match 'is off and the stored password is removed'
    ($lines -join "`n") | Should -Not -Match 'are back to what they were before'
    $lines | Should -Contain '  Automatic sign-in of rpa-runner could not be turned off completely: see the list below.'
    $lines | Should -Contain "    $failed"
  }

  It 'lists what could not be put back and says where the list is kept, whether or not the data directory was removed' {
    $failed = 'registry HKLM\SOFTWARE\Example A (it was REG_SZ ""): Access is denied.'
    foreach ($removed in $false, $true) {
      $lines = Get-Summary (New-UninstallResult @{ NotRestored = @($failed); LeftoversFile = 'C:\Program Files\RPA Runner\uninstall-leftovers.json'; DataRemoved = $removed; DataKept = (-not $removed) })
      $lines | Should -Contain '  Of the settings -AutoSignIn changed, these could not be put back:'
      $lines | Should -Contain "    $failed"
      $lines | Should -Contain '  This list, with what each setting was before, is kept in C:\Program Files\RPA Runner\uninstall-leftovers.json,'
      ($lines -join "`n") | Should -Not -Match 'not kept'
    }
  }

  It 'says so when the list could not be kept' {
    $lines = Get-Summary (New-UninstallResult @{ NotRestored = @('x: y'); LeftoversProblem = 'the reason' })
    $lines | Should -Contain '  This list could not be kept in C:\Program Files\RPA Runner\uninstall-leftovers.json: the reason'
  }

  It 'says what a later install does with a data directory that is kept, and names what was removed' {
    $lines = Get-Summary (New-UninstallResult @{ AutoSignIn = $false; HadChanges = $false })
    $lines | Should -Contain '  Kept:      C:\ProgramData\RPA Runner (remove it with -RemoveData)'
    ($lines -join ' ') | Should -Match 'A later install for rpa-runner takes it over when everything in it belongs to Administrators,\s+SYSTEM or rpa-runner'
    $lines | Should -Contain '  Kept:      the Windows user rpa-runner'
    $lines = Get-Summary (New-UninstallResult @{ AutoSignIn = $false; HadChanges = $false; DataRemoved = $true; DataKept = $false })
    $lines | Should -Contain '  Removed:   C:\ProgramData\RPA Runner'
    ($lines -join "`n") | Should -Not -Match 'A later install'
  }

  It 'names the temp folder of the browser that it removed from the profile of the bot user' {
    $temp = @{ Path = 'C:\Users\rpa-runner\AppData\Local\RPA Runner'; Name = 'rpa-runner'; Removed = $true; Why = '' }
    $lines = Get-Summary (New-UninstallResult @{ AutoSignIn = $false; HadChanges = $false; BrowserTemp = @($temp) })
    $lines | Should -Contain "  Removed:   C:\Users\rpa-runner\AppData\Local\RPA Runner (the browser's temp folder of rpa-runner)"
    ($lines -join "`n") | Should -Not -Match 'typed into pages'
  }

  It 'says why it left that folder, what it can hold and what to do' {
    $why = 'rpa-runner is signed in. Sign rpa-runner out, then run Uninstall-Rpa.ps1 -RemoveData from the unpacked package, which removes it, or remove the folder.'
    $temp = @{ Path = 'C:\Users\rpa-runner\AppData\Local\RPA Runner'; Name = 'rpa-runner'; Removed = $false; Why = $why }
    $lines = Get-Summary (New-UninstallResult @{ AutoSignIn = $false; HadChanges = $false; BrowserTemp = @($temp) })
    $lines | Should -Contain "  Kept:      C:\Users\rpa-runner\AppData\Local\RPA Runner (the browser's temp folder of rpa-runner; it can hold"
    $lines | Should -Contain '             what was typed into pages).'
    $lines | Should -Contain "             $why"
  }

  It 'does not say that it kept a Windows user that is no longer there' {
    $lines = Get-Summary (New-UninstallResult @{ AutoSignIn = $false; HadChanges = $false; UserKept = $false })
    ($lines -join "`n") | Should -Not -Match 'the Windows user'
  }
}

Describe 'What the uninstaller could not put back' {
  BeforeAll {
    function New-TestFailure([string]$Name, $Value) {
      $change = New-Object psobject -Property ([ordered]@{ kind = 'registry'; key = 'HKLM\SOFTWARE\Example'; name = $Name; existed = $true; type = 'REG_SZ'; value = $Value })
      @{ Change = $change; Text = "registry HKLM\SOFTWARE\Example $Name (it was REG_SZ `"$Value`"): Access is denied." }
    }
  }

  It 'lists each setting with what it was before, why it was not put back, for which user and when' {
    $failed = @((New-TestFailure 'A' ''), @{ Change = $null; Text = 'The registry of the user could not be closed.' })
    $list = InModuleScope RpaInstall -Parameters @{ Failed = $failed } { Add-RpaLeftovers $null $Failed 'rpa-runner' '2026-11-09 10:00:00 UTC' }
    $read = ConvertTo-Json -InputObject $list -Depth 6 | ConvertFrom-Json
    $read.note | Should -Not -BeNullOrEmpty
    @($read.notPutBack).Count | Should -Be 2
    $first = $read.notPutBack[0]
    $first.kind | Should -BeExactly 'registry'
    $first.key | Should -BeExactly 'HKLM\SOFTWARE\Example'
    $first.name | Should -BeExactly 'A'
    $first.existed | Should -BeTrue
    $first.type | Should -BeExactly 'REG_SZ'
    $first.value | Should -BeExactly ''
    $first.reason | Should -BeExactly 'registry HKLM\SOFTWARE\Example A (it was REG_SZ ""): Access is denied.'
    $first.user | Should -BeExactly 'rpa-runner'
    $first.at | Should -BeExactly '2026-11-09 10:00:00 UTC'
    $read.notPutBack[1].kind | Should -BeExactly 'other'
    $read.notPutBack[1].reason | Should -BeExactly 'The registry of the user could not be closed.'
  }

  It 'keeps what an earlier uninstall listed, and the first record of a setting that is listed again' {
    $earlier = InModuleScope RpaInstall -Parameters @{ Failed = @(New-TestFailure 'A' 'the first value') } { Add-RpaLeftovers $null $Failed 'rpa-runner' '2026-11-09 10:00:00 UTC' }
    $earlier = ConvertTo-Json -InputObject $earlier -Depth 6 | ConvertFrom-Json
    $failed = @((New-TestFailure 'A' 'a later value'), (New-TestFailure 'B' 'b'))
    $list = InModuleScope RpaInstall -Parameters @{ Earlier = $earlier; Failed = $failed } { Add-RpaLeftovers $Earlier $Failed 'bot2' '2026-11-10 10:00:00 UTC' }
    $read = ConvertTo-Json -InputObject $list -Depth 6 | ConvertFrom-Json
    @($read.notPutBack | ForEach-Object { $_.name }) | Should -BeExactly @('A', 'B')
    $read.notPutBack[0].value | Should -BeExactly 'the first value'
    $read.notPutBack[0].at | Should -BeExactly '2026-11-09 10:00:00 UTC'
    $read.notPutBack[1].user | Should -BeExactly 'bot2'
  }

  It 'names a setting with what it was before: <Text>' -ForEach @(
    @{ Change = @{ kind = 'registry'; key = 'HKLM\S'; name = 'N'; existed = $true; type = 'REG_SZ'; value = '' }; Text = 'registry HKLM\S N (it was REG_SZ "")' }
    @{ Change = @{ kind = 'registry'; key = 'HKLM\S'; name = 'N'; existed = $true; type = 'REG_DWORD'; value = '1' }; Text = 'registry HKLM\S N (it was REG_DWORD "1")' }
    @{ Change = @{ kind = 'registry'; key = 'HKLM\S'; name = 'N'; existed = $false }; Text = 'registry HKLM\S N (it did not exist)' }
    @{ Change = @{ kind = 'key'; key = 'HKLM\S\K'; name = '' }; Text = 'registry key HKLM\S\K (it did not exist)' }
    @{ Change = @{ kind = 'task'; key = '\Microsoft\Windows\Server Manager\'; name = 'ServerManager' }; Text = 'scheduled task \Microsoft\Windows\Server Manager\ServerManager (it was enabled)' }
    @{ Change = @{ kind = 'power'; key = 'SUB_VIDEO'; name = 'VIDEOIDLE'; value = '600' }; Text = 'power timeout SUB_VIDEO VIDEOIDLE (it was 600 seconds)' }
    @{ Change = @{ kind = 'secret'; key = 'DefaultPassword'; name = '' }; Text = 'the password stored for automatic sign-in (it is still stored)' }
    @{ Change = @{ kind = 'secret'; key = 'L$RpaRunnerBotPassword'; name = '' }; Text = "the bot user's password stored for the RPA Supervisor (it is still stored)" }
    @{ Change = @{ kind = 'group'; key = 'S-1-5-32-555'; name = 'S-1-5-21-1-2-3-1001'; value = 'rpa-runner' }; Text = 'the membership of rpa-runner in Remote Desktop Users (it was not a member)' }
    @{ Change = @{ kind = 'service'; key = 'RPA Supervisor'; name = '' }; Text = 'the service RPA Supervisor (it was not there)' }
    @{ Change = @{ kind = 'firewall'; key = 'RPA-Runner-In'; name = '' }; Text = 'firewall rule RPA-Runner-In (it was for the runner)' }
    @{ Change = @{ kind = 'firewall'; key = 'RPA-Browser-In'; name = '' }; Text = 'firewall rule RPA-Browser-In (it was for the browser)' }
  ) {
    $record = New-Object psobject -Property $Change
    InModuleScope RpaInstall -Parameters @{ Record = $record } { Get-RpaChangeText $Record } | Should -BeExactly $Text
  }

  It 'writes the list where only administrators can read or change it, and adds to one that is there' -Skip:($env:OS -ne 'Windows_NT') {
    $dir = Join-Path $TestDrive 'RPA Runner'
    New-Item -ItemType Directory -Path $dir | Out-Null
    $layout = @{ InstallDir = $dir; LeftoversFile = (Join-Path $dir 'uninstall-leftovers.json') }
    $file = InModuleScope RpaInstall -Parameters @{ Layout = $layout; Failed = @(New-TestFailure 'A' '') } { Save-RpaLeftovers $Layout $Failed 'rpa-runner' }
    $file | Should -BeExactly $layout.LeftoversFile
    $acl = Get-Acl -LiteralPath $file
    $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value | Should -BeExactly 'S-1-5-32-544'
    $acl.AreAccessRulesProtected | Should -BeTrue
    @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object) | Should -BeExactly @('S-1-5-18', 'S-1-5-32-544')

    $null = InModuleScope RpaInstall -Parameters @{ Layout = $layout; Failed = @(New-TestFailure 'B' 'b') } { Save-RpaLeftovers $Layout $Failed 'rpa-runner' }
    $read = InModuleScope RpaInstall -Parameters @{ File = $file } { Read-RpaLeftovers $File }
    $read.State | Should -BeExactly 'trusted'
    @($read.List.notPutBack | ForEach-Object { $_.name }) | Should -BeExactly @('A', 'B')
    $read.List.notPutBack[0].value | Should -BeExactly ''
  }

  It 'does not use <Why> in the place of the list, and says so' -Skip:($env:OS -ne 'Windows_NT') -ForEach @(
    @{ Why = 'a folder'; Make = { param($file) New-Item -ItemType Directory -Path $file | Out-Null } }
    @{ Why = 'a file with a second name'; Make = { param($file) Set-Content -LiteralPath "$file.other" -Value '{}'; & (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') /d /c ('mklink /H "{0}" "{1}"' -f $file, "$file.other") | Out-Null } }
    @{ Why = 'a file of another owner'; Make = { param($file) Set-Content -LiteralPath $file -Value '{}'; & (Join-Path ([Environment]::SystemDirectory) 'icacls.exe') $file /setowner '*S-1-5-32-545' | Out-Null } }
    @{ Why = 'a file that is not a list'; Make = { param($file) Set-Content -LiteralPath $file -Value 'not json {' } }
  ) {
    $dir = Join-Path $TestDrive ('slot-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $layout = @{ InstallDir = $dir; LeftoversFile = (Join-Path $dir 'uninstall-leftovers.json') }
    & $Make $layout.LeftoversFile
    (InModuleScope RpaInstall -Parameters @{ File = $layout.LeftoversFile } { Read-RpaLeftovers $File }).State | Should -BeExactly 'untrusted'
    { InModuleScope RpaInstall -Parameters @{ Layout = $layout; Failed = @(New-TestFailure 'A' '') } { Save-RpaLeftovers $Layout $Failed 'rpa-runner' } } |
      Should -Throw -ExpectedMessage '*uninstall-leftovers.json is there already and is not a list that Administrators or SYSTEM own; it was left as it is*'
  }

  It 'removes the program files and leaves <What> in the install directory' -Skip:($env:OS -ne 'Windows_NT') -ForEach @(
    @{ What = 'the list alone'; Make = { param($file) Set-Content -LiteralPath $file -Value '{ "notPutBack": [] }' }; Left = @('uninstall-leftovers.json') }
    @{ What = 'a folder that stands in the place of the list'; Make = { param($file) New-Item -ItemType Directory -Path $file | Out-Null }; Left = @('uninstall-leftovers.json') }
    @{ What = 'nothing, and no directory, when there is no list'; Make = { param($file) }; Left = @() }
  ) {
    $dir = Join-Path $TestDrive ('programs-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir, (Join-Path $dir 'runner') | Out-Null
    Set-Content -LiteralPath (Join-Path $dir 'install.json') -Value '{}'
    Set-Content -LiteralPath (Join-Path (Join-Path $dir 'runner') 'RpaRunner.exe') -Value 'x'
    $layout = @{ InstallDir = $dir; LeftoversFile = (Join-Path $dir 'uninstall-leftovers.json') }
    & $Make $layout.LeftoversFile
    InModuleScope RpaInstall -Parameters @{ Layout = $layout } { Remove-RpaProgramFiles $Layout }
    if ($Left.Count -eq 0) { $dir | Should -Not -Exist }
    else { @(Get-ChildItem -LiteralPath $dir -Force | ForEach-Object { $_.Name }) | Should -BeExactly $Left }
  }

  # A record of a user's own registry, when that user's profile is gone: there is nothing to put it back into.
  It 'skips a setting in the registry of a user whose profile is no longer on the machine, with a line that says so' {
    Mock -ModuleName RpaInstall Test-RpaUserRegistry { $false }
    Mock -ModuleName RpaInstall Restore-RpaSignInChange { }
    $gone = New-Object psobject -Property ([ordered]@{ kind = 'registry'; key = 'HKU\S-1-5-21-1-2-3-1001\Control Panel\Desktop'; name = 'ScreenSaveActive'; existed = $true; type = 'REG_SZ'; value = '1' })
    $machine = New-Object psobject -Property ([ordered]@{ kind = 'registry'; key = 'HKLM\SOFTWARE\Example'; name = 'A'; existed = $false })
    $output = @(InModuleScope RpaInstall -Parameters @{ Changes = @($machine, $gone) } { Restore-RpaSignInChanges $Changes $false } 6>&1)
    @($output | Where-Object { $_ -is [hashtable] }).Count | Should -Be 0
    ($output | ForEach-Object { "$_" }) | Should -BeExactly @('    skipped: registry HKU\S-1-5-21-1-2-3-1001\Control Panel\Desktop ScreenSaveActive (it was REG_SZ "1"): the profile of that user is no longer on this machine')
    Should -Invoke -ModuleName RpaInstall Restore-RpaSignInChange -Times 1 -Exactly
  }

  It 'prints each setting it could not put back when that happens' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChange { throw 'Access is denied.' }
    $machine = New-Object psobject -Property ([ordered]@{ kind = 'registry'; key = 'HKLM\SOFTWARE\Example'; name = 'A'; existed = $false })
    $output = @(InModuleScope RpaInstall -Parameters @{ Changes = @($machine) } { Restore-RpaSignInChanges $Changes $false } 6>&1)
    $failed = @($output | Where-Object { $_ -is [hashtable] })
    $failed.Count | Should -Be 1
    $failed[0].Text | Should -BeExactly 'registry HKLM\SOFTWARE\Example A (it did not exist): Access is denied.'
    (@($output | Where-Object { $_ -isnot [hashtable] }) | ForEach-Object { "$_" }) | Should -BeExactly @('    could not put back: registry HKLM\SOFTWARE\Example A (it did not exist): Access is denied.')
  }
}

Describe 'A list an earlier uninstall left' {
  BeforeAll {
    $script:LeftoversFile = 'C:\Program Files\RPA Runner\uninstall-leftovers.json'
    $script:Leftovers = @'
{ "note": "x", "notPutBack": [
  { "kind": "registry", "key": "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization", "name": "NoLockScreen", "existed": false, "reason": "r", "user": "rpa-runner", "at": "2026-11-09 10:00:00 UTC" },
  { "kind": "other", "reason": "The registry of the user could not be closed.", "user": "rpa-runner", "at": "2026-11-09 10:00:00 UTC" },
  { "kind": "registry", "key": "HKLM\\SOFTWARE\\Example", "name": "A", "existed": true, "type": "REG_SZ", "value": "", "reason": "r", "user": "rpa-runner", "at": "2026-11-09 10:00:00 UTC" }
] }
'@ | ConvertFrom-Json
    function New-TestRecord2($Previous, $Leftovers) {
      $parameters = New-TestParameters
      InModuleScope RpaInstall -Parameters @{ Previous = $Previous; Leftovers = $Leftovers; Parameters = $parameters } {
        New-RpaInstallRecord -Version '0.2.0' -Account (Get-RpaAccount -User 'rpa-runner' -ComputerName 'BOT-PC') -Parameters $Parameters -Plan @{ Steps = @(); AllowFrom = @('10.0.0.5'); PublicNetwork = $true } -Previous $Previous -Leftovers $Leftovers
      }
    }
  }

  # Otherwise the install would record the changed setting as what was there before, and no uninstall would put it back.
  It 'gives install.json its first records: what each setting was before the earlier install' {
    $record = New-TestRecord2 $null $script:Leftovers
    @($record.signInChanges).Count | Should -Be 2
    $first = $record.signInChanges[0]
    $first.name | Should -BeExactly 'NoLockScreen'
    $first.existed | Should -BeFalse
    @($first.PSObject.Properties.Name) | Should -BeExactly @('kind', 'key', 'name', 'existed')
    $record.signInChanges[1].value | Should -BeExactly ''
    $record.autoSignIn | Should -BeFalse
  }

  It 'adds nothing for a setting install.json records already' {
    $previous = '{ "user": "rpa-runner", "autoSignIn": false, "allowFrom": "any", "signInChanges": [ { "kind": "registry", "key": "HKLM\\SOFTWARE\\Example", "name": "A", "existed": true, "type": "REG_SZ", "value": "older" } ] }' | ConvertFrom-Json
    $record = New-TestRecord2 $previous $script:Leftovers
    @($record.signInChanges | ForEach-Object { $_.name }) | Should -BeExactly @('A', 'NoLockScreen')
    $record.signInChanges[0].value | Should -BeExactly 'older'
  }

  It 'without a list, records what install.json had' {
    @((New-TestRecord2 $null $null).signInChanges).Count | Should -Be 0
  }

  It 'warns when the list cannot be trusted, and says what that means' {
    $facts = New-TestFacts @{ Leftovers = @{ File = $script:LeftoversFile; State = 'untrusted' } }
    $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts $facts
    $plan.Refusals.Count | Should -Be 0
    $plan.Warnings | Should -BeExactly @('C:\Program Files\RPA Runner\uninstall-leftovers.json is not a list that Administrators or SYSTEM own, so the installer does not read it. An earlier uninstall keeps there what it could not put back; without it, a setting that is still changed is recorded as it is now, and a later uninstall leaves it that way. Check the file and remove it.')
    foreach ($state in 'missing', 'trusted') {
      $facts = New-TestFacts @{ Leftovers = @{ File = $script:LeftoversFile; State = $state } }
      (Get-RpaInstallPlan -Parameters (New-TestParameters @{ UserPassword = New-TestPassword }) -Facts $facts).Warnings.Count | Should -Be 0
    }
  }
}

Describe 'install.json' {
  BeforeAll {
    function New-TestRecord([hashtable]$Plan, $Previous, [hashtable]$Change = @{}) {
      $parameters = New-TestParameters $Change
      InModuleScope RpaInstall -Parameters @{ Plan = $Plan; Previous = $Previous; Parameters = $parameters } {
        New-RpaInstallRecord -Version '0.2.0' -Account (Get-RpaAccount -User $Parameters.User -ComputerName 'BOT-PC') -Parameters $Parameters -Plan $Plan -Previous $Previous
      }
    }
  }

  It 'holds these fields, in this order' {
    $plan = @{ Steps = @('write install.json'); AllowFrom = @('10.0.0.5', '10.1.0.0/16'); PublicNetwork = $true }
    $record = New-TestRecord $plan $null
    @($record.Keys) | Should -BeExactly @('version', 'user', 'runnerPort', 'browserPort', 'browser', 'autoSignIn', 'allowFrom', 'publicNetwork', 'mode', 'signInChanges')
    $record.mode | Should -BeExactly 'signedIn'
    $record.version | Should -BeExactly '0.2.0'
    $record.user | Should -BeExactly 'rpa-runner'
    $record.runnerPort | Should -Be 8765
    $record.browserPort | Should -Be 3000
    $record.browser | Should -BeTrue
    $record.autoSignIn | Should -BeFalse
    $record.allowFrom | Should -BeExactly @('10.0.0.5', '10.1.0.0/16')
    $record.publicNetwork | Should -BeTrue
    @($record.signInChanges).Count | Should -Be 0
  }

  It 'records any address as the word any, and whether Public networks are included' {
    $record = New-TestRecord @{ Steps = @(); AllowFrom = @('any'); PublicNetwork = $false } $null
    $record.allowFrom | Should -BeExactly 'any'
    $record.allowFrom | Should -BeOfType [string]
    $record.publicNetwork | Should -BeFalse
    (New-TestRecord @{ Steps = @(); AllowFrom = @('any'); PublicNetwork = $true } $null).publicNetwork | Should -BeTrue
  }

  It 'says that automatic sign-in is on when this run turns it on or an earlier run did' {
    (New-TestRecord @{ Steps = @('turn on automatic sign-in'); AllowFrom = @('any'); PublicNetwork = $false } $null).autoSignIn | Should -BeTrue
    $previous = '{ "user": "rpa-runner", "autoSignIn": true, "allowFrom": "any", "publicNetwork": true, "signInChanges": [ { "kind": "secret", "key": "DefaultPassword", "name": "" } ] }' | ConvertFrom-Json
    $record = New-TestRecord @{ Steps = @(); AllowFrom = $null; PublicNetwork = $false } $previous @{ NoFirewall = $true }
    $record.autoSignIn | Should -BeTrue
    @($record.signInChanges).Count | Should -Be 1
    # A run that makes no firewall rule keeps what an earlier run recorded about them.
    $record.allowFrom | Should -BeExactly 'any'
    $record.publicNetwork | Should -BeTrue
  }

  It 'records the word none for an install without firewall rules, and keeps it when an upgrade makes none either' {
    $record = New-TestRecord @{ Steps = @(); AllowFrom = $null; PublicNetwork = $false } $null @{ NoFirewall = $true; NoBrowser = $true }
    $record.allowFrom | Should -BeExactly 'none'
    $record.allowFrom | Should -BeOfType [string]
    $record.publicNetwork | Should -BeFalse
    $record.browser | Should -BeFalse

    $previous = '{ "user": "rpa-runner", "autoSignIn": false, "allowFrom": "none", "publicNetwork": false, "signInChanges": [] }' | ConvertFrom-Json
    (New-TestRecord @{ Steps = @(); AllowFrom = $null; PublicNetwork = $false } $previous @{ AllowFrom = @() }).allowFrom | Should -BeExactly 'none'
    # A record of an earlier version that says nothing, upgraded with -NoFirewall.
    $previous = '{ "user": "rpa-runner", "autoSignIn": false, "allowFrom": null, "signInChanges": [] }' | ConvertFrom-Json
    (New-TestRecord @{ Steps = @(); AllowFrom = $null; PublicNetwork = $false } $previous @{ NoFirewall = $true }).allowFrom | Should -BeExactly 'none'
    # An upgrade that makes rules replaces it.
    $previous = '{ "user": "rpa-runner", "autoSignIn": false, "allowFrom": "none", "publicNetwork": false, "signInChanges": [] }' | ConvertFrom-Json
    (New-TestRecord @{ Steps = @(); AllowFrom = @('10.0.0.5'); PublicNetwork = $true } $previous).allowFrom | Should -BeExactly @('10.0.0.5')
  }

  # The names RPA Supervisor reads (desktop/runner/src/Rpa.Supervisor.Core/InstallFile.cs).
  It 'with -Unattended holds what the RPA Supervisor reads: the mode, the plain user name, the ports behind it, the idle time and where it listens' {
    $plan = @{ Steps = @('write install.json'); AllowFrom = @('10.0.0.5'); PublicNetwork = $true; Unattended = $true; IdleSeconds = 30 }
    $record = New-TestRecord $plan $null @{ Unattended = $true; User = '.\rpa-runner' }
    @($record.Keys) | Should -BeExactly @('version', 'user', 'runnerPort', 'browserPort', 'browser', 'autoSignIn', 'allowFrom', 'publicNetwork', 'mode', 'idleSeconds', 'runnerInnerPort', 'browserInnerPort', 'listenAddresses', 'signInChanges')
    $record.mode | Should -BeExactly 'unattended'
    $record.user | Should -BeExactly 'rpa-runner'
    $record.idleSeconds | Should -Be 30
    $record.runnerInnerPort | Should -Be 18765
    $record.browserInnerPort | Should -Be 13000
    $json = $record | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    @($json.listenAddresses) | Should -BeExactly @('0.0.0.0')
    $json.listenAddresses.GetType().IsArray | Should -BeTrue
  }

  It 'with -Unattended -NoBrowser has no browser port, so that the RPA Supervisor passes on the runner port only' {
    $record = New-TestRecord @{ Steps = @(); AllowFrom = @('10.0.0.5'); PublicNetwork = $true; Unattended = $true; IdleSeconds = 15 } $null @{ Unattended = $true; NoBrowser = $true }
    $record.browserPort | Should -BeNullOrEmpty
    $record.Contains('browserInnerPort') | Should -BeFalse
    $record.runnerInnerPort | Should -Be 18765
  }

  It 'never holds the password' {
    $password = New-MadeUpPassword
    $plan = @{ Steps = @('write install.json', "store the bot user's password for the supervisor"); AllowFrom = @('10.0.0.5'); PublicNetwork = $true; Unattended = $true; IdleSeconds = 15 }
    $record = New-TestRecord $plan $null @{ Unattended = $true; UserPassword = $password.Secure }
    ($record | ConvertTo-Json -Depth 5).Contains($password.Text) | Should -BeFalse
  }
}

Describe 'A failed install' {
  BeforeAll {
    # The state of a first install with -AutoSignIn that created its user, wrote install.json and then changed two
    # settings: A existed as an empty string, B did not exist.
    function New-FailedRun([string]$InstallFile) {
      InModuleScope RpaInstall -Parameters @{ File = $InstallFile } {
        $changes = @(
          (New-Object psobject -Property ([ordered]@{ kind = 'registry'; key = 'HKLM\SOFTWARE\Example'; name = 'A'; existed = $true; type = 'REG_SZ'; value = '' }))
          (New-Object psobject -Property ([ordered]@{ kind = 'registry'; key = 'HKLM\SOFTWARE\Example'; name = 'B'; existed = $false }))
        )
        $run = @{
          Layout = @{ InstallFile = $File }; Account = @{ Display = 'rpa-runner'; Name = 'rpa-runner' }; Sid = 'S-1-5-21-1-2-3-1001'
          Upgrade = $false; AutoSignInBefore = $false; NewChanges = $changes; CreatedUser = $true; WroteInstallFile = $true
          Install = [ordered]@{ version = '0.0.0'; user = 'rpa-runner'; autoSignIn = $true; signInChanges = $changes }
        }
        Save-RpaInstallFile $run
        $run
      }
    }
  }

  It 'removes the user it created and install.json when everything it changed is put back' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    Mock -ModuleName RpaInstall Remove-RpaUser { }
    $file = Join-Path $TestDrive 'undone.json'
    $run = New-FailedRun $file
    $result = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    @($result.NotPutBack).Count | Should -Be 0
    $result.UserKept | Should -BeNullOrEmpty
    Should -Invoke -ModuleName RpaInstall Remove-RpaUser -Times 1 -Exactly
    $file | Should -Not -Exist
  }

  It 'keeps the user it created and the record of what it could not put back' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { param($Changes) @(@{ Change = $Changes[0]; Text = 'registry HKLM\SOFTWARE\Example A: Access is denied.' }) }
    Mock -ModuleName RpaInstall Remove-RpaUser { }
    $file = Join-Path $TestDrive 'left.json'
    $run = New-FailedRun $file
    $result = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    $result.NotPutBack | Should -BeExactly @('registry HKLM\SOFTWARE\Example A: Access is denied.')
    $result.UserKept | Should -BeExactly 'rpa-runner'
    Should -Invoke -ModuleName RpaInstall Remove-RpaUser -Times 0 -Exactly

    # install.json stays: it holds the one record that could not be put back, and does not say that automatic sign-in is on.
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    $kept.autoSignIn | Should -BeFalse
    @($kept.signInChanges).Count | Should -Be 1
    $kept.signInChanges[0].name | Should -BeExactly 'A'
    $kept.signInChanges[0].existed | Should -BeTrue
    $kept.signInChanges[0].value | Should -BeExactly ''
  }
}

Describe 'A failed switch to -Unattended' {
  # A signed-in install, run again with -Unattended: install.json says unattended by the time a later step fails.
  It 'puts install.json back to the mode it had, without the fields of the RPA Supervisor' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    $file = Join-Path $TestDrive 'switch.json'
    $before = '{ "version": "0.2.0", "user": "rpa-runner", "runnerPort": 8765, "browserPort": 3000, "browser": true, "autoSignIn": false, "allowFrom": ["10.0.0.5"], "publicNetwork": true, "signInChanges": [] }' | ConvertFrom-Json
    $secret = New-Object psobject -Property ([ordered]@{ kind = 'secret'; key = 'L$RpaRunnerBotPassword'; name = '' })
    $run = @{
      Layout = @{ InstallFile = $file }; Account = @{ Display = 'rpa-runner'; Name = 'rpa-runner' }; Sid = 'S-1-5-21-1-2-3-1001'
      Upgrade = $true; AutoSignInBefore = $false; Before = $before; NewChanges = @($secret); CreatedUser = $false; WroteInstallFile = $true
      Install = [ordered]@{ version = '0.3.0'; user = 'rpa-runner'; runnerPort = 8765; browserPort = $null; browser = $false; autoSignIn = $false; mode = 'unattended'
        idleSeconds = 15; runnerInnerPort = 18765; listenAddresses = @('0.0.0.0'); signInChanges = @($secret) }
    }
    $null = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    $kept.mode | Should -BeExactly 'signedIn'
    $kept.browserPort | Should -Be 3000
    foreach ($field in 'idleSeconds', 'runnerInnerPort', 'browserInnerPort', 'listenAddresses') { $kept.PSObject.Properties.Name | Should -Not -Contain $field }
    @($kept.signInChanges).Count | Should -Be 0
  }

  # The other way: an install without -Unattended over an unattended one fails after its reverse step removed the
  # supervisor. It keeps the signed-in mode it wrote.
  It 'a failed switch back to the signed-in mode keeps that mode' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    $file = Join-Path $TestDrive 'switch-back.json'
    $before = '{ "version": "0.2.0", "user": "rpa-runner", "runnerPort": 8765, "browserPort": 3000, "browser": true, "autoSignIn": false, "mode": "unattended", "idleSeconds": 15, "runnerInnerPort": 18765, "browserInnerPort": 13000, "listenAddresses": ["0.0.0.0"], "signInChanges": [] }' | ConvertFrom-Json
    $run = @{
      Layout = @{ InstallFile = $file }; Account = @{ Display = 'rpa-runner'; Name = 'rpa-runner' }; Sid = 'S-1-5-21-1-2-3-1001'
      Upgrade = $true; AutoSignInBefore = $false; Before = $before; NewChanges = @(); CreatedUser = $false; WroteInstallFile = $true; UnattendedPutBack = $true
      Install = [ordered]@{ version = '0.3.0'; user = 'rpa-runner'; runnerPort = 8765; browserPort = 3000; browser = $true; autoSignIn = $false; mode = 'signedIn'; signInChanges = @() }
    }
    $null = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    $kept.mode | Should -BeExactly 'signedIn'
    foreach ($field in 'idleSeconds', 'runnerInnerPort', 'browserInnerPort', 'listenAddresses') { $kept.PSObject.Properties.Name | Should -Not -Contain $field }
  }
}

Describe 'Moving an install with automatic sign-in to -Unattended' {
  BeforeAll {
    # What install.json records of -AutoSignIn: the stored password and one registry value.
    function New-AutoSignInChanges {
      @(
        [ordered]@{ kind = 'secret'; key = 'DefaultPassword'; name = '' }
        [ordered]@{ kind = 'registry'; key = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'; name = 'AutoAdminLogon'; existed = $false }
      ) | ForEach-Object { New-Object psobject -Property $_ }
    }
  }

  It 'keeps the password stored for automatic sign-in for the supervisor, in memory only' {
    $password = New-MadeUpPassword
    $env:RPA_TEST_SECRET = $password.Text
    Mock -ModuleName RpaInstall Read-RpaAutoSignInPassword { $s = New-Object Security.SecureString; foreach ($c in $env:RPA_TEST_SECRET.ToCharArray()) { $s.AppendChar($c) }; $s }
    Mock -ModuleName RpaInstall Set-RpaSupervisorPassword { }
    $run = @{ Password = $null }
    try { InModuleScope RpaInstall -Parameters @{ Run = $run } { Copy-RpaAutoSignInPassword $Run } } finally { $env:RPA_TEST_SECRET = $null }
    Should -Invoke -ModuleName RpaInstall Set-RpaSupervisorPassword -Times 1 -Exactly
    $run.Password | Should -BeOfType [Security.SecureString]
    $run.Password.Length | Should -Be $password.Text.Length

    Mock -ModuleName RpaInstall Read-RpaAutoSignInPassword { }
    { InModuleScope RpaInstall -Parameters @{ Run = @{ Password = $null } } { Copy-RpaAutoSignInPassword $Run } } |
      Should -Throw -ExpectedMessage 'The password stored for automatic sign-in is missing or empty; nothing of it was kept.'
  }

  It 'the way back keeps the password the supervisor has, in memory only' {
    $password = New-MadeUpPassword
    $env:RPA_TEST_SECRET = $password.Text
    Mock -ModuleName RpaInstall Read-RpaSupervisorPassword { $s = New-Object Security.SecureString; foreach ($c in $env:RPA_TEST_SECRET.ToCharArray()) { $s.AppendChar($c) }; $s }
    $run = @{ Password = $null }
    try { InModuleScope RpaInstall -Parameters @{ Run = $run } { Copy-RpaSupervisorPassword $Run } } finally { $env:RPA_TEST_SECRET = $null }
    $run.Password | Should -BeOfType [Security.SecureString]
    $run.Password.Length | Should -Be $password.Text.Length
    Mock -ModuleName RpaInstall Read-RpaSupervisorPassword { }
    { InModuleScope RpaInstall -Parameters @{ Run = @{ Password = $null } } { Copy-RpaSupervisorPassword $Run } } |
      Should -Throw -ExpectedMessage 'The password stored for the RPA Supervisor is missing or empty; nothing of it was kept.'
  }

  It 'a failed way back before the supervisor is put back leaves the install unattended, with its records' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    $file = Join-Path $TestDrive 'failed-way-back.json'
    $before = '{ "version": "0.3.0", "user": "rpa-runner", "runnerPort": 8765, "browserPort": 3000, "browser": true, "autoSignIn": false, "mode": "unattended", "idleSeconds": 15, "runnerInnerPort": 18765, "browserInnerPort": 13000, "listenAddresses": ["0.0.0.0"], "signInChanges": [] }' | ConvertFrom-Json
    $secret = New-Object psobject -Property ([ordered]@{ kind = 'secret'; key = 'L$RpaRunnerBotPassword'; name = '' })
    $autoSecret = New-Object psobject -Property ([ordered]@{ kind = 'secret'; key = 'DefaultPassword'; name = '' })
    $run = @{
      Layout = @{ InstallFile = $file }; Account = @{ Display = 'rpa-runner'; Name = 'rpa-runner' }; Upgrade = $true; AutoSignInBefore = $false; Before = $before
      NewChanges = @($autoSecret); CreatedUser = $false; WroteInstallFile = $true
      Install = [ordered]@{ version = '0.3.1'; user = 'rpa-runner'; runnerPort = 8765; browserPort = 3000; browser = $true; autoSignIn = $true; mode = 'signedIn'; signInChanges = @($secret, $autoSecret) }
    }
    $null = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    Should -Invoke -ModuleName RpaInstall Restore-RpaSignInChanges -Times 1 -Exactly
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    $kept.mode | Should -BeExactly 'unattended'
    $kept.runnerInnerPort | Should -Be 18765
    $kept.autoSignIn | Should -BeFalse
    @($kept.signInChanges | ForEach-Object { $_.key }) | Should -BeExactly @('L$RpaRunnerBotPassword')
  }

  It 'a way back that failed while putting back the supervisor keeps automatic sign-in, which is set up by then' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    $file = Join-Path $TestDrive 'failed-put-back.json'
    $before = '{ "version": "0.3.0", "user": "rpa-runner", "autoSignIn": false, "mode": "unattended", "idleSeconds": 15, "runnerInnerPort": 18765, "signInChanges": [] }' | ConvertFrom-Json
    $service = New-Object psobject -Property ([ordered]@{ kind = 'service'; key = 'RPA Supervisor'; name = '' })
    $autoSecret = New-Object psobject -Property ([ordered]@{ kind = 'secret'; key = 'DefaultPassword'; name = '' })
    $run = @{
      Layout = @{ InstallFile = $file }; Account = @{ Display = 'rpa-runner'; Name = 'rpa-runner' }; Upgrade = $true; AutoSignInBefore = $false; Before = $before
      NewChanges = @($autoSecret); CreatedUser = $false; WroteInstallFile = $true; UnattendedPutBack = $true
      Install = [ordered]@{ version = '0.3.1'; user = 'rpa-runner'; autoSignIn = $true; mode = 'signedIn'; signInChanges = @($service, $autoSecret) }
    }
    $null = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    Should -Invoke -ModuleName RpaInstall Restore-RpaSignInChanges -Times 0 -Exactly
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    $kept.mode | Should -BeExactly 'signedIn'
    $kept.autoSignIn | Should -BeTrue
    @($kept.signInChanges | ForEach-Object { $_.key }) | Should -BeExactly @('RPA Supervisor', 'DefaultPassword')
  }

  It 'Install-Rpa.ps1 ends with the short commands, and after an unattended install with the connection lines and when its own sign-in ends' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'Install-Rpa.ps1')
    $closing = $source.Substring($source.IndexOf("Write-Host 'RPA is installed.'"))
    $closing | Should -Match ([regex]::Escape("`$rpa = Join-Path `$layout.InstallDir 'rpa.cmd'"))
    $closing | Should -Match ([regex]::Escape("Write-Host ('  & `"{0}`" connection' -f `$rpa)"))
    $closing | Should -Match ([regex]::Escape("Write-Host ('For how the supervisor is doing: & `"{0}`" status' -f `$rpa)"))
    $closing | Should -Match ([regex]::Escape("Write-Host ('The installer signed {0} in once, to check the runner; that session ends by itself {1} s after the check (the idle time).' -f `$User, `$plan.IdleSeconds)"))
    $closing | Should -Match ([regex]::Escape("& (Join-Path (Join-Path `$layout.InstallDir 'scripts') 'Show-RpaConnection.ps1') | Out-Host"))
    # No 110-character command any more.
    $closing | Should -Not -Match 'ExecutionPolicy Bypass -File'
  }

  It 'Install-Rpa.ps1 says after a failed move that the bot user stays signed out until the next start' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'Install-Rpa.ps1')
    $source | Should -Match ([regex]::Escape("if (`$_.Exception.Data['SignedOut'])"))
    $source | Should -Match ([regex]::Escape("stays signed out until this machine starts again, when Windows signs it in, or until someone signs in as {0}."))
  }

  It 'turns automatic sign-in off from its records and keeps those of -Unattended' {
    $env:RPA_TEST_ORDER = ''
    Mock -ModuleName RpaInstall Restore-RpaSignInChange { $env:RPA_TEST_ORDER += '{0}:{1};' -f $Change.kind, $Change.key }
    $file = Join-Path $TestDrive 'turn-off.json'
    $group = New-Object psobject -Property ([ordered]@{ kind = 'group'; key = 'S-1-5-32-555'; name = 'S-1-5-21-1-2-3-1001'; value = 'rpa-runner' })
    $run = @{ Layout = @{ InstallFile = $file }; Install = [ordered]@{ version = '0.0.0'; autoSignIn = $true; mode = 'unattended'; signInChanges = @(New-AutoSignInChanges) + @($group) } }
    try { InModuleScope RpaInstall -Parameters @{ Run = $run } { Disable-RpaAutoSignIn $Run 6>$null } }
    finally { $order = $env:RPA_TEST_ORDER; $env:RPA_TEST_ORDER = $null }
    $order | Should -BeExactly 'registry:HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon;secret:DefaultPassword;'
    $run.AutoSignInTurnedOff | Should -BeTrue
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    $kept.autoSignIn | Should -BeFalse
    @($kept.signInChanges | ForEach-Object { $_.kind }) | Should -BeExactly @('group')
  }

  It 'a failed conversion turns automatic sign-in on again, with its stored password, and goes back to the signed-in mode' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    Mock -ModuleName RpaInstall Set-RpaSignInPassword { }
    Mock -ModuleName RpaInstall Enable-RpaAutoSignIn { }
    Mock -ModuleName RpaInstall Set-RpaDesktopUnlocked { }
    $file = Join-Path $TestDrive 'failed-conversion.json'
    $before = '{ "version": "0.2.0", "user": "rpa-runner", "runnerPort": 8765, "browserPort": 3000, "browser": true, "autoSignIn": true, "signInChanges": [ { "kind": "secret", "key": "DefaultPassword", "name": "" } ] }' | ConvertFrom-Json
    $supervisor = New-Object psobject -Property ([ordered]@{ kind = 'secret'; key = 'L$RpaRunnerBotPassword'; name = '' })
    $run = @{
      Layout = @{ InstallFile = $file }; Account = @{ Display = 'rpa-runner'; Name = 'rpa-runner' }; Sid = 'S-1-5-21-1-2-3-1001'; Password = (New-TestPassword)
      Upgrade = $true; AutoSignInBefore = $true; Before = $before; NewChanges = @($supervisor); CreatedUser = $false; WroteInstallFile = $true; AutoSignInTurnedOff = $true
      Install = [ordered]@{ version = '0.3.0'; user = 'rpa-runner'; runnerPort = 8765; browserPort = 3000; browser = $true; autoSignIn = $false; mode = 'unattended'
        idleSeconds = 15; runnerInnerPort = 18765; browserInnerPort = 13000; listenAddresses = @('0.0.0.0'); signInChanges = @($supervisor) }
    }
    $result = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    @($result.NotPutBack).Count | Should -Be 0
    Should -Invoke -ModuleName RpaInstall Set-RpaSignInPassword -Times 1 -Exactly
    Should -Invoke -ModuleName RpaInstall Enable-RpaAutoSignIn -Times 1 -Exactly
    Should -Invoke -ModuleName RpaInstall Set-RpaDesktopUnlocked -Times 1 -Exactly
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    $kept.autoSignIn | Should -BeTrue
    $kept.mode | Should -BeExactly 'signedIn'
    @($kept.signInChanges | Where-Object { $_.key -eq 'L$RpaRunnerBotPassword' }).Count | Should -Be 0
  }

  It 'says what it could not turn on again, and keeps going' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    Mock -ModuleName RpaInstall Set-RpaSignInPassword { throw 'Access is denied.' }
    Mock -ModuleName RpaInstall Enable-RpaAutoSignIn { }
    Mock -ModuleName RpaInstall Set-RpaDesktopUnlocked { }
    $run = @{
      Layout = @{ InstallFile = (Join-Path $TestDrive 'failed-again.json') }; Account = @{ Display = 'rpa-runner'; Name = 'rpa-runner' }; Password = (New-TestPassword)
      Upgrade = $true; AutoSignInBefore = $true; Before = $null; NewChanges = @(); CreatedUser = $false; WroteInstallFile = $true; AutoSignInTurnedOff = $true
      Install = [ordered]@{ version = '0.3.0'; user = 'rpa-runner'; autoSignIn = $false; mode = 'signedIn'; signInChanges = @() }
    }
    $result = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    $result.NotPutBack | Should -BeExactly @('automatic sign-in of rpa-runner, which this run had turned off: Access is denied.')
  }
}

Describe 'What -Unattended changed, put back' {
  BeforeAll {
    # The records an install with -Unattended leaves in install.json, in the order its steps make them: the bot user put
    # into Remote Desktop Users, Remote Desktop turned on (it was off), the password stored, the service, the two rules.
    function New-UnattendedChanges {
      @(
        [ordered]@{ kind = 'group'; key = 'S-1-5-32-555'; name = 'S-1-5-21-1-2-3-1001'; value = 'rpa-runner' }
        [ordered]@{ kind = 'registry'; key = 'HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server'; name = 'fDenyTSConnections'; existed = $true; type = 'REG_DWORD'; value = '1' }
        [ordered]@{ kind = 'secret'; key = 'L$RpaRunnerBotPassword'; name = '' }
        [ordered]@{ kind = 'service'; key = 'RPA Supervisor'; name = '' }
        [ordered]@{ kind = 'firewall'; key = 'RPA-Runner-In'; name = '' }
        [ordered]@{ kind = 'firewall'; key = 'RPA-Browser-In'; name = '' }
      ) | ForEach-Object { New-Object psobject -Property $_ }
    }
  }

  It 'puts back <What>' -ForEach @(
    @{ What = 'the service and its event source'; Change = @{ kind = 'service'; key = 'RPA Supervisor'; name = '' }; Command = 'Remove-RpaSupervisor'; Filter = { $true } }
    @{ What = "the bot user's stored password"; Change = @{ kind = 'secret'; key = 'L$RpaRunnerBotPassword'; name = '' }; Command = 'Remove-RpaLsaSecret'; Filter = { $Name -eq 'L$RpaRunnerBotPassword' } }
    @{ What = 'the membership in Remote Desktop Users'; Change = @{ kind = 'group'; key = 'S-1-5-32-555'; name = 'S-1-5-21-1-2-3-1001'; value = 'rpa-runner' }; Command = 'Remove-RpaGroupMember'; Filter = { $Group -eq 'S-1-5-32-555' -and $Member -eq 'S-1-5-21-1-2-3-1001' } }
    @{ What = 'Remote Desktop as it was found'; Change = @{ kind = 'registry'; key = 'HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server'; name = 'fDenyTSConnections'; existed = $true; type = 'REG_DWORD'; value = '1' }; Command = 'Set-RpaRegistryValue'; Filter = { $Name -eq 'fDenyTSConnections' -and $Type -eq 'REG_DWORD' -and $Value -eq '1' } }
    @{ What = 'the runner firewall rule'; Change = @{ kind = 'firewall'; key = 'RPA-Runner-In'; name = '' }; Command = 'Set-RpaFirewallRuleProgram'; Filter = { $Name -eq 'RPA-Runner-In' -and $Program -like '*runner?RpaRunner.exe' } }
    @{ What = 'the browser firewall rule'; Change = @{ kind = 'firewall'; key = 'RPA-Browser-In'; name = '' }; Command = 'Set-RpaFirewallRuleProgram'; Filter = { $Name -eq 'RPA-Browser-In' -and $Program -like '*browser?node.exe' } }
  ) {
    Mock -ModuleName RpaInstall $Command { }
    # A folder that Join-Path takes on every platform.
    $env:RPA_TEST_INSTALL = Join-Path $TestDrive 'RPA Runner'
    Mock -ModuleName RpaInstall Get-RpaLayout { @{ InstallDir = $env:RPA_TEST_INSTALL } }
    $record = New-Object psobject -Property $Change
    try { InModuleScope RpaInstall -Parameters @{ Record = $record } { Restore-RpaSignInChange $Record } }
    finally { $env:RPA_TEST_INSTALL = $null }
    Should -Invoke -ModuleName RpaInstall $Command -Times 1 -Exactly -ParameterFilter $Filter
  }

  # An install without -Unattended over one with it.
  It 'removes the service, the password and the group membership, puts Remote Desktop back, last first, and keeps the other records' {
    $env:RPA_TEST_ORDER = ''
    Mock -ModuleName RpaInstall Restore-RpaSignInChange { $env:RPA_TEST_ORDER += '{0}:{1};' -f $Change.kind, $Change.key }
    $file = Join-Path $TestDrive 'reverse.json'
    $other = New-Object psobject -Property ([ordered]@{ kind = 'registry'; key = 'HKLM\SOFTWARE\Example'; name = 'A'; existed = $false })
    $run = @{ Layout = @{ InstallFile = $file }; Install = [ordered]@{ version = '0.0.0'; user = 'rpa-runner'; mode = 'signedIn'; signInChanges = @($other) + @(New-UnattendedChanges) } }
    try {
      InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaUnattended $Run 6>$null }
      $env:RPA_TEST_ORDER | Should -BeExactly 'firewall:RPA-Browser-In;firewall:RPA-Runner-In;service:RPA Supervisor;secret:L$RpaRunnerBotPassword;registry:HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server;group:S-1-5-32-555;'
    } finally { $env:RPA_TEST_ORDER = $null }
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    @($kept.signInChanges).Count | Should -Be 1
    $kept.signInChanges[0].key | Should -BeExactly 'HKLM\SOFTWARE\Example'
  }

  It 'keeps the record of what it could not put back, and fails the step with it' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChange { if ($Change.kind -eq 'service') { throw 'Access is denied.' } }
    $file = Join-Path $TestDrive 'reverse-failed.json'
    $run = @{ Layout = @{ InstallFile = $file }; Install = [ordered]@{ version = '0.0.0'; user = 'rpa-runner'; mode = 'signedIn'; signInChanges = @(New-UnattendedChanges) } }
    { InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaUnattended $Run 6>$null } } |
      Should -Throw -ExpectedMessage 'Could not put back: the service RPA Supervisor (it was not there): Access is denied.'
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    @($kept.signInChanges | ForEach-Object { $_.kind }) | Should -BeExactly @('service')
  }

  It 'Uninstall-Rpa.ps1 puts back the same, and says that it was -Unattended that changed them' {
    if (-not (Get-Command Remove-NetFirewallRule -ErrorAction SilentlyContinue)) { function global:Remove-NetFirewallRule { [CmdletBinding()] param([string[]]$Name) } }
    $computer = $env:COMPUTERNAME
    if (-not $computer) { $env:COMPUTERNAME = 'BOT-PC' }
    $file = Join-Path $TestDrive 'unattended-install.json'
    [ordered]@{ version = '0.0.0'; user = 'rpa-runner'; autoSignIn = $false; mode = 'unattended'; signInChanges = @(New-UnattendedChanges) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $file
    $env:RPA_TEST_FILE = $file
    Mock -ModuleName RpaInstall Get-RpaLayout { @{ InstallDir = 'C:\Program Files\RPA Runner'; InstallFile = $env:RPA_TEST_FILE; DataDir = "$($env:RPA_TEST_FILE).data"; LeftoversFile = "$($env:RPA_TEST_FILE).list" } }
    Mock -ModuleName RpaInstall Get-RpaSid { 'S-1-5-21-1-2-3-1001' }
    Mock -ModuleName RpaInstall Stop-RpaServices { }
    Mock -ModuleName RpaInstall Get-RpaUninstallFacts { @{ Accounts = @(); RunningSids = @(); UnknownProcesses = @() } }
    Mock -ModuleName RpaInstall Remove-RpaBrowserTemp { }
    Mock -ModuleName RpaInstall Unregister-RpaTask { }
    Mock -ModuleName RpaInstall Remove-NetFirewallRule { }
    Mock -ModuleName RpaInstall Remove-RpaProgramFiles { }
    Mock -ModuleName RpaInstall Remove-RpaSupervisor { }
    Mock -ModuleName RpaInstall Remove-RpaLsaSecret { }
    Mock -ModuleName RpaInstall Get-RpaServicePath { }
    $env:RPA_TEST_ORDER = ''
    Mock -ModuleName RpaInstall Restore-RpaSignInChange { $env:RPA_TEST_ORDER += '{0};' -f $Change.kind }
    try {
      $result = Invoke-RpaUninstall -Plan @{ Refusals = @() } 6>$null
      $env:RPA_TEST_ORDER | Should -BeExactly 'firewall;firewall;service;secret;registry;group;'
      # The recorded service is not tried again by its name (one that could not be removed is listed instead); the
      # secret is removed by its name too.
      Should -Invoke -ModuleName RpaInstall Remove-RpaSupervisor -Times 0 -Exactly
      Should -Invoke -ModuleName RpaInstall Get-RpaServicePath -Times 0 -Exactly
      Should -Invoke -ModuleName RpaInstall Remove-RpaLsaSecret -Times 1 -Exactly -ParameterFilter { $Name -eq 'L$RpaRunnerBotPassword' }
    } finally { $env:RPA_TEST_ORDER = $null; $env:RPA_TEST_FILE = $null; $env:COMPUTERNAME = $computer }
    $lines = @(InModuleScope RpaInstall -Parameters @{ Result = $result } { Get-RpaUninstallSummary $Result })
    $lines | Should -Contain '  The settings -Unattended changed are back to what they were before.'
    $lines | Should -Contain '  Remote Desktop is off again, as it was before -Unattended turned it on.'
    ($lines -join "`n") | Should -Not -Match 'Automatic sign-in'
  }

  It 'Uninstall-Rpa.ps1 without install.json removes the stored password, and the service only when <Case>' -ForEach @(
    @{ Case = "it runs this install's RpaSupervisor.exe"; Path = '"C:\Program Files\RPA Runner\runner\RpaSupervisor.exe"'; Removed = 1 }
    @{ Case = 'it runs this install''s program (not one of another path)'; Path = '"C:\Other\RpaSupervisor.exe"'; Removed = 0 }
    @{ Case = 'it is there at all (not when there is none)'; Path = $null; Removed = 0 }
  ) {
    $env:RPA_TEST_FILE = Join-Path $TestDrive 'missing-install.json'
    $env:RPA_TEST_PATH = $Path
    Mock -ModuleName RpaInstall Get-RpaServicePath { $env:RPA_TEST_PATH }
    Mock -ModuleName RpaInstall Get-RpaLayout { @{ InstallDir = 'C:\Program Files\RPA Runner'; InstallFile = $env:RPA_TEST_FILE; DataDir = "$($env:RPA_TEST_FILE).data"; LeftoversFile = "$($env:RPA_TEST_FILE).list" } }
    Mock -ModuleName RpaInstall Stop-RpaServices { }
    Mock -ModuleName RpaInstall Get-RpaUninstallFacts { @{ Accounts = @(); RunningSids = @(); UnknownProcesses = @() } }
    Mock -ModuleName RpaInstall Remove-RpaBrowserTemp { }
    Mock -ModuleName RpaInstall Unregister-RpaTask { }
    Mock -ModuleName RpaInstall Remove-NetFirewallRule { }
    Mock -ModuleName RpaInstall Remove-RpaProgramFiles { }
    Mock -ModuleName RpaInstall Remove-RpaSupervisor { }
    Mock -ModuleName RpaInstall Remove-RpaLsaSecret { }
    try { $result = Invoke-RpaUninstall -Plan @{ Refusals = @() } 6>$null } finally { $env:RPA_TEST_FILE = $null; $env:RPA_TEST_PATH = $null }
    Should -Invoke -ModuleName RpaInstall Remove-RpaSupervisor -Times $Removed -Exactly
    Should -Invoke -ModuleName RpaInstall Remove-RpaLsaSecret -Times 1 -Exactly -ParameterFilter { $Name -eq 'L$RpaRunnerBotPassword' }
    $result.HadChanges | Should -BeFalse
  }

  It 'takes an earlier bot user out of Remote Desktop Users when this installer put it there, and drops its record' {
    Mock -ModuleName RpaInstall Remove-RpaGroupMember { }
    $file = Join-Path $TestDrive 'change-of-user.json'
    $changes = @(New-UnattendedChanges)
    $run = @{ Layout = @{ InstallFile = $file }; Sid = 'S-1-5-21-1-2-3-1002'; Install = [ordered]@{ version = '0.0.0'; user = 'bot2'; mode = 'unattended'; signInChanges = $changes } }
    InModuleScope RpaInstall -Parameters @{ Run = $run } { Remove-RpaEarlierRemoteDesktopUsers $Run }
    Should -Invoke -ModuleName RpaInstall Remove-RpaGroupMember -Times 1 -Exactly -ParameterFilter { $Group -eq 'S-1-5-32-555' -and $Member -eq 'S-1-5-21-1-2-3-1001' }
    $kept = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    @($kept.signInChanges | Where-Object { $_.kind -eq 'group' }).Count | Should -Be 0
    @($kept.signInChanges).Count | Should -Be 5
    # The same user: nothing to take out.
    $run = @{ Layout = @{ InstallFile = $file }; Sid = 'S-1-5-21-1-2-3-1001'; Install = [ordered]@{ version = '0.0.0'; signInChanges = @(New-UnattendedChanges) } }
    InModuleScope RpaInstall -Parameters @{ Run = $run } { Remove-RpaEarlierRemoteDesktopUsers $Run }
    Should -Invoke -ModuleName RpaInstall Remove-RpaGroupMember -Times 1 -Exactly
  }

  It 'the wait for the first sign-in only warns, also when the connection helper cannot be loaded' {
    Mock -ModuleName RpaInstall Add-RpaProbeType { throw 'Unable to find type [RpaProbe].' }
    $run = @{ Account = @{ Display = 'rpa-runner' }; Layout = @{ SupervisorDir = (Join-Path $TestDrive 'no-supervisor') } }
    $warnings = @(InModuleScope RpaInstall -Parameters @{ Run = $run } { Wait-RpaFirstSignIn $Run 8765 6>$null 3>&1 })
    $warnings.Count | Should -Be 1
    "$($warnings[0])" | Should -BeLike 'The runner did not answer through the RPA Supervisor within * s (Unable to find type `[RpaProbe`].).*'
  }

  It 'the connection helper is compiled on its own, so that a window with the helpers of an earlier installer gets it' {
    InModuleScope RpaInstall {
      (Get-Command Add-RpaNativeTypes).Definition | Should -Not -Match 'RpaProbe'
      (Get-Command Add-RpaProbeType).Definition | Should -Match "if \('RpaProbe' -as \[type\]\) \{ return \}"
    }
  }

  # Add-RpaMoveTypes is reached only on the move from automatic sign-in to -Unattended, and a connection helper that
  # does not compile gives only a warning: both are compiled here, and on Windows the move's helpers are called once.
  It 'the helpers for the move to -Unattended and the connection helper compile' {
    InModuleScope RpaInstall { Add-RpaMoveTypes; Add-RpaProbeType }
    foreach ($name in 'RpaSessions', 'RpaLsaRead', 'RpaProbe') { $name -as [type] | Should -Not -BeNullOrEmpty -Because $name }
  }

  It 'the helpers for the move to -Unattended find no session of an unknown user and no LSA secret of an unknown name' -Skip:($env:OS -ne 'Windows_NT') {
    InModuleScope RpaInstall { Add-RpaMoveTypes }
    @([RpaSessions]::OfUser('NO-SUCH-DOMAIN', 'no-such-user')).Count | Should -Be 0
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { Set-ItResult -Skipped -Because 'reading an LSA secret needs an administrator'; return }
    [RpaLsaRead]::Read('L$RpaNotThere') | Should -BeNullOrEmpty
  }
}

Describe 'Registry values in install.json' {
  # What the registry holds (the .NET kind and data) goes into install.json as a type and a value, and comes back
  # from there as the same data.
  It 'keeps <Why> so that it comes back the same' -ForEach @(
    @{ Why = 'an empty string'; Kind = 'String'; Type = 'REG_SZ'; Data = ''; Value = '' }
    @{ Why = 'a string with spaces and quotes'; Kind = 'String'; Type = 'REG_SZ'; Data = 'say "hi" to C:\Program Files\x /d %PATH%'; Value = 'say "hi" to C:\Program Files\x /d %PATH%' }
    @{ Why = 'a string with variables'; Kind = 'ExpandString'; Type = 'REG_EXPAND_SZ'; Data = '%SystemRoot%\system32'; Value = '%SystemRoot%\system32' }
    @{ Why = 'the number 0'; Kind = 'DWord'; Type = 'REG_DWORD'; Data = 0; Value = '0' }
    @{ Why = 'the largest 32-bit number'; Kind = 'DWord'; Type = 'REG_DWORD'; Data = -1; Value = '4294967295' }
    @{ Why = 'the largest 64-bit number'; Kind = 'QWord'; Type = 'REG_QWORD'; Data = [long]-1; Value = '18446744073709551615' }
    @{ Why = 'a list of strings'; Kind = 'MultiString'; Type = 'REG_MULTI_SZ'; Data = [string[]]@('one', 'two words'); Value = @('one', 'two words') }
    @{ Why = 'a list of one string'; Kind = 'MultiString'; Type = 'REG_MULTI_SZ'; Data = [string[]]@('one'); Value = @('one') }
    @{ Why = 'an empty list'; Kind = 'MultiString'; Type = 'REG_MULTI_SZ'; Data = [string[]]@(); Value = @() }
    @{ Why = 'bytes'; Kind = 'Binary'; Type = 'REG_BINARY'; Data = [byte[]]@(0, 16, 255); Value = '0010FF' }
    @{ Why = 'no bytes'; Kind = 'Binary'; Type = 'REG_BINARY'; Data = [byte[]]@(); Value = '' }
    @{ Why = 'bytes without a type'; Kind = 'None'; Type = 'REG_NONE'; Data = [byte[]]@(7); Value = '07' }
  ) {
    $recorded = InModuleScope RpaInstall -Parameters @{ Kind = $Kind; Data = $Data } { ConvertFrom-RpaRegistryData $Kind $Data }
    $recorded.type | Should -BeExactly $Type
    @($recorded.value) | Should -BeExactly @($Value)

    # Through install.json and back.
    $record = New-Object psobject -Property ([ordered]@{ kind = 'registry'; existed = $true; type = $recorded.type; value = $recorded.value })
    $read = (ConvertTo-Json -InputObject @{ signInChanges = @($record) } -Depth 5 | ConvertFrom-Json).signInChanges[0]
    $back = InModuleScope RpaInstall -Parameters @{ Read = $read } { , (ConvertTo-RpaRegistryData $Read.type $Read.value) }
    , $back | Should -BeOfType $Data.GetType()
    @($back).Count | Should -Be @($Data).Count
    for ($i = 0; $i -lt @($Data).Count; $i++) { @($back)[$i] | Should -BeExactly @($Data)[$i] }
  }

  It 'refuses a kind of value it does not record, and names the value' {
    { InModuleScope RpaInstall { ConvertFrom-RpaRegistryData 'Unknown' $null 'HKLM\SOFTWARE\Example' 'A' } } |
      Should -Throw -ExpectedMessage 'HKLM\SOFTWARE\Example A is a registry value of the kind Unknown, which the installer does not record.'
    { InModuleScope RpaInstall { ConvertTo-RpaRegistryData 'REG_LINK' 'x' } } | Should -Throw -ExpectedMessage '*not a registry type the installer writes*'
  }

  # reg.exe gets no data when the data is an empty string (Windows PowerShell 5.1 leaves it out of the command line).
  It 'the module uses reg.exe only to load and unload a registry file' {
    $source = $script:ModuleSource
    $uses = @([regex]::Matches($source, "reg\.exe @\('(\w+)'") | ForEach-Object { $_.Groups[1].Value })
    $uses | Should -BeExactly @('load', 'unload')
    $source | Should -Not -Match "'reg(\.exe)?'"
  }

  It 'writes values to the real registry and puts back what was there: an empty string, quotes, a number, a list, nothing' -Skip:($env:OS -ne 'Windows_NT') {
    $key = 'HKU\{0}\Software\RpaInstallTest-{1}' -f [Security.Principal.WindowsIdentity]::GetCurrent().User.Value, [guid]::NewGuid().ToString('N')
    try {
      InModuleScope RpaInstall -Parameters @{ Key = $key } {
        $before = @(
          @{ Name = 'empty'; Type = 'REG_SZ'; Value = '' }
          @{ Name = 'quoted'; Type = 'REG_SZ'; Value = 'say "hi" to C:\Program Files\x /d' }
          @{ Name = 'number'; Type = 'REG_DWORD'; Value = '4294967295' }
          @{ Name = 'list'; Type = 'REG_MULTI_SZ'; Value = @('a b', 'c') }
        )
        foreach ($value in $before) { Set-RpaRegistryValue $Key $value.Name $value.Type $value.Value }
        # The records as install.json keeps them, read back from its text.
        $records = @($before.Name + 'missing' | ForEach-Object { New-Object psobject -Property (Get-RpaRegistryRecord $Key $_) })
        $records = @((ConvertTo-Json -InputObject @{ signInChanges = $records } -Depth 5 | ConvertFrom-Json).signInChanges)
        ($records | Where-Object { $_.name -eq 'empty' }).value | Should -BeExactly ''
        ($records | Where-Object { $_.name -eq 'missing' }).existed | Should -BeFalse

        foreach ($record in $records) { Set-RpaRegistryValue $Key $record.name 'REG_SZ' 'changed by the test' }
        foreach ($record in $records) { Restore-RpaSignInChange $record }

        foreach ($value in $before) {
          $now = Get-RpaRegistryRecord $Key $value.Name
          $now.existed | Should -BeTrue
          $now.type | Should -BeExactly $value.Type
          @($now.value) | Should -BeExactly @($value.Value)
        }
        (Get-RpaRegistryRecord $Key 'missing').existed | Should -BeFalse
      }
    } finally {
      Remove-Item -LiteralPath ('Registry::HKEY_USERS\' + $key.Substring(4)) -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Describe 'New-RpaSecret' {
  It 'New-RpaSecret 48 gives 48 characters with an upper, a lower and a digit' {
    $secret = New-RpaSecret -Length 48
    $secret.Length | Should -Be 48
    ($secret -cmatch '[A-Z]') | Should -BeTrue
    ($secret -cmatch '[a-z]') | Should -BeTrue
    ($secret -cmatch '[0-9]') | Should -BeTrue
  }

  It 'uses only letters, digits, - and _, and no part of an account name Windows would refuse in a password' {
    foreach ($i in 1..20) {
      $secret = New-RpaSecret -Length 32
      ($secret -cmatch '^[A-Za-z0-9_-]{32}$') | Should -BeTrue
      ($secret -match 'rpa|runner|admin') | Should -BeFalse
    }
  }

  It 'gives a new value every time' {
    ((New-RpaSecret -Length 48) -ceq (New-RpaSecret -Length 48)) | Should -BeFalse
  }

  # PowerShell's module logging records the parameters of every command and what a pipeline hands to it.
  It 'sends no character of the secret through a pipeline or to a command' {
    $ast = (Get-Command New-RpaSecret).ScriptBlock.Ast
    @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.PipelineAst] -and $node.PipelineElements.Count -gt 1 }, $true)).Count | Should -Be 0
    $commands = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
    # Only the two empty arrays it fills.
    $commands | Should -BeExactly @('New-Object', 'New-Object')
  }

  It 'the module turns no plain text into a SecureString with a command' {
    $source = $script:ModuleSource
    $source | Should -Not -Match 'ConvertTo-SecureString'
    $source | Should -Not -Match 'AsPlainText'
  }
}

Describe 'Get-RpaAccount' {
  It 'takes a bare name, .\name and COMPUTER\name as a local user' {
    foreach ($user in 'rpa-runner', '.\rpa-runner', 'bot-pc\rpa-runner') {
      $account = Get-RpaAccount -User $user -ComputerName 'BOT-PC'
      $account.IsDomain | Should -BeFalse
      $account.Name | Should -BeExactly 'rpa-runner'
      $account.Qualified | Should -BeExactly 'BOT-PC\rpa-runner'
    }
  }

  It 'takes DOMAIN\name as a domain user' {
    $account = Get-RpaAccount -User 'CORP\svc-rpa' -ComputerName 'BOT-PC'
    $account.IsDomain | Should -BeTrue
    $account.Name | Should -BeExactly 'svc-rpa'
    $account.Domain | Should -BeExactly 'CORP'
    $account.Qualified | Should -BeExactly 'CORP\svc-rpa'
  }
}

Describe 'Show-RpaConnection.ps1' {
  BeforeAll {
    # A made-up install: <root>/install (install.json, scripts/) and <root>/data/RPA Runner (the log, the certificate,
    # the tokens). The runner port is listening, the browser port is not. Every key, certificate and token is made here.
    $script:Root = Join-Path ([IO.Path]::GetTempPath()) ('rpa-show-' + [guid]::NewGuid().ToString('N'))
    $script:MadeUpInstall = Join-Path $script:Root 'install'
    $scriptsDir = Join-Path $script:MadeUpInstall 'scripts'
    $script:MadeUpData = Join-Path (Join-Path $script:Root 'data') 'RPA Runner'
    $script:LogDir = Join-Path $script:MadeUpData 'logs'
    New-Item -ItemType Directory -Force -Path $scriptsDir, $script:LogDir | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $script:InstallerDir 'scripts') 'Show-RpaConnection.ps1') -Destination $scriptsDir
    $script:ShowScript = Join-Path $scriptsDir 'Show-RpaConnection.ps1'

    $script:Listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
    $script:Listener.Start()
    $script:RunnerPort = $script:Listener.LocalEndpoint.Port
    $closed = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
    $closed.Start()
    $script:BrowserPort = $closed.LocalEndpoint.Port
    $closed.Stop()
    $install = [ordered]@{ version = '0.0.0'; user = 'rpa-runner'; runnerPort = $script:RunnerPort; browserPort = $script:BrowserPort; browser = $true; autoSignIn = $false }
    $script:InstallJson = $install | ConvertTo-Json
    Set-Content -LiteralPath (Join-Path $script:MadeUpInstall 'install.json') -Value $script:InstallJson -Encoding UTF8

    function New-TestFingerprint {
      $bytes = New-Object byte[] 32
      $random = [Security.Cryptography.RandomNumberGenerator]::Create()
      try { $random.GetBytes($bytes) } finally { $random.Dispose() }
      ($bytes | ForEach-Object { $_.ToString('X2') }) -join ':'
    }
    # The runner's start line as RunnerLog writes it to its output: a UTC time, the level, the message.
    function New-StartLine([string]$Fingerprint) {
      "2026-11-09T10:15:30.123Z INFO RPA runner listening on wss://0.0.0.0:$($script:RunnerPort)/rpa/v1, fingerprint $Fingerprint"
    }
    $script:RunnerLog = Join-Path $script:LogDir 'runner.out.log'
    $script:RunnerFingerprint = New-TestFingerprint
    Set-Content -LiteralPath $script:RunnerLog -Value @(
      '2026-11-09T10:15:29.900Z INFO RPA runner 0.2.0 starting (data dir C:\ProgramData\RPA Runner, policy C:\ProgramData\RPA Runner\policy.json)'
      (New-StartLine $script:RunnerFingerprint)
    )

    $rsa = [Security.Cryptography.RSA]::Create(2048)
    try {
      $request = New-Object Security.Cryptography.X509Certificates.CertificateRequest('CN=rpa-test', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
      $sha256 = [Security.Cryptography.SHA256]::Create()
      try { $hash = $sha256.ComputeHash($certificate.RawData) } finally { $sha256.Dispose() }
      $script:BrowserFingerprint = ($hash | ForEach-Object { $_.ToString('X2') }) -join ':'
      $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($certificate.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"
      Set-Content -LiteralPath (Join-Path $script:MadeUpData 'browser-cert.pem') -Value $pem -NoNewline
      $certificate.Dispose()
    } finally { $rsa.Dispose() }

    $script:RunnerToken = 'runner-' + [guid]::NewGuid().ToString('N')
    $script:BrowserToken = 'browser-' + [guid]::NewGuid().ToString('N')
    Set-Content -LiteralPath (Join-Path $script:MadeUpData 'token') -Value $script:RunnerToken -NoNewline
    Set-Content -LiteralPath (Join-Path $script:MadeUpData 'browser-token') -Value $script:BrowserToken -NoNewline

    $script:ProgramDataBefore = $env:ProgramData
    $env:ProgramData = Join-Path $script:Root 'data'
    $script:Output = @(& $script:ShowScript)
  }

  AfterAll {
    $env:ProgramData = $script:ProgramDataBefore
    $script:Listener.Stop()
    Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
  }

  It 'prints the runner fingerprint from the start line in logs\runner.out.log' {
    $script:Output | Should -Contain "Runner fingerprint: $($script:RunnerFingerprint)"
  }

  It 'takes the first start line: a later line of the same form does not replace the fingerprint' {
    $forged = New-TestFingerprint
    Add-Content -LiteralPath $script:RunnerLog -Value @(
      '2026-11-09T10:20:00.000Z WARN unknown method x'
      (New-StartLine $forged)
    )
    try {
      $output = @(& $script:ShowScript)
      $output | Should -Contain "Runner fingerprint: $($script:RunnerFingerprint)"
      ($output -join "`n").Contains($forged) | Should -BeFalse
    } finally {
      Set-Content -LiteralPath $script:RunnerLog -Value (New-StartLine $script:RunnerFingerprint)
    }
  }

  It 'takes only a whole line in the form the runner writes: <Why>' -ForEach @(
    @{ Why = 'text before it'; Line = '2026-11-09T10:15:30.123Z WARN unknown method RPA runner listening on wss://0.0.0.0:1/rpa/v1, fingerprint {0}' }
    @{ Why = 'no time and level'; Line = 'RPA runner listening on wss://0.0.0.0:1/rpa/v1, fingerprint {0}' }
    @{ Why = 'text after it'; Line = '2026-11-09T10:15:30.123Z INFO RPA runner listening on wss://0.0.0.0:1/rpa/v1, fingerprint {0} and more' }
    @{ Why = 'another level'; Line = '2026-11-09T10:15:30.123Z WARN RPA runner listening on wss://0.0.0.0:1/rpa/v1, fingerprint {0}' }
  ) {
    $other = New-TestFingerprint
    Set-Content -LiteralPath $script:RunnerLog -Value ($Line -f $other)
    try {
      $output = @(& $script:ShowScript)
      $output | Should -Contain 'Runner fingerprint: not known yet (the program has not started)'
      ($output -join "`n").Contains($other) | Should -BeFalse
    } finally {
      Set-Content -LiteralPath $script:RunnerLog -Value (New-StartLine $script:RunnerFingerprint)
    }
  }

  It "prints the browser fingerprint: the SHA-256 of the certificate in browser-cert.pem" {
    $script:BrowserFingerprint | Should -Match '^([0-9A-F]{2}:){31}[0-9A-F]{2}$'
    $script:Output | Should -Contain "Browser fingerprint: $($script:BrowserFingerprint)"
  }

  It 'prints one runner URL and one browser URL for each IPv4 address' {
    $runner = @($script:Output | Where-Object { $_ -like 'Runner URL:*' })
    $browser = @($script:Output | Where-Object { $_ -like 'Browser URL:*' })
    $browser.Count | Should -Be $runner.Count
    foreach ($line in $runner) { $line | Should -Match "^Runner URL: wss://\d+\.\d+\.\d+\.\d+:$($script:RunnerPort)/rpa/v1$" }
    foreach ($line in $browser) { $line | Should -Match "^Browser URL: wss://\d+\.\d+\.\d+\.\d+:$($script:BrowserPort)$" }
  }

  It 'says which service is not listening and where its log is' {
    $script:Output | Should -Contain "Browser: not listening yet. It starts within a minute of the bot user's sign-in: run this again. If it stays like this, read $(Join-Path $script:LogDir 'browser.err.log')"
    @($script:Output | Where-Object { $_ -like 'Runner: not listening*' }).Count | Should -Be 0
  }

  # The runner writes its failures through RunnerLog to its output, so they are in runner.out.log.
  It 'names runner.out.log for a runner that is not listening' {
    $file = Join-Path $script:MadeUpInstall 'install.json'
    $closed = $script:InstallJson -replace ('"runnerPort":\s*{0}' -f $script:RunnerPort), ('"runnerPort": {0}' -f $script:BrowserPort)
    Set-Content -LiteralPath $file -Value $closed -Encoding UTF8
    try {
      $output = @(& $script:ShowScript)
      $output | Should -Contain "Runner: not listening yet. It starts within a minute of the bot user's sign-in: run this again. If it stays like this, read $(Join-Path $script:LogDir 'runner.out.log')"
    } finally {
      Set-Content -LiteralPath $file -Value $script:InstallJson -Encoding UTF8
    }
  }

  It 'prints no token without -ShowTokens' {
    $text = $script:Output -join "`n"
    $text.Contains($script:RunnerToken) | Should -BeFalse
    $text.Contains($script:BrowserToken) | Should -BeFalse
  }

  It 'says that RPA is not installed when install.json is missing' {
    $file = Join-Path $script:MadeUpInstall 'install.json'
    Remove-Item -LiteralPath $file
    try {
      $output = @(& $script:ShowScript)
      $output | Should -BeExactly @("RPA is not installed here: $file is missing. Run Install-Rpa.ps1 from the unpacked package.")
      $LASTEXITCODE | Should -Be 1
    } finally {
      Set-Content -LiteralPath $file -Value $script:InstallJson -Encoding UTF8
    }
  }

  # PowerShell's module logging records the parameters of every cmdlet, so a token must not be one.
  It 'writes the token lines through the host, not through a cmdlet or the pipeline' {
    $source = Get-Content -Raw -LiteralPath $script:ShowScript
    $source | Should -Match ([regex]::Escape('if ($ShowTokens) { $Host.UI.WriteLine((Get-TokenLine $service.Name $service.Token)) }'))
    @([regex]::Matches($source, 'Get-TokenLine')).Count | Should -Be 2
  }

  # The administrator check is a Windows one, and the desktop workflow runs these tests as an administrator. The token
  # lines go to the host, so the script runs in a Windows PowerShell of its own, whose output is read here, as a remote
  # command tool reads it.
  It 'prints both tokens with -ShowTokens, in the output of powershell.exe' -Skip:($env:OS -ne 'Windows_NT') {
    $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:ShowScript -ShowTokens)
    $LASTEXITCODE | Should -Be 0
    $output | Should -Contain "Runner token: $($script:RunnerToken)"
    $output | Should -Contain "Browser token: $($script:BrowserToken)"
    # In the order of the other lines: each token line follows the lines of its service.
    [array]::IndexOf($output, "Runner token: $($script:RunnerToken)") | Should -BeGreaterThan ([array]::IndexOf($output, "Runner fingerprint: $($script:RunnerFingerprint)"))
    [array]::IndexOf($output, "Browser token: $($script:BrowserToken)") | Should -BeGreaterThan ([array]::IndexOf($output, "Browser fingerprint: $($script:BrowserFingerprint)"))
  }

  It 'with -ShowTokens says which token file is missing and what to do' -Skip:($env:OS -ne 'Windows_NT') {
    $file = Join-Path $script:MadeUpData 'browser-token'
    Remove-Item -LiteralPath $file
    try {
      $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:ShowScript -ShowTokens)
      $output | Should -Contain "Browser token: $file is missing. Run Install-Rpa.ps1 again: it writes a token file that is missing."
      $output | Should -Contain "Runner token: $($script:RunnerToken)"
    } finally {
      Set-Content -LiteralPath $file -Value $script:BrowserToken -NoNewline
    }
  }

  It 'in the signed-in mode says nothing of a mode or a supervisor' {
    ($script:Output -join "`n") | Should -Not -Match 'Mode:|Supervisor'
  }

  Context 'the connection lines' {
    BeforeAll {
      # The script's own functions, defined here, for the parts that need no install.
      $ast = [Management.Automation.Language.Parser]::ParseFile($script:ShowScript, [ref]$null, [ref]$null)
      foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        . ([scriptblock]::Create($function.Extent.Text))
      }
      $script:Lines = Get-Content -Raw -LiteralPath $script:LinesFile | ConvertFrom-Json
      $script:Hidden = '<hidden: run with -ShowTokens>'
      # A fingerprint as the script reads it: upper-case pairs joined by colons.
      function ConvertTo-Pairs([string]$Hex) { (($Hex.ToUpperInvariant() -split '(..)') | Where-Object { $_ }) -join ':' }
      $script:TokenFile = Join-Path $script:Root 'line-token'
      $script:Machine = [Net.Dns]::GetHostName()
      $script:Hint = '& "{0}" connection -ShowTokens' -f (Join-Path $script:MadeUpInstall 'rpa.cmd')
    }

    It 'the shared samples hold at least six lines: a name, an IPv6 address, another port, an install without the browser' {
      $script:Lines.hiddenToken | Should -BeExactly $script:Hidden
      @($script:Lines.samples).Count | Should -BeGreaterOrEqual 6
      @($script:Lines.samples | Where-Object { $_.address -match '^[A-Za-z]' }).Count | Should -BeGreaterThan 0
      @($script:Lines.samples | Where-Object { $_.line -match '://\[[0-9a-f:]+\]:' }).Count | Should -BeGreaterThan 0
      @($script:Lines.samples | Where-Object { 8765, 3000 -notcontains $_.port }).Count | Should -BeGreaterThan 0
      @($script:Lines.samples | Where-Object { $_.description -match '-NoBrowser' }).Count | Should -BeGreaterThan 0
    }

    It 'makes each line of the shared samples: <description>' -ForEach $script:LineSamples {
      [IO.File]::WriteAllText($script:TokenFile, $token + "`r`n")
      $made = Get-ConnectionLine $kind (Get-ConnectionHost $address) $port (ConvertTo-Pairs $fingerprint) $script:TokenFile $true
      $made.Problem | Should -BeNullOrEmpty
      $made.Line | Should -BeExactly $line
      $made = Get-ConnectionLine $kind (Get-ConnectionHost $address) $port (ConvertTo-Pairs $fingerprint) $script:TokenFile $false
      $made.Line | Should -BeExactly ($line.Replace("token=$token", "token=$($script:Hidden)"))
    }

    It 'makes the hidden lines of the shared samples without reading a token' {
      Remove-Item -LiteralPath $script:TokenFile -ErrorAction SilentlyContinue
      foreach ($sample in $script:Lines.hidden) {
        $source = @($script:Lines.samples | Where-Object { $sample.line -eq $_.line.Replace("token=$($_.token)", "token=$($script:Hidden)") })
        $source.Count | Should -Be 1
        (Get-ConnectionLine $sample.kind (Get-ConnectionHost $source[0].address) $source[0].port (ConvertTo-Pairs $source[0].fingerprint) $script:TokenFile $false).Line | Should -BeExactly $sample.line
      }
    }

    It 'takes a host name, an IPv4 address or an IPv6 address, and nothing else, for -Address' {
      Get-ConnectionHost 'RPA-BOT-01' | Should -BeExactly 'RPA-BOT-01'
      Get-ConnectionHost 'rpa.corp.example' | Should -BeExactly 'rpa.corp.example'
      Get-ConnectionHost '203.0.113.10' | Should -BeExactly '203.0.113.10'
      Get-ConnectionHost 'fd00::20' | Should -BeExactly '[fd00::20]'
      Get-ConnectionHost '[fd00::20]' | Should -BeExactly '[fd00::20]'
      foreach ($bad in '', 'a b', 'host/path', 'host#x', 'user@host', 'host:8765', 'host?x', '-host', 'host-', '256.1.1.1', 'fe80::1%3', '[fd00::20', 'fd00::g', 'a&b', '"host"') {
        Get-ConnectionHost $bad | Should -BeNullOrEmpty -Because $bad
      }
    }

    It 'says what is wrong with a token that cannot go into a line, and never the token' {
      [IO.File]::WriteAllText($script:TokenFile, 'made up&token')
      $made = Get-ConnectionLine 'runner' 'RPA-BOT-01' 8765 (ConvertTo-Pairs ('ab' * 32)) $script:TokenFile $true
      $made.Line | Should -BeNullOrEmpty
      $made.Problem | Should -BeExactly 'the token holds a character that a connection line cannot carry; use the Token field'
      Remove-Item -LiteralPath $script:TokenFile
      $made = Get-ConnectionLine 'runner' 'RPA-BOT-01' 8765 (ConvertTo-Pairs ('ab' * 32)) $script:TokenFile $true
      $made.Line | Should -BeNullOrEmpty
      $made.Problem | Should -BeExactly 'the token cannot be read (see the Runner token line)'
    }

    It "prints a line for each program with the machine's name and the token hidden, above the separate lines, and says so" {
      $runner = 'rpa-runner://{0}:{1}/rpa/v1#token={2}&fingerprint={3}' -f $script:Machine, $script:RunnerPort, $script:Hidden, $script:RunnerFingerprint.Replace(':', '').ToLowerInvariant()
      $browser = 'rpa-browser://{0}:{1}/#token={2}&fingerprint={3}' -f $script:Machine, $script:BrowserPort, $script:Hidden, $script:BrowserFingerprint.Replace(':', '').ToLowerInvariant()
      $output = $script:Output
      $at = [array]::IndexOf($output, 'Runner connection line, for the Connection Line of the RPA Desktop Runner credential:')
      $at | Should -Be 0
      $output[$at + 1] | Should -BeExactly $runner
      $at = [array]::IndexOf($output, 'Browser connection line, for the Connection Line of the RPA Browser credential:')
      $at | Should -BeGreaterThan ([array]::IndexOf($output, "Runner fingerprint: $($script:RunnerFingerprint)"))
      $output[$at + 1] | Should -BeExactly $browser
      [array]::IndexOf($output, "Browser fingerprint: $($script:BrowserFingerprint)") | Should -BeGreaterThan ($at + 1)
      $output | Should -Contain ('The tokens are hidden in the lines (token={0}). For the lines to paste, run as an administrator: {1}' -f $script:Hidden, $script:Hint)
      $output[-1] | Should -BeExactly 'Where n8n reaches this machine by another name or address (a NAT, a tunnel), add -Address <that name or address>.'
    }

    It 'puts the address given with -Address into the lines, and into the command it names' {
      $output = @(& $script:ShowScript -Address 'fd00::20')
      $output[1] | Should -BeLike ('rpa-runner://`[fd00::20`]:{0}/rpa/v1#token=*' -f $script:RunnerPort)
      @($output | Where-Object { $_ -like 'rpa-browser://`[fd00::20`]:*' }).Count | Should -Be 1
      $output | Should -Contain ('The tokens are hidden in the lines (token={0}). For the lines to paste, run as an administrator: {1} -Address fd00::20' -f $script:Hidden, $script:Hint)
      ($output -join "`n") | Should -Not -Match 'add -Address'
    }

    It 'refuses an -Address that is not a host name or an IP address, and prints nothing else' {
      $output = @(& $script:ShowScript -Address 'evil.example/#token=x')
      $output | Should -BeExactly @('-Address: evil.example/#token=x is not a host name, an IPv4 address or an IPv6 address.')
      $LASTEXITCODE | Should -Be 1
    }

    It 'says that a line is not known yet while its fingerprint is not' {
      Set-Content -LiteralPath $script:RunnerLog -Value 'nothing yet'
      try {
        $output = @(& $script:ShowScript)
        $output | Should -Contain 'Runner connection line: not known yet (the program has not started)'
        @($output | Where-Object { $_ -like 'rpa-runner://*' }).Count | Should -Be 0
      } finally {
        Set-Content -LiteralPath $script:RunnerLog -Value (New-StartLine $script:RunnerFingerprint)
      }
    }

    # PowerShell's module logging records the parameters of every command, so a token must not be one.
    It 'writes a line with a token through the host, and reads the token inside the function that makes the line' {
      $source = Get-Content -Raw -LiteralPath $script:ShowScript
      $source | Should -Match ([regex]::Escape('if ($ShowTokens) { $Host.UI.WriteLine($made.Line) } else { Write-Output $made.Line }'))
      $source | Should -Match ([regex]::Escape('function Get-ConnectionLine([string]$Kind, [string]$HostName, [int]$Port, [string]$Fingerprint, [string]$TokenFile, [bool]$WithToken)'))
    }

    It 'prints both lines with their tokens with -ShowTokens, in the output of powershell.exe' -Skip:($env:OS -ne 'Windows_NT') {
      $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:ShowScript -ShowTokens -Address 203.0.113.10)
      $LASTEXITCODE | Should -Be 0
      $output | Should -Contain ('rpa-runner://203.0.113.10:{0}/rpa/v1#token={1}&fingerprint={2}' -f $script:RunnerPort, $script:RunnerToken, $script:RunnerFingerprint.Replace(':', '').ToLowerInvariant())
      $output | Should -Contain ('rpa-browser://203.0.113.10:{0}/#token={1}&fingerprint={2}' -f $script:BrowserPort, $script:BrowserToken, $script:BrowserFingerprint.Replace(':', '').ToLowerInvariant())
      ($output -join "`n") | Should -Not -Match 'tokens are hidden'
    }
  }

  Context 'rpa status' {
    It 'says whether each program listens, the mode and the sessions, and nothing n8n is given' {
      $output = @(& $script:ShowScript -Status)
      $LASTEXITCODE | Should -Be 0
      $output | Should -Contain ('Runner: listening on port {0}' -f $script:RunnerPort)
      $output | Should -Contain "Browser: not listening yet. It starts within a minute of the bot user's sign-in: run this again. If it stays like this, read $(Join-Path $script:LogDir 'browser.err.log')"
      $output | Should -Contain 'Mode: signed in. The runner and the browser run while rpa-runner is signed in.'
      @($output | Where-Object { $_ -like 'Sessions of rpa-runner: *' -or $_ -like 'Session of rpa-runner: *' }).Count | Should -BeGreaterThan 0
      ($output -join "`n") | Should -Not -Match 'URL|fingerprint|connection line|rpa-runner://|rpa-browser://|token'
    }

    It 'names automatic sign-in as the mode of an install that has it' {
      $file = Join-Path $script:MadeUpInstall 'install.json'
      Set-Content -LiteralPath $file -Value ($script:InstallJson -replace '"autoSignIn":\s*false', '"autoSignIn": true') -Encoding UTF8
      try { @(& $script:ShowScript -Status) | Should -Contain 'Mode: automatic sign-in. Windows signs rpa-runner in at every start of this machine.' }
      finally { Set-Content -LiteralPath $file -Value $script:InstallJson -Encoding UTF8 }
    }

    It 'refuses -ShowTokens and -Address, which are for the connection lines' {
      @(& $script:ShowScript -Status -ShowTokens) | Should -BeExactly @('-Status shows no connection values: give it without -ShowTokens and -Address.')
      $LASTEXITCODE | Should -Be 1
      @(& $script:ShowScript -Status -Address 'RPA-BOT-01') | Should -BeExactly @('-Status shows no connection values: give it without -ShowTokens and -Address.')
    }
  }

  # The RPA Supervisor is not registered where these tests run (it is registered only by an install with -Unattended).
  Context 'in unattended mode' {
    BeforeAll {
      $script:SupervisorDir = Join-Path $script:MadeUpData 'supervisor'
      $script:StateFile = Join-Path $script:SupervisorDir 'supervisor-state.json'
      $file = Join-Path $script:MadeUpInstall 'install.json'
      $install = $script:InstallJson | ConvertFrom-Json
      $install | Add-Member -NotePropertyName mode -NotePropertyValue 'unattended'
      $install | Add-Member -NotePropertyName idleSeconds -NotePropertyValue 15
      Set-Content -LiteralPath $file -Value ($install | ConvertTo-Json) -Encoding UTF8
      New-Item -ItemType Directory -Force -Path $script:SupervisorDir | Out-Null
    }
    AfterAll {
      Set-Content -LiteralPath (Join-Path $script:MadeUpInstall 'install.json') -Value $script:InstallJson -Encoding UTF8
      Remove-Item -LiteralPath $script:SupervisorDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "says the mode, whether the service runs, the bot user's sessions, the last failure and where the log is, and no token" {
      $failure = 'UserSignedIn: rpa-runner is signed in in a session the RPA Supervisor did not create (session 2); the connection is refused.'
      Set-Content -LiteralPath $script:StateFile -Value (@{ sessionId = $null; logonTime = $null; lastFailure = $failure } | ConvertTo-Json)
      # No service of that name, whatever this machine has: a function of the name the script calls stands in for the cmdlet.
      function global:Get-CimInstance { $null }
      try { $output = @(& $script:ShowScript) } finally { Remove-Item -LiteralPath function:\Get-CimInstance }
      $output | Should -Contain 'Mode: unattended. The RPA Supervisor signs rpa-runner in when n8n connects, and out 15 s after the last connection.'
      $output | Should -Contain "Supervisor: the service RPA Supervisor is not registered. Run Install-Rpa.ps1 -Unattended again."
      @($output | Where-Object { $_ -like 'Sessions of rpa-runner: *' -or $_ -like 'Session of rpa-runner: *' }).Count | Should -BeGreaterThan 0
      $output | Should -Contain "Supervisor's last failure: $failure"
      $output | Should -Contain "Supervisor log: $(Join-Path $script:SupervisorDir 'supervisor.log')"
      # What n8n needs stays as in the signed-in mode: the public ports, which the supervisor listens on.
      $output | Should -Contain "Runner fingerprint: $($script:RunnerFingerprint)"
      $text = $output -join "`n"
      $text.Contains($script:RunnerToken) | Should -BeFalse
      $text.Contains($script:BrowserToken) | Should -BeFalse
    }

    It 'says when no failure is recorded' {
      Set-Content -LiteralPath $script:StateFile -Value (@{ sessionId = 3; logonTime = '2026-11-10T10:00:00+00:00'; lastFailure = $null } | ConvertTo-Json)
      @(& $script:ShowScript) | Should -Contain "Supervisor's last failure: none recorded"
      Remove-Item -LiteralPath $script:StateFile
      @(& $script:ShowScript) | Should -Contain "Supervisor's last failure: none recorded"
    }

    # As for the bot user, or a window that is not run as administrator: the file is there and cannot be read.
    It 'says that the state file can be read by administrators only when it cannot read it, and goes on' {
      Set-Content -LiteralPath $script:StateFile -Value (@{ lastFailure = 'Timeout: made up.' } | ConvertTo-Json)
      if ($env:OS -eq 'Windows_NT') { & icacls.exe $script:StateFile /inheritance:r | Out-Null } else { & chmod 000 $script:StateFile }
      try {
        $output = @(& $script:ShowScript)
        $output | Should -Contain "Supervisor's last failure: $($script:StateFile) can be read by administrators only; run this from an administrator PowerShell."
        $output | Should -Contain "Supervisor log: $(Join-Path $script:SupervisorDir 'supervisor.log')"
        ($output -join "`n") | Should -Not -Match 'none recorded|made up'
      } finally {
        if ($env:OS -eq 'Windows_NT') { & icacls.exe $script:StateFile /reset | Out-Null } else { & chmod 644 $script:StateFile }
        Remove-Item -LiteralPath $script:StateFile -Force
      }
    }

    # A blocked supervisor still shows as running. The service is made up here: a function of the name the script calls
    # stands in for the cmdlet, with this test's own process as the service's.
    It 'says that sign-ins are blocked when the last failure of the running service says so, and not for one from before its start' {
      $blocked = 'WrongPassword: Windows refused the password of rpa-runner. No further sign-in is tried until the RPA Supervisor service is restarted.'
      Set-Content -LiteralPath $script:StateFile -Value (@{ lastFailure = $blocked } | ConvertTo-Json)
      function global:Get-CimInstance { [pscustomobject]@{ State = 'Running'; ProcessId = $PID } }
      try {
        $output = @(& $script:ShowScript)
        $output | Should -Contain 'Supervisor: running'
        $output | Should -Contain "Supervisor's last failure: $blocked"
        $output | Should -Contain "Supervisor: sign-ins are blocked until the service is restarted. Store the right password with Install-Rpa.ps1 -Unattended -UserPassword, which restarts it, or fix the cause and run: Restart-Service 'RPA Supervisor'"
        # Written before the service started: that block ended with the restart.
        (Get-Item -LiteralPath $script:StateFile).LastWriteTime = (Get-Process -Id $PID).StartTime.AddMinutes(-1)
        ((@(& $script:ShowScript)) -join "`n") | Should -Not -Match 'sign-ins are blocked'
      } finally {
        Remove-Item -LiteralPath function:\Get-CimInstance
        Remove-Item -LiteralPath $script:StateFile -Force
      }
    }
  }
}

# The short commands: rpa.cmd in the install folder runs scripts\rpa.ps1, which runs Show-RpaConnection.ps1 or
# RpaPolicy.exe. In a made-up install both are stand-ins that print what they were given, one argument per line.
Describe 'The rpa command' {
  BeforeAll {
    $script:RpaRoot = Join-Path ([IO.Path]::GetTempPath()) ('rpa-cmd-' + [guid]::NewGuid().ToString('N'))
    $install = Join-Path $script:RpaRoot 'RPA Runner'
    $scripts = Join-Path $install 'scripts'
    $runner = Join-Path $install 'runner'
    New-Item -ItemType Directory -Force -Path $scripts, $runner | Out-Null
    Copy-Item -LiteralPath (Join-Path $script:InstallerDir 'rpa.cmd') -Destination $install
    Copy-Item -LiteralPath (Join-Path (Join-Path $script:InstallerDir 'scripts') 'rpa.ps1') -Destination $scripts
    $script:RpaScript = Join-Path $scripts 'rpa.ps1'
    $script:RpaCmd = Join-Path $install 'rpa.cmd'
    # rpa.cmd starts it with -File, which reads -ShowTokens and -Address as parameters: so do these tests.
    $script:Shell = (Get-Process -Id $PID).Path
    Set-Content -LiteralPath (Join-Path $scripts 'Show-RpaConnection.ps1') -Value @'
param([switch]$ShowTokens, [string]$Address, [switch]$Status)
'Show-RpaConnection.ps1'
foreach ($name in @($PSBoundParameters.Keys | Sort-Object)) { '-{0} {1}' -f $name, $PSBoundParameters[$name] }
exit 4
'@
    # A stand-in for RpaPolicy.exe that prints each argument in brackets and exits with 3, as the tool does when the
    # answer is no.
    $script:PolicyTool = Join-Path $runner 'RpaPolicy.exe'
    if ($env:OS -eq 'Windows_NT') {
      Add-Type -OutputType ConsoleApplication -OutputAssembly $script:PolicyTool -TypeDefinition @'
public static class Program {
  public static int Main(string[] args) { foreach (string arg in args) System.Console.WriteLine("[" + arg + "]"); return 3; }
}
'@
    } else {
      [IO.File]::WriteAllText($script:PolicyTool, "#!/bin/sh`nfor a in `"`$@`"; do printf '[%s]\n' `"`$a`"; done`nexit 3`n")
      & chmod +x $script:PolicyTool
    }
    $script:Usage = @(
      'Usage:'
      '  rpa connection [-ShowTokens] [-Address <name or address>]   the lines and values for the n8n credentials'
      '  rpa status                                                 the programs, the mode and the sessions'
      '  rpa policy apply <file>                                    RpaPolicy.exe apply <file>: shows the change and asks'
    )
  }
  AfterAll { Remove-Item -LiteralPath $script:RpaRoot -Recurse -Force -ErrorAction SilentlyContinue }

  It 'rpa <Typed> runs <What>' -ForEach @(
    @{ Typed = 'connection'; Arguments = @('connection'); What = 'Show-RpaConnection.ps1'; Expected = @('Show-RpaConnection.ps1'); Code = 4 }
    @{ Typed = 'connection -ShowTokens -Address fd00::20'; Arguments = @('connection', '-ShowTokens', '-Address', 'fd00::20'); What = 'Show-RpaConnection.ps1 -ShowTokens -Address fd00::20'; Expected = @('Show-RpaConnection.ps1', '-Address fd00::20', '-ShowTokens True'); Code = 4 }
    @{ Typed = 'status'; Arguments = @('status'); What = 'Show-RpaConnection.ps1 -Status'; Expected = @('Show-RpaConnection.ps1', '-Status True'); Code = 4 }
    @{ Typed = 'policy apply <a path with spaces and = , ; & ^ %>'; Arguments = @('policy', 'apply', (Join-Path ([IO.Path]::GetTempPath()) 'rpa made up/a b/RPA recordings/x=1,2;3&4^5%6.json')); What = 'RpaPolicy.exe apply with the path as one argument'; Expected = @('[apply]', ('[{0}]' -f (Join-Path ([IO.Path]::GetTempPath()) 'rpa made up/a b/RPA recordings/x=1,2;3&4^5%6.json'))); Code = 3 }
  ) {
    $output = @(& $script:Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:RpaScript @Arguments)
    $output | Should -BeExactly $Expected
    $LASTEXITCODE | Should -Be $Code
  }

  It 'says how it is used for <Why>, and runs nothing' -ForEach @(
    @{ Why = 'no command'; Arguments = @() }
    @{ Why = 'another command'; Arguments = @('install') }
    @{ Why = 'policy without apply'; Arguments = @('policy', 'show', 'x.json') }
    @{ Why = 'policy apply without a file'; Arguments = @('policy', 'apply') }
    @{ Why = 'connection with more words'; Arguments = @('connection', 'now') }
    @{ Why = 'status with -ShowTokens'; Arguments = @('status', '-ShowTokens') }
    @{ Why = 'policy with -Address'; Arguments = @('policy', 'apply', 'x.json', '-Address', 'h') }
  ) {
    $output = @(& $script:Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:RpaScript @Arguments)
    $output | Should -BeExactly $script:Usage
    $LASTEXITCODE | Should -Be 1
  }

  It 'rpa.cmd hands its arguments over as they were typed, to Windows PowerShell by its full path' {
    $text = [IO.File]::ReadAllText((Join-Path $script:InstallerDir 'rpa.cmd'))
    $text | Should -Match ([regex]::Escape('"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rpa.ps1" %*'))
    $text | Should -Match ([regex]::Escape('exit /b %ERRORLEVEL%'))
    # Each argument split out again (%1, shift) would split a path at = , and ; and drop its quotes.
    $text | Should -Not -Match '%~?[1-9]|\bshift\b|\bgoto\b|^:'
    @([IO.File]::ReadAllBytes((Join-Path $script:InstallerDir 'rpa.cmd')) | Where-Object { $_ -gt 127 }).Count | Should -Be 0
  }

  It 'rpa.cmd in cmd.exe passes a quoted path with spaces, = , and ; to the policy tool as one argument' -Skip:($env:OS -ne 'Windows_NT') {
    $output = @(& (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') /d /c ('"{0}" policy apply "C:\Users\a b\RPA recordings\x=1,2;3.json"' -f $script:RpaCmd))
    $output | Should -BeExactly @('[apply]', '[C:\Users\a b\RPA recordings\x=1,2;3.json]')
    $LASTEXITCODE | Should -Be 3
    $output = @(& (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') /d /c ('"{0}" connection -ShowTokens' -f $script:RpaCmd))
    $output | Should -BeExactly @('Show-RpaConnection.ps1', '-ShowTokens True')
    $LASTEXITCODE | Should -Be 4
  }
}

# What start-runner.ps1 and start-browser.ps1 hand to their program, read from a made-up install: a start-loop.ps1 in
# its place prints the program's settings instead of starting it. Each runs in a PowerShell of its own.
Describe 'The start scripts' {
  BeforeAll {
    $script:StartRoot = Join-Path ([IO.Path]::GetTempPath()) ('rpa-start-' + [guid]::NewGuid().ToString('N'))
    $script:StartScripts = Join-Path (Join-Path $script:StartRoot 'install') 'scripts'
    New-Item -ItemType Directory -Force -Path $script:StartScripts | Out-Null
    foreach ($name in 'start-runner.ps1', 'start-browser.ps1') { Copy-Item -LiteralPath (Join-Path (Join-Path $script:InstallerDir 'scripts') $name) -Destination $script:StartScripts }
    Set-Content -LiteralPath (Join-Path $script:StartScripts 'start-loop.ps1') -Value @'
param($Name, $Label, $Exe, $Arguments, $WorkingDirectory, $Target)
if ($Name -eq 'runner') { 'port={0} bind={1}' -f $env:RPA_RUNNER_PORT, $env:RPA_RUNNER_BIND }
else { 'port={0} bind={1}' -f $env:RPA_BROWSER_PORT, $env:RPA_BROWSER_BIND }
'@
    $script:StartInstallFile = Join-Path (Join-Path $script:StartRoot 'install') 'install.json'
    $script:Shell = (Get-Process -Id $PID).Path
    function Invoke-StartScript([string]$Name, [hashtable]$Install) {
      $Install | ConvertTo-Json | Set-Content -LiteralPath $script:StartInstallFile -Encoding UTF8
      $saved = @{ Runner = $env:RPA_RUNNER_BIND; Browser = $env:RPA_BROWSER_BIND; ProgramData = $env:ProgramData }
      $env:RPA_RUNNER_BIND = $null; $env:RPA_BROWSER_BIND = $null; $env:ProgramData = $script:StartRoot
      try { @(& $script:Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $script:StartScripts $Name)) }
      finally { $env:RPA_RUNNER_BIND = $saved.Runner; $env:RPA_BROWSER_BIND = $saved.Browser; $env:ProgramData = $saved.ProgramData }
    }
  }
  AfterAll { Remove-Item -LiteralPath $script:StartRoot -Recurse -Force -ErrorAction SilentlyContinue }

  It '<Name> lets its program listen on <Expected> in the <Mode> mode' -ForEach @(
    @{ Name = 'start-runner.ps1'; Mode = 'signed-in'; Install = @{ runnerPort = 8765; browserPort = 3000; browser = $true; mode = 'signedIn' }; Expected = 'port=8765 bind=' }
    @{ Name = 'start-browser.ps1'; Mode = 'signed-in'; Install = @{ runnerPort = 8765; browserPort = 3000; browser = $true; mode = 'signedIn' }; Expected = 'port=3000 bind=' }
    @{ Name = 'start-runner.ps1'; Mode = 'signed-in (an install.json without a mode)'; Install = @{ runnerPort = 8765; browserPort = 3000; browser = $true }; Expected = 'port=8765 bind=' }
    @{ Name = 'start-runner.ps1'; Mode = 'unattended'; Install = @{ runnerPort = 8765; browserPort = 3000; browser = $true; mode = 'unattended'; runnerInnerPort = 18765; browserInnerPort = 13000 }; Expected = 'port=18765 bind=127.0.0.1' }
    @{ Name = 'start-browser.ps1'; Mode = 'unattended'; Install = @{ runnerPort = 8765; browserPort = 3000; browser = $true; mode = 'unattended'; runnerInnerPort = 18765; browserInnerPort = 13000 }; Expected = 'port=13000 bind=127.0.0.1' }
  ) {
    Invoke-StartScript $Name $Install | Should -BeExactly @($Expected)
  }
}

Describe 'The installer scripts' {
  BeforeDiscovery {
    $installerDir = Split-Path -Parent $PSScriptRoot
    # What the package ships: the files beside Install-Rpa.ps1 and those in scripts\.
    $scripts = @(Get-ChildItem -LiteralPath $installerDir, (Join-Path $installerDir 'scripts') -File |
        Where-Object { '.ps1', '.psm1', '.psd1' -contains $_.Extension } | ForEach-Object { @{ Name = $_.Name; Path = $_.FullName } })
  }

  # Windows PowerShell 5.1 runs them (the PowerShell that ships with Windows), while these tests may run in PowerShell 7.
  # 5.1 reads a file without a byte order mark in the system's code page, so only ASCII is safe, and it has no ?:, ??,
  # ?. or && and ||.
  It '<Name> is ASCII and parses without PowerShell 7 only syntax' -ForEach $scripts {
    @([IO.File]::ReadAllBytes($Path) | Where-Object { $_ -gt 127 }).Count | Should -Be 0

    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    @($errors).Count | Should -Be 0
    $newNodes = @($ast.FindAll({ param($node) 'TernaryExpressionAst', 'PipelineChainAst' -contains $node.GetType().Name }, $true))
    $newNodes.Count | Should -Be 0
    $newTokens = @($tokens | Where-Object { 'QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket' -contains $_.Kind.ToString() })
    $newTokens.Count | Should -Be 0
  }

  It 'are all there: the installer, the uninstaller, the module (a manifest and three files), rpa.cmd, the five installed scripts and Get-Rpa.ps1' {
    foreach ($name in @('Install-Rpa.ps1', 'Uninstall-Rpa.ps1', 'rpa.cmd') + $script:ModuleFiles) { Join-Path $script:InstallerDir $name | Should -Exist }
    # What a package holds beside Install-Rpa.ps1: exactly these. Get-Rpa.ps1 is published beside the zip, not in it.
    @(Get-ChildItem -LiteralPath $script:InstallerDir -File | ForEach-Object { $_.Name } | Sort-Object) | Should -BeExactly (@('Install-Rpa.ps1', 'Uninstall-Rpa.ps1', 'rpa.cmd', 'Get-Rpa.ps1') + $script:ModuleFiles | Sort-Object)
    foreach ($name in 'start-loop.ps1', 'start-runner.ps1', 'start-browser.ps1', 'Show-RpaConnection.ps1', 'rpa.ps1') { Join-Path (Join-Path $script:InstallerDir 'scripts') $name | Should -Exist }
  }

  It 'the manifest loads the three files into one module and exports what the scripts and these tests call' {
    $manifest = Import-PowerShellDataFile -LiteralPath (Join-Path $script:InstallerDir 'RpaInstall.psd1')
    $manifest.NestedModules | Should -BeExactly @('RpaInstall.Plan.ps1', 'RpaInstall.SignIn.ps1', 'RpaInstall.Machine.ps1')
    $manifest.ContainsKey('RootModule') | Should -BeFalse
    $module = Get-Module RpaInstall
    @($module).Count | Should -Be 1
    @($module.ExportedFunctions.Keys | Sort-Object) | Should -BeExactly @($manifest.FunctionsToExport | Sort-Object)
    foreach ($name in 'Get-RpaInstallPlan', 'Get-RpaMachineFacts', 'Invoke-RpaInstallPlan', 'Get-RpaUninstallPlan', 'Get-RpaUninstallFacts', 'Invoke-RpaUninstall', 'Get-RpaUninstallSummary', 'Get-RpaLayout', 'Test-RpaAdministrator') {
      $module.ExportedFunctions.Keys | Should -Contain $name
    }
    # A function of one file calls a function of another, and both see the same module variables.
    InModuleScope RpaInstall { (Get-Command Get-RpaChangeText).Module.Name; (Get-Command Get-RpaPathRefusal).Module.Name; (Get-Command Remove-RpaTree).Module.Name } | Should -BeExactly @('RpaInstall', 'RpaInstall', 'RpaInstall')
    InModuleScope RpaInstall { $script:TaskPath; $script:Winlogon; $script:RunnerTask } | Should -BeExactly @('\RPA\', 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon', 'RPA Runner')
  }

  It '<Name> holds no loop of its own and runs start-loop.ps1' -ForEach @(@{ Name = 'start-runner.ps1' }, @{ Name = 'start-browser.ps1' }) {
    $path = Join-Path (Join-Path $script:InstallerDir 'scripts') $Name
    $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
    @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.LoopStatementAst] }, $true)).Count | Should -Be 0
    (Get-Content -Raw -LiteralPath $path) | Should -Match "Join-Path \`$PSScriptRoot 'start-loop\.ps1'"
  }

  # The installer runs as an administrator; a tool found along PATH could come from a folder other users can write to.
  # Also what the bot user's tasks run at its logon: a program found along PATH there could be another user's.
  It '<Name> starts no Windows tool by its bare name' -ForEach $scripts {
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$null)
    $bare = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) |
        ForEach-Object { $_.GetCommandName() } | Where-Object { $_ -match '^(icacls|reg|powercfg|robocopy|cmd|schtasks|net|sc|takeown|shutdown|powershell|pwsh|node|fsutil|quser|logoff)(\.exe)?$' })
    $bare.Count | Should -Be 0
  }

  It 'the scheduled tasks start Windows PowerShell by its full path' {
    $source = $script:ModuleSource
    $source | Should -Not -Match "-Execute\s+'"
    $source | Should -Match '-Execute \(Get-RpaWindowsPowerShell\)'
    $path = InModuleScope RpaInstall { Get-RpaWindowsPowerShell }
    [IO.Path]::IsPathRooted($path) | Should -BeTrue
    $path | Should -Match 'WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$'
  }

  It '<Name> judges who can change its folder before it loads anything else from it' -ForEach @(@{ Name = 'Install-Rpa.ps1' }, @{ Name = 'Uninstall-Rpa.ps1' }) {
    $path = Join-Path $script:InstallerDir $Name
    $source = Get-Content -Raw -LiteralPath $path
    $refusal = $source.IndexOf("'{0} can be changed by {1}. Unpack the package in a folder only you or administrators can change, and run it from there.'")
    $refusal | Should -BeGreaterThan 0
    $source.IndexOf("'{0} is a link or junction. Unpack the package again and run the {1} from the new folder.'") | Should -BeGreaterThan 0
    $source.IndexOf("'Run the {2} from a folder on a local drive. {0} is on {1}.'") | Should -BeGreaterThan 0
    $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
    # The check is called, and its refusal ends the script, before the one place that loads the module.
    $check = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Test-Package' }, $true))
    $check.Count | Should -Be 1
    $loads = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and ($node.GetCommandName() -eq 'Import-Module' -or $node.InvocationOperator -eq 'Dot') }, $true))
    $loads.Count | Should -Be 1
    $loads[0].Extent.StartOffset | Should -BeGreaterThan $check[0].Extent.StartOffset
    $loads[0].Extent.StartOffset | Should -BeGreaterThan $refusal
  }

  # The check has to run before anything is loaded from the package, so it cannot live in a file of its own: each of
  # the two scripts carries it.
  It 'Install-Rpa.ps1 and Uninstall-Rpa.ps1 carry the same package check, word for word' {
    $blocks = foreach ($name in 'Install-Rpa.ps1', 'Uninstall-Rpa.ps1') {
      $source = (Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir $name)) -replace "`r`n", "`n"
      $begin = $source.IndexOf('# ---- package check: begin')
      $end = $source.IndexOf('# ---- package check: end')
      $begin | Should -BeGreaterThan 0
      $end | Should -BeGreaterThan $begin
      $source.Substring($begin, $end - $begin)
    }
    $blocks[0].Length | Should -BeGreaterThan 2000
    $blocks[1] | Should -BeExactly $blocks[0]
  }

  # Without it the exit code of a run that finished would be the one the last Windows tool left (robocopy's 1 means
  # it copied files).
  It '<Name> ends with exit 0 after its closing lines' -ForEach @(@{ Name = 'Install-Rpa.ps1' }, @{ Name = 'Uninstall-Rpa.ps1' }) {
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $script:InstallerDir $Name), [ref]$null, [ref]$null)
    $last = $ast.EndBlock.Statements[$ast.EndBlock.Statements.Count - 1]
    $last.Extent.Text | Should -BeExactly 'exit 0'
  }

  # An upgrade keeps the policy file; only a run that wrote it may call it new.
  It 'Install-Rpa.ps1 says that the policy allows no app only when this run wrote it' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'Install-Rpa.ps1')
    $source | Should -Match ([regex]::Escape("if (`$plan.Steps -contains 'write policy') { Write-Host ('             It is new and allows no app. Change it with {0}' -f `$policyTool) }"))
    $source | Should -Match ([regex]::Escape("else { Write-Host ('             It was there already and is kept as it is. Change it with {0}' -f `$policyTool) }"))
    $source | Should -Not -Match 'A new policy allows no app'
  }

  # The earlier bot user could read the tokens the plan replaced on a change of user.
  It 'Install-Rpa.ps1 says at its end when it replaced the tokens, and where the new ones are shown' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'Install-Rpa.ps1')
    $said = $source.IndexOf("if (`$plan.Steps -contains 'remove the old tokens') {")
    $said | Should -BeGreaterThan $source.IndexOf("Write-Host 'RPA is installed.'")
    $source.IndexOf("  if (-not `$browser) { Write-Host 'The runner token is new and the browser token is removed: the earlier bot user could read them.' }", $said) | Should -BeGreaterThan $said
    $source.IndexOf("  else { Write-Host 'Both tokens are new: the earlier bot user could read the old ones.' }", $said) | Should -BeGreaterThan $said
    $source.IndexOf("  Write-Host ('Update the n8n credentials with the new tokens, which & `"{0}`" connection -ShowTokens shows.' -f `$rpa)", $said) | Should -BeGreaterThan $said
  }

  # -WithBrowser, -NoBrowser and the install decide whether it has the browser; the plan says which, from the facts
  # about the package folder too, and the steps and the closing lines follow the plan.
  It 'Install-Rpa.ps1 gives the facts the package folder, and hands the plan''s browser on to the steps' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'Install-Rpa.ps1')
    $source | Should -Match ([regex]::Escape('(Get-RpaMachineFacts -Parameters $parameters -SourceDir $package)'))
    $handed = $source.IndexOf('$parameters.NoBrowser = -not $browser')
    $handed | Should -BeGreaterThan $source.IndexOf('$browser = [bool]$plan.Browser')
    $handed | Should -BeLessThan $source.IndexOf('Invoke-RpaInstallPlan -Plan $plan')
    # The closing lines say what the plan decided, not what was typed.
    $source.Substring($source.IndexOf("Write-Host 'RPA is installed.'")) | Should -Not -Match '\$NoBrowser|\$WithBrowser'
  }

  It 'says that it is checking before it reads the files of a package' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'Install-Rpa.ps1')
    $said = $source.IndexOf("Write-Host `"Checking the package's files...`"")
    $said | Should -BeGreaterThan 0
    $source.IndexOf('Get-PackageRefusal $', $said) | Should -BeGreaterThan $said
  }

  Context 'on Windows' {
    BeforeAll {
      # A copy of the installer in a folder of its own, under a folder whose access rules the tests set. The runs
      # below can install nothing: both ports are the same, which the plan refuses before any step.
      $script:Leaf = 'rpa-package-' + [guid]::NewGuid().ToString('N')
      $script:Area = Join-Path ([IO.Path]::GetTempPath()) $script:Leaf
      $script:Package = Join-Path $script:Area 'package'
      $script:Unpack = 'Unpack the package in a folder only you or administrators can change, and run it from there.'
      function Invoke-TestInstaller {
        $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $script:Package 'Install-Rpa.ps1') -RunnerPort 7 -BrowserPort 7 -AllowFromAnyAddress)
        @{ Output = $output; ExitCode = $LASTEXITCODE }
      }
      if ($env:OS -eq 'Windows_NT') {
        New-Item -ItemType Directory -Path $script:Area | Out-Null
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        & icacls.exe $script:Area /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$($me):(OI)(CI)F" | Out-Null
        New-Item -ItemType Directory -Path $script:Package, (Join-Path $script:Package 'scripts'), (Join-Path $script:Area 'elsewhere') | Out-Null
        Copy-Item -LiteralPath (@('Install-Rpa.ps1') + $script:ModuleFiles | ForEach-Object { Join-Path $script:InstallerDir $_ }) -Destination $script:Package
        Copy-Item -LiteralPath (Join-Path (Join-Path $script:InstallerDir 'scripts') 'start-loop.ps1') -Destination (Join-Path $script:Package 'scripts')
        $script:Users = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545').Translate([Security.Principal.NTAccount]).Value
      }
    }

    AfterAll {
      if (Test-Path -LiteralPath $script:Area) { & cmd.exe /d /c ('rd /s /q "{0}"' -f $script:Area) | Out-Null }
    }

    # The installer names real locations (long names, the case on disk), so the refusals are matched from the test's
    # own folder on, whatever form the temporary folder's path has.
    It 'Install-Rpa.ps1 runs from a package only administrators, SYSTEM and the person running it can change' -Skip:($env:OS -ne 'Windows_NT') {
      $run = Invoke-TestInstaller
      ($run.Output -join "`n") | Should -Not -Match 'can be changed by|is a link|local drive'
      $run.Output | Should -Contain '-RunnerPort and -BrowserPort are both 7. Give each its own port.'
      $run.ExitCode | Should -Be 1
    }

    It 'Install-Rpa.ps1 refuses a package with one file that other users can change' -Skip:($env:OS -ne 'Windows_NT') {
      $file = Join-Path (Join-Path $script:Package 'scripts') 'start-loop.ps1'
      & icacls.exe $file /grant '*S-1-5-32-545:M' | Out-Null
      try {
        $run = Invoke-TestInstaller
        $run.Output.Count | Should -Be 3
        $run.Output[0] | Should -BeExactly "Checking the package's files..."
        $run.Output[1] | Should -Match ([regex]::Escape("$($script:Leaf)\package\scripts\start-loop.ps1 can be changed by $($script:Users). $($script:Unpack)") + '$')
        $run.Output[2] | Should -BeExactly 'Nothing was changed.'
        $run.ExitCode | Should -Be 1
      } finally { & icacls.exe $file /remove '*S-1-5-32-545' | Out-Null }
    }

    It 'Install-Rpa.ps1 refuses a package with a junction in it' -Skip:($env:OS -ne 'Windows_NT') {
      $junction = Join-Path $script:Package 'runner'
      & cmd.exe /d /c ('mklink /J "{0}" "{1}"' -f $junction, (Join-Path $script:Area 'elsewhere')) | Out-Null
      try {
        $run = Invoke-TestInstaller
        $run.Output.Count | Should -Be 3
        $run.Output[0] | Should -BeExactly "Checking the package's files..."
        $run.Output[1] | Should -Match ([regex]::Escape("$($script:Leaf)\package\runner is a link or junction. Unpack the package again and run the installer from the new folder.") + '$')
        $run.ExitCode | Should -Be 1
      } finally { & cmd.exe /d /c ('rd "{0}"' -f $junction) | Out-Null }
    }

    It 'Install-Rpa.ps1 refuses a package in a folder where other users may delete what is in it' -Skip:($env:OS -ne 'Windows_NT') {
      & icacls.exe $script:Area /grant '*S-1-5-32-545:(DC)' | Out-Null
      try {
        $run = Invoke-TestInstaller
        $run.Output.Count | Should -Be 3
        $run.Output[0] | Should -BeExactly "Checking the package's files..."
        $run.Output[1] | Should -Match ([regex]::Escape("$($script:Leaf) can be changed by $($script:Users). $($script:Unpack)") + '$')
        $run.ExitCode | Should -Be 1
      } finally { & icacls.exe $script:Area /remove '*S-1-5-32-545' | Out-Null }
    }

    It 'Install-Rpa.ps1 judges a package reached through a junction by where it really is' -Skip:($env:OS -ne 'Windows_NT') {
      # <area>\elsewhere\via is a junction to <area>; the installer is started as <area>\elsewhere\via\package\...
      $via = Join-Path (Join-Path $script:Area 'elsewhere') 'via'
      $file = Join-Path $script:Package 'RpaInstall.Plan.ps1'
      & cmd.exe /d /c ('mklink /J "{0}" "{1}"' -f $via, $script:Area) | Out-Null
      try {
        $started = Join-Path (Join-Path $via 'package') 'Install-Rpa.ps1'
        $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $started -RunnerPort 7 -BrowserPort 7 -AllowFromAnyAddress)
        $output | Should -Contain '-RunnerPort and -BrowserPort are both 7. Give each its own port.'

        & icacls.exe $file /grant '*S-1-5-32-545:M' | Out-Null
        $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $started -RunnerPort 7 -BrowserPort 7 -AllowFromAnyAddress)
        $output[1] | Should -Match ([regex]::Escape("$($script:Leaf)\package\RpaInstall.Plan.ps1 can be changed by $($script:Users). $($script:Unpack)") + '$')
        $output[1] | Should -Not -Match 'via'
      } finally {
        & icacls.exe $file /remove '*S-1-5-32-545' | Out-Null
        & cmd.exe /d /c ('rd "{0}"' -f $via) | Out-Null
      }
    }

    It 'Install-Rpa.ps1 refuses a package folder that other users can change' -Skip:($env:OS -ne 'Windows_NT') {
      & icacls.exe $script:Package /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
      $run = Invoke-TestInstaller
      $run.Output.Count | Should -Be 3
      $run.Output[1] | Should -Match ([regex]::Escape("$($script:Leaf)\package can be changed by $($script:Users). $($script:Unpack)") + '$')
      $run.ExitCode | Should -Be 1
    }

    # Refused before the module is loaded and before anything is removed; a package that passes is not tried here,
    # because the uninstaller would then remove an install from the machine the tests run on.
    It 'Uninstall-Rpa.ps1 run from a package that other users can change is refused' -Skip:($env:OS -ne 'Windows_NT') {
      Copy-Item -LiteralPath (Join-Path $script:InstallerDir 'Uninstall-Rpa.ps1') -Destination $script:Package
      & icacls.exe $script:Package /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
      $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $script:Package 'Uninstall-Rpa.ps1'))
      $LASTEXITCODE | Should -Be 1
      $output.Count | Should -Be 3
      $output[0] | Should -BeExactly "Checking the package's files..."
      $output[1] | Should -Match ([regex]::Escape("$($script:Leaf)\package can be changed by $($script:Users). $($script:Unpack)") + '$')
      $output[2] | Should -BeExactly 'Nothing was changed.'
    }
  }
}

# Get-Rpa.ps1, published beside the zip: what it decides, from its own functions (dot-sourced, the script does nothing
# else), and the unpack from a made-up zip in a temporary folder.
Describe 'Get-Rpa.ps1' {
  BeforeAll {
    $script:GetRpa = Join-Path $script:InstallerDir 'Get-Rpa.ps1'
    . $script:GetRpa
    $script:GetRoot = Join-Path ([IO.Path]::GetTempPath()) ('rpa-get-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:GetRoot | Out-Null
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

    # A zip of the package's shape: rpa-windows-x64\VERSION, an Install-Rpa.ps1 and whatever -Entries adds, and its
    # .sha256 file as Stage.ps1 writes it (or with -Sha256).
    function New-TestZip([string]$Name, [string]$Version = '0.3.0', [string[]]$Entries = @(), [string]$Sha256) {
      $folder = Join-Path $script:GetRoot ('zip-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $folder | Out-Null
      $zip = Join-Path $folder $Name
      $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
      try {
        foreach ($entry in @('rpa-windows-x64/VERSION', 'rpa-windows-x64/Install-Rpa.ps1') + $Entries) {
          $writer = New-Object IO.StreamWriter ($archive.CreateEntry($entry).Open())
          try { if ($entry -like '*VERSION') { $writer.Write($Version + "`r`n") } else { $writer.Write("'made up'") } } finally { $writer.Dispose() }
        }
      } finally { $archive.Dispose() }
      if (-not $Sha256) { $Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() }
      [IO.File]::WriteAllText($zip + '.sha256', ('{0}  rpa-windows-x64.zip' -f $Sha256))
      @{ Zip = $zip; Sha = $zip + '.sha256'; Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() }
    }
    # The browser package's zip: browser\VERSION, a browser file and the start script, at the top (it is unpacked into
    # the package folder), and whatever -Entries adds.
    function New-TestBrowserZip([string]$Version = '0.3.0', [string[]]$Entries = @(), [string]$Sha256) {
      $folder = Join-Path $script:GetRoot ('zip-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $folder | Out-Null
      $zip = Join-Path $folder 'rpa-browser-windows-x64.zip'
      $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
      try {
        foreach ($entry in @('browser/VERSION', 'browser/node.exe', 'scripts/start-browser.ps1') + $Entries) {
          $writer = New-Object IO.StreamWriter ($archive.CreateEntry($entry).Open())
          try { if ($entry -like '*VERSION') { $writer.Write($Version + "`r`n") } else { $writer.Write("'made up'") } } finally { $writer.Dispose() }
        }
      } finally { $archive.Dispose() }
      if (-not $Sha256) { $Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() }
      [IO.File]::WriteAllText($zip + '.sha256', ('{0}  rpa-browser-windows-x64.zip' -f $Sha256))
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
      @{ Zip = $zip; Sha = $zip + '.sha256'; Hash = $hash; Spec = @{ ZipPath = $zip; ShaPath = $zip + '.sha256'; Named = '' } }
    }
    $script:NoAttestation = { param($Zip, $Version) $null }
    $script:Other = 'ab' * 32
  }
  AfterAll { Remove-Item -LiteralPath $script:GetRoot -Recurse -Force -ErrorAction SilentlyContinue }

  It 'dot-sourced, defines its functions and does nothing else' {
    Get-Command Expand-RpaPackage, Get-RpaInstallArguments, Get-RpaPublishedHash -CommandType Function | Should -HaveCount 3
  }

  It 'downloads from the release it belongs to, at an address written in the script' {
    Get-RpaDownloadUrl '0.3.0' 'rpa-windows-x64.zip' | Should -BeExactly 'https://github.com/jb-n8n/n8n-nodes-rpa/releases/download/desktop-v0.3.0/rpa-windows-x64.zip'
    Get-RpaDownloadUrl '0.3.0' 'rpa-windows-x64.zip.sha256' | Should -BeExactly 'https://github.com/jb-n8n/n8n-nodes-rpa/releases/download/desktop-v0.3.0/rpa-windows-x64.zip.sha256'
    # Only the script's own values: no parameter names an address, and the copy in the repository names no release.
    $ast = [Management.Automation.Language.Parser]::ParseFile($script:GetRpa, [ref]$null, [ref]$null)
    @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) | Should -Not -Contain 'Url'
    # Unix line ends: in a Windows checkout a line ends in CRLF, and $ does not match before the CR.
    $source = (Get-Content -Raw -LiteralPath $script:GetRpa) -replace "`r`n", "`n"
    ([regex]::Matches($source, "(?m)^\`$Version = ''$")).Count | Should -Be 1
    ([regex]::Matches($source, "(?m)^\`$PackageSha256 = ''$")).Count | Should -Be 1
    ([regex]::Matches($source, "(?m)^\`$BrowserPackageSha256 = ''$")).Count | Should -Be 1
    # The zip and its .sha256, and the browser zip and its .sha256: all from the release.
    @([regex]::Matches($source, 'Invoke-WebRequest')).Count | Should -Be 4
    @([regex]::Matches($source, 'Invoke-WebRequest -UseBasicParsing -Uri \(Get-RpaDownloadUrl \$Version ')).Count | Should -Be 4
  }

  It 'takes the parameters of Install-Rpa.ps1, with their types and checks, and three of its own' {
    $own = [Management.Automation.Language.Parser]::ParseFile($script:GetRpa, [ref]$null, [ref]$null).ParamBlock.Parameters
    $installer = [Management.Automation.Language.Parser]::ParseFile((Join-Path $script:InstallerDir 'Install-Rpa.ps1'), [ref]$null, [ref]$null).ParamBlock.Parameters
    $texts = @($own | ForEach-Object { $_.Extent.Text })
    foreach ($parameter in $installer) { $texts | Should -Contain $parameter.Extent.Text }
    @($own | ForEach-Object { $_.Name.VariablePath.UserPath } | Where-Object { @($installer | ForEach-Object { $_.Name.VariablePath.UserPath }) -notcontains $_ }) | Should -BeExactly @('Zip', 'BrowserZip', 'RequireAttestation')
  }

  It 'passes on to Install-Rpa.ps1 exactly what it was given, a password as the same SecureString, and -Unattended:$false as given' {
    $paramBlock = [Management.Automation.Language.Parser]::ParseFile($script:GetRpa, [ref]$null, [ref]$null).ParamBlock.Extent.Text
    $capture = [scriptblock]::Create("[CmdletBinding()]`n$paramBlock`n`$PSBoundParameters")
    $installerBlock = [Management.Automation.Language.Parser]::ParseFile((Join-Path $script:InstallerDir 'Install-Rpa.ps1'), [ref]$null, [ref]$null).ParamBlock.Extent.Text
    $fake = [scriptblock]::Create("[CmdletBinding()]`n$installerBlock`n" + '$PSBoundParameters.Keys | Sort-Object | ForEach-Object { "{0}={1}" -f $_, (@($PSBoundParameters[$_]) -join ",") }; if ($UserPassword) { [object]::ReferenceEquals($UserPassword, $script:Secure) }')
    $script:Secure = New-Object Security.SecureString
    $bound = & $capture -AllowFrom 10.0.0.5, 10.0.0.6 -Unattended:$false -UserPassword $script:Secure -IdleSeconds 30 -Zip 'C:\x.zip' -BrowserZip 'C:\b.zip' -WithBrowser -RequireAttestation -Force
    $arguments = Get-RpaInstallArguments $bound
    @($arguments.Keys | Sort-Object) | Should -BeExactly @('AllowFrom', 'Force', 'IdleSeconds', 'Unattended', 'UserPassword', 'WithBrowser')
    & $fake @arguments | Should -BeExactly @('AllowFrom=10.0.0.5,10.0.0.6', 'Force=True', 'IdleSeconds=30', 'Unattended=False', 'UserPassword=System.Security.SecureString', 'WithBrowser=True', 'True')
    # Nothing given, nothing passed: Install-Rpa.ps1 keeps its own defaults.
    (Get-RpaInstallArguments (& $capture)).Count | Should -Be 0
  }

  It 'shows what it passes on without the password' {
    $arguments = [ordered]@{ AllowFrom = @('10.0.0.5', '10.0.0.6'); UserPassword = (New-Object Security.SecureString); Unattended = [switch]$false; NoBrowser = [switch]$true; RunnerPort = 9000; User = 'bot 2' }
    Format-RpaInstallArguments $arguments | Should -BeExactly "-User 'bot 2' -UserPassword (given) -RunnerPort 9000 -AllowFrom 10.0.0.5,10.0.0.6 -NoBrowser -Unattended:`$false"
  }

  It 'reads the SHA-256 at the start of a .sha256 file, and nothing else' {
    Get-RpaPublishedHash ('{0}  rpa-windows-x64.zip' -f ('AB' * 32)) | Should -BeExactly ('ab' * 32)
    Get-RpaPublishedHash ("{0} *rpa-windows-x64.zip`r`nmore" -f ('ab' * 32)) | Should -BeExactly ('ab' * 32)
    foreach ($bad in '', 'abc  rpa-windows-x64.zip', ('{0}0  rpa-windows-x64.zip' -f ('ab' * 32)), ('  {0}' -f ('ab' * 32)), ('g' * 64)) { Get-RpaPublishedHash $bad | Should -BeNullOrEmpty }
  }

  It 'gets the browser zip with -WithBrowser, or for an install that has the browser unless -NoBrowser, and says what -Zip then needs' {
    $both = '-WithBrowser and -NoBrowser cannot be used together: -WithBrowser adds the browser, -NoBrowser leaves it out or removes it. Choose one.'
    # -WithBrowser, -NoBrowser, -Zip, -BrowserZip, the install has the browser: Get, Refusal.
    foreach ($case in @(
        ,@($false, $false, '', '', $false, $false, $null)
        ,@($true, $false, '', '', $false, $true, $null)
        ,@($false, $false, '', '', $true, $true, $null)
        ,@($false, $true, '', '', $true, $false, $null)
        ,@($true, $true, '', '', $false, $false, $both)
        ,@($true, $false, 'C:\x.zip', 'C:\b.zip', $false, $true, $null)
        ,@($true, $false, 'C:\x.zip', '', $false, $true, '-Zip with -WithBrowser needs -BrowserZip <path>: the path of rpa-browser-windows-x64.zip, with its .sha256 file beside it.')
        ,@($false, $false, 'C:\x.zip', '', $true, $true, 'This install has the browser, so -Zip needs -BrowserZip <path> too: the path of rpa-browser-windows-x64.zip, with its .sha256 file beside it. Or remove the browser with -NoBrowser.')
        ,@($false, $true, 'C:\x.zip', '', $true, $false, $null)
        ,@($true, $false, '', 'C:\b.zip', $false, $true, '-BrowserZip goes with -Zip. Without -Zip, Get-Rpa.ps1 downloads the browser zip from the release.')
        ,@($false, $false, 'C:\x.zip', 'C:\b.zip', $false, $false, '-BrowserZip is for an install with the browser. Add -WithBrowser, or leave -BrowserZip out.')
      )) {
      $choice = Get-RpaBrowserChoice $case[0] $case[1] $case[2] $case[3] $case[4]
      "$($case[0..4] -join ' ') -> $($choice.Get) $($choice.Refusal)" | Should -BeExactly "$($case[0..4] -join ' ') -> $($case[5]) $($case[6])"
    }
  }

  # The last check before the installer starts, on the unpacked folder first, then on each folder above it. Both cases
  # here are refused at the folder itself, whatever the folders above the temporary folder allow.
  It 'on Windows: refuses an unpacked folder that other users can change, and one that is a junction' -Skip:($env:OS -ne 'Windows_NT') {
    $folder = Join-Path $script:GetRoot ('unpacked-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $folder | Out-Null
    & icacls.exe $folder /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
    $users = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545').Translate([Security.Principal.NTAccount]).Value
    Get-RpaFolderRefusal $folder | Should -BeExactly ('{0} can be changed by {1}, so the installer is not started from it. Give that folder the access rules of C:\Program Files.' -f $folder, $users)
    $link = Join-Path $script:GetRoot ('link-' + [guid]::NewGuid().ToString('N'))
    $cmd = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    & $cmd /d /c ('mklink /J "{0}" "{1}"' -f $link, $folder) | Out-Null
    try {
      Get-RpaFolderRefusal $link | Should -BeExactly ('{0} is a link or junction, so the installer is not started from it.' -f $link)
    } finally { & $cmd /d /c ('rd "{0}"' -f $link) | Out-Null }
  }

  Context 'the unpack' {
    It 'unpacks a zip whose SHA-256 is the one beside it into <root>\<version>, and says which version' {
      $zip = New-TestZip 'rpa-windows-x64.zip'
      $root = Join-Path $script:GetRoot 'ok'
      $result = Expand-RpaPackage $zip.Zip $zip.Sha '' '' $root $script:NoAttestation
      $result.Version | Should -BeExactly '0.3.0'
      $result.Hash | Should -BeExactly $zip.Hash
      $result.Package | Should -BeExactly (Join-Path (Join-Path $root '0.3.0') 'rpa-windows-x64')
      Join-Path $result.Package 'Install-Rpa.ps1' | Should -Exist
    }

    It 'with the version and the SHA-256 the release wrote into the script, needs the zip to have both' {
      $zip = New-TestZip 'rpa-windows-x64.zip'
      $root = Join-Path $script:GetRoot 'named'
      (Expand-RpaPackage $zip.Zip $zip.Sha $zip.Hash '0.3.0' $root $script:NoAttestation).Version | Should -BeExactly '0.3.0'
      $root = Join-Path $script:GetRoot 'named-other'
      { Expand-RpaPackage $zip.Zip $zip.Sha $script:Other '0.3.0' $root $script:NoAttestation } | Should -Throw -ExpectedMessage ("The SHA-256 of $($zip.Zip) is $($zip.Hash), and this Get-Rpa.ps1 of release 0.3.0 names $($script:Other). Nothing was unpacked: do not use this zip.")
      Test-Path -LiteralPath $root | Should -BeFalse
      { Expand-RpaPackage $zip.Zip $zip.Sha '' '0.4.0' $root $script:NoAttestation } | Should -Throw -ExpectedMessage ("$($zip.Zip) holds version 0.3.0, and this Get-Rpa.ps1 is for version 0.4.0. Nothing was unpacked.")
      Test-Path -LiteralPath $root | Should -BeFalse
    }

    It 'stops before anything is unpacked when <Why>' -ForEach @(
      @{ Why = 'the SHA-256 differs from the one beside the zip'; Sha256 = 'cd' * 32; Entries = @(); Expected = 'The SHA-256 of {0} is {1}, and {2} says {3}: the zip is not the file published beside it. Nothing was unpacked: do not use this zip.' }
      @{ Why = 'the .sha256 file holds no SHA-256'; Sha256 = 'not-a-hash'; Entries = @(); Expected = '{2} does not start with a SHA-256 (64 hexadecimal digits). Nothing was unpacked.' }
      @{ Why = 'an entry is outside the package folder'; Sha256 = ''; Entries = @('rpa-windows-x64/../../evil.ps1'); Expected = '{0} holds rpa-windows-x64/../../evil.ps1, which is not inside rpa-windows-x64\. Nothing was unpacked: do not use this zip.' }
      @{ Why = 'an entry is beside the package folder'; Sha256 = ''; Entries = @('evil.ps1'); Expected = '{0} holds evil.ps1, which is not inside rpa-windows-x64\. Nothing was unpacked: do not use this zip.' }
      @{ Why = 'an entry names a drive'; Sha256 = ''; Entries = @('rpa-windows-x64/C:evil.ps1'); Expected = '{0} holds rpa-windows-x64/C:evil.ps1, which is not inside rpa-windows-x64\. Nothing was unpacked: do not use this zip.' }
    ) {
      $zip = New-TestZip 'rpa-windows-x64.zip' -Entries $Entries -Sha256 $Sha256
      $root = Join-Path $script:GetRoot ('stop-' + [guid]::NewGuid().ToString('N'))
      { Expand-RpaPackage $zip.Zip $zip.Sha '' '' $root $script:NoAttestation } | Should -Throw -ExpectedMessage ($Expected -f $zip.Zip, $zip.Hash, $zip.Sha, $Sha256)
      Test-Path -LiteralPath $root | Should -BeFalse
    }

    It 'stops before anything is unpacked when the attestation check refuses, and gives that check the version and the zip' {
      $zip = New-TestZip 'rpa-windows-x64.zip'
      $root = Join-Path $script:GetRoot 'attest'
      $script:Asked = $null
      $refuse = { param($Zip, $Version) $script:Asked = '{0} {1}' -f $Zip, $Version; 'made-up refusal.' }
      { Expand-RpaPackage $zip.Zip $zip.Sha '' '' $root $refuse } | Should -Throw -ExpectedMessage 'made-up refusal. Nothing was unpacked.'
      $script:Asked | Should -BeExactly ('{0} 0.3.0' -f $zip.Zip)
      Test-Path -LiteralPath $root | Should -BeFalse
    }

    It 'does not unpack into a folder that is there already' {
      $zip = New-TestZip 'rpa-windows-x64.zip'
      $root = Join-Path $script:GetRoot 'there'
      New-Item -ItemType Directory -Path (Join-Path $root '0.3.0') | Out-Null
      $folder = Join-Path $root '0.3.0'
      { Expand-RpaPackage $zip.Zip $zip.Sha '' '' $root $script:NoAttestation } | Should -Throw -ExpectedMessage ("$folder exists already. To install from it, run $(Join-Path (Join-Path $folder 'rpa-windows-x64') 'Install-Rpa.ps1') with the same parameters; to unpack again, remove $folder first.")
      @(Get-ChildItem -LiteralPath $folder).Count | Should -Be 0
    }

    It 'hashes and unpacks the zip through one handle that nobody can write through meanwhile' {
      $zip = New-TestZip 'rpa-windows-x64.zip'
      $root = Join-Path $script:GetRoot 'held'
      $swap = { param($Zip, $Version) try { [IO.File]::OpenWrite($Zip).Dispose(); 'the zip could be opened for writing.' } catch { $null } }
      if ($env:OS -eq 'Windows_NT') { (Expand-RpaPackage $zip.Zip $zip.Sha '' '' $root $swap).Version | Should -BeExactly '0.3.0' }
      $source = Get-Content -Raw -LiteralPath $script:GetRpa
      $source | Should -Match ([regex]::Escape("[IO.File]::Open(`$ZipPath, 'Open', 'Read', 'Read')"))
    }

    It 'with the browser zip, unpacks it into the package folder, and asks the attestation of each zip by its name' {
      $zip = New-TestZip 'rpa-windows-x64.zip'
      $browser = New-TestBrowserZip
      $root = Join-Path $script:GetRoot 'browser-ok'
      $script:Asked = @()
      $record = { param($Zip, $Version, $Named, $Name) $script:Asked += '{0} {1} {2} {3}' -f $Zip, $Version, $Named, $Name; $null }
      $spec = $browser.Spec
      $spec.Named = $browser.Hash
      $result = Expand-RpaPackage $zip.Zip $zip.Sha '' '' $root $record $spec
      $result.BrowserHash | Should -BeExactly $browser.Hash
      Join-Path $result.Package 'Install-Rpa.ps1' | Should -Exist
      Join-Path (Join-Path $result.Package 'browser') 'node.exe' | Should -Exist
      Join-Path (Join-Path $result.Package 'scripts') 'start-browser.ps1' | Should -Exist
      $script:Asked | Should -BeExactly @(('{0} 0.3.0 False rpa-windows-x64.zip' -f $zip.Zip), ('{0} 0.3.0 True rpa-browser-windows-x64.zip' -f $browser.Zip))
    }

    It 'stops before anything is unpacked when the browser zip <Why>' -ForEach @(
      @{ Why = 'has another SHA-256 than the one beside it'; Version = '0.3.0'; Sha256 = 'cd' * 32; Entries = @(); Named = ''; Expected = 'The SHA-256 of {0} is {1}, and {2} says {3}: the zip is not the file published beside it. Nothing was unpacked: do not use this zip.' }
      @{ Why = 'has another SHA-256 than the one the script names'; Version = '0.3.0'; Sha256 = ''; Entries = @(); Named = 'ab' * 32; Expected = 'The SHA-256 of {0} is {1}, and this Get-Rpa.ps1 of release 0.3.0 names {4}. Nothing was unpacked: do not use this zip.' }
      @{ Why = 'holds an entry outside browser\'; Version = '0.3.0'; Sha256 = ''; Entries = @('scripts/start-runner.ps1'); Named = ''; Expected = '{0} holds scripts/start-runner.ps1, which is not inside browser\ nor scripts\start-browser.ps1. Nothing was unpacked: do not use this zip.' }
      @{ Why = 'holds an entry that climbs out'; Version = '0.3.0'; Sha256 = ''; Entries = @('browser/../../evil.ps1'); Named = ''; Expected = '{0} holds browser/../../evil.ps1, which is not inside browser\ nor scripts\start-browser.ps1. Nothing was unpacked: do not use this zip.' }
      @{ Why = 'is of another version'; Version = '0.2.0'; Sha256 = ''; Entries = @(); Named = ''; Expected = '{0} holds the browser of version 0.2.0, and {5} is version 0.3.0. Nothing was unpacked.' }
    ) {
      $zip = New-TestZip 'rpa-windows-x64.zip'
      $browser = New-TestBrowserZip -Version $Version -Entries $Entries -Sha256 $Sha256
      $spec = $browser.Spec
      $spec.Named = $Named
      $root = Join-Path $script:GetRoot ('browser-stop-' + [guid]::NewGuid().ToString('N'))
      { Expand-RpaPackage $zip.Zip $zip.Sha '' '0.3.0' $root $script:NoAttestation $spec } | Should -Throw -ExpectedMessage ($Expected -f $browser.Zip, $browser.Hash, $browser.Sha, $Sha256, $Named, $zip.Zip)
      Test-Path -LiteralPath $root | Should -BeFalse
    }

    It 'stops before anything is unpacked when the attestation check refuses the browser zip' {
      $zip = New-TestZip 'rpa-windows-x64.zip'
      $browser = New-TestBrowserZip
      $root = Join-Path $script:GetRoot 'browser-attest'
      $refuse = { param($Zip, $Version, $Named, $Name) if ($Name -eq 'rpa-browser-windows-x64.zip') { 'made-up refusal.' } }
      { Expand-RpaPackage $zip.Zip $zip.Sha '' '' $root $refuse $browser.Spec } | Should -Throw -ExpectedMessage 'made-up refusal. Nothing was unpacked.'
      Test-Path -LiteralPath $root | Should -BeFalse
    }
  }

  # A stand-in for gh.exe: exit codes for "auth status" and "attestation verify" from RPA_FAKE_AUTH and RPA_FAKE_VERIFY,
  # and each call written to RPA_FAKE_LOG.
  Context 'the build attestation' {
    BeforeAll {
      $script:FakeGh = Join-Path $script:GetRoot 'gh.exe'
      $script:GhLog = Join-Path $script:GetRoot 'gh.log'
      if ($env:OS -eq 'Windows_NT') {
        Add-Type -OutputType ConsoleApplication -OutputAssembly $script:FakeGh -TypeDefinition @'
using System;
public static class Program {
  public static int Main(string[] args) {
    System.IO.File.AppendAllText(Environment.GetEnvironmentVariable("RPA_FAKE_LOG"), string.Join(" ", args) + "\n");
    if (args.Length > 0 && args[0] == "auth") return int.Parse(Environment.GetEnvironmentVariable("RPA_FAKE_AUTH"));
    Console.WriteLine("made-up verify output");
    return int.Parse(Environment.GetEnvironmentVariable("RPA_FAKE_VERIFY"));
  }
}
'@
      } else {
        [IO.File]::WriteAllText($script:FakeGh, "#!/bin/sh`nprintf '%s\n' `"`$*`" >> `"`$RPA_FAKE_LOG`"`nif [ `"`$1`" = auth ]; then exit `$RPA_FAKE_AUTH; fi`necho made-up verify output`nexit `$RPA_FAKE_VERIFY`n")
        & chmod +x $script:FakeGh
      }
      $env:RPA_FAKE_LOG = $script:GhLog
      $script:Command = 'gh attestation verify rpa-windows-x64.zip --repo jb-n8n/n8n-nodes-rpa --signer-workflow jb-n8n/n8n-nodes-rpa/.github/workflows/desktop-release.yml --source-ref refs/tags/desktop-v0.3.0'
      $script:Why = "It shows that this project's release workflow built the zip; the hash only shows that the zip is the file published beside this script."
      function Set-FakeGh([int]$Auth, [int]$Verify) { $env:RPA_FAKE_AUTH = "$Auth"; $env:RPA_FAKE_VERIFY = "$Verify"; Remove-Item -LiteralPath $script:GhLog -ErrorAction SilentlyContinue }
      function Get-GhCalls { if (Test-Path -LiteralPath $script:GhLog) { @(Get-Content -LiteralPath $script:GhLog) } else { @() } }
    }
    AfterAll { Remove-Item -LiteralPath env:RPA_FAKE_LOG, env:RPA_FAKE_AUTH, env:RPA_FAKE_VERIFY -ErrorAction SilentlyContinue }

    It 'without the GitHub CLI goes on, and says in one line that the attestation was NOT checked, why it matters and how to check it' {
      $missing = Join-Path $script:GetRoot 'no-gh.exe'
      Get-RpaGhState $missing | Should -BeExactly 'missing'
      $result = Test-RpaAttestation $missing 'missing' 'C:\x\rpa-windows-x64.zip' '0.3.0' $false
      $result.Refusal | Should -BeNullOrEmpty
      $result.Line | Should -BeExactly ("The build attestation was NOT checked: the GitHub CLI is not installed here ($missing). $($script:Why) To check it on a machine with gh: $($script:Command)")
    }

    It 'with a GitHub CLI that is not signed in goes on the same way, and does not ask it to verify' {
      Set-FakeGh 1 0
      Get-RpaGhState $script:FakeGh | Should -BeExactly 'signed out'
      $result = Test-RpaAttestation $script:FakeGh 'signed out' 'C:\x\rpa-windows-x64.zip' '0.3.0' $false
      $result.Refusal | Should -BeNullOrEmpty
      $result.Line | Should -BeExactly ("The build attestation was NOT checked: the GitHub CLI here is not signed in (gh auth status). $($script:Why) To check it on a machine with gh: $($script:Command)")
      Get-GhCalls | Should -BeExactly @('auth status')
    }

    It 'with a signed-in GitHub CLI checks it: accepted goes on, refused stops, with and without -RequireAttestation' {
      Set-FakeGh 0 0
      Get-RpaGhState $script:FakeGh | Should -BeExactly 'ready'
      foreach ($require in $false, $true) {
        $result = Test-RpaAttestation $script:FakeGh 'ready' 'C:\x\rpa-windows-x64.zip' '0.3.0' $require
        $result.Refusal | Should -BeNullOrEmpty
        $result.Line | Should -BeExactly 'The attestation: gh accepted it (desktop-release.yml of jb-n8n/n8n-nodes-rpa, tag desktop-v0.3.0).'
      }
      (Get-GhCalls)[-1] | Should -BeExactly 'attestation verify C:\x\rpa-windows-x64.zip --repo jb-n8n/n8n-nodes-rpa --signer-workflow jb-n8n/n8n-nodes-rpa/.github/workflows/desktop-release.yml --source-ref refs/tags/desktop-v0.3.0'
      Set-FakeGh 0 1
      foreach ($require in $false, $true) {
        (Test-RpaAttestation $script:FakeGh 'ready' 'C:\x\rpa-windows-x64.zip' '0.3.0' $require).Refusal | Should -BeExactly 'gh attestation verify did not accept C:\x\rpa-windows-x64.zip (exit code 1): made-up verify output'
      }
    }

    It 'with -RequireAttestation stops when the GitHub CLI is <State>, without asking it to verify' -ForEach @(
      @{ State = 'missing'; Reason = 'the GitHub CLI is not installed here ({0})' }
      @{ State = 'signed out'; Reason = 'the GitHub CLI here is not signed in (gh auth status)' }
    ) {
      Set-FakeGh 1 0
      $result = Test-RpaAttestation $script:FakeGh $State 'C:\x\rpa-windows-x64.zip' '0.3.0' $true
      $result.Refusal | Should -BeExactly ('-RequireAttestation: the build attestation cannot be checked: {0}. Install the GitHub CLI here and sign it in (gh auth login), then run this again.' -f ($Reason -f $script:FakeGh))
      @(Get-GhCalls | Where-Object { $_ -like 'attestation*' }).Count | Should -Be 0
    }

    # A copy that names no SHA-256 (the repository's own, with -Zip) has only the .sha256 file beside the zip, which
    # comes from the same place: the attestation is then what ties the zip to a release.
    It 'without a named SHA-256 stops when the GitHub CLI is <State>, says why and what to do, and does not ask it to verify' -ForEach @(
      @{ State = 'missing'; Reason = 'the GitHub CLI is not installed here ({0})' }
      @{ State = 'signed out'; Reason = 'the GitHub CLI here is not signed in (gh auth status)' }
    ) {
      Set-FakeGh 1 0
      $result = Test-RpaAttestation $script:FakeGh $State 'C:\x\rpa-windows-x64.zip' '0.3.0' $false $false
      $result.Refusal | Should -BeExactly ('This Get-Rpa.ps1 names no SHA-256 for the zip: it was not published with a release, so only the build attestation ties the zip to one, and it cannot be checked: {0}. Use the Get-Rpa.ps1 published with the release, or install the GitHub CLI here and sign it in (gh auth login).' -f ($Reason -f $script:FakeGh))
      $result.Line | Should -BeNullOrEmpty
      @(Get-GhCalls | Where-Object { $_ -like 'attestation*' }).Count | Should -Be 0
    }

    It 'without a named SHA-256 goes on when a signed-in GitHub CLI accepts the attestation, and stops when it refuses' {
      Set-FakeGh 0 0
      (Test-RpaAttestation $script:FakeGh 'ready' 'C:\x\rpa-windows-x64.zip' '0.3.0' $false $false).Line | Should -BeExactly 'The attestation: gh accepted it (desktop-release.yml of jb-n8n/n8n-nodes-rpa, tag desktop-v0.3.0).'
      Set-FakeGh 0 1
      (Test-RpaAttestation $script:FakeGh 'ready' 'C:\x\rpa-windows-x64.zip' '0.3.0' $false $false).Refusal | Should -BeExactly 'gh attestation verify did not accept C:\x\rpa-windows-x64.zip (exit code 1): made-up verify output'
    }

    It 'asks for the attestation when the script names no SHA-256, for each zip' {
      $source = Get-Content -Raw -LiteralPath $script:GetRpa
      $source | Should -Match ([regex]::Escape("Test-RpaAttestation `$gh `$ghState '' `$Version ([bool]`$RequireAttestation) ([bool]`$PackageSha256)"))
      $source | Should -Match ([regex]::Escape("Test-RpaAttestation `$gh `$ghState '' `$Version ([bool]`$RequireAttestation) ([bool]`$BrowserPackageSha256) (`$BrowserPackageName + '.zip')"))
      $source | Should -Match ([regex]::Escape("@{ ZipPath = `$browserZipPath; ShaPath = `$browserZipPath + '.sha256'; Named = `$BrowserPackageSha256 }"))
    }

    It 'names the browser zip in the command that checks its attestation elsewhere' {
      $result = Test-RpaAttestation 'C:\no-gh.exe' 'missing' 'C:\x\rpa-browser-windows-x64.zip' '0.3.0' $false $true 'rpa-browser-windows-x64.zip'
      $result.Line | Should -Match ([regex]::Escape('To check it on a machine with gh: gh attestation verify rpa-browser-windows-x64.zip --repo jb-n8n/n8n-nodes-rpa'))
    }

    It 'stops before the download when -RequireAttestation cannot be met, and otherwise checks before the unpack' {
      $source = Get-Content -Raw -LiteralPath $script:GetRpa
      $source | Should -Match ([regex]::Escape("`$ghState = Get-RpaGhState `$gh"))
      $source.IndexOf('$early = Test-RpaAttestation') | Should -BeLessThan $source.IndexOf('Invoke-WebRequest')
    }
  }

  Context 'Stage.ps1' {
    BeforeAll {
      $script:Stage = Join-Path (Join-Path $script:InstallerDir 'build') 'Stage.ps1'
      $ast = [Management.Automation.Language.Parser]::ParseFile($script:Stage, [ref]$null, [ref]$null)
      $function = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ReleaseGetRpa' }, $false)
      . ([scriptblock]::Create($function[0].Extent.Text))
    }

    It 'writes the version and the SHA-256 of each zip into the Get-Rpa.ps1 it publishes, and changes nothing else' {
      $source = Get-Content -Raw -LiteralPath $script:GetRpa
      $hash = 'ab' * 32
      $browserHash = 'cd' * 32
      $made = Get-ReleaseGetRpa $source '0.3.0' $hash $browserHash
      $made | Should -BeExactly ($source.Replace("`$Version = ''", "`$Version = '0.3.0'").Replace("`$PackageSha256 = ''", "`$PackageSha256 = '$hash'").Replace("`$BrowserPackageSha256 = ''", "`$BrowserPackageSha256 = '$browserHash'"))
      $made | Should -Not -BeExactly $source
      { Get-ReleaseGetRpa ($source.Replace("`$Version = ''", '')) '0.3.0' $hash $browserHash } | Should -Throw -ExpectedMessage "Get-Rpa.ps1 does not hold the line `$Version = '' exactly once."
      { Get-ReleaseGetRpa ($source.Replace("`$BrowserPackageSha256 = ''", '')) '0.3.0' $hash $browserHash } | Should -Throw -ExpectedMessage "Get-Rpa.ps1 does not hold the line `$BrowserPackageSha256 = '' exactly once."
      { Get-ReleaseGetRpa $source '0.3' $hash $browserHash } | Should -Throw
      { Get-ReleaseGetRpa $source '0.3.0' 'abc' $browserHash } | Should -Throw
      { Get-ReleaseGetRpa $source '0.3.0' $hash '' } | Should -Throw
    }

    It 'puts rpa.cmd and scripts\rpa.ps1 into the package, and Get-Rpa.ps1 beside the zips' {
      $source = Get-Content -Raw -LiteralPath $script:Stage
      $source | Should -Match ([regex]::Escape("'RpaInstall.SignIn.ps1', 'RpaInstall.Machine.ps1', 'rpa.cmd') `$stage"))
      $source | Should -Match ([regex]::Escape("'Show-RpaConnection.ps1', 'rpa.ps1') (Join-Path `$stage 'scripts')"))
      $source | Should -Match ([regex]::Escape("Get-ReleaseGetRpa (Get-Content -Raw -LiteralPath (Join-Path `$installer 'Get-Rpa.ps1')) `$version `$hash `$browserHash"))
    }

    # The browser's files go into the browser package only, laid out to be unpacked into the package folder.
    It 'puts the browser, its version and its start script into the browser package, and nothing of them into the package' {
      $source = Get-Content -Raw -LiteralPath $script:Stage
      $source | Should -Match ([regex]::Escape("`$browser = Join-Path `$browserStage 'browser'"))
      $source | Should -Match ([regex]::Escape("[IO.File]::WriteAllText((Join-Path `$browser 'VERSION'), `$version"))
      $source | Should -Match ([regex]::Escape("Copy-Named (Join-Path `$installer 'scripts') @('start-browser.ps1') (Join-Path `$browserStage 'scripts')"))
      $source | Should -Not -Match "Join-Path \`$stage 'browser'"
      @([regex]::Matches($source, "'start-browser\.ps1'")).Count | Should -Be 1
      $source | Should -Match ([regex]::Escape("CreateFromDirectory(`$stage, `$zip, [IO.Compression.CompressionLevel]::Optimal, `$true)"))
      $source | Should -Match ([regex]::Escape("CreateFromDirectory(`$browserStage, `$browserZip, [IO.Compression.CompressionLevel]::Optimal, `$false)"))
      $source | Should -Match ([regex]::Escape("`$BrowserPackageName = 'rpa-browser-windows-x64'"))
    }
  }
}

# A path a person types is resolved against PowerShell's current location, as the person meant it, and used in full:
# .NET resolves a relative path against the process's folder (C:\Windows\system32 in an administrator PowerShell that
# was started from the Start menu), which is not where the person is. Get-Rpa.ps1 and scripts\rpa.ps1 each hold the
# same function, because each runs alone.
Describe 'A path a person types' {
  BeforeAll {
    . (Join-Path $script:InstallerDir 'Get-Rpa.ps1')
    $script:Typed = Join-Path ([IO.Path]::GetTempPath()) ('rpa-typed-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $script:Typed 'where I am') | Out-Null
    # A started program reports the folder's real name (on macOS /var is /private/var).
    if ($env:OS -ne 'Windows_NT') { $script:Typed = (& /bin/sh -c 'cd "$1" && pwd -P' sh $script:Typed) }
    $script:There = Join-Path $script:Typed 'where I am'
    $script:Processes = [IO.Directory]::GetCurrentDirectory()
  }
  AfterAll { Remove-Item -LiteralPath $script:Typed -Recurse -Force -ErrorAction SilentlyContinue }

  It 'a relative path is resolved against the PowerShell location, not the process folder' {
    Push-Location -LiteralPath $script:There
    try {
      [IO.Directory]::SetCurrentDirectory($script:Processes)
      Get-RpaTypedPath 'rpa-windows-x64.zip' | Should -BeExactly (Join-Path $script:There 'rpa-windows-x64.zip')
      Get-RpaTypedPath (Join-Path '.' 'a.zip') | Should -BeExactly (Join-Path $script:There 'a.zip')
      Get-RpaTypedPath (Join-Path '..' 'b.zip') | Should -BeExactly (Join-Path $script:Typed 'b.zip')
    } finally { Pop-Location }
  }

  It 'a full path stays as it is, and a name is never read as a pattern' {
    $full = Join-Path $script:There 'x[1]*.zip'
    Get-RpaTypedPath $full | Should -BeExactly $full
    Push-Location -LiteralPath $script:There
    try { Get-RpaTypedPath 'x[1]*.zip' | Should -BeExactly $full } finally { Pop-Location }
  }

  It 'does not follow a link: the path is the one typed' {
    if ($env:OS -eq 'Windows_NT') { Set-ItResult -Skipped -Because 'needs a link that a test may make'; return }
    $link = Join-Path $script:Typed 'link'
    New-Item -ItemType SymbolicLink -Path $link -Target $script:There | Out-Null
    Push-Location -LiteralPath $link
    try { Get-RpaTypedPath 'a.zip' | Should -BeExactly (Join-Path $link 'a.zip') } finally { Pop-Location }
  }

  It 'refuses a place that is not the file system' {
    { Get-RpaTypedPath 'Env:Path' } | Should -Throw -ExpectedMessage '*is not a path in the file system*'
  }

  It 'is the same function in Get-Rpa.ps1 and scripts\rpa.ps1' {
    function Get-FunctionText([string]$File) {
      $ast = [Management.Automation.Language.Parser]::ParseFile($File, [ref]$null, [ref]$null)
      $found = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-RpaTypedPath' }, $false)
      $found.Count | Should -Be 1
      $found[0].Extent.Text
    }
    (Get-FunctionText (Join-Path (Join-Path $script:InstallerDir 'scripts') 'rpa.ps1')) | Should -BeExactly (Get-FunctionText (Join-Path $script:InstallerDir 'Get-Rpa.ps1'))
  }

  It 'Get-Rpa.ps1 resolves -Zip with it before it looks for the file, and works with the full paths' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'Get-Rpa.ps1')
    $source | Should -Match ([regex]::Escape('$zipPath = Get-RpaTypedPath $Zip'))
    $source | Should -Not -Match '\$zipPath = \$Zip\b'
    $source | Should -Not -Match '\$shaPath = \$Zip\b'
  }

  It 'rpa policy apply hands the policy tool the full path of a relative file' {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('rpa-cmd-typed-' + [guid]::NewGuid().ToString('N'))
    $scripts = Join-Path (Join-Path $root 'RPA Runner') 'scripts'
    $runner = Join-Path (Join-Path $root 'RPA Runner') 'runner'
    New-Item -ItemType Directory -Force -Path $scripts, $runner | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $script:InstallerDir 'scripts') 'rpa.ps1') -Destination $scripts
    $tool = Join-Path $runner 'RpaPolicy.exe'
    if ($env:OS -eq 'Windows_NT') {
      Add-Type -OutputType ConsoleApplication -OutputAssembly $tool -TypeDefinition 'public static class Program { public static int Main(string[] args) { foreach (string arg in args) System.Console.WriteLine("[" + arg + "]"); return 0; } }'
    } else {
      [IO.File]::WriteAllText($tool, "#!/bin/sh`nfor a in `"`$@`"; do printf '[%s]\n' `"`$a`"; done`n")
      & chmod +x $tool
    }
    try {
      Push-Location -LiteralPath $script:There
      try {
        $output = @(& (Get-Process -Id $PID).Path -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $scripts 'rpa.ps1') policy apply (Join-Path '.' 'change [1].json'))
      } finally { Pop-Location }
      $output | Should -BeExactly @('[apply]', ('[{0}]' -f (Join-Path $script:There 'change [1].json')))
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# The Start menu shortcut "RPA Recorder" for all users: made by the step 'add the Start menu shortcut', recorded in
# install.json before it is made (kind shortcut, the key is the file), removed by a failed install and by the uninstaller.
Describe 'The Start menu shortcut' {
  BeforeAll {
    function New-ShortcutRun([string]$Recorder = 'present', [object[]]$Recorded = @()) {
      $install = Join-Path $TestDrive ('install-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Force -Path (Join-Path $install 'recorder') | Out-Null
      if ($Recorder -eq 'present') { Set-Content -LiteralPath (Join-Path (Join-Path $install 'recorder') 'RpaRecorder.exe') -Value 'made up' }
      @{
        Layout = @{ InstallDir = $install; InstallFile = (Join-Path $install 'install.json') }
        NewChanges = @(); Install = [ordered]@{ version = '0.0.0'; user = 'rpa-runner'; signInChanges = @($Recorded) }
      }
    }
    $script:Menu = Join-Path $TestDrive 'Programs'
    New-Item -ItemType Directory -Force -Path $script:Menu | Out-Null
    $script:Lnk = Join-Path $script:Menu 'RPA Recorder.lnk'
    function Invoke-ShortcutStep([hashtable]$Run) {
      $env:RPA_TEST_LNK = $script:Lnk
      try { @(InModuleScope RpaInstall -Parameters @{ Run = $Run } { Add-RpaStartMenuShortcut $Run 6>&1 } | ForEach-Object { "$_" }) } finally { $env:RPA_TEST_LNK = $null }
    }
    function New-ShortcutRecord { New-Object psobject -Property ([ordered]@{ kind = 'shortcut'; key = $script:Lnk; name = '' }) }
  }
  BeforeEach {
    Remove-Item -LiteralPath $script:Lnk -Force -ErrorAction SilentlyContinue
    Mock -ModuleName RpaInstall Get-RpaShortcutPath { $env:RPA_TEST_LNK }
    $env:RPA_TEST_MADE = ''
    Mock -ModuleName RpaInstall New-RpaShortcutFile {
      # The record is in install.json by the time the shortcut is made.
      $recorded = @((Get-Content -Raw -LiteralPath $env:RPA_TEST_INSTALLFILE | ConvertFrom-Json).signInChanges | Where-Object { $_.kind -eq 'shortcut' })
      $env:RPA_TEST_MADE += ('{0}|{1}|{2}|recorded={3};' -f $Path, $Target, $WorkingDirectory, $recorded.Count)
      Set-Content -LiteralPath $Path -Value 'shortcut'
    }
  }
  AfterEach { $env:RPA_TEST_MADE = $null; $env:RPA_TEST_INSTALLFILE = $null }
  AfterAll { if ($script:StubbedFirewall) { Remove-Item -LiteralPath Function:\Remove-NetFirewallRule -ErrorAction SilentlyContinue } }

  It 'is for all users: the common Programs folder of the Start menu, named RPA Recorder' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'RpaInstall.Machine.ps1')
    $source | Should -Match ([regex]::Escape("[Environment]::GetFolderPath('CommonPrograms')"))
    $source | Should -Match ([regex]::Escape("'RPA Recorder.lnk'"))
    $source | Should -Match ([regex]::Escape("New-Object -ComObject WScript.Shell"))
    $source | Should -Not -Match "GetFolderPath\('(Desktop|CommonDesktopDirectory|Programs|StartMenu)'\)"
  }

  It 'decides <Case>' -ForEach @(
    @{ Case = 'to skip it when the package has no recorder'; Given = @{ RecorderThere = $false; Exists = $false; IsFile = $false; Recorded = $false }; Expected = 'skip' }
    @{ Case = 'to skip it, and not to touch one, when there is no recorder'; Given = @{ RecorderThere = $false; Exists = $true; IsFile = $true; Recorded = $true }; Expected = 'skip' }
    @{ Case = 'to make it when none is there'; Given = @{ RecorderThere = $true; Exists = $false; IsFile = $false; Recorded = $false }; Expected = 'create' }
    @{ Case = 'to make it again when the one it recorded is gone'; Given = @{ RecorderThere = $true; Exists = $false; IsFile = $false; Recorded = $true }; Expected = 'create' }
    @{ Case = 'to replace the one it made'; Given = @{ RecorderThere = $true; Exists = $true; IsFile = $true; Recorded = $true }; Expected = 'create' }
    @{ Case = 'to leave one it did not make'; Given = @{ RecorderThere = $true; Exists = $true; IsFile = $true; Recorded = $false }; Expected = 'leave' }
    @{ Case = 'to leave a folder or a link in its place, even a recorded name'; Given = @{ RecorderThere = $true; Exists = $true; IsFile = $false; Recorded = $true }; Expected = 'leave' }
  ) {
    InModuleScope RpaInstall -Parameters @{ A = $Given } { Get-RpaShortcutAction -RecorderThere $A.RecorderThere -Exists $A.Exists -IsFile $A.IsFile -Recorded $A.Recorded } | Should -BeExactly $Expected
  }

  It 'records it before it makes it, pointing at the recorder with its folder as the working directory' {
    $run = New-ShortcutRun
    $env:RPA_TEST_INSTALLFILE = $run.Layout.InstallFile
    $said = Invoke-ShortcutStep $run
    $recorder = Join-Path (Join-Path $run.Layout.InstallDir 'recorder') 'RpaRecorder.exe'
    $env:RPA_TEST_MADE | Should -BeExactly ('{0}|{1}|{2}|recorded=1;' -f $script:Lnk, $recorder, (Join-Path $run.Layout.InstallDir 'recorder'))
    $said.Count | Should -Be 0
    @($run.Install.signInChanges).Count | Should -Be 1
    $run.Install.signInChanges[0].kind | Should -BeExactly 'shortcut'
    $run.Install.signInChanges[0].key | Should -BeExactly $script:Lnk
    @($run.NewChanges).Count | Should -Be 1
  }

  It 'makes none, and records nothing, when the package has no recorder' {
    $run = New-ShortcutRun 'missing'
    $env:RPA_TEST_INSTALLFILE = $run.Layout.InstallFile
    Invoke-ShortcutStep $run | Should -BeNullOrEmpty
    "$env:RPA_TEST_MADE" | Should -BeExactly ''
    @($run.Install.signInChanges).Count | Should -Be 0
    $run.Layout.InstallFile | Should -Not -Exist
  }

  It 'leaves a shortcut of that name that it did not make, says so in one line, and records nothing' {
    Set-Content -LiteralPath $script:Lnk -Value 'somebody else'
    $run = New-ShortcutRun
    $env:RPA_TEST_INSTALLFILE = $run.Layout.InstallFile
    $said = @(Invoke-ShortcutStep $run)
    $said.Count | Should -Be 1
    $said[0] | Should -BeExactly ('  left: {0}, which this installer did not make' -f $script:Lnk)
    "$env:RPA_TEST_MADE" | Should -BeExactly ''
    (Get-Content -Raw -LiteralPath $script:Lnk).Trim() | Should -BeExactly 'somebody else'
    @($run.Install.signInChanges).Count | Should -Be 0
  }

  It 'makes the shortcut again on an upgrade, keeping the one record' {
    Set-Content -LiteralPath $script:Lnk -Value 'old'
    $run = New-ShortcutRun 'present' @(New-ShortcutRecord)
    $env:RPA_TEST_INSTALLFILE = $run.Layout.InstallFile
    $null = InModuleScope RpaInstall -Parameters @{ Run = $run } { Save-RpaInstallFile $Run }
    Invoke-ShortcutStep $run | Should -BeNullOrEmpty
    $env:RPA_TEST_MADE | Should -Match 'recorded=1;$'
    @($run.Install.signInChanges).Count | Should -Be 1
    @($run.NewChanges).Count | Should -Be 0
  }

  It 'is a step of the plan, once, on a first install and on an upgrade, before the tasks are started' {
    $first = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts)
    @($first.Steps | Where-Object { $_ -eq 'add the Start menu shortcut' }).Count | Should -Be 1
    $first.Steps[-1] | Should -BeExactly 'add the Start menu shortcut'
    $upgrade = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts)
    @($upgrade.Steps | Where-Object { $_ -eq 'add the Start menu shortcut' }).Count | Should -Be 1
    $upgrade.Steps[-2..-1] | Should -BeExactly @('add the Start menu shortcut', 'start tasks')
    (InModuleScope RpaInstall { $script:KnownSteps }) | Should -Contain 'add the Start menu shortcut'
    $first.Steps.IndexOf('add the Start menu shortcut') | Should -BeGreaterThan $first.Steps.IndexOf('write install.json')
  }

  It 'is described in words, and put back by removing the file' {
    InModuleScope RpaInstall -Parameters @{ Record = (New-ShortcutRecord) } { Get-RpaChangeText $Record } | Should -BeExactly ('the Start menu shortcut {0} (it was not there)' -f $script:Lnk)
    Set-Content -LiteralPath $script:Lnk -Value 'ours'
    InModuleScope RpaInstall -Parameters @{ Record = (New-ShortcutRecord) } { Restore-RpaSignInChange $Record }
    $script:Lnk | Should -Not -Exist
  }

  It 'put back: a shortcut that is gone is no error, and a folder in its place is left alone' {
    { InModuleScope RpaInstall -Parameters @{ Record = (New-ShortcutRecord) } { Restore-RpaSignInChange $Record } } | Should -Not -Throw
    New-Item -ItemType Directory -Path $script:Lnk | Out-Null
    Set-Content -LiteralPath (Join-Path $script:Lnk 'keep.txt') -Value 'x'
    { InModuleScope RpaInstall -Parameters @{ Record = (New-ShortcutRecord) } { Restore-RpaSignInChange $Record } } | Should -Not -Throw
    (Join-Path $script:Lnk 'keep.txt') | Should -Exist
    Remove-Item -LiteralPath $script:Lnk -Recurse -Force
  }

  It 'a failed install removes the shortcut this run made, with its record' {
    $run = New-ShortcutRun
    $env:RPA_TEST_INSTALLFILE = $run.Layout.InstallFile
    Invoke-ShortcutStep $run | Out-Null
    $script:Lnk | Should -Exist
    $run.Account = @{ Display = 'rpa-runner'; Name = 'rpa-runner' }
    $run.Upgrade = $false; $run.AutoSignInBefore = $false; $run.CreatedUser = $false; $run.WroteInstallFile = $true
    $null = InModuleScope RpaInstall -Parameters @{ Run = $run } { Undo-RpaFailedRun $Run 6>$null }
    $script:Lnk | Should -Not -Exist
    $run.Layout.InstallFile | Should -Not -Exist
  }

  It 'turning automatic sign-in off leaves the shortcut and its record alone' {
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    $secret = New-Object psobject -Property ([ordered]@{ kind = 'secret'; key = 'DefaultPassword'; name = '' })
    $run = New-ShortcutRun 'present' @($secret, (New-ShortcutRecord))
    $null = InModuleScope RpaInstall -Parameters @{ Run = $run } { Disable-RpaAutoSignIn $Run }
    Should -Invoke -ModuleName RpaInstall Restore-RpaSignInChanges -Times 1 -Exactly -ParameterFilter { @($Changes).Count -eq 1 -and $Changes[0].kind -eq 'secret' }
    @($run.Install.signInChanges | ForEach-Object { $_.kind }) | Should -BeExactly @('shortcut')
  }

  It 'the uninstaller removes it, and says nothing of sign-in settings when that is all it recorded' {
    $install = Join-Path $TestDrive 'RPA Runner'
    New-Item -ItemType Directory -Force -Path $install | Out-Null
    $file = Join-Path $install 'install.json'
    Set-Content -LiteralPath $script:Lnk -Value 'ours'
    $env:RPA_TEST_LNK = $script:Lnk
    $env:RPA_TEST_INSTALLFILE = $file
    Set-Content -LiteralPath $file -Value ('{{ "version": "0.3.0", "user": "rpa-runner", "autoSignIn": false, "mode": "signedIn", "signInChanges": [ {{ "kind": "shortcut", "key": {0}, "name": "" }} ] }}' -f (ConvertTo-Json $script:Lnk))
    Mock -ModuleName RpaInstall Get-RpaLayout { @{ InstallDir = $env:RPA_TEST_INSTALL_DIR; InstallFile = $env:RPA_TEST_INSTALLFILE; DataDir = 'C:\ProgramData\RPA Runner'; LeftoversFile = (Join-Path $TestDrive 'left.json') } }
    $env:RPA_TEST_INSTALL_DIR = $install
    # The recorded Windows user is not on this machine, whichever machine this is: no Kept line for it.
    Mock -ModuleName RpaInstall Get-RpaSid { throw 'The Windows user does not exist.' }
    Mock -ModuleName RpaInstall Stop-RpaServices { }
    Mock -ModuleName RpaInstall Get-RpaUninstallFacts { @{ DataDir = 'C:\ProgramData\RPA Runner'; DataDirState = @{ Exists = $false; IsLink = $false }; Accounts = @(); RunningSids = @(); UnknownProcesses = @(); AutoSignInSid = $null } }
    Mock -ModuleName RpaInstall Remove-RpaBrowserTemp { @() }
    Mock -ModuleName RpaInstall Unregister-RpaTask { }
    # Windows' own command, which a Mock needs to find.
    if (-not (Get-Command Remove-NetFirewallRule -ErrorAction SilentlyContinue)) { function global:Remove-NetFirewallRule { }; $script:StubbedFirewall = $true }
    Mock -ModuleName RpaInstall Remove-NetFirewallRule { }
    Mock -ModuleName RpaInstall Remove-RpaLsaSecret { }
    Mock -ModuleName RpaInstall Get-RpaServicePath { $null }
    Mock -ModuleName RpaInstall Remove-RpaProgramFiles { }
    Mock -ModuleName RpaInstall Get-RpaPathState { @{ Exists = $false } }
    Mock -ModuleName RpaInstall Restore-RpaSignInChanges { @() }
    try {
      $result = InModuleScope RpaInstall { Invoke-RpaUninstall -Plan @{ Refusals = @() } 6>$null }
    } finally { $env:RPA_TEST_INSTALL_DIR = $null }
    Should -Invoke -ModuleName RpaInstall Restore-RpaSignInChanges -Times 1 -Exactly -ParameterFilter { @($Changes).Count -eq 1 -and $Changes[0].kind -eq 'shortcut' }
    $result.HadChanges | Should -BeFalse
    @($result.ShortcutNotRemoved).Count | Should -Be 0
    @(InModuleScope RpaInstall -Parameters @{ Result = $result } { Get-RpaUninstallSummary $Result }) | Should -BeExactly @('RPA is removed.')
  }

  It 'the uninstaller names a shortcut it could not remove' {
    $result = @{ NotRestored = @(); ShortcutNotRemoved = @('the Start menu shortcut C:\x.lnk (it was not there): Access is denied.'); Layout = @{ DataDir = 'C:\d' } }
    $lines = @(InModuleScope RpaInstall -Parameters @{ Result = $result } { Get-RpaUninstallSummary $Result })
    $lines | Should -Contain '  The Start menu shortcut could not be removed:'
    $lines | Should -Contain '    the Start menu shortcut C:\x.lnk (it was not there): Access is denied.'
  }
}

# Names the installer shares with the supervisor's C# code and a place in the guide its refusals point to. The service's
# own "blocked" sentence (Show-RpaConnection.ps1 against SessionManager.cs) is pinned here too.
Describe 'Names shared with the supervisor and the guide' {
  BeforeAll {
    $script:RepoRoot = Join-Path $PSScriptRoot '../../..'
    function Get-RepoText([string]$Path) { Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot $Path) }
  }

  It 'the LSA secret that holds the password of the bot user is the one the supervisor reads' {
    $name = InModuleScope RpaInstall { $script:SupervisorSecret }
    $name | Should -BeExactly 'L$RpaRunnerBotPassword'
    Get-RepoText 'desktop/runner/src/Rpa.Supervisor/LsaSecret.cs' | Should -Match ([regex]::Escape(('public const string BotPasswordName = "{0}";' -f $name)))
  }

  It 'the service is the one the supervisor registers as, also where Show-RpaConnection.ps1 looks for it' {
    $name = InModuleScope RpaInstall { $script:SupervisorService }
    Get-RepoText 'desktop/runner/src/Rpa.Supervisor/SupervisorService.cs' | Should -Match ([regex]::Escape(('public const string Name = "{0}";' -f $name)))
    Get-RepoText 'desktop/installer/scripts/Show-RpaConnection.ps1' | Should -Match ([regex]::Escape(("-Filter `"Name='{0}'`"" -f $name)))
  }

  It 'the sentence Show-RpaConnection.ps1 matches to detect a blocked sign-in is the one the supervisor writes' {
    $script = Get-RepoText 'desktop/installer/scripts/Show-RpaConnection.ps1'
    $match = [regex]::Match($script, '\$failure\.Contains\(''([^'']+)''\)')
    $match.Success | Should -BeTrue
    Get-RepoText 'desktop/runner/src/Rpa.Supervisor.Core/SessionManager.cs' | Should -Match ([regex]::Escape($match.Groups[1].Value))
  }

  It 'section 10 of the Windows guide, which the refusals about a new password name, is about the certificates' {
    $script:ModuleSource | Should -Match ([regex]::Escape('(docs/install/windows.md, section 10)'))
    (Get-RepoText 'docs/install/windows.md') -split "`r?`n" | Should -Contain '## 10. Changing the tokens and the certificates'
  }
}
