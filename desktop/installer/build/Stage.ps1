# Stages the Windows package in two parts: the package, one folder that Install-Rpa.ps1 installs from, and the browser
# package, the files that Install-Rpa.ps1 -WithBrowser needs in that folder besides. Each goes into a zip with its
# SHA-256, and the Get-Rpa.ps1 that is published beside the zips gets the version and both SHA-256 written into it.
# The desktop workflow (.github/workflows/desktop.yml) runs it, and it can be run by hand on a Windows machine with
# Windows PowerShell 5.1 or PowerShell 7, from a checkout of this repository:
#
#   .\Stage.ps1 -Out <dir> -RunnerDir <dir> -PolicyToolDir <dir> -RecorderDir <dir> -ErpDemoDir <dir>
#
#   -Out            where the packages go: <Out>\rpa-windows-x64\ and <Out>\rpa-browser-windows-x64\ (the trees below),
#                   <Out>\rpa-windows-x64.zip, <Out>\rpa-browser-windows-x64.zip, their .sha256 files and
#                   <Out>\Get-Rpa.ps1. What is there under those seven names is replaced.
#   -RunnerDir      the folder with the published RpaRunner.exe (dotnet publish desktop/runner/src/Rpa.Runner) and
#                   RpaSupervisor.exe (dotnet publish desktop/runner/src/Rpa.Supervisor, into the same folder)
#   -PolicyToolDir  the folder with the published RpaPolicy.exe (dotnet publish
#                   desktop/runner/src/Rpa.Runner.PolicyTool, on Windows: its administrator manifest is embedded
#                   only there)
#   -RecorderDir    the folder with the published RpaRecorder.exe (dotnet publish desktop/recorder/src/Rpa.Recorder)
#   -ErpDemoDir     the folder with the published demo app, v1\ErpDemo.exe and v2\ErpDemo.exe
#   Publish the runner, the supervisor, the policy tool and the recorder as single files without
#   IncludeNativeLibrariesForSelfExtract: such a program would unpack native libraries to the temp folder of whoever
#   starts it, at every start, and load them from there. Without it the publish leaves those libraries beside the
#   program, and this script copies every .dll it finds there into the program's folder with the program.
#   The NuGet packages in those programs are read from the obj\project.assets.json that each publish leaves in its
#   project folder, and their licence files from the NuGet packages folder named there, so publish from this checkout.
#
#   rpa-windows-x64\
#     Install-Rpa.ps1  Uninstall-Rpa.ps1  RpaInstall.psd1  RpaInstall.Plan.ps1  RpaInstall.SignIn.ps1
#     RpaInstall.Machine.ps1  rpa.cmd  LICENSE  THIRD-PARTY-NOTICES.md  VERSION
#     licenses\  <component>-<version>\ (the licence and notice files of each third-party component of this package)
#     runner\    RpaRunner.exe  RpaSupervisor.exe  RpaPolicy.exe  *.dll (their native libraries)  policy.example.json
#     recorder\  RpaRecorder.exe  *.dll (its native libraries)
#     scripts\   start-loop.ps1  start-runner.ps1  Show-RpaConnection.ps1  rpa.ps1
#     erp-demo\  v1\  v2\
#
#   rpa-browser-windows-x64\ (its zip holds what is in this folder, without the folder itself, so that unpacking it into
#   rpa-windows-x64\ adds these to the package)
#     browser\   VERSION  THIRD-PARTY-NOTICES.md  node.exe  host\{host.mjs,run-server.mjs}
#                gate\{gate.mjs,ecs.mjs,selfsigned.mjs}  node_modules\ (playwright)  ms-playwright\ (Chromium)
#                ms-playwright.sha256
#                licenses\  <component>-<version>\ (the licence and notice files of each third-party component of the
#                browser package)
#     scripts\   start-browser.ps1
#
# Each THIRD-PARTY-NOTICES.md is that zip's section of the THIRD-PARTY-NOTICES.md at the top of this repository,
# followed by a table of what the licenses\ beside it holds. The browser package's are in browser\, so that an install
# without the browser has none of them and the installer adds and removes them with the browser's files. The licence
# files come from the components themselves (the NuGet packages for the package; the Node.js zip, the npm packages and
# the browser builds for the browser package), and from desktop\installer\build\notices\ for a build that carries none;
# one that is missing stops the script.
#
# What comes from the network, and what it is checked against:
#   - Node.js for Windows x64 (node.exe, and the npm that comes with it, which is used here and not shipped), from
#     nodejs.org. The zip's SHA-256 must equal $NodeSha256 below, which is the line for this file in
#     https://nodejs.org/dist/v<version>/SHASUMS256.txt. To change the Node version, change both.
#   - playwright and playwright-core, through "npm ci" in a copy of images\browser\server. npm checks each package
#     against the hash in package-lock.json there. No install script of a package runs.
#   - Chromium (with the headless shell, ffmpeg and winldd), through Playwright's own installer (playwright install
#     chromium). Which builds it downloads is written in the playwright-core package that npm checked; the installer
#     itself checks no hash of the files. So this script lists every file it installed under browser\ms-playwright,
#     with each file's SHA-256, and the SHA-256 of that list must equal $BrowsersSha256 below. A new Playwright version
#     brings other builds and a new value; take it only when two builds on different machines and networks print the
#     same one. Then it removes Playwright's ffmpeg build, which Playwright uses only to record video (nothing in RPA
#     records video), and writes the list without its files into browser\ms-playwright.sha256.
# npm and Playwright's installer run without what the environment could say about where and how to download: the
# variables in $DownloadVariables are cleared for them (and only for them).
# VERSION and browser\VERSION are the <Version> of desktop\Directory.Build.props, the version the runner reports: the
# installer refuses browser files of another version than the package.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$RunnerDir,
  [Parameter(Mandatory = $true)][string]$PolicyToolDir,
  [Parameter(Mandatory = $true)][string]$RecorderDir,
  [Parameter(Mandatory = $true)][string]$ErpDemoDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$NodeVersion = '22.23.4'
$NodeSha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
# The SHA-256 of the list of the builds Playwright 1.63.0 installs on Windows x64 (609 files, ffmpeg's among them), as
# a build on a hosted CI machine and one on another Windows machine printed it on 2026-11-10. It changes together
# with the Playwright version in images\browser\server\package.json.
$BrowsersSha256 = '1b178abcd915d6ffa5b465a26ffafcf937544a7c862f5a69061ab68ae7cff240'
$PackageName = 'rpa-windows-x64'
$BrowserPackageName = 'rpa-browser-windows-x64'

# What Node's HTTPS client and Playwright 1.63.0's browser installer read about where and how to download: another
# download server (Playwright reads each PLAYWRIGHT_ name also as npm_config_<name> and npm_package_config_<name> in
# lower case, hence the two prefixes), another platform's builds, a proxy, more trusted certificates or none, and
# code that Node loads first. Matched in any letter case.
$DownloadVariables = @(
  'PLAYWRIGHT_DOWNLOAD_HOST', 'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST', 'PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST',
  'PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST', 'PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
  'PLAYWRIGHT_HOST_PLATFORM_OVERRIDE', 'PW_TEST_CDN_THAT_SHOULD_WORK',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA')
$DownloadVariablePrefixes = @('npm_config_playwright_', 'npm_package_config_playwright_')

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).ProviderPath
$installer = Join-Path $repo 'desktop\installer'
$browserSource = Join-Path $repo 'images\browser'

# desktop\installer\Get-Rpa.ps1 as it is published beside the zips: the same text with the version and the SHA-256 of
# each zip written into its three empty lines for them.
function Get-ReleaseGetRpa([string]$Source, [string]$Version, [string]$Sha256, [string]$BrowserSha256) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw ('{0} is not a version.' -f $Version) }
  foreach ($hash in $Sha256, $BrowserSha256) { if ($hash -notmatch '^[0-9a-f]{64}$') { throw ('{0} is not a SHA-256.' -f $hash) } }
  foreach ($line in "`$Version = ''", "`$PackageSha256 = ''", "`$BrowserPackageSha256 = ''") {
    if (([regex]::Matches($Source, ('(?m)^{0}\r?$' -f [regex]::Escape($line)))).Count -ne 1) { throw ('Get-Rpa.ps1 does not hold the line {0} exactly once.' -f $line) }
  }
  $Source.Replace("`$Version = ''", ("`$Version = '{0}'" -f $Version)).Replace("`$PackageSha256 = ''", ("`$PackageSha256 = '{0}'" -f $Sha256)).Replace("`$BrowserPackageSha256 = ''", ("`$BrowserPackageSha256 = '{0}'" -f $BrowserSha256))
}

function Get-Sha256([string]$File) {
  (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
}

# Copies named files, each of which must be there, into a folder that is created when it is missing.
function Copy-Named([string]$From, [string[]]$Names, [string]$To) {
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  foreach ($name in $Names) {
    $file = Join-Path $From $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('{0} is missing.' -f $file) }
    Copy-Item -LiteralPath $file -Destination (Join-Path $To $name)
  }
}

# Runs a program without the variables of $DownloadVariables and with those of -Environment, and stops when its exit
# code says that it failed. This script's own environment is put back afterwards. What the program writes to its
# error stream does not stop the script by itself.
function Invoke-Tool([string]$What, [string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory, [hashtable]$Environment = @{}) {
  $saved = @{}
  foreach ($variable in @(Get-ChildItem Env:)) {
    $name = $variable.Name
    $prefixed = @($DownloadVariablePrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    if ($prefixed -or $DownloadVariables -contains $name -or $Environment.ContainsKey($name)) { $saved[$name] = $variable.Value }
  }
  foreach ($name in $saved.Keys) { Remove-Item -LiteralPath ('Env:' + $name) }
  foreach ($name in $Environment.Keys) { Set-Item -LiteralPath ('Env:' + $name) -Value $Environment[$name] }
  Push-Location -LiteralPath $WorkingDirectory
  $ErrorActionPreference = 'Continue'
  try {
    # Without the progress bars of Playwright's installer.
    & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^\|' } | Out-Host
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    foreach ($name in $Environment.Keys) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    foreach ($name in $saved.Keys) { Set-Item -LiteralPath ('Env:' + $name) -Value $saved[$name] }
  }
  if ($code -ne 0) { throw ('{0} failed with exit code {1}.' -f $What, $code) }
}

# Copies a published program and the native libraries its publish left beside it (every .dll there; not the .pdb
# files, nor what else the caller put in that folder). Two programs may bring a library of the same name; it must then
# be the same file.
function Copy-Program([string]$From, [string]$Exe, [string]$To) {
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $files = @(Get-Item -LiteralPath (Join-Path $From $Exe)) + @(Get-ChildItem -LiteralPath $From -File | Where-Object { $_.Extension -eq '.dll' })
  foreach ($file in $files) {
    $target = Join-Path $To $file.Name
    if (Test-Path -LiteralPath $target) {
      if ((Get-Sha256 $target) -ne (Get-Sha256 $file.FullName)) { throw ('{0} and {1} have the same name and differ.' -f $file.FullName, $target) }
      continue
    }
    Copy-Item -LiteralPath $file.FullName -Destination $target
  }
}

# One line per file below $Root: its SHA-256 and its path below $Root with forward slashes, separated by two spaces
# (the form sha256sum -c reads), sorted by the path with an ordinal comparison, each line ended by LF. A link or
# junction below $Root stops the script: the list would not say what it points to.
function Get-FileList([string]$Root) {
  $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  $link = @($items | Where-Object { [int]($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1)
  if ($link.Count -gt 0) { throw ('{0} is a link or junction.' -f $link[0].FullName) }
  $files = @($items | Where-Object { -not $_.PSIsContainer })
  $paths = [string[]]@($files | ForEach-Object { $_.FullName.Substring($Root.Length + 1).Replace('\', '/') })
  $hashes = [string[]]@($files | ForEach-Object { Get-Sha256 $_.FullName })
  [Array]::Sort($paths, $hashes, [StringComparer]::Ordinal)
  $list = New-Object Text.StringBuilder
  for ($i = 0; $i -lt $paths.Length; $i++) { [void]$list.Append($hashes[$i]).Append('  ').Append($paths[$i]).Append("`n") }
  $list.ToString()
}

# A list that Get-FileList made, without the lines of the files below one of its top folders. A folder the list does
# not name stops the script.
function Get-ListWithout([string]$List, [string]$Folder) {
  $below = '  {0}/' -f $Folder
  $kept = New-Object Text.StringBuilder
  $dropped = 0
  foreach ($line in $List.Split([char]10)) {
    if (-not $line) { continue }
    if ($line.IndexOf($below, [StringComparison]::Ordinal) -eq 64) { $dropped++; continue }
    [void]$kept.Append($line).Append("`n")
  }
  if ($dropped -eq 0) { throw ('The list of the browser files names nothing below {0}/.' -f $Folder) }
  $kept.ToString()
}

# The NuGet packages in the published programs, from the project.assets.json that each publish left: every package with
# code for win-x64 (a package whose only entry there is "_._" brings none), and the runtime packs a self-contained publish
# takes the .NET runtime from (*.Runtime.win-x64). Each package once, sorted by name, with its folder: in the first of
# the restore's package folders (the NuGet packages folder, then any fallback folders) that holds it.
function Get-NuGetComponents([string[]]$AssetsFiles) {
  $found = @{}
  foreach ($file in $AssetsFiles) {
    $assets = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    $folders = @($assets.packageFolders.PSObject.Properties | ForEach-Object { $_.Name })
    $targets = @($assets.targets.PSObject.Properties | Where-Object { $_.Name -like '*/win-x64' })
    if ($folders.Count -eq 0 -or $targets.Count -ne 1) { throw ('{0} is not the restore of a win-x64 publish.' -f $file) }
    $packages = @()
    foreach ($library in $targets[0].Value.PSObject.Properties) {
      if ($library.Value.type -ne 'package') { continue }
      $code = @(foreach ($group in 'runtime', 'native') {
          if ($library.Value.$group) { $library.Value.$group.PSObject.Properties | Where-Object { -not $_.Name.EndsWith('/_._') } }
        })
      if ($code.Count -eq 0) { continue }
      $id, $version = $library.Name.Split('/')
      $packages += , @($id, $version, $assets.libraries.($library.Name).path)
    }
    foreach ($framework in $assets.project.frameworks.PSObject.Properties) {
      foreach ($pack in @($framework.Value.downloadDependencies | Where-Object { $_.name -like '*.Runtime.win-x64' })) {
        if ($pack.version -notmatch '^\[([^,\]]+), ?\1\]$') { throw ('{0} names {1} in no single version ({2}).' -f $file, $pack.name, $pack.version) }
        $packages += , @($pack.name, $Matches[1], ('{0}/{1}' -f $pack.name.ToLowerInvariant(), $Matches[1]))
      }
    }
    foreach ($package in $packages) {
      $id, $version, $path = $package
      $folder = @($folders | ForEach-Object { Join-Path $_ $path } | Where-Object { Test-Path -LiteralPath $_ -PathType Container }) + @(Join-Path $folders[0] $path)
      $found[('{0}/{1}' -f $id, $version)] = [pscustomobject]@{ Id = $id; Version = $version; Folder = $folder[0] }
    }
  }
  @($found.Values | Sort-Object Id, Version)
}

# The names of the licence and notice files at the top of a component's folder (LICENSE*, NOTICE*,
# THIRD-PARTY-NOTICES* and ThirdPartyNotices*, in any letter case), sorted. A folder without one stops the script.
function Get-LicenseFiles([string]$Folder) {
  if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { throw ('{0} is missing.' -f $Folder) }
  $names = @(Get-ChildItem -LiteralPath $Folder -File | Where-Object { $_.Name -match '^(LICENSE|NOTICE|THIRD-PARTY-NOTICES|ThirdPartyNotices)' } | ForEach-Object { $_.Name } | Sort-Object)
  if ($names.Count -eq 0) { throw ('{0} holds no LICENSE, NOTICE or THIRD-PARTY-NOTICES file.' -f $Folder) }
  $names
}

# The end of a package's THIRD-PARTY-NOTICES.md: one row for each folder of its licence folder (Name, Version, Files).
# -Folder is that folder as the file names it: licenses\ in the package, browser\licenses\ in the browser package.
function Get-NoticesIndex([object[]]$Entries, [string]$Folder) {
  $text = New-Object Text.StringBuilder
  [void]$text.Append("`n## The licence texts in this package`n`n")
  [void]$text.Append(("The build copied these files into ``{0}``, one folder per component, named ``<component>-<version>``.`n`n" -f $Folder))
  [void]$text.Append("| Component | Version | Files |`n|---|---|---|`n")
  foreach ($entry in $Entries) {
    [void]$text.Append(('| {0} | {1} | {2} |' -f $entry.Name, $entry.Version, (@($entry.Files | ForEach-Object { '`{0}`' -f $_ }) -join ', '))).Append("`n")
  }
  $text.ToString()
}

# The section of the repository's THIRD-PARTY-NOTICES.md under the line "## <Heading>", that line included, up to the
# next heading of that level, without the blank lines at its end; line ends LF whatever the file has. A heading that is
# not there exactly once stops the script.
function Get-NoticesSection([string]$Text, [string]$Heading) {
  $lines = ($Text -replace "`r`n", "`n").Split([char]10)
  $starts = @(for ($i = 0; $i -lt $lines.Length; $i++) { if ($lines[$i] -ceq ('## ' + $Heading)) { $i } })
  if ($starts.Count -ne 1) { throw ('THIRD-PARTY-NOTICES.md does not hold the heading "## {0}" exactly once.' -f $Heading) }
  $end = $starts[0] + 1
  while ($end -lt $lines.Length -and -not $lines[$end].StartsWith('## ')) { $end++ }
  ($lines[$starts[0]..($end - 1)] -join "`n").TrimEnd()
}

# The THIRD-PARTY-NOTICES.md of one package, line ends LF: a short opening, that package's section of the repository's
# THIRD-PARTY-NOTICES.md (-Text), and the table of what its licence folder (-Folder) holds. It names nothing of the
# other package.
function Get-PackageNotices([string]$Text, [string]$Heading, [string]$Folder, [object[]]$Entries) {
  "# Third-party notices`n`nRPA's own code is under the MIT licence in the package's ``LICENSE``. This file lists the software by others in the zip named below, with its licences. It is not legal advice.`n`n" +
  (Get-NoticesSection $Text $Heading) + "`n" + (Get-NoticesIndex $Entries $Folder)
}

# Copies the licence files of each component (-Entries: Name, Version, From, Files) into <Root>\licenses\<name>-<version>\
# (Copy-Named stops at a file that is missing), and writes <Root>\THIRD-PARTY-NOTICES.md with Windows line ends.
# -Root is the top of the package, or browser\ in the browser package.
function Write-PackageNotices([string]$Root, [string]$Folder, [string]$Heading, [object[]]$Entries) {
  if ($Entries.Count -eq 0) { throw ('No third-party component was found for {0}.' -f $Heading) }
  foreach ($entry in $Entries) { Copy-Named $entry.From $entry.Files (Join-Path (Join-Path $Root 'licenses') ('{0}-{1}' -f $entry.Name, $entry.Version)) }
  $text = Get-PackageNotices ([IO.File]::ReadAllText((Join-Path $repo 'THIRD-PARTY-NOTICES.md'))) $Heading $Folder $Entries
  [IO.File]::WriteAllText((Join-Path $Root 'THIRD-PARTY-NOTICES.md'), ($text -replace "`r?`n", "`r`n"), (New-Object Text.UTF8Encoding $false))
  Write-Host ('THIRD-PARTY-NOTICES.md, and the licence files of {0} components in {1}' -f $Entries.Count, $Folder)
}

foreach ($needed in @((Join-Path $RunnerDir 'RpaRunner.exe'), (Join-Path $RunnerDir 'RpaSupervisor.exe'), (Join-Path $PolicyToolDir 'RpaPolicy.exe'), (Join-Path $RecorderDir 'RpaRecorder.exe'),
    (Join-Path $ErpDemoDir 'v1\ErpDemo.exe'), (Join-Path $ErpDemoDir 'v2\ErpDemo.exe'))) {
  if (-not (Test-Path -LiteralPath $needed -PathType Leaf)) { throw ('{0} is missing. Publish it first.' -f $needed) }
}
$RunnerDir = (Resolve-Path -LiteralPath $RunnerDir).ProviderPath
$PolicyToolDir = (Resolve-Path -LiteralPath $PolicyToolDir).ProviderPath
$RecorderDir = (Resolve-Path -LiteralPath $RecorderDir).ProviderPath
$ErpDemoDir = (Resolve-Path -LiteralPath $ErpDemoDir).ProviderPath

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).ProviderPath
$stage = Join-Path $Out $PackageName
$browserStage = Join-Path $Out $BrowserPackageName
$zip = Join-Path $Out ($PackageName + '.zip')
$browserZip = Join-Path $Out ($BrowserPackageName + '.zip')
$work = Join-Path $Out 'stage-work'
foreach ($old in $stage, $browserStage, $work) { if (Test-Path -LiteralPath $old) { [IO.Directory]::Delete($old, $true) } }
$getRpa = Join-Path $Out 'Get-Rpa.ps1'
foreach ($old in $zip, ($zip + '.sha256'), $browserZip, ($browserZip + '.sha256'), $getRpa) { if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force } }
New-Item -ItemType Directory -Path $stage, $browserStage, $work | Out-Null

Write-Host 'The installer, the license and the version'
Copy-Named $installer @('Install-Rpa.ps1', 'Uninstall-Rpa.ps1', 'RpaInstall.psd1', 'RpaInstall.Plan.ps1', 'RpaInstall.SignIn.ps1', 'RpaInstall.Machine.ps1', 'rpa.cmd') $stage
Copy-Named (Join-Path $installer 'scripts') @('start-loop.ps1', 'start-runner.ps1', 'Show-RpaConnection.ps1', 'rpa.ps1') (Join-Path $stage 'scripts')
Copy-Named $repo @('LICENSE') $stage
$properties = Get-Content -Raw -LiteralPath (Join-Path $repo 'desktop\Directory.Build.props')
if ($properties -notmatch '<Version>(\d+\.\d+\.\d+)</Version>') { throw 'desktop\Directory.Build.props names no <Version>.' }
$version = $Matches[1]
[IO.File]::WriteAllText((Join-Path $stage 'VERSION'), $version + "`r`n", [Text.Encoding]::ASCII)

Write-Host 'The runner, the supervisor, the policy tool, the recorder and the demo app'
Copy-Program $RunnerDir 'RpaRunner.exe' (Join-Path $stage 'runner')
Copy-Program $RunnerDir 'RpaSupervisor.exe' (Join-Path $stage 'runner')
Copy-Program $PolicyToolDir 'RpaPolicy.exe' (Join-Path $stage 'runner')
Copy-Program $RecorderDir 'RpaRecorder.exe' (Join-Path $stage 'recorder')
Copy-Named (Join-Path $repo 'desktop\runner') @('policy.example.json') (Join-Path $stage 'runner')
foreach ($ui in 'v1', 'v2') {
  $target = Join-Path (Join-Path $stage 'erp-demo') $ui
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $ErpDemoDir $ui) -File | Where-Object { $_.Extension -ne '.pdb' } | Copy-Item -Destination $target
}

Write-Host 'The third-party notices of the package'
# The NuGet packages and runtime packs the published programs were built with, each with its licence files.
$assetsFiles = @('runner\src\Rpa.Runner', 'runner\src\Rpa.Supervisor', 'runner\src\Rpa.Runner.PolicyTool', 'recorder\src\Rpa.Recorder', 'erp-demo') |
  ForEach-Object { Join-Path $repo ('desktop\{0}\obj\project.assets.json' -f $_) }
$packageNotices = @(foreach ($package in Get-NuGetComponents $assetsFiles) {
    [pscustomobject]@{ Name = $package.Id; Version = $package.Version; From = $package.Folder; Files = @(Get-LicenseFiles $package.Folder) }
  })
Write-PackageNotices $stage 'licenses\' ('The Windows package (`{0}.zip`)' -f $PackageName) $packageNotices

Write-Host 'The browser package: its version and its start script'
$browser = Join-Path $browserStage 'browser'
New-Item -ItemType Directory -Path $browser | Out-Null
[IO.File]::WriteAllText((Join-Path $browser 'VERSION'), $version + "`r`n", [Text.Encoding]::ASCII)
Copy-Named (Join-Path $installer 'scripts') @('start-browser.ps1') (Join-Path $browserStage 'scripts')

Write-Host ('Node.js {0}' -f $NodeVersion)
$nodeName = 'node-v{0}-win-x64' -f $NodeVersion
$nodeZip = Join-Path $work ($nodeName + '.zip')
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/v{0}/{1}.zip' -f $NodeVersion, $nodeName) -OutFile $nodeZip
$hash = Get-Sha256 $nodeZip
if ($hash -ne $NodeSha256) { throw ('{0}.zip has the SHA-256 {1}, not the expected {2}. Nothing of it was used.' -f $nodeName, $hash, $NodeSha256) }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($nodeZip, $work)
$nodeDir = Join-Path $work $nodeName
$node = Join-Path $nodeDir 'node.exe'
Copy-Named $nodeDir @('node.exe') $browser

Write-Host 'The browser host and the gate'
Copy-Named (Join-Path $browserSource 'host') @('host.mjs', 'run-server.mjs') (Join-Path $browser 'host')
Copy-Named (Join-Path $browserSource 'gate') @('gate.mjs', 'ecs.mjs', 'selfsigned.mjs') (Join-Path $browser 'gate')

Write-Host 'Playwright (npm ci from images\browser\server)'
$server = Join-Path $work 'server'
Copy-Named (Join-Path $browserSource 'server') @('package.json', 'package-lock.json') $server
$npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
Invoke-Tool 'npm ci' $node @($npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--cache', (Join-Path $work 'npm-cache')) $server
# The command shims in .bin start whatever "node" is found along PATH; the host does not use them.
$shims = Join-Path $server 'node_modules\.bin'
if (Test-Path -LiteralPath $shims) { [IO.Directory]::Delete($shims, $true) }
[IO.Directory]::Move((Join-Path $server 'node_modules'), (Join-Path $browser 'node_modules'))
$wanted = ((Get-Content -Raw -LiteralPath (Join-Path $server 'package.json') | ConvertFrom-Json).dependencies).playwright
$installed = (Get-Content -Raw -LiteralPath (Join-Path $browser 'node_modules\playwright\package.json') | ConvertFrom-Json).version
if ($installed -ne $wanted) { throw ('playwright {0} was installed, not {1}.' -f $installed, $wanted) }

Write-Host ('Chromium (playwright {0} install chromium)' -f $installed)
$browsers = Join-Path $browser 'ms-playwright'
Invoke-Tool 'playwright install chromium' $node @((Join-Path $browser 'node_modules\playwright\cli.js'), 'install', 'chromium') $browser @{ PLAYWRIGHT_BROWSERS_PATH = $browsers }
# Playwright notes there which install uses the browsers: the path of this build, which is not the installed one.
$links = Join-Path $browsers '.links'
if (Test-Path -LiteralPath $links) { [IO.Directory]::Delete($links, $true) }
foreach ($kind in 'chromium-*', 'chromium_headless_shell-*') {
  if (-not (Get-ChildItem -LiteralPath $browsers -Directory -Filter $kind)) { throw ('{0} holds no {1} after the install.' -f $browsers, $kind) }
}
$listFile = Join-Path $browser 'ms-playwright.sha256'
$installedList = Get-FileList $browsers
[IO.File]::WriteAllText($listFile, $installedList, (New-Object Text.UTF8Encoding $false))
$listHash = Get-Sha256 $listFile
if ($listHash -ne $BrowsersSha256) {
  Get-Content -LiteralPath $listFile | Out-Host
  $expected = if ($BrowsersSha256) { $BrowsersSha256 } else { '(empty)' }
  throw ('The browser files are not the ones this script expects: the SHA-256 of their list (above, written to {0}) is {1}, and $BrowsersSha256 in this script is {2}. The value changes together with the Playwright version in images\browser\server\package.json; take a new one only when two builds on different machines and networks print the same.' -f $listFile, $listHash, $expected)
}
# Playwright's installer puts its ffmpeg build beside Chromium. Playwright runs it only to record video of a page
# (VideoRecorder in playwright-core), and nothing in RPA records video, so it is not shipped: a client that asks this
# browser for a video gets Playwright's error that the ffmpeg executable does not exist.
$builds = @((Get-Content -Raw -LiteralPath (Join-Path $browser 'node_modules\playwright-core\browsers.json') | ConvertFrom-Json).browsers)
$ffmpeg = 'ffmpeg-{0}' -f @($builds | Where-Object { $_.name -eq 'ffmpeg' })[0].revision
[IO.Directory]::Delete((Join-Path $browsers $ffmpeg), $true)
[IO.File]::WriteAllText($listFile, (Get-ListWithout $installedList $ffmpeg), (New-Object Text.UTF8Encoding $false))
Write-Host ('{0} files under browser\ms-playwright, as listed in browser\ms-playwright.sha256: what Playwright installed (the SHA-256 of its list is {1}) without {2}' -f @(Get-Content -LiteralPath $listFile).Count, $listHash, $ffmpeg)

Write-Host 'The third-party notices of the browser package'
# Each component's licence files, copied from the component into browser\licenses\<name>-<version>\.
$chromium = @($builds | Where-Object { $_.name -eq 'chromium' })[0]
$shell = @($builds | Where-Object { $_.name -eq 'chromium-headless-shell' })[0]
$winldd = @($builds | Where-Object { $_.name -eq 'winldd' })[0]
$browserNotices = @(
  [pscustomobject]@{ Name = 'node'; Version = $NodeVersion; From = $nodeDir; Files = @('LICENSE') }
  [pscustomobject]@{ Name = 'playwright'; Version = $installed; From = (Join-Path $browser 'node_modules\playwright'); Files = @('LICENSE', 'NOTICE', 'ThirdPartyNotices.txt') }
  [pscustomobject]@{ Name = 'playwright-core'; Version = $installed; From = (Join-Path $browser 'node_modules\playwright-core'); Files = @('LICENSE', 'NOTICE', 'ThirdPartyNotices.txt') }
  [pscustomobject]@{ Name = 'chrome-for-testing'; Version = $chromium.browserVersion; From = (Join-Path $browsers ('chromium-{0}\chrome-win64' -f $chromium.revision)); Files = @('ABOUT') }
  [pscustomobject]@{ Name = 'chrome-headless-shell'; Version = $shell.browserVersion; From = (Join-Path $browsers ('chromium_headless_shell-{0}\chrome-headless-shell-win64' -f $shell.revision)); Files = @('LICENSE.headless_shell') }
  # The winldd build carries no licence file. This repository keeps the licence headers of its source for one build;
  # another build stops here until they are checked and kept for it.
  [pscustomobject]@{ Name = 'winldd'; Version = $winldd.revision; From = (Join-Path $PSScriptRoot ('notices\winldd-{0}' -f $winldd.revision)); Files = @('LICENSE.txt') }
)
Write-PackageNotices $browser 'browser\licenses\' ('The browser package (`{0}.zip`)' -f $BrowserPackageName) $browserNotices

Write-Host 'The zips'
[IO.Directory]::Delete($work, $true)
# The package's zip holds its folder; the browser package's holds what is in its folder, for unpacking into the
# package's folder.
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
[IO.Compression.ZipFile]::CreateFromDirectory($browserStage, $browserZip, [IO.Compression.CompressionLevel]::Optimal, $false)
$hash = Get-Sha256 $zip
$browserHash = Get-Sha256 $browserZip
[IO.File]::WriteAllText(($zip + '.sha256'), ('{0}  {1}.zip' -f $hash, $PackageName), [Text.Encoding]::ASCII)
[IO.File]::WriteAllText(($browserZip + '.sha256'), ('{0}  {1}.zip' -f $browserHash, $BrowserPackageName), [Text.Encoding]::ASCII)
[IO.File]::WriteAllText($getRpa, (Get-ReleaseGetRpa (Get-Content -Raw -LiteralPath (Join-Path $installer 'Get-Rpa.ps1')) $version $hash $browserHash), [Text.Encoding]::ASCII)

foreach ($part in @(@{ Name = $PackageName; Folder = $stage; Zip = $zip; Hash = $hash }, @{ Name = $BrowserPackageName; Folder = $browserStage; Zip = $browserZip; Hash = $browserHash })) {
  $files = @(Get-ChildItem -LiteralPath $part.Folder -Recurse -File)
  $bytes = ($files | Measure-Object -Property Length -Sum).Sum
  Write-Host ('{0} {1}: {2} files, {3:N1} MB unpacked' -f $part.Name, $version, $files.Count, ($bytes / 1MB))
  Write-Host ('{0}.zip: {1:N1} MB, SHA-256 {2}' -f $part.Name, ((Get-Item -LiteralPath $part.Zip).Length / 1MB), $part.Hash)
}
