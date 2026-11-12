# Shows what the n8n credentials need: for the RPA desktop runner and, when it is installed, for the RPA browser, one
# connection line to paste into the credential's Connection Line field, and below it the URL and the certificate
# fingerprint for the separate fields, and whether each program is listening. Run it as the bot user or from an
# administrator PowerShell (nobody else can read the data directory); rpa.cmd in the install folder runs it:
#
#   rpa connection [-ShowTokens] [-Address <name or address>]     (this script [-ShowTokens] [-Address ...])
#   rpa status                                                     (this script -Status)
#
# A connection line is rpa-runner://<address>:<port>/rpa/v1#token=<token>&fingerprint=<64 hex> or
# rpa-browser://<address>:<port>/#token=<token>&fingerprint=<64 hex>. Its address is this machine's name, or the
# -Address given (the name or address n8n really uses, through a NAT or a tunnel); an IPv6 address goes in brackets.
# -Status shows whether each program listens, the mode, the bot user's sessions and, in unattended mode, the
# supervisor's state: nothing that goes into a credential.
#
# The tokens are shown only with -ShowTokens, which needs an administrator PowerShell; without it each line holds
# token=<hidden: run with -ShowTokens>, and the script says so. The token lines and the connection lines with a token
# are written through the host's own writer, not through a cmdlet or the pipeline, and a token is read inside the
# function that makes its line, so that no command's parameters carry a token (PowerShell's module logging records
# those). What remains: a transcript records what the window shows, a program that runs this script and reads its output
# (a remote command tool, for example) keeps that output, and a PowerShell command that calls this script in its own
# session gets those lines on the screen, not as output. Everything else is written to the pipeline. The runner's
# fingerprint comes from its start line in logs\runner.out.log; the browser's is the SHA-256 of its certificate
# (browser-cert.pem). The bot user can write both files, so the fingerprints are what this machine's bot user reports.
#
# In unattended mode (Install-Rpa.ps1 -Unattended) it also shows whether the service RPA Supervisor runs, the bot
# user's sessions (quser.exe), the supervisor's last failure from supervisor-state.json and whether that failure blocks
# sign-ins until the service is restarted (the service then still shows as running), and where its log is. Its folder
# can be read by administrators only.
param([switch]$ShowTokens, [string]$Address, [switch]$Status)
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
$hidden = '<hidden: run with -ShowTokens>'

# The address as it goes into a connection line: a host name or an IPv4 address as it is, an IPv6 address (with or
# without its brackets) in brackets; nothing for anything else, so that no text of -Address can add to the line.
function Get-ConnectionHost([string]$Text) {
  if ($Text -match '^\d{1,3}(\.\d{1,3}){3}$') {
    foreach ($part in $Text.Split('.')) { if ([int]$part -gt 255) { return $null } }
    return $Text
  }
  if ($Text -match '^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$') { return $Text }
  $bare = $Text
  if ($bare -match '^\[(.*)\]$') { $bare = $Matches[1] }
  $parsed = $null
  if ($bare -match '^[0-9A-Fa-f:.]+$' -and $bare.Contains(':') -and [Net.IPAddress]::TryParse($bare, [ref]$parsed)) { return '[{0}]' -f $bare }
  $null
}

# A connection line (Line), or why there is none (Problem). -Fingerprint is in the form the other lines show it
# (upper-case pairs joined by colons) and goes into the line as 64 lower-case hexadecimal digits. With -WithToken the
# token is read here from -TokenFile, so that it is never a parameter of a command; without it the line holds the
# placeholder. Only a token of letters, digits, - and _ (the installer's own) goes into a line.
function Get-ConnectionLine([string]$Kind, [string]$HostName, [int]$Port, [string]$Fingerprint, [string]$TokenFile, [bool]$WithToken) {
  $path = '/'
  $name = 'Browser'
  if ($Kind -eq 'runner') { $path = '/rpa/v1'; $name = 'Runner' }
  $token = '<hidden: run with -ShowTokens>'
  if ($WithToken) {
    try { $token = ([IO.File]::ReadAllText($TokenFile)).Trim() }
    catch { return @{ Line = $null; Problem = ('the token cannot be read (see the {0} token line)' -f $name) } }
    if ($token -notmatch '^[A-Za-z0-9_-]+$') { return @{ Line = $null; Problem = 'the token holds a character that a connection line cannot carry; use the Token field' } }
  }
  $line = 'rpa-{0}://{1}:{2}{3}#token={4}&fingerprint={5}' -f $Kind, $HostName, $Port, $path, $token, $Fingerprint.Replace(':', '').ToLowerInvariant()
  @{ Line = $line; Problem = $null }
}

# -Status shows nothing that goes into a credential, and an -Address that cannot go into a line stops everything.
if ($Status -and ($ShowTokens -or $Address)) {
  Write-Output '-Status shows no connection values: give it without -ShowTokens and -Address.'
  exit 1
}
# Kept apart: $address below is each address of this machine.
$givenAddress = $Address
if ($givenAddress) {
  $lineHost = Get-ConnectionHost $givenAddress
  if (-not $lineHost) {
    Write-Output ('-Address: {0} is not a host name, an IPv4 address or an IPv6 address.' -f $givenAddress)
    exit 1
  }
} else { $lineHost = Get-ConnectionHost ([Net.Dns]::GetHostName()) }
# A name that cannot go into a line (an underscore in it, for example) leaves the lines to -Address.
$noLine = $null
if (-not $lineHost) { $noLine = 'the name of this machine, {0}, cannot go into a line: run this with -Address <the name or address n8n uses>' -f [Net.Dns]::GetHostName() }
$dataDir = Join-Path $env:ProgramData 'RPA Runner'
$logDir = Join-Path $dataDir 'logs'
$installFile = Join-Path $installDir 'install.json'
if (-not (Test-Path -LiteralPath $installFile)) {
  Write-Output ('RPA is not installed here: {0} is missing. Run Install-Rpa.ps1 from the unpacked package.' -f $installFile)
  exit 1
}
$install = Get-Content -Raw -LiteralPath $installFile -Encoding UTF8 | ConvertFrom-Json

if ($ShowTokens) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Output '-ShowTokens needs an administrator PowerShell.'
    exit 1
  }
}

# The fingerprint in the runner's start line, or nothing. This takes the first line of that exact form in the log of
# the current run. The runner writes its start line once, when it starts; a later line of the same form is not the
# start line (a caller can make the runner log text that the caller chose).
function Get-RunnerFingerprint([string]$log) {
  foreach ($line in @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue)) {
    if ($line -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO RPA runner listening on wss://[0-9A-Fa-f.:]+:\d{1,5}/rpa/v1, fingerprint ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})$') { return $Matches[1] }
  }
  $null
}

# The SHA-256 of the certificate's DER bytes as uppercase hex pairs joined by colons, or nothing.
function Get-CertificateFingerprint([string]$pemFile) {
  $pem = Get-Content -Raw -LiteralPath $pemFile -ErrorAction SilentlyContinue
  if (-not $pem -or $pem -notmatch '-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----') { return $null }
  $der = [Convert]::FromBase64String(($Matches[1] -replace '\s', ''))
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try { $hash = $sha256.ComputeHash($der) } finally { $sha256.Dispose() }
  ($hash | ForEach-Object { $_.ToString('X2') }) -join ':'
}

# A token line: the token, or what is wrong with its file and what to do about it.
function Get-TokenLine([string]$name, [string]$file) {
  if (-not (Test-Path -LiteralPath $file)) {
    return ('{0} token: {1} is missing. Run Install-Rpa.ps1 again: it writes a token file that is missing.' -f $name, $file)
  }
  try { $token = ([IO.File]::ReadAllText($file)).Trim() }
  catch { return ('{0} token: {1} cannot be read: {2}' -f $name, $file, $_.Exception.GetBaseException().Message) }
  '{0} token: {1}' -f $name, $token
}

$addresses = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
    ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
    Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
    ForEach-Object { $_.Address.ToString() } |
    Where-Object { $_ -notlike '127.*' -and $_ -notlike '169.254.*' } |
    Sort-Object -Unique)
$listening = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })

$services = @(@{
    # The runner writes its failures to its output (runner.out.log), and to logs\runner-<date>.log.
    Name = 'Runner'; Kind = 'runner'; Credential = 'RPA Desktop Runner'; Port = [int]$install.runnerPort; Path = '/rpa/v1'; Log = Join-Path $logDir 'runner.out.log'
    Fingerprint = Get-RunnerFingerprint (Join-Path $logDir 'runner.out.log'); Token = Join-Path $dataDir 'token'
  })
if ($install.browser) {
  $services += @{
    Name = 'Browser'; Kind = 'browser'; Credential = 'RPA Browser'; Port = [int]$install.browserPort; Path = ''; Log = Join-Path $logDir 'browser.err.log'
    Fingerprint = Get-CertificateFingerprint (Join-Path $dataDir 'browser-cert.pem'); Token = Join-Path $dataDir 'browser-token'
  }
}

# The bot user's sessions (quser.exe lists them, whoever made them; it exits with 1 when there is none). What it writes
# to its error stream must not end this script.
function Write-Sessions([string]$User) {
  $sessions = $null
  $ErrorActionPreference = 'Continue'
  try {
    $said = @(& (Join-Path ([Environment]::SystemDirectory) 'quser.exe') $User 2>$null)
    if ($LASTEXITCODE -eq 0) { $sessions = @($said | Select-Object -Skip 1 | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) }
    elseif ($LASTEXITCODE -eq 1) { $sessions = @() }
  } catch { }
  $ErrorActionPreference = 'Stop'
  if ($null -eq $sessions) { Write-Output ('Sessions of {0}: could not be read (quser.exe)' -f $User) }
  elseif ($sessions.Count -eq 0) { Write-Output ('Sessions of {0}: none' -f $User) }
  else { foreach ($session in $sessions) { Write-Output ('Session of {0}: {1}' -f $User, $session) } }
}

if (-not $Status -and $addresses.Count -eq 0) { Write-Output 'This machine has no IPv4 address on a network.' }
foreach ($service in $services) {
  $notListening = ('{0}: not listening yet. It starts within a minute of the bot user''s sign-in: run this again. If it stays like this, read {1}' -f $service.Name, $service.Log)
  if ($Status) {
    if ($listening -contains $service.Port) { Write-Output ('{0}: listening on port {1}' -f $service.Name, $service.Port) } else { Write-Output $notListening }
    continue
  }
  # The line to paste, then the values for the separate fields. A service that has never started has no certificate yet.
  if ($noLine) { Write-Output ('{0} connection line: {1}' -f $service.Name, $noLine) }
  elseif ($service.Fingerprint) {
    $made = Get-ConnectionLine $service.Kind $lineHost $service.Port $service.Fingerprint $service.Token ([bool]$ShowTokens)
    if ($made.Line) {
      Write-Output ('{0} connection line, for the Connection Line of the {1} credential:' -f $service.Name, $service.Credential)
      if ($ShowTokens) { $Host.UI.WriteLine($made.Line) } else { Write-Output $made.Line }
    } else { Write-Output ('{0} connection line: {1}' -f $service.Name, $made.Problem) }
  } else { Write-Output ('{0} connection line: not known yet (the program has not started)' -f $service.Name) }
  foreach ($address in $addresses) { Write-Output ('{0} URL: wss://{1}:{2}{3}' -f $service.Name, $address, $service.Port, $service.Path) }
  if ($service.Fingerprint) { Write-Output ('{0} fingerprint: {1}' -f $service.Name, $service.Fingerprint) }
  else { Write-Output ('{0} fingerprint: not known yet (the program has not started)' -f $service.Name) }
  if ($listening -notcontains $service.Port) { Write-Output $notListening }
  if ($ShowTokens) { $Host.UI.WriteLine((Get-TokenLine $service.Name $service.Token)) }
}
if (-not $Status -and -not $ShowTokens) {
  $command = '& "{0}" connection -ShowTokens' -f (Join-Path $installDir 'rpa.cmd')
  if ($givenAddress) { $command += ' -Address {0}' -f $givenAddress }
  if ($services.Count -eq 1) { Write-Output ('The token is hidden in the line (token={0}). For the line to paste, run as an administrator: {1}' -f $hidden, $command) }
  else { Write-Output ('The tokens are hidden in the lines (token={0}). For the lines to paste, run as an administrator: {1}' -f $hidden, $command) }
}
if (-not $Status -and -not $givenAddress) { Write-Output 'Where n8n reaches this machine by another name or address (a NAT, a tunnel), add -Address <that name or address>.' }

if ($Status -and $install.mode -ne 'unattended') {
  if ($install.autoSignIn -eq $true) { Write-Output ('Mode: automatic sign-in. Windows signs {0} in at every start of this machine.' -f $install.user) }
  elseif ($install.browser) { Write-Output ('Mode: signed in. The runner and the browser run while {0} is signed in.' -f $install.user) }
  else { Write-Output ('Mode: signed in. The runner runs while {0} is signed in.' -f $install.user) }
  Write-Sessions ([string]$install.user)
}

if ($install.mode -eq 'unattended') {
  $supervisorDir = Join-Path $dataDir 'supervisor'
  $stateFile = Join-Path $supervisorDir 'supervisor-state.json'
  $user = [string]$install.user
  Write-Output ('Mode: unattended. The RPA Supervisor signs {0} in when n8n connects, and out {1} s after the last connection.' -f $user, $install.idleSeconds)

  $service = $null
  try { $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='RPA Supervisor'" -ErrorAction Stop } catch { }
  if (-not $service) { Write-Output 'Supervisor: the service RPA Supervisor is not registered. Run Install-Rpa.ps1 -Unattended again.' }
  elseif ($service.State -ne 'Running') { Write-Output ("Supervisor: the service RPA Supervisor is {0}. Start it: Start-Service 'RPA Supervisor'" -f $service.State.ToLowerInvariant()) }
  else { Write-Output 'Supervisor: running' }

  Write-Sessions $user

  # Only SYSTEM and administrators can open the supervisor's folder: a file that is not there (no failure yet) is told
  # from one that this account may not read.
  $failure = $null
  try {
    $failure = [string]([IO.File]::ReadAllText($stateFile) | ConvertFrom-Json).lastFailure
    if ($failure) { Write-Output "Supervisor's last failure: $failure" } else { Write-Output "Supervisor's last failure: none recorded" }
  } catch {
    # The exception and those inside it: the call's own comes wrapped, and may wrap the system's reason in turn.
    $chain = @()
    for ($e = $_.Exception; $e; $e = $e.InnerException) { $chain += $e }
    $cause = $chain[-1]
    if (@($chain | Where-Object { $_ -is [IO.FileNotFoundException] -or $_ -is [IO.DirectoryNotFoundException] }).Count -gt 0) { Write-Output "Supervisor's last failure: none recorded" }
    elseif (@($chain | Where-Object { $_ -is [UnauthorizedAccessException] }).Count -gt 0) { Write-Output ("Supervisor's last failure: {0} can be read by administrators only; run this from an administrator PowerShell." -f $stateFile) }
    else { Write-Output ("Supervisor's last failure: {0} could not be read: {1}" -f $stateFile, $cause.Message) }
  }
  # After a wrong or expired password the supervisor tries no sign-in until it starts again, and still shows as
  # running. The failure is from this run of the service when the file was written after the service started.
  if ($failure -and $failure.Contains('No further sign-in is tried until the RPA Supervisor service is restarted.') -and $service -and $service.State -eq 'Running') {
    $started = $null
    try { $started = (Get-Process -Id $service.ProcessId -ErrorAction Stop).StartTime } catch { }
    if (-not $started -or [IO.File]::GetLastWriteTime($stateFile) -ge $started) {
      Write-Output "Supervisor: sign-ins are blocked until the service is restarted. Store the right password with Install-Rpa.ps1 -Unattended -UserPassword, which restarts it, or fix the cause and run: Restart-Service 'RPA Supervisor'"
    }
  }
  Write-Output ('Supervisor log: {0}' -f (Join-Path $supervisorDir 'supervisor.log'))
}
# Whatever the last Windows tool this ran left in $LASTEXITCODE (quser.exe exits with 1 when there is no session).
exit 0
