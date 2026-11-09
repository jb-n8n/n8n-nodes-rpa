# Pester tests for the Windows installer (desktop/installer). They cover what runs anywhere: the plan the installer
# makes from its parameters and hand-made facts about the machine (Get-RpaInstallPlan touches nothing), the secret
# generator, how a user name is read, Show-RpaConnection.ps1 against a made-up install, and that every script still
# parses as Windows PowerShell 5.1. The install itself (users, permissions, tasks, firewall) runs only on Windows and is
# driven end to end by the desktop workflow.
#
#   Invoke-Pester desktop/installer/test

BeforeAll {
  $script:InstallerDir = Split-Path -Parent $PSScriptRoot
  Import-Module (Join-Path $script:InstallerDir 'RpaInstall.psm1') -Force

  # Install-Rpa.ps1 with no arguments.
  function New-TestParameters([hashtable]$Change = @{}) {
    $parameters = @{
      User = 'rpa-runner'; UserPassword = $null; RunnerPort = 8765; BrowserPort = 3000
      NoBrowser = $false; NoFirewall = $false; AutoSignIn = $false; Force = $false
    }
    foreach ($key in $Change.Keys) { $parameters[$key] = $Change[$key] }
    $parameters
  }

  # A clean, supported machine: an administrator on 64-bit Windows Server 2022, nothing installed, no such user.
  function New-TestFacts([hashtable]$Change = @{}) {
    $facts = @{
      IsAdmin = $true; Is64Bit = $true; OsBuild = 20348
      UserExists = $false; UserIsDomain = $false; UserPasswordExpires = $false
      PortsInUse = @{}; Installed = $false; RunnerRunning = $false
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
      $facts = New-TestFacts @{ Installed = $true; UserExists = $true; PortsInUse = @{ 8765 = 'RpaRunner'; 3000 = 'node' } }
      (Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts).Refusals.Count | Should -Be 0
    }

    It 'refuses a domain user that does not exist' {
      $parameters = New-TestParameters @{ User = 'CORP\svc-rpa'; UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts @{ UserIsDomain = $true })
      $plan.Refusals | Should -BeExactly @('CORP\svc-rpa does not exist. Create it in your directory first; the installer only creates local users.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses -AutoSignIn for an existing user without -UserPassword' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true }) -Facts (New-TestFacts @{ UserExists = $true })
      $plan.Refusals | Should -BeExactly @('-AutoSignIn for the existing user rpa-runner needs -UserPassword.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'refuses a new local user without -AutoSignIn and without -UserPassword' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts (New-TestFacts)
      $plan.Refusals | Should -BeExactly @('Give -UserPassword for the new user rpa-runner, or use -AutoSignIn to have a random password stored for automatic sign-in.')
      $plan.Steps.Count | Should -Be 0
    }

    It 'on an upgrade with the runner running, refuses without -Force and warns with it' {
      $facts = New-TestFacts @{ Installed = $true; UserExists = $true; RunnerRunning = $true }
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
        'store sign-in password'
        'turn on automatic sign-in'
        'keep the desktop unlocked'
        'write install.json'
      )
    }

    It 'an upgrade keeps the policy, tokens and user' {
      $facts = New-TestFacts @{ Installed = $true; UserExists = $true }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters) -Facts $facts
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
      $facts = New-TestFacts @{ Installed = $true; UserExists = $true }
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ NoBrowser = $true }) -Facts $facts
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

    It '-AutoSignIn adds the three sign-in steps, in order' {
      $plan = Get-RpaInstallPlan -Parameters (New-TestParameters @{ AutoSignIn = $true }) -Facts (New-TestFacts)
      @($plan.Steps | Where-Object { $script:SignInSteps -contains $_ }) | Should -BeExactly $script:SignInSteps
    }

    It 'without -AutoSignIn no sign-in step is listed' {
      $parameters = New-TestParameters @{ UserPassword = New-TestPassword }
      $plan = Get-RpaInstallPlan -Parameters $parameters -Facts (New-TestFacts)
      $plan.Refusals.Count | Should -Be 0
      foreach ($step in $script:SignInSteps) { $plan.Steps | Should -Not -Contain $step }
      $plan.Steps | Should -Contain 'create user'
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
    $installDir = Join-Path $script:Root 'install'
    $scriptsDir = Join-Path $installDir 'scripts'
    $dataDir = Join-Path (Join-Path $script:Root 'data') 'RPA Runner'
    $script:LogDir = Join-Path $dataDir 'logs'
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
    Set-Content -LiteralPath (Join-Path $installDir 'install.json') -Value ($install | ConvertTo-Json) -Encoding UTF8

    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $script:RunnerFingerprint = ($bytes | ForEach-Object { $_.ToString('X2') }) -join ':'
    Set-Content -LiteralPath (Join-Path $script:LogDir 'runner.out.log') -Value "RPA runner listening on wss://0.0.0.0:$($script:RunnerPort)/rpa/v1, fingerprint $($script:RunnerFingerprint)"

    $rsa = [Security.Cryptography.RSA]::Create(2048)
    try {
      $request = New-Object Security.Cryptography.X509Certificates.CertificateRequest('CN=rpa-test', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
      $hex = $certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256)
      $script:BrowserFingerprint = (($hex.ToUpperInvariant() -split '(..)') -ne '') -join ':'
      $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($certificate.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"
      Set-Content -LiteralPath (Join-Path $dataDir 'browser-cert.pem') -Value $pem -NoNewline
      $certificate.Dispose()
    } finally { $rsa.Dispose() }

    $script:RunnerToken = 'runner-' + [guid]::NewGuid().ToString('N')
    $script:BrowserToken = 'browser-' + [guid]::NewGuid().ToString('N')
    Set-Content -LiteralPath (Join-Path $dataDir 'token') -Value $script:RunnerToken -NoNewline
    Set-Content -LiteralPath (Join-Path $dataDir 'browser-token') -Value $script:BrowserToken -NoNewline

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

  # The administrator check is a Windows one, and the desktop workflow runs these tests as an administrator.
  It 'prints both tokens with -ShowTokens' -Skip:($env:OS -ne 'Windows_NT') {
    $output = @(& $script:ShowScript -ShowTokens)
    $output | Should -Contain "Runner token: $($script:RunnerToken)"
    $output | Should -Contain "Browser token: $($script:BrowserToken)"
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

  It 'are all there: the installer, the uninstaller, the module and the three installed scripts' {
    foreach ($name in 'Install-Rpa.ps1', 'Uninstall-Rpa.ps1', 'RpaInstall.psm1') { Join-Path $script:InstallerDir $name | Should -Exist }
    foreach ($name in 'start-runner.ps1', 'start-browser.ps1', 'Show-RpaConnection.ps1') { Join-Path (Join-Path $script:InstallerDir 'scripts') $name | Should -Exist }
  }
}
