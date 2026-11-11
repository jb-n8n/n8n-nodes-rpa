# Shows what the n8n credentials need: the URL and the certificate fingerprint of the RPA desktop runner and of the RPA
# browser on this machine, and whether each is listening. Run it as the bot user or from an administrator PowerShell
# (nobody else can read the data directory):
#
#   powershell -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1" [-ShowTokens]
#
# The tokens are shown only with -ShowTokens, which needs an administrator PowerShell. The two token lines are written
# through the host's own writer, not through a cmdlet or the pipeline, so that no cmdlet's parameters carry a token
# (PowerShell's module logging records those). What remains: a transcript records what the window shows, a program
# that runs this script and reads its output (a remote command tool, for example) keeps that output, and a PowerShell
# command that calls this script in its own session gets the two lines on the screen, not as output. Everything else
# is written to the pipeline. The runner's fingerprint comes from its start line in logs\runner.out.log; the browser's
# is the SHA-256 of its certificate (browser-cert.pem). The bot user can write both files, so the fingerprints are
# what this machine's bot user reports.
#
# In unattended mode (Install-Rpa.ps1 -Unattended) it also shows whether the service RPA Supervisor runs, the bot
# user's sessions (quser.exe), the supervisor's last failure from supervisor-state.json and whether that failure blocks
# sign-ins until the service is restarted (the service then still shows as running), and where its log is. Its folder
# can be read by administrators only.
param([switch]$ShowTokens)
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
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
    Name = 'Runner'; Port = [int]$install.runnerPort; Path = '/rpa/v1'; Log = Join-Path $logDir 'runner.out.log'
    Fingerprint = Get-RunnerFingerprint (Join-Path $logDir 'runner.out.log'); Token = Join-Path $dataDir 'token'
  })
if ($install.browser) {
  $services += @{
    Name = 'Browser'; Port = [int]$install.browserPort; Path = ''; Log = Join-Path $logDir 'browser.err.log'
    Fingerprint = Get-CertificateFingerprint (Join-Path $dataDir 'browser-cert.pem'); Token = Join-Path $dataDir 'browser-token'
  }
}

if ($addresses.Count -eq 0) { Write-Output 'This machine has no IPv4 address on a network.' }
foreach ($service in $services) {
  foreach ($address in $addresses) { Write-Output ('{0} URL: wss://{1}:{2}{3}' -f $service.Name, $address, $service.Port, $service.Path) }
  # A service that has never started has no certificate yet.
  if ($service.Fingerprint) { Write-Output ('{0} fingerprint: {1}' -f $service.Name, $service.Fingerprint) }
  else { Write-Output ('{0} fingerprint: not known yet' -f $service.Name) }
  if ($listening -notcontains $service.Port) { Write-Output ('{0}: not listening: see {1}' -f $service.Name, $service.Log) }
  if ($ShowTokens) { $Host.UI.WriteLine((Get-TokenLine $service.Name $service.Token)) }
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

  # quser.exe lists the user's sessions, whoever made them; it exits with 1 when there is none. What it writes to its
  # error stream must not end this script.
  $sessions = $null
  $ErrorActionPreference = 'Continue'
  try {
    $said = @(& (Join-Path ([Environment]::SystemDirectory) 'quser.exe') $user 2>$null)
    if ($LASTEXITCODE -eq 0) { $sessions = @($said | Select-Object -Skip 1 | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) }
    elseif ($LASTEXITCODE -eq 1) { $sessions = @() }
  } catch { }
  $ErrorActionPreference = 'Stop'
  if ($null -eq $sessions) { Write-Output ('Sessions of {0}: could not be read (quser.exe)' -f $user) }
  elseif ($sessions.Count -eq 0) { Write-Output ('Sessions of {0}: none' -f $user) }
  else { foreach ($session in $sessions) { Write-Output ('Session of {0}: {1}' -f $user, $session) } }

  $failure = $null
  if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output "Supervisor's last failure: none recorded" }
  else {
    try {
      $failure = [string](Get-Content -Raw -LiteralPath $stateFile -ErrorAction Stop | ConvertFrom-Json).lastFailure
      if ($failure) { Write-Output "Supervisor's last failure: $failure" } else { Write-Output "Supervisor's last failure: none recorded" }
    } catch { Write-Output ("Supervisor's last failure: {0} could not be read; run this from an administrator PowerShell." -f $stateFile) }
  }
  # After a wrong or expired password the supervisor tries no sign-in until it starts again, and still shows as
  # running. The failure is from this run of the service when the file was written after the service started.
  if ($failure -and $failure.Contains('No further sign-in is tried until the RPA Supervisor service is restarted.') -and $service -and $service.State -eq 'Running') {
    $started = $null
    try { $started = (Get-Process -Id $service.ProcessId -ErrorAction Stop).StartTime } catch { }
    if (-not $started -or (Get-Item -LiteralPath $stateFile).LastWriteTime -ge $started) {
      Write-Output "Supervisor: sign-ins are blocked until the service is restarted. Store the right password with Install-Rpa.ps1 -Unattended -UserPassword, which restarts it, or fix the cause and run: Restart-Service 'RPA Supervisor'"
    }
  }
  Write-Output ('Supervisor log: {0}' -f (Join-Path $supervisorDir 'supervisor.log'))
}
