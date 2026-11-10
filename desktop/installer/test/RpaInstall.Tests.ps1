# Pester tests for the Windows installer (desktop/installer). They cover what runs anywhere: the plan the installer
# makes from its parameters and hand-made facts about the machine (Get-RpaInstallPlan touches nothing), the secret
# generator, how a user name is read, Show-RpaConnection.ps1 against a made-up install, and that every script still
# parses as Windows PowerShell 5.1. A few tests need Windows and are skipped elsewhere. The install itself (users,
# permissions, tasks, firewall) runs only on Windows and is driven end to end by the desktop workflow.
#
#   Invoke-Pester desktop/installer/test

BeforeAll {
  $script:InstallerDir = Split-Path -Parent $PSScriptRoot
  Import-Module (Join-Path $script:InstallerDir 'RpaInstall.psm1') -Force
  $script:DataDir = 'C:\ProgramData\RPA Runner'

  # Install-Rpa.ps1 -AllowFrom 10.0.0.5 and nothing else.
  function New-TestParameters([hashtable]$Change = @{}) {
    $parameters = @{
      User = 'rpa-runner'; UserPassword = $null; RunnerPort = 8765; BrowserPort = 3000
      AllowFrom = @('10.0.0.5'); AllowFromAnyAddress = $false; IncludePublicNetwork = $false
      NoBrowser = $false; NoFirewall = $false; AutoSignIn = $false; Force = $false
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
  # data directory.
  function New-TestFacts([hashtable]$Change = @{}) {
    $facts = @{
      IsAdmin = $true; Is64Bit = $true; OsBuild = 20348
      UserExists = $false; UserIsDomain = $false; UserIsAdmin = $false; UserAdminUnknown = $false
      UserPasswordExpires = $false; UserPasswordWrong = $false; UserPasswordProblem = $null
      PortsInUse = @{}; Installed = $false; RunnerRunning = $false
      InstalledRunnerPort = $null; InstalledBrowserPort = $null; InstalledBrowser = $false
      InstalledAllowFrom = $null; InstalledPublicNetwork = $false
      InstalledAutoSignInForUser = $false; InstalledAutoSignInUser = $null; InstalledUser = $null; InstalledForUser = $false
      UserSid = $null
      DataDir = $script:DataDir; LogDir = "$($script:DataDir)\logs"; PolicyBackupsDir = "$($script:DataDir)\policy-backups"
      DataDirState = New-PathState 'missing'; LogDirState = New-PathState 'missing'; PolicyBackupsState = New-PathState 'missing'
      DataDirEntries = $null
      DataFiles = @{ 'policy.json' = New-PathState 'missing'; 'token' = New-PathState 'missing'; 'browser-token' = New-PathState 'missing' }
      TaskFolderOwner = $null; PublicNetwork = $false
    }
    foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
    $facts
  }

  # The same machine after Install-Rpa.ps1 -AllowFrom 10.0.0.5 -UserPassword ... ran on it.
  function New-InstalledFacts([hashtable]$Change = @{}) {
    $facts = New-TestFacts @{
      Installed = $true; UserExists = $true; UserSid = $script:BotSid; InstalledUser = 'rpa-runner'; InstalledForUser = $true
      InstalledRunnerPort = 8765; InstalledBrowserPort = 3000; InstalledBrowser = $true; InstalledAllowFrom = @('10.0.0.5')
      DataDirState = New-PathState 'ours'; LogDirState = New-PathState 'ours'; PolicyBackupsState = New-PathState 'ours'
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
    $entries = @{ Link = $null; Owners = @(); Backups = @(); Accounts = @{} }
    foreach ($key in $Change.Keys) { $entries[$key] = $Change[$key] }
    $entries
  }
  function New-OwnerEntry([string]$Sid, [string]$Name, [int]$Number, [string]$First, [int]$Order) {
    @{ Sid = $Sid; Name = $Name; Number = $Number; First = "$($script:DataDir)\$First"; Order = $Order }
  }

  # Stands for a -UserPassword value. The plan only looks at whether one was given, so it is empty: no secret here.
  function New-TestPassword { New-Object Security.SecureString }

  $script:SignInSteps = @('store sign-in password', 'turn on automatic sign-in', 'keep the desktop unlocked')
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
      $text = '-AutoSignIn for the existing user rpa-runner needs -UserPassword. A password the installer generated earlier is not known to anyone: set a new password for rpa-runner and pass it, or remove rpa-runner so the installer creates it again.'
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

    It 'refuses a new local user without -AutoSignIn and without -UserPassword' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('Give -UserPassword for the new user rpa-runner, or use -AutoSignIn to have a random password stored for automatic sign-in.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'on an upgrade with the runner running, refuses without -Force and warns with it' {
      $facts = New-InstalledFacts @{ RunnerRunning = $true }
      $text = 'The runner is running; a run in progress will fail. Use -Force to continue.'

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
      $plan.Refusals | Should -BeExactly @($text)
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

    It 'on an upgrade for the same user, does not judge what is in the data directory' {
      $entries = New-DataEntries @{
        Link   = @{ Path = 'C:\ProgramData\RPA Runner\exports\x'; IsLink = $true; Links = 1 }
        Owners = @((New-OwnerEntry $script:BotSid 'BOT-PC\rpa-runner' 12 'exports' 1), (New-OwnerEntry 'S-1-5-21-1-2-3-1002' 'BOT-PC\mallory' 2 'browser-key.pem' 7))
      }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-InstalledFacts @{ DataDirEntries = $entries })
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions.Count | Should -Be 0
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
    BeforeAll { $script:NotTheUser = 'bot2 is not the user this install was made for (rpa-runner).' }

    It 'says so and has it confirmed: a question without -Force, a warning with it' {
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserSid = 'S-1-5-21-1-2-3-1003' }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2' }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions | Should -BeExactly @($script:NotTheUser)
      $plan.Warnings.Count | Should -Be 0
      $plan.Steps | Should -Not -Contain 'create user'

      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; Force = $true }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions.Count | Should -Be 0
      $plan.Warnings | Should -BeExactly @($script:NotTheUser)
    }

    # A mistyped name: the user does not exist and would be created.
    It 'says so before it creates a user of that name' {
      $facts = New-InstalledFacts @{ InstalledForUser = $false; UserExists = $false; UserSid = $null }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ User = 'bot2'; UserPassword = New-TestPassword }) -Facts $facts
      $plan.Refusals.Count | Should -Be 0
      $plan.Questions | Should -BeExactly @($script:NotTheUser)
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
      $parameters = New-TestParameters @{ NoBrowser = $true; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PortsInUse = @{ 3000 = 'node' } })
      $plan.Refusals.Count | Should -Be 0
      foreach ($step in 'register the browser task', 'add the browser firewall rule', 'write browser-token') { $plan.Steps | Should -Not -Contain $step }
      foreach ($step in 'register the runner task', 'add the runner firewall rule', 'write token') { $plan.Steps | Should -Contain $step }
    }

    It '-NoBrowser on an upgrade removes the browser task and firewall rule of the earlier install' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ NoBrowser = $true }) -Facts (New-InstalledFacts)
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
}

Describe 'Invoke-RpaInstallPlan' {
  It 'checks every step name before it runs the first step' {
    $plan = @{ Refusals = @(); Warnings = @(); Steps = @('copy program files', 'make coffee') }
    { Invoke-RpaInstallPlan -Plan $plan -Parameters (New-TestParameters) -SourceDir $script:InstallerDir } |
      Should -Throw -ExpectedMessage 'The installer has no step "make coffee"; nothing was changed.'
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

  It 'says how to get there when Windows signs the bot user in again by itself' {
    $facts = New-UninstallFacts @{ RunningSids = @($script:BotSid); AutoSignInSid = $script:BotSid }
    $plan = Get-RpaUninstallPlan -Parameters @{ RemoveData = $true } -Facts $facts
    $plan.Refusals | Should -BeExactly @(
      'rpa-runner is signed in. Sign rpa-runner out, then run Uninstall-Rpa.ps1 -RemoveData again.'
      'Automatic sign-in is on for rpa-runner, and Windows signs it in again after a sign-out. Run Uninstall-Rpa.ps1 without -RemoveData first, which turns that off; then sign rpa-runner out and run Uninstall-Rpa.ps1 -RemoveData from the unpacked package.'
    )
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
  }
}

Describe 'What the uninstaller reports' {
  BeforeAll {
    function New-UninstallResult([hashtable]$Change = @{}) {
      $result = @{
        User = 'rpa-runner'; UserKept = $true; AutoSignIn = $true; SignInKept = $false; SignInFailed = $false; HadChanges = $true; NotRestored = @()
        LeftoversFile = $null; LeftoversProblem = $null; DataRemoved = $false; DataKept = $true
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
    @($record.Keys) | Should -BeExactly @('version', 'user', 'runnerPort', 'browserPort', 'browser', 'autoSignIn', 'allowFrom', 'publicNetwork', 'signInChanges')
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
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'RpaInstall.psm1')
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
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'RpaInstall.psm1')
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
      $output | Should -Contain 'Runner fingerprint: not known yet'
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
    $script:Output | Should -Contain "Browser: not listening: see $(Join-Path $script:LogDir 'browser.err.log')"
    @($script:Output | Where-Object { $_ -like 'Runner: not listening*' }).Count | Should -Be 0
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

  # The administrator check is a Windows one, and the desktop workflow runs these tests as an administrator.
  It 'prints both tokens with -ShowTokens' -Skip:($env:OS -ne 'Windows_NT') {
    $output = @(& $script:ShowScript -ShowTokens)
    $output | Should -Contain "Runner token: $($script:RunnerToken)"
    $output | Should -Contain "Browser token: $($script:BrowserToken)"
  }

  It 'with -ShowTokens says which token file is missing and what to do' -Skip:($env:OS -ne 'Windows_NT') {
    $file = Join-Path $script:MadeUpData 'browser-token'
    Remove-Item -LiteralPath $file
    try {
      $output = @(& $script:ShowScript -ShowTokens)
      $output | Should -Contain "Browser token: $file is missing. Run Install-Rpa.ps1 again: it writes a token file that is missing."
      $output | Should -Contain "Runner token: $($script:RunnerToken)"
    } finally {
      Set-Content -LiteralPath $file -Value $script:BrowserToken -NoNewline
    }
  }
}

Describe 'The installer scripts' {
  BeforeDiscovery {
    $installerDir = Split-Path -Parent $PSScriptRoot
    # What the package ships: the files beside Install-Rpa.ps1 and those in scripts\.
    $scripts = @(Get-ChildItem -LiteralPath $installerDir, (Join-Path $installerDir 'scripts') -File |
        Where-Object { $_.Extension -eq '.ps1' -or $_.Extension -eq '.psm1' } | ForEach-Object { @{ Name = $_.Name; Path = $_.FullName } })
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

  It 'are all there: the installer, the uninstaller, the module and the four installed scripts' {
    foreach ($name in 'Install-Rpa.ps1', 'Uninstall-Rpa.ps1', 'RpaInstall.psm1') { Join-Path $script:InstallerDir $name | Should -Exist }
    foreach ($name in 'start-loop.ps1', 'start-runner.ps1', 'start-browser.ps1', 'Show-RpaConnection.ps1') { Join-Path (Join-Path $script:InstallerDir 'scripts') $name | Should -Exist }
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
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:InstallerDir 'RpaInstall.psm1')
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
        Copy-Item -LiteralPath (Join-Path $script:InstallerDir 'Install-Rpa.ps1'), (Join-Path $script:InstallerDir 'RpaInstall.psm1') -Destination $script:Package
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
      $file = Join-Path $script:Package 'RpaInstall.psm1'
      & cmd.exe /d /c ('mklink /J "{0}" "{1}"' -f $via, $script:Area) | Out-Null
      try {
        $started = Join-Path (Join-Path $via 'package') 'Install-Rpa.ps1'
        $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $started -RunnerPort 7 -BrowserPort 7 -AllowFromAnyAddress)
        $output | Should -Contain '-RunnerPort and -BrowserPort are both 7. Give each its own port.'

        & icacls.exe $file /grant '*S-1-5-32-545:M' | Out-Null
        $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $started -RunnerPort 7 -BrowserPort 7 -AllowFromAnyAddress)
        $output[1] | Should -Match ([regex]::Escape("$($script:Leaf)\package\RpaInstall.psm1 can be changed by $($script:Users). $($script:Unpack)") + '$')
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
