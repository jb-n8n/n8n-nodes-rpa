# Installs or replaces the RPA desktop runner from an HTTPS URL: a zip of the self-contained win-x64 publish, or the
# single executable. Run it as an administrator: the first-boot setup does when runner_artifact_url is set, and
# desktop-testbed.sh install-runner runs it over SSM (as SYSTEM). It stops a running runner; start-runner.ps1, in the
# rpa-runner session, starts the new one within 30 seconds.
#
#   & 'C:\Program Files\RPA Runner\install-runner.ps1' -Url https://.../rpa-desktop-runner.zip [-Sha256 <hex>]
#
# The log (%ProgramData%\RPA Runner\setup\install-runner.log, which only administrators can write) and the output
# never show a URL's query string, where a pre-signed URL carries its signature.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Sha256 = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $env:ProgramData 'RPA Runner\setup\install-runner.log'
$own = @('start-runner.ps1', 'install-runner.ps1', 'runner.json')

function Log([string]$message) {
  Add-Content -Path $logFile -Value ('{0} {1}' -f (Get-Date -Format o), $message)
  Write-Output $message
}

if ($Url -notmatch '^https://[^\s''"`]+$') { throw 'The runner URL must be https:// without spaces or quotes.' }
if ($Sha256 -and $Sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'The SHA-256 must be 64 hexadecimal characters.' }
$config = Get-Content -Raw -Path (Join-Path $installDir 'runner.json') | ConvertFrom-Json
$shown = ([Uri]$Url).GetLeftPart([UriPartial]::Path)
$work = Join-Path $env:TEMP ('rpa-runner-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $download = Join-Path $work 'download'
  Log "downloading $shown"
  Invoke-WebRequest -Uri $Url -OutFile $download -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash
  if ($Sha256 -and $hash -ne $Sha256.ToUpperInvariant()) { throw "SHA-256 mismatch: expected $($Sha256.ToUpperInvariant()), got $hash" }
  Log "SHA-256 $hash$(if (-not $Sha256) { ' (not checked: no -Sha256 given)' })"

  $head = New-Object byte[] 2
  $stream = [IO.File]::OpenRead($download)
  try { [void]$stream.Read($head, 0, 2) } finally { $stream.Dispose() }
  $source = Join-Path $work 'files'
  New-Item -ItemType Directory -Path $source | Out-Null
  if ($head[0] -eq 0x50 -and $head[1] -eq 0x4B) {
    # A zip ("PK"): use the folder that holds the executable, wherever it sits in the archive.
    Rename-Item -LiteralPath $download -NewName 'download.zip'
    Expand-Archive -LiteralPath (Join-Path $work 'download.zip') -DestinationPath $source
    $found = Get-ChildItem -LiteralPath $source -Recurse -File -Filter $config.exe | Sort-Object { $_.FullName.Length } | Select-Object -First 1
    if (-not $found) { throw "The zip has no $($config.exe)." }
    $source = $found.DirectoryName
  } elseif ($head[0] -eq 0x4D -and $head[1] -eq 0x5A) {
    # A Windows executable ("MZ").
    Move-Item -LiteralPath $download -Destination (Join-Path $source $config.exe)
  } else {
    throw 'The download is neither a zip nor a Windows executable.'
  }

  Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($config.exe)) -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Get-ChildItem -LiteralPath $source | Where-Object { $own -notcontains $_.Name } | Copy-Item -Destination $installDir -Recurse -Force
  Log "installed $($config.exe) into $installDir; start-runner.ps1 starts it within 30 s"
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
