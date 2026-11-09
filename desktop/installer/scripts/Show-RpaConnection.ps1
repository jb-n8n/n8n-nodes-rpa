# Shows what the n8n credentials need: the URL and the certificate fingerprint of the RPA desktop runner and of the RPA
# browser on this machine, and whether each is listening. Run it as the bot user or from an administrator PowerShell
# (nobody else can read the data directory):
#
#   powershell -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1" [-ShowTokens]
#
# The tokens are shown only with -ShowTokens, which needs an administrator PowerShell. The runner's fingerprint comes
# from its start line in logs\runner.out.log; the browser's is the SHA-256 of its certificate (browser-cert.pem).
param([switch]$ShowTokens)
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:ProgramData 'RPA Runner'
$logDir = Join-Path $dataDir 'logs'
$install = Get-Content -Raw -LiteralPath (Join-Path $installDir 'install.json') -Encoding UTF8 | ConvertFrom-Json

if ($ShowTokens) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Output '-ShowTokens needs an administrator PowerShell.'
    exit 1
  }
}

# The fingerprint in the runner's latest start line, or nothing.
function Get-RunnerFingerprint([string]$log) {
  $found = $null
  foreach ($line in @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue)) {
    if ($line -match 'RPA runner listening on \S+, fingerprint ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})') { $found = $Matches[1] }
  }
  $found
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

$addresses = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
    ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
    Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
    ForEach-Object { $_.Address.ToString() } |
    Where-Object { $_ -notlike '127.*' -and $_ -notlike '169.254.*' } |
    Sort-Object -Unique)
$listening = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })

$services = @(@{
    Name = 'Runner'; Port = [int]$install.runnerPort; Path = '/rpa/v1'; Log = Join-Path $logDir 'runner.err.log'
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
  if ($ShowTokens) { Write-Output ('{0} token: {1}' -f $service.Name, ([IO.File]::ReadAllText($service.Token)).Trim()) }
}
