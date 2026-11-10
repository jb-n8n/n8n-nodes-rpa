# Installs the RPA Windows package (rpa-windows-x64.zip) from an HTTPS URL with the package's own installer. The test
# bed's first boot writes this file to C:\Program Files\RPA Test Bed\, a folder only SYSTEM and Administrators can read
# or change, and runs it for the first install; desktop-testbed.sh install runs it over SSM (as SYSTEM) to upgrade:
#
#   & 'C:\Program Files\RPA Test Bed\install-package.ps1' -Url https://.../rpa-windows-x64.zip -Sha256 <64 hex digits>
#
# In order:
#   1. downloads the zip into a new folder under pkg\ beside this file, created for SYSTEM and Administrators only (not
#      under a temp folder, where other users can create files);
#   2. compares the zip's SHA-256 with -Sha256 and stops when they differ, before anything is unpacked or run;
#   3. unpacks it there, after checking that every entry lands inside the package's one top folder, rpa-windows-x64;
#   4. runs the package's Install-Rpa.ps1 inside this PowerShell. With the first-install parameters (-User,
#      -UserPassword, -RunnerPort, -BrowserPort, -AllowFrom; the first boot gives them) that is a first install with
#      -AutoSignIn and -Force. Without them it is an upgrade with -Force, for the user and ports the install was made
#      with (install.json): the installer then keeps the user, the data, the policy, the tokens and the firewall
#      addresses, and a run in progress fails;
#   5. removes the unpacked package.
# Install-Rpa.ps1 itself reads who could change the unpacked package and refuses when that is anyone but
# administrators. The SHA-256 is what ties the download to the package you chose; the URL only says where it is.
#
# -UserPassword is a SecureString and reaches the installer inside this process, never on a command line. The log
# (install-package.log beside this file) and the output hold this script's lines and the installer's, and never a URL's
# query string, where a pre-signed URL carries its signature.
[CmdletBinding(DefaultParameterSetName = 'Upgrade')]
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Sha256,
  [Parameter(Mandatory = $true, ParameterSetName = 'FirstInstall')][string]$User,
  [Parameter(Mandatory = $true, ParameterSetName = 'FirstInstall')][Security.SecureString]$UserPassword,
  [Parameter(Mandatory = $true, ParameterSetName = 'FirstInstall')][int]$RunnerPort,
  [Parameter(Mandatory = $true, ParameterSetName = 'FirstInstall')][int]$BrowserPort,
  [Parameter(Mandatory = $true, ParameterSetName = 'FirstInstall')][string]$AllowFrom
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$logFile = Join-Path $PSScriptRoot 'install-package.log'
$installFile = Join-Path (Join-Path $env:ProgramFiles 'RPA Runner') 'install.json'
$work = $null
$script:installed = $false

function Say([string]$message) {
  Add-Content -LiteralPath $logFile -Value ('{0} {1}' -f (Get-Date -Format o), $message)
  Write-Output $message
}

# Removes the unpacked package with cmd's rd, which takes paths of any length. What rd writes about a file it could
# not delete must not end this script, so the error setting is changed inside this function only.
function Remove-Work([string]$path) {
  $ErrorActionPreference = 'Continue'
  & (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') /d /c ('rd /s /q "\\?\{0}"' -f $path) 2>&1 | Out-Null
}

# One line of the installer: into the log and the output, and the line with which it reports success is noted. The
# installer ends with "exit <code>" only when it refuses or fails, so its exit code alone does not say that it
# finished (after a good run the code is that of the last Windows tool it ran).
function Read-InstallerLine($line) {
  $text = "$line".TrimEnd()
  if ($text -ceq 'RPA is installed.') { $script:installed = $true }
  if ($text) { Say "installer: $text" }
}

try {
  # RFC 3986's characters without the single quote. \z, not $: $ also matches before a line break at the end.
  if ($Url -cnotmatch '^https://[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+\z') { throw 'The package URL must be an https:// URL of plain URL characters, without spaces or quotes.' }
  if ($Sha256 -notmatch '^[0-9A-Fa-f]{64}\z') { throw 'The SHA-256 must be 64 hexadecimal characters.' }
  $first = $PSCmdlet.ParameterSetName -eq 'FirstInstall'
  if (-not $first) {
    if (-not (Test-Path -LiteralPath $installFile -PathType Leaf)) {
      throw 'RPA is not installed on this machine, so there is nothing to upgrade. A first install needs choices this script does not make (the user, the addresses that may connect): run Install-Rpa.ps1 from an unpacked package, or set package_url and package_sha256 and replace the VM.'
    }
    $install = Get-Content -Raw -LiteralPath $installFile -Encoding UTF8 | ConvertFrom-Json
    $upgrade = @{ User = [string]$install.user; RunnerPort = [int]$install.runnerPort; BrowserPort = [int]$install.browserPort; Force = $true }
    if ($install.browser -ne $true) { $upgrade.NoBrowser = $true }
  }
  $shown = ([Uri]$Url).GetLeftPart([UriPartial]::Path)

  # A new folder that only SYSTEM and Administrators can read or change, with those rules from its first moment.
  $folder = Join-Path (Join-Path $PSScriptRoot 'pkg') ([guid]::NewGuid().ToString('N').Substring(0, 12))
  if (Test-Path -LiteralPath $folder) { throw "$folder is there already; run this again." }
  $rules = New-Object Security.AccessControl.DirectorySecurity
  $rules.SetSecurityDescriptorSddlForm('O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  [void][IO.Directory]::CreateDirectory($folder, $rules)
  $work = $folder

  $zip = Join-Path $work 'package.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Say "downloading $shown"
  try { Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing }
  catch { throw ('The download failed: {0}' -f ([string]$_.Exception.Message -replace 'https?://\S+', '(the URL)')) }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
  if ($hash -ne $Sha256.ToUpperInvariant()) { throw "SHA-256 mismatch: expected $($Sha256.ToUpperInvariant()), got $hash. Nothing was unpacked." }
  Say "SHA-256 $hash matches"

  $package = Join-Path $work 'rpa-windows-x64'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($entry in $archive.Entries) {
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($work, $entry.FullName))
      if (-not $target.StartsWith($package + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The zip is not the RPA Windows package: an entry is outside its one top folder, rpa-windows-x64.' }
    }
  } finally { $archive.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $work)
  Remove-Item -LiteralPath $zip -Force
  $installer = Join-Path $package 'Install-Rpa.ps1'
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The zip is not the RPA Windows package: it has no rpa-windows-x64\Install-Rpa.ps1.' }

  $global:LASTEXITCODE = 0
  if ($first) {
    Say 'running Install-Rpa.ps1 (first install)'
    & $installer -User $User -UserPassword $UserPassword -RunnerPort $RunnerPort -BrowserPort $BrowserPort -AllowFrom $AllowFrom -AutoSignIn -Force *>&1 | ForEach-Object { Read-InstallerLine $_ }
  } else {
    Say 'running Install-Rpa.ps1 (upgrade)'
    & $installer @upgrade *>&1 | ForEach-Object { Read-InstallerLine $_ }
  }
  if (-not $script:installed) { throw "Install-Rpa.ps1 did not finish (exit code $LASTEXITCODE); its lines above say why." }
  Say 'done'
} catch {
  Say ('FAILED: {0}' -f $_.Exception.Message)
  throw
} finally {
  if ($work) { Remove-Work $work }
}
