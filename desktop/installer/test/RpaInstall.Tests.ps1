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
      AllowFrom = @('10.0.0.5'); AllowFromAnyAddress = $false
      NoBrowser = $false; NoFirewall = $false; AutoSignIn = $false; Force = $false
    }
    foreach ($key in $Change.Keys) { $parameters[$key] = $Change[$key] }
    $parameters
  }

  # What Get-RpaMachineFacts says about one path in the data directory.
  function New-PathState([string]$Kind = 'ours') {
    switch ($Kind) {
      'missing' { @{ Exists = $false; IsLink = $false; OwnerTrusted = $false; Owner = '' } }
      'ours' { @{ Exists = $true; IsLink = $false; OwnerTrusted = $true; Owner = 'BUILTIN\Administrators' } }
      'link' { @{ Exists = $true; IsLink = $true; OwnerTrusted = $true; Owner = 'BUILTIN\Administrators' } }
      'theirs' { @{ Exists = $true; IsLink = $false; OwnerTrusted = $false; Owner = 'BOT-PC\mallory' } }
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
      InstalledAllowFrom = $null; InstalledAutoSignInForUser = $false
      DataDir = $script:DataDir; LogDir = "$($script:DataDir)\logs"
      DataDirState = New-PathState 'missing'; LogDirState = New-PathState 'missing'
      DataFiles = @{ 'policy.json' = New-PathState 'missing'; 'token' = New-PathState 'missing'; 'browser-token' = New-PathState 'missing' }
      TaskFolderOwner = $null; PublicNetwork = $false
    }
    foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
    $facts
  }

  # The same machine after Install-Rpa.ps1 -AllowFrom 10.0.0.5 -UserPassword ... ran on it.
  function New-InstalledFacts([hashtable]$Change = @{}) {
    $facts = New-TestFacts @{
      Installed = $true; UserExists = $true
      InstalledRunnerPort = 8765; InstalledBrowserPort = 3000; InstalledBrowser = $true; InstalledAllowFrom = @('10.0.0.5')
      DataDirState = New-PathState 'ours'; LogDirState = New-PathState 'ours'
      DataFiles = @{ 'policy.json' = New-PathState 'ours'; 'token' = New-PathState 'ours'; 'browser-token' = New-PathState 'ours' }
    }
    foreach ($key in $Change.Keys) { $facts[$key] = $Change[$key] }
    $facts
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

      # An install made with -NoFirewall recorded nothing, so the upgrade has to say.
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AllowFrom = @() }) -Facts (New-InstalledFacts @{ InstalledAllowFrom = $null })
      $plan.Refusals | Should -BeExactly @($script:SayWhich)
    }

    It '-NoFirewall needs neither and makes no rule' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword; AllowFrom = @(); NoFirewall = $true }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      $plan.AllowFrom | Should -BeNullOrEmpty
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

    It 'warns that the firewall rules let nothing in on a Public network' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PublicNetwork = $true })
      $plan.Warnings | Should -BeExactly @('This machine is on a network that Windows treats as Public. The firewall rules are for Domain and Private networks, so they let nothing in on that network.')

      $parameters.NoFirewall = $true
      (Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ PublicNetwork = $true })).Warnings.Count | Should -Be 0
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

  It 'runs no plan that has a refusal' {
    $plan = @{ Refusals = @('no'); Warnings = @(); Steps = @() }
    { Invoke-RpaInstallPlan -Plan $plan -Parameters (New-TestParameters) -SourceDir $script:InstallerDir } |
      Should -Throw -ExpectedMessage 'The plan has refusals; nothing was changed.'
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
  It '<Name> starts no Windows tool by its bare name' -ForEach @(@{ Name = 'RpaInstall.psm1' }, @{ Name = 'Install-Rpa.ps1' }, @{ Name = 'Uninstall-Rpa.ps1' }) {
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $script:InstallerDir $Name), [ref]$null, [ref]$null)
    $bare = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) |
        ForEach-Object { $_.GetCommandName() } | Where-Object { $_ -match '^(icacls|reg|powercfg|robocopy|cmd|schtasks|net|sc|takeown|shutdown)(\.exe)?$' })
    $bare.Count | Should -Be 0
  }

  It 'Install-Rpa.ps1 judges who can change its folder before it loads anything else from it' {
    $path = Join-Path $script:InstallerDir 'Install-Rpa.ps1'
    $source = Get-Content -Raw -LiteralPath $path
    $refusal = $source.IndexOf("'{0} can be changed by {1}. Unpack the package in a folder only you or administrators can change, and run it from there.'")
    $refusal | Should -BeGreaterThan 0
    $source.IndexOf("'{0} is a link or junction. Unpack the package again and run the installer from the new folder.'") | Should -BeGreaterThan 0
    $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
    $loads = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and ($node.GetCommandName() -eq 'Import-Module' -or $node.InvocationOperator -eq 'Dot') }, $true))
    $loads.Count | Should -Be 1
    $loads[0].Extent.StartOffset | Should -BeGreaterThan $refusal
  }

  Context 'on Windows' {
    BeforeAll {
      # A copy of the installer in a folder of its own, under a folder whose access rules the tests set. The runs
      # below can install nothing: both ports are the same, which the plan refuses before any step.
      $script:Area = Join-Path ([IO.Path]::GetTempPath()) ('rpa-package-' + [guid]::NewGuid().ToString('N'))
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

    It 'Install-Rpa.ps1 runs from a package only administrators, SYSTEM and the person running it can change' -Skip:($env:OS -ne 'Windows_NT') {
      $run = Invoke-TestInstaller
      ($run.Output -join "`n") | Should -Not -Match 'can be changed by|is a link'
      $run.Output | Should -Contain '-RunnerPort and -BrowserPort are both 7. Give each its own port.'
      $run.ExitCode | Should -Be 1
    }

    It 'Install-Rpa.ps1 refuses a package with one file that other users can change' -Skip:($env:OS -ne 'Windows_NT') {
      $file = Join-Path (Join-Path $script:Package 'scripts') 'start-loop.ps1'
      & icacls.exe $file /grant '*S-1-5-32-545:M' | Out-Null
      try {
        $run = Invoke-TestInstaller
        $run.Output | Should -BeExactly @("$file can be changed by $($script:Users). $($script:Unpack)", 'Nothing was changed.')
        $run.ExitCode | Should -Be 1
      } finally { & icacls.exe $file /remove '*S-1-5-32-545' | Out-Null }
    }

    It 'Install-Rpa.ps1 refuses a package with a junction in it' -Skip:($env:OS -ne 'Windows_NT') {
      $junction = Join-Path $script:Package 'runner'
      & cmd.exe /d /c ('mklink /J "{0}" "{1}"' -f $junction, (Join-Path $script:Area 'elsewhere')) | Out-Null
      try {
        $run = Invoke-TestInstaller
        $run.Output | Should -BeExactly @("$junction is a link or junction. Unpack the package again and run the installer from the new folder.", 'Nothing was changed.')
        $run.ExitCode | Should -Be 1
      } finally { & cmd.exe /d /c ('rd "{0}"' -f $junction) | Out-Null }
    }

    It 'Install-Rpa.ps1 refuses a package in a folder where other users may delete what is in it' -Skip:($env:OS -ne 'Windows_NT') {
      & icacls.exe $script:Area /grant '*S-1-5-32-545:(DC)' | Out-Null
      try {
        $run = Invoke-TestInstaller
        $run.Output | Should -BeExactly @("$($script:Area) can be changed by $($script:Users). $($script:Unpack)", 'Nothing was changed.')
        $run.ExitCode | Should -Be 1
      } finally { & icacls.exe $script:Area /remove '*S-1-5-32-545' | Out-Null }
    }

    It 'Install-Rpa.ps1 refuses a package folder that other users can change' -Skip:($env:OS -ne 'Windows_NT') {
      & icacls.exe $script:Package /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
      $run = Invoke-TestInstaller
      $run.Output | Should -BeExactly @("$($script:Package) can be changed by $($script:Users). $($script:Unpack)", 'Nothing was changed.')
      $run.ExitCode | Should -Be 1
    }
  }
}
