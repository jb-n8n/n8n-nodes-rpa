# Gets the RPA Windows package of the release this file is published with, checks it, unpacks it and starts its
# installer. Run it from an administrator Windows PowerShell (powershell.exe, 64-bit):
#
#   .\Get-Rpa.ps1 -AllowFrom <n8n address> [-RequireAttestation] [-Zip <path> [-BrowserZip <path>]]
#                 [the other parameters of Install-Rpa.ps1, -WithBrowser among them]
#
# What it does, each step said in one line, and stopping with the reason when a check fails:
#   1. Checks that it runs in a 64-bit Windows PowerShell 5.1 as an administrator, on Windows 10 1809, Windows 11 or
#      Windows Server 2019 or later, and that the drives have room (about 0.7 GB for the download, 2.6 GB for the
#      unpacked package and the install).
#   2. Downloads rpa-windows-x64.zip and rpa-windows-x64.zip.sha256 from the GitHub Release desktop-v<version> of
#      jb-n8n/n8n-nodes-rpa into <your profile>\Downloads\rpa-<version>. The address is written in this script, and the
#      version and the zip's SHA-256 are written into it when the release is made. With -Zip <path> it takes a zip that
#      is there already, as it is, and the .sha256 file beside it (<path>.sha256).
#      With the browser (-WithBrowser, or an upgrade of an install that has the browser, without -NoBrowser) it gets
#      rpa-browser-windows-x64.zip and its .sha256 the same way, from the same release; the release writes that zip's
#      SHA-256 into this script too. With -Zip it needs -BrowserZip <path>, the browser zip beside its .sha256 file.
#   3. Opens the zip (and the browser zip) once, so that nobody can change it until the unpack has finished, and
#      compares its SHA-256 with the .sha256 file and with the one this script names. A difference stops it before
#      anything is unpacked.
#   4. Checks the build attestation of each zip with the GitHub CLI when C:\Program Files\GitHub CLI\gh.exe is
#      installed and signed in, as docs/install/windows.md does: the workflow desktop-release.yml of
#      jb-n8n/n8n-nodes-rpa attested it, for the tag desktop-v<version>. A failed check stops it. Where gh is not
#      installed or not signed in, the attestation is NOT checked: it says so in one line, with the command that checks
#      the zip's attestation on a machine with gh, and goes on; the zip must
#      still have the SHA-256 of the .sha256 file and the one this script names. With -RequireAttestation the check is
#      mandatory: without a signed-in gh it stops before it downloads anything. A copy that names no SHA-256 (the
#      repository's own, run with -Zip) has only the .sha256 file beside the zip, from the same place, so there the
#      check is always mandatory, for each zip it names no SHA-256 for.
#   5. Unpacks into C:\Program Files\RPA package\<version>, a new folder that takes the access rules of Program Files
#      (only administrators can change it), refusing an entry outside rpa-windows-x64\, and a folder that is there
#      already. The browser zip goes into the package folder rpa-windows-x64\, refusing an entry outside browser\ and
#      scripts\start-browser.ps1, and a browser zip of another version (its browser\VERSION). Both zips are checked
#      before either is unpacked. Then it checks that no account other than Administrators, SYSTEM, TrustedInstaller
#      and you can change that folder, or delete or rename it or a folder above it, and unblocks the files.
#      With -WithBrowser, when that folder is there already (the package unpacked earlier without the browser), it gets
#      and checks only the browser zip, as above, and unpacks it into that package folder: only when the folder holds
#      the package of this version (its VERSION), the same check finds nobody else who can change it, and it has no
#      browser yet. Otherwise it stops with the reason, and unpacks nothing over it.
#   6. Starts rpa-windows-x64\Install-Rpa.ps1 from there, in this PowerShell, with the parameters it was given (a
#      -UserPassword as the same SecureString). The installer then checks the package itself, as it always does.
#
# What it trusts: this script itself (check it before you run it: it prints its own SHA-256 first); the GitHub Release
# for the .sha256 files (the hash shows only that a zip is the file published beside it); the attestation, when gh
# checked it (otherwise nothing shows that this project's release workflow built the zip); Windows PowerShell and gh.exe
# at their places under Windows and Program Files. It changes nothing on the machine before step 5, and nothing outside
# the download folder and C:\Program Files\RPA package before the installer starts. Exit codes: those of Install-Rpa.ps1
# (0 installed, 1 refused or failed, 3 declined at the question), and 1 when it stops before the installer.
[CmdletBinding()]
param(
  [string]$Zip,
  [string]$BrowserZip,
  [switch]$RequireAttestation,
  # The parameters of Install-Rpa.ps1, passed on as they were given (a test compares the two).
  [ValidateNotNullOrEmpty()][string]$User = 'rpa-runner',
  [Security.SecureString]$UserPassword,
  [ValidateRange(1, 65535)][int]$RunnerPort = 8765,
  [ValidateRange(1, 65535)][int]$BrowserPort = 3000,
  [string[]]$AllowFrom = @(),
  [switch]$AllowFromAnyAddress,
  [switch]$IncludePublicNetwork,
  [string]$Address,
  [switch]$NoBrowser,
  [switch]$WithBrowser,
  [switch]$NoFirewall,
  [switch]$AutoSignIn,
  [switch]$Unattended,
  [ValidateRange(0, 86400)][int]$IdleSeconds = 15,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

# Written into the published copy when the release is made (build\Stage.ps1); empty in the repository.
$Version = ''
$PackageSha256 = ''
$BrowserPackageSha256 = ''
$Repository = 'jb-n8n/n8n-nodes-rpa'
$PackageName = 'rpa-windows-x64'
$BrowserPackageName = 'rpa-browser-windows-x64'
# Install-Rpa.ps1's parameters, in its order: what is passed on, and how it is shown.
$InstallParameters = @('User', 'UserPassword', 'RunnerPort', 'BrowserPort', 'AllowFrom', 'AllowFromAnyAddress', 'IncludePublicNetwork', 'Address', 'NoBrowser', 'WithBrowser', 'NoFirewall', 'AutoSignIn', 'Unattended', 'IdleSeconds', 'Force')

# A path the person typed, as a full path: a relative one is resolved against PowerShell's current location (not the
# process's folder, which .NET uses and which is not where the person is), as the file system would read what was
# typed. Nothing is read as a pattern and no link is followed, so it is the path that was typed, in full. A place that
# is not the file system (Env:, HKLM:) is refused.
function Get-RpaTypedPath([string]$Path) {
  $provider = $null
  $drive = $null
  $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path, [ref]$provider, [ref]$drive)
  if ($provider.Name -ne 'FileSystem') { throw ('{0} is not a path in the file system.' -f $Path) }
  $full
}

# A file of the release desktop-v<version>.
function Get-RpaDownloadUrl([string]$Version, [string]$Name) {
  'https://github.com/{0}/releases/download/desktop-v{1}/{2}' -f $Repository, $Version, $Name
}

# The SHA-256 at the start of a .sha256 file (the form sha256sum writes), in lower case, or nothing.
function Get-RpaPublishedHash([string]$Text) {
  if ($Text -match '^([0-9A-Fa-f]{64})(\s|$)') { return $Matches[1].ToLowerInvariant() }
  $null
}

# What of the given parameters goes to Install-Rpa.ps1: all of them but this script's own, as they were given.
function Get-RpaInstallArguments($Bound) {
  $arguments = [ordered]@{}
  foreach ($name in $InstallParameters) { if ($Bound.ContainsKey($name)) { $arguments[$name] = $Bound[$name] } }
  $arguments
}

# The parameters as one line to show, without the password.
function Format-RpaInstallArguments($Arguments) {
  $parts = @()
  foreach ($name in $InstallParameters) {
    if (-not $Arguments.Contains($name)) { continue }
    $value = $Arguments[$name]
    if ($name -eq 'UserPassword') { $parts += '-UserPassword (given)' }
    elseif ($value -is [switch] -or $value -is [bool]) { if ([bool]$value) { $parts += "-$name" } else { $parts += "-${name}:`$false" } }
    elseif ($name -eq 'User') { $parts += "-User '{0}'" -f ([string]$value).Replace("'", "''") }
    else { $parts += '-{0} {1}' -f $name, (@($value) -join ',') }
  }
  $parts -join ' '
}

# The SHA-256 of what -Stream holds, read from its start, after it is compared with the .sha256 file -ShaPath and with
# -Named (when the script names one): a difference stops it.
function Get-RpaCheckedHash($Stream, [string]$ZipPath, [string]$ShaPath, [string]$Named, [string]$Version) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try { $hash = (($sha256.ComputeHash($Stream) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha256.Dispose() }
  $published = Get-RpaPublishedHash ([IO.File]::ReadAllText($ShaPath))
  if (-not $published) { throw ('{0} does not start with a SHA-256 (64 hexadecimal digits). Nothing was unpacked.' -f $ShaPath) }
  if ($hash -ne $published) { throw ('The SHA-256 of {0} is {1}, and {2} says {3}: the zip is not the file published beside it. Nothing was unpacked: do not use this zip.' -f $ZipPath, $hash, $ShaPath, $published) }
  if ($Named -and $hash -ne $Named) { throw ('The SHA-256 of {0} is {1}, and this Get-Rpa.ps1 of release {2} names {3}. Nothing was unpacked: do not use this zip.' -f $ZipPath, $hash, $Version, $Named) }
  $Stream.Position = 0
  $hash
}

# The text of a zip entry, trimmed (a VERSION file), or nothing when the zip has no entry of that name (with / or \).
function Read-RpaZipText($Archive, [string]$Name) {
  $entry = $Archive.GetEntry($Name)
  if (-not $entry) { $entry = $Archive.GetEntry($Name.Replace('/', '\')) }
  if (-not $entry) { return $null }
  $reader = New-Object IO.StreamReader ($entry.Open())
  try { $reader.ReadToEnd().Trim() } finally { $reader.Dispose() }
}

# Whether a zip entry's name stays inside where it is unpacked: no drive, no .. part.
function Test-RpaEntryName([string]$Name) {
  -not $Name.Contains(':') -and @($Name.Split('/') | Where-Object { $_ -eq '..' }).Count -eq 0
}

# Opens the browser zip -Browser (ZipPath, ShaPath, Named) through a handle of its own that lets others read it but
# not change it (added to -Opened, which the caller closes) and checks it: the SHA-256 against its .sha256 file and
# against -Browser.Named (when the script of release -Release names one), every entry inside browser\ or
# scripts\start-browser.ps1, its browser\VERSION equal to -Version (the version of -Of, the package it goes with), and
# -Attest. Any of these stops it with the reason. Returns the archive and the SHA-256.
function Open-RpaBrowserZip([hashtable]$Browser, [string]$Release, [string]$Version, [string]$Of, [scriptblock]$Attest, $Opened) {
  $stream = [IO.File]::Open($Browser.ZipPath, 'Open', 'Read', 'Read')
  $Opened.Add($stream)
  $hash = Get-RpaCheckedHash $stream $Browser.ZipPath $Browser.ShaPath $Browser.Named $Release
  $archive = New-Object IO.Compression.ZipArchive ($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
  $Opened.Add($archive)
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if (-not ($name.StartsWith('browser/') -or $name -eq 'scripts/start-browser.ps1') -or -not (Test-RpaEntryName $name)) {
      throw ('{0} holds {1}, which is not inside browser\ nor scripts\start-browser.ps1. Nothing was unpacked: do not use this zip.' -f $Browser.ZipPath, $entry.FullName)
    }
  }
  $held = Read-RpaZipText $archive 'browser/VERSION'
  if ($held -notmatch '^\d+\.\d+\.\d+$') { throw ('{0} holds no browser\VERSION with a version. Nothing was unpacked: do not use this zip.' -f $Browser.ZipPath) }
  if ($held -ne $Version) { throw ('{0} holds the browser of version {1}, and {2} is version {3}. Nothing was unpacked.' -f $Browser.ZipPath, $held, $Of, $Version) }
  $refusal = & $Attest $Browser.ZipPath $Version ([bool]$Browser.Named) ($BrowserPackageName + '.zip')
  if ($refusal) { throw ('{0} Nothing was unpacked.' -f $refusal) }
  @{ Archive = $archive; Hash = $hash }
}

# Checks the zip and unpacks it into <Root>\<version>: through one handle that lets others read the zip but not change
# it, the SHA-256 is compared with -ShaPath's and with -Named (when the script names one), -Attest is asked (with the
# zip's path, its version, whether the script names its SHA-256 and the zip's name; it returns a refusal or nothing),
# and every entry must be inside rpa-windows-x64\. With -Browser (ZipPath, ShaPath, Named: the browser zip) the browser
# zip gets the checks of Open-RpaBrowserZip, for the package's version, and is unpacked into the package folder. Any of
# these stops it with the reason before the folder is made. Returns the version, the SHA-256 of each zip (Hash,
# BrowserHash) and the package folder.
function Expand-RpaPackage([string]$ZipPath, [string]$ShaPath, [string]$Named, [string]$Version, [string]$Root, [scriptblock]$Attest, [hashtable]$Browser) {
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $opened = New-Object Collections.Generic.List[IDisposable]
  try {
    $stream = [IO.File]::Open($ZipPath, 'Open', 'Read', 'Read')
    $opened.Add($stream)
    $hash = Get-RpaCheckedHash $stream $ZipPath $ShaPath $Named $Version
    $archive = New-Object IO.Compression.ZipArchive ($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    $opened.Add($archive)
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if (-not $name.StartsWith($PackageName + '/') -or -not (Test-RpaEntryName $name)) {
        throw ('{0} holds {1}, which is not inside {2}\. Nothing was unpacked: do not use this zip.' -f $ZipPath, $entry.FullName, $PackageName)
      }
    }
    $held = Read-RpaZipText $archive ($PackageName + '/VERSION')
    if ($held -notmatch '^\d+\.\d+\.\d+$') { throw ('{0} holds no {1}\VERSION with a version. Nothing was unpacked: do not use this zip.' -f $ZipPath, $PackageName) }
    if ($Version -and $held -ne $Version) { throw ('{0} holds version {1}, and this Get-Rpa.ps1 is for version {2}. Nothing was unpacked.' -f $ZipPath, $held, $Version) }
    $refusal = & $Attest $ZipPath $held ([bool]$Named) ($PackageName + '.zip')
    if ($refusal) { throw ('{0} Nothing was unpacked.' -f $refusal) }

    $browserHash = $null
    $browserArchive = $null
    if ($Browser) {
      $checked = Open-RpaBrowserZip $Browser $Version $held $ZipPath $Attest $opened
      $browserHash = $checked.Hash
      $browserArchive = $checked.Archive
    }

    $folder = Join-Path $Root $held
    if (Test-Path -LiteralPath $folder) {
      throw ('{0} exists already. To install from it, run {1} with the same parameters; to unpack again, remove {0} first.' -f $folder, (Join-Path (Join-Path $folder $PackageName) 'Install-Rpa.ps1'))
    }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    New-Item -ItemType Directory -Path $folder | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $folder)
    if ($browserArchive) { [IO.Compression.ZipFileExtensions]::ExtractToDirectory($browserArchive, (Join-Path $folder $PackageName)) }
  } finally {
    for ($i = $opened.Count - 1; $i -ge 0; $i--) { $opened[$i].Dispose() }
  }
  @{ Version = $held; Hash = $hash; BrowserHash = $browserHash; Package = Join-Path $folder $PackageName }
}

# Adds the browser to the package of -Version that is unpacked already in -Folder (<root>\<version>): only when that
# package folder holds the package of -Version (its VERSION), -Judge (Get-RpaFolderRefusal) finds nobody else who can
# change it or -Folder, and it has no browser yet (neither browser\ nor scripts\start-browser.ps1). The browser zip
# gets the checks of Open-RpaBrowserZip, for -Version. Any of these stops it with the reason before anything is
# unpacked. Returns the version, the browser zip's SHA-256 (BrowserHash) and the package folder.
function Add-RpaBrowser([string]$Folder, [string]$Version, [scriptblock]$Attest, [hashtable]$Browser, [scriptblock]$Judge = { param($Path) Get-RpaFolderRefusal $Path }) {
  $package = Join-Path $Folder $PackageName
  $versionFile = Join-Path $package 'VERSION'
  $there = $null
  if (Test-Path -LiteralPath $versionFile -PathType Leaf) { $there = [IO.File]::ReadAllText($versionFile).Trim() }
  if ($there -ne $Version) { throw ('{0} does not hold the package of version {1} ({2}), so the browser is not added to it: to unpack again, remove {0} first. Nothing was unpacked.' -f $Folder, $Version, $versionFile) }
  foreach ($path in $package, $Folder) {
    $refusal = & $Judge $path
    if ($refusal) { throw ('{0} Nothing was unpacked.' -f $refusal) }
  }
  if ((Test-Path -LiteralPath (Join-Path $package 'browser')) -or (Test-Path -LiteralPath (Join-Path (Join-Path $package 'scripts') 'start-browser.ps1'))) {
    throw ('{0} has the browser already. To install from it, run {1} with the same parameters; to unpack again, remove {2} first.' -f $package, (Join-Path $package 'Install-Rpa.ps1'), $Folder)
  }
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $opened = New-Object Collections.Generic.List[IDisposable]
  try {
    $checked = Open-RpaBrowserZip $Browser $Version $Version $package $Attest $opened
    [IO.Compression.ZipFileExtensions]::ExtractToDirectory($checked.Archive, $package)
  } finally {
    for ($i = $opened.Count - 1; $i -ge 0; $i--) { $opened[$i].Dispose() }
  }
  @{ Version = $Version; BrowserHash = $checked.Hash; Package = $package }
}

# Whether the GitHub CLI at -Gh can check an attestation: missing, signed out (gh auth status fails) or ready.
function Get-RpaGhState([string]$Gh) {
  if (-not (Test-Path -LiteralPath $Gh -PathType Leaf)) { return 'missing' }
  $ErrorActionPreference = 'Continue'
  $null = & $Gh auth status 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -eq 0) { return 'ready' }
  'signed out'
}

# The attestation check: Refusal (stop before the unpack) or Line (what to say, and go on). A ready gh verifies the
# zip, and a failed check is a refusal. Without a ready gh the check is not made: a refusal with -Require, or when
# the script names no SHA-256 (-Named false: then only the attestation ties the zip to a release), otherwise a line
# that says so, why it matters and how to check it elsewhere (for the zip -ZipName, as the release names it).
function Test-RpaAttestation([string]$Gh, [string]$State, [string]$ZipPath, [string]$Version, [bool]$Require, [bool]$Named = $true, [string]$ZipName = ($PackageName + '.zip')) {
  $workflow = '{0}/.github/workflows/desktop-release.yml' -f $Repository
  $tag = 'refs/tags/desktop-v{0}' -f $Version
  if ($State -eq 'ready') {
    $ErrorActionPreference = 'Continue'
    $said = @(& $Gh attestation verify $ZipPath --repo $Repository --signer-workflow $workflow --source-ref $tag 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -eq 0) { return @{ Refusal = $null; Line = ('The attestation: gh accepted it (desktop-release.yml of {0}, tag desktop-v{1}).' -f $Repository, $Version) } }
    return @{ Refusal = ('gh attestation verify did not accept {0} (exit code {1}): {2}' -f $ZipPath, $code, (($said | Where-Object { $_ }) -join ' ')); Line = $null }
  }
  $reason = 'the GitHub CLI here is not signed in (gh auth status)'
  if ($State -eq 'missing') { $reason = 'the GitHub CLI is not installed here ({0})' -f $Gh }
  if (-not $Named) {
    return @{ Refusal = ('This Get-Rpa.ps1 names no SHA-256 for the zip: it was not published with a release, so only the build attestation ties the zip to one, and it cannot be checked: {0}. Use the Get-Rpa.ps1 published with the release, or install the GitHub CLI here and sign it in (gh auth login).' -f $reason); Line = $null }
  }
  if ($Require) {
    return @{ Refusal = ('-RequireAttestation: the build attestation cannot be checked: {0}. Install the GitHub CLI here and sign it in (gh auth login), then run this again.' -f $reason); Line = $null }
  }
  $line = "The build attestation was NOT checked: {0}. It shows that this project's release workflow built the zip; the hash only shows that the zip is the file published beside this script. To check it on a machine with gh: gh attestation verify {1} --repo {2} --signer-workflow {3} --source-ref {4}" -f $reason, $ZipName, $Repository, $workflow, $tag
  @{ Refusal = $null; Line = $line }
}

# Whether to get the browser zip as well (Get) or why this run stops (Refusal). The browser is asked for with
# -WithBrowser, or kept on an upgrade of an install that has it (-InstalledBrowser, from its install.json), as the
# installer keeps it, unless -NoBrowser removes it. With -Zip the browser zip is given with -BrowserZip too.
function Get-RpaBrowserChoice([bool]$WithBrowser, [bool]$NoBrowser, [string]$Zip, [string]$BrowserZip, [bool]$InstalledBrowser) {
  $choice = @{ Get = $false; Refusal = $null }
  if ($WithBrowser -and $NoBrowser) { $choice.Refusal = '-WithBrowser and -NoBrowser cannot be used together: -WithBrowser adds the browser, -NoBrowser leaves it out or removes it. Choose one.'; return $choice }
  $choice.Get = $WithBrowser -or ($InstalledBrowser -and -not $NoBrowser)
  $file = '{0}.zip, with its .sha256 file beside it' -f $BrowserPackageName
  if ($BrowserZip -and -not $Zip) { $choice.Refusal = '-BrowserZip goes with -Zip. Without -Zip, Get-Rpa.ps1 downloads the browser zip from the release.' }
  elseif ($BrowserZip -and -not $choice.Get) { $choice.Refusal = '-BrowserZip is for an install with the browser. Add -WithBrowser, or leave -BrowserZip out.' }
  elseif ($Zip -and $choice.Get -and -not $BrowserZip) {
    if ($WithBrowser) { $choice.Refusal = '-Zip with -WithBrowser needs -BrowserZip <path>: the path of {0}.' -f $file }
    else { $choice.Refusal = 'This install has the browser, so -Zip needs -BrowserZip <path> too: the path of {0}. Or remove the browser with -NoBrowser.' -f $file }
  }
  $choice
}

# The first account other than Administrators, SYSTEM, TrustedInstaller, CREATOR OWNER and the person running this
# that could change -Folder (create, write or delete in it, change its rules, take it), or delete, rename or
# re-permission a folder above it, or a link or junction on the way: why the installer is not started from there.
function Get-RpaFolderRefusal([string]$Folder) {
  $trusted = @{}
  foreach ($sid in 'S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0',
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { $trusted[$sid] = $true }
  $sections = [Security.AccessControl.AccessControlSections]'Owner, Access'
  $rights = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  $path = $Folder
  while ($path) {
    if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) { return ('{0} is a link or junction, so the installer is not started from it.' -f $path) }
    $who = $null
    try {
      $security = [IO.Directory]::GetAccessControl($path, $sections)
      $owner = $security.GetOwner([Security.Principal.SecurityIdentifier])
      if (-not $trusted.ContainsKey($owner.Value)) { $who = $owner }
      else {
        foreach ($rule in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
          if ($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
          if (([int]$rule.FileSystemRights -band $rights) -and -not $trusted.ContainsKey($rule.IdentityReference.Value)) { $who = $rule.IdentityReference; break }
        }
      }
      if ($who) { try { $who = $who.Translate([Security.Principal.NTAccount]).Value } catch { $who = $who.Value } }
    } catch { $who = 'someone whose access rules cannot be read' }
    if ($who) { return ('{0} can be changed by {1}, so the installer is not started from it. Give that folder the access rules of C:\Program Files.' -f $path, $who) }
    $path = [IO.Path]::GetDirectoryName($path)
    # Above the package folder: deleting, renaming or re-permissioning replaces it; creating something there does not.
    $rights = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000
  }
  $null
}

# Dot-sourced (the tests), only the functions above are defined.
if ($MyInvocation.InvocationName -eq '.') { return }

function Stop-Rpa([string]$Reason) {
  Write-Host $Reason
  exit 1
}

if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { Stop-Rpa 'Run Get-Rpa.ps1 from the 64-bit Windows PowerShell, not Windows PowerShell (x86).' }
if ($PSVersionTable.PSEdition -eq 'Core') { Stop-Rpa 'Run Get-Rpa.ps1 from Windows PowerShell (powershell.exe), not PowerShell 7 (pwsh).' }
if (-not (New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Stop-Rpa 'Run Get-Rpa.ps1 from an administrator PowerShell.'
}
if ([Environment]::OSVersion.Version.Build -lt 17763) { Stop-Rpa 'Windows 10 1809, Windows 11 or Windows Server 2019 or later (64-bit) is required.' }

$self = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()
if ($Version) { Write-Host ('Get-Rpa.ps1 for the RPA Windows package {0} (the SHA-256 of this script: {1})' -f $Version, $self) }
else { Write-Host ('Get-Rpa.ps1 from the repository, for a zip given with -Zip (the SHA-256 of this script: {0})' -f $self) }
if (-not $Zip -and -not $Version) { Stop-Rpa 'This Get-Rpa.ps1 names no release: use the one published beside rpa-windows-x64.zip, or give the zip with -Zip <path>.' }

# The GitHub CLI where its installer puts it, never one found along PATH.
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$gh = Join-Path (Join-Path $programFiles 'GitHub CLI') 'gh.exe'
$ghState = Get-RpaGhState $gh
# With -RequireAttestation, or in a copy that names no SHA-256, a gh that cannot check stops it before anything is
# downloaded or unpacked.
if ($ghState -ne 'ready') {
  $early = Test-RpaAttestation $gh $ghState '' $Version ([bool]$RequireAttestation) ([bool]$PackageSha256)
  if ($early.Refusal) { Stop-Rpa ('{0} Nothing was downloaded or unpacked.' -f $early.Refusal) }
}

# The browser zip too: with -WithBrowser, or for an install that has the browser (install.json under Program Files,
# which only administrators can change), unless -NoBrowser.
$installFile = Join-Path (Join-Path $programFiles 'RPA Runner') 'install.json'
$installedBrowser = $false
if (Test-Path -LiteralPath $installFile -PathType Leaf) {
  try { $installedBrowser = (Get-Content -Raw -LiteralPath $installFile -Encoding UTF8 | ConvertFrom-Json).browser -eq $true } catch { }
}
$choice = Get-RpaBrowserChoice ([bool]$WithBrowser) ([bool]$NoBrowser) $Zip $BrowserZip $installedBrowser
if ($choice.Refusal) { Stop-Rpa ('{0} Nothing was downloaded or unpacked.' -f $choice.Refusal) }
if ($choice.Get -and -not $WithBrowser) { Write-Host 'This install has the browser, so its zip is checked and unpacked too (-NoBrowser removes the browser instead).' }
if ($choice.Get -and $ghState -ne 'ready') {
  $early = Test-RpaAttestation $gh $ghState '' $Version ([bool]$RequireAttestation) ([bool]$BrowserPackageSha256) ($BrowserPackageName + '.zip')
  if ($early.Refusal) { Stop-Rpa ('{0} Nothing was downloaded or unpacked.' -f $early.Refusal) }
}

$root = Join-Path $programFiles 'RPA package'
# The package of this version unpacked already (by an earlier Get-Rpa.ps1): -WithBrowser adds the browser to it, with
# the browser zip only (Add-RpaBrowser says when it does not); without -WithBrowser the folder is left as it is.
$adding = $false
if ($Version -and (Test-Path -LiteralPath (Join-Path $root $Version))) {
  $folder = Join-Path $root $Version
  if (-not $WithBrowser) { Stop-Rpa ('{0} exists already. To install from it, run {1} with the same parameters; to unpack again, remove {0} first.' -f $folder, (Join-Path (Join-Path $folder $PackageName) 'Install-Rpa.ps1')) }
  $adding = $true
  Write-Host ('{0} exists already: only the browser zip is checked and unpacked into it, the package zip is not used again.' -f $folder)
}

if ($Zip) {
  # .NET resolves a relative path against the process's folder, not PowerShell's current location (cd): make it full.
  if (-not $adding) {
    try { $zipPath = Get-RpaTypedPath $Zip } catch { Stop-Rpa $_.Exception.Message }
    $shaPath = $zipPath + '.sha256'
    foreach ($file in $zipPath, $shaPath) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-Rpa ('{0} is not there. Give -Zip the path of rpa-windows-x64.zip, with its .sha256 file beside it.' -f $file) } }
  }
  if ($choice.Get) {
    try { $browserZipPath = Get-RpaTypedPath $BrowserZip } catch { Stop-Rpa $_.Exception.Message }
    foreach ($file in $browserZipPath, ($browserZipPath + '.sha256')) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-Rpa ('{0} is not there. Give -BrowserZip the path of {1}.zip, with its .sha256 file beside it.' -f $file, $BrowserPackageName) } }
  }
} else {
  $download = Join-Path $env:USERPROFILE ('Downloads\rpa-{0}' -f $Version)
  $zipPath = Join-Path $download ($PackageName + '.zip')
  $shaPath = $zipPath + '.sha256'
  $browserZipPath = Join-Path $download ($BrowserPackageName + '.zip')
}
$browserSpec = $null
if ($choice.Get) { $browserSpec = @{ ZipPath = $browserZipPath; ShaPath = $browserZipPath + '.sha256'; Named = $BrowserPackageSha256 } }

# Room for the download (unless -Zip), the unpacked package and the install, by drive.
$needed = @{}
$programDrive = [IO.Path]::GetPathRoot($programFiles)
$needed[$programDrive] = 2.6
if (-not $Zip) {
  $downloadDrive = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($download))
  if ($needed.ContainsKey($downloadDrive)) { $needed[$downloadDrive] += 0.7 } else { $needed[$downloadDrive] = 0.7 }
}
foreach ($drive in $needed.Keys) {
  $free = (New-Object IO.DriveInfo $drive).AvailableFreeSpace / 1GB
  if ($free -lt $needed[$drive]) { Stop-Rpa ('Drive {0} has {1:N1} GB free, and the download, the unpacked package and the install need about {2:N1} GB there.' -f $drive, $free, $needed[$drive]) }
}

if (-not $Zip) {
  # Windows PowerShell 5.1 needs TLS 1.2 for GitHub; without the progress bar a large download is much faster.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  New-Item -ItemType Directory -Force -Path $download | Out-Null
  if (-not $adding) {
    Write-Host ('Downloading {0} to {1}' -f (Get-RpaDownloadUrl $Version ($PackageName + '.zip')), $zipPath)
    try {
      Invoke-WebRequest -UseBasicParsing -Uri (Get-RpaDownloadUrl $Version ($PackageName + '.zip')) -OutFile $zipPath
      Write-Host ('Downloading {0}' -f (Get-RpaDownloadUrl $Version ($PackageName + '.zip.sha256')))
      Invoke-WebRequest -UseBasicParsing -Uri (Get-RpaDownloadUrl $Version ($PackageName + '.zip.sha256')) -OutFile $shaPath
    } catch { Stop-Rpa ('The download failed: {0} Nothing was unpacked.' -f $_.Exception.GetBaseException().Message) }
  }
  if ($choice.Get) {
    # The browser zip the same way, from the same release.
    Write-Host ('Downloading {0} to {1}' -f (Get-RpaDownloadUrl $Version ($BrowserPackageName + '.zip')), $browserZipPath)
    try {
      Invoke-WebRequest -UseBasicParsing -Uri (Get-RpaDownloadUrl $Version ($BrowserPackageName + '.zip')) -OutFile $browserZipPath
      Write-Host ('Downloading {0}' -f (Get-RpaDownloadUrl $Version ($BrowserPackageName + '.zip.sha256')))
      Invoke-WebRequest -UseBasicParsing -Uri (Get-RpaDownloadUrl $Version ($BrowserPackageName + '.zip.sha256')) -OutFile ($browserZipPath + '.sha256')
    } catch { Stop-Rpa ('The download failed: {0} Nothing was unpacked.' -f $_.Exception.GetBaseException().Message) }
  }
}

# Asked while each zip is held open, after its SHA-256 matched; the lines are said after the unpack.
$script:AttestationLines = @()
$attest = { param($ZipPath, $Version, $Named, $ZipName) $result = Test-RpaAttestation $gh $ghState $ZipPath $Version ([bool]$RequireAttestation) $Named $ZipName; $script:AttestationLines += $result.Line; $result.Refusal }
if ($adding) {
  Write-Host ('Checking {0}: its SHA-256, the build attestation and what it holds' -f $browserZipPath)
  try { $unpacked = Add-RpaBrowser (Join-Path $root $Version) $Version $attest $browserSpec }
  catch { Stop-Rpa $_.Exception.Message }
} else {
  if ($browserSpec) { Write-Host ('Checking {0} and {1}: their SHA-256, the build attestation and what they hold' -f $zipPath, $browserZipPath) }
  else { Write-Host ('Checking {0}: its SHA-256, the build attestation and what it holds' -f $zipPath) }
  try { $unpacked = Expand-RpaPackage $zipPath $shaPath $PackageSha256 $Version $root $attest $browserSpec }
  catch { Stop-Rpa $_.Exception.Message }
  $named = ''
  if ($PackageSha256) { $named = ', and the one this script names' }
  Write-Host ('  The SHA-256 is {0}: the one in {1}{2}.' -f $unpacked.Hash, $shaPath, $named)
}
if ($browserSpec) {
  $named = ''
  if ($BrowserPackageSha256) { $named = ', and the one this script names' }
  Write-Host ('  The SHA-256 of the browser zip is {0}: the one in {1}{2}.' -f $unpacked.BrowserHash, $browserSpec.ShaPath, $named)
}
foreach ($line in $script:AttestationLines) { Write-Host ('  {0}' -f $line) }
if ($adding) { Write-Host ('Unpacked the browser into {0}' -f $unpacked.Package) }
else { Write-Host ('Unpacked into {0}' -f (Split-Path -Parent $unpacked.Package)) }

$refusal = Get-RpaFolderRefusal (Split-Path -Parent $unpacked.Package)
if ($refusal) { Stop-Rpa ('{0} Nothing was installed.' -f $refusal) }
Get-ChildItem -LiteralPath $unpacked.Package -Recurse -File | Unblock-File

$installer = Join-Path $unpacked.Package 'Install-Rpa.ps1'
$arguments = Get-RpaInstallArguments $PSBoundParameters
Write-Host ('Starting {0} {1}' -f $installer, (Format-RpaInstallArguments $arguments)).TrimEnd()
& $installer @arguments
exit $LASTEXITCODE
