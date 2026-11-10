# Stages the Windows package: one folder that Install-Rpa.ps1 installs from, and a zip of it with its SHA-256.
# The desktop workflow (.github/workflows/desktop.yml) runs it, and it can be run by hand on a Windows machine with
# Windows PowerShell 5.1 or PowerShell 7, from a checkout of this repository:
#
#   .\Stage.ps1 -Out <dir> -RunnerDir <dir> -PolicyToolDir <dir> -ErpDemoDir <dir>
#
#   -Out            where the package goes: <Out>\rpa-windows-x64\ (the tree below), <Out>\rpa-windows-x64.zip and
#                   <Out>\rpa-windows-x64.zip.sha256. What is there under those three names is replaced.
#   -RunnerDir      the folder with the published RpaRunner.exe (dotnet publish desktop/runner/src/Rpa.Runner)
#   -PolicyToolDir  the folder with the published RpaPolicy.exe (dotnet publish
#                   desktop/runner/src/Rpa.Runner.PolicyTool, on Windows: its administrator manifest is embedded
#                   only there)
#   -ErpDemoDir     the folder with the published demo app, v1\ErpDemo.exe and v2\ErpDemo.exe
#
#   rpa-windows-x64\
#     Install-Rpa.ps1  Uninstall-Rpa.ps1  RpaInstall.psd1  RpaInstall.Plan.ps1  RpaInstall.SignIn.ps1
#     RpaInstall.Machine.ps1  LICENSE  VERSION
#     runner\    RpaRunner.exe  RpaPolicy.exe  policy.example.json
#     browser\   node.exe  LICENSE-node.txt  host\{host.mjs,run-server.mjs}  gate\{gate.mjs,ecs.mjs,selfsigned.mjs}
#                node_modules\ (playwright)  ms-playwright\ (Chromium)
#     scripts\   start-loop.ps1  start-runner.ps1  start-browser.ps1  Show-RpaConnection.ps1
#     erp-demo\  v1\  v2\
#
# What comes from the network, and what it is checked against:
#   - Node.js for Windows x64 (node.exe, and the npm that comes with it, which is used here and not shipped), from
#     nodejs.org. The zip's SHA-256 must equal the one written below, which is the line for this file in
#     https://nodejs.org/dist/v<version>/SHASUMS256.txt. To change the Node version, change both.
#   - playwright and playwright-core, through "npm ci" in a copy of images\browser\server. npm checks each package
#     against the hash in package-lock.json there. No install script of a package runs.
#   - Chromium, through Playwright's own installer (playwright install chromium). Which builds it downloads is
#     written in the playwright-core package that npm checked; the files come from Playwright's download server over
#     HTTPS. This script holds no hash for them. The variables that point that installer at another server
#     (PLAYWRIGHT_DOWNLOAD_HOST and the like) are cleared first.
# VERSION is the <Version> of desktop\Directory.Build.props, the version the runner reports.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$RunnerDir,
  [Parameter(Mandatory = $true)][string]$PolicyToolDir,
  [Parameter(Mandatory = $true)][string]$ErpDemoDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$NodeVersion = '22.23.4'
$NodeSha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
$PackageName = 'rpa-windows-x64'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).ProviderPath
$installer = Join-Path $repo 'desktop\installer'
$browserSource = Join-Path $repo 'images\browser'

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

# Runs a program and stops when its exit code says that it failed. What the program writes to its error stream does
# not stop the script by itself.
function Invoke-Tool([string]$What, [string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location -LiteralPath $WorkingDirectory
  $ErrorActionPreference = 'Continue'
  # Without the progress bars of Playwright's installer.
  try { & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^\|' } | Out-Host } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw ('{0} failed with exit code {1}.' -f $What, $LASTEXITCODE) }
}

foreach ($needed in @((Join-Path $RunnerDir 'RpaRunner.exe'), (Join-Path $PolicyToolDir 'RpaPolicy.exe'),
    (Join-Path $ErpDemoDir 'v1\ErpDemo.exe'), (Join-Path $ErpDemoDir 'v2\ErpDemo.exe'))) {
  if (-not (Test-Path -LiteralPath $needed -PathType Leaf)) { throw ('{0} is missing. Publish it first.' -f $needed) }
}
$RunnerDir = (Resolve-Path -LiteralPath $RunnerDir).ProviderPath
$PolicyToolDir = (Resolve-Path -LiteralPath $PolicyToolDir).ProviderPath
$ErpDemoDir = (Resolve-Path -LiteralPath $ErpDemoDir).ProviderPath

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).ProviderPath
$stage = Join-Path $Out $PackageName
$zip = Join-Path $Out ($PackageName + '.zip')
$work = Join-Path $Out 'stage-work'
foreach ($old in $stage, $work) { if (Test-Path -LiteralPath $old) { [IO.Directory]::Delete($old, $true) } }
foreach ($old in $zip, ($zip + '.sha256')) { if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force } }
New-Item -ItemType Directory -Path $stage, $work | Out-Null

Write-Host 'The installer, the license and the version'
Copy-Named $installer @('Install-Rpa.ps1', 'Uninstall-Rpa.ps1', 'RpaInstall.psd1', 'RpaInstall.Plan.ps1', 'RpaInstall.SignIn.ps1', 'RpaInstall.Machine.ps1') $stage
Copy-Named (Join-Path $installer 'scripts') @('start-loop.ps1', 'start-runner.ps1', 'start-browser.ps1', 'Show-RpaConnection.ps1') (Join-Path $stage 'scripts')
Copy-Named $repo @('LICENSE') $stage
$properties = Get-Content -Raw -LiteralPath (Join-Path $repo 'desktop\Directory.Build.props')
if ($properties -notmatch '<Version>(\d+\.\d+\.\d+)</Version>') { throw 'desktop\Directory.Build.props names no <Version>.' }
$version = $Matches[1]
[IO.File]::WriteAllText((Join-Path $stage 'VERSION'), $version + "`r`n", [Text.Encoding]::ASCII)

Write-Host 'The runner, the policy tool and the demo app'
Copy-Named $RunnerDir @('RpaRunner.exe') (Join-Path $stage 'runner')
Copy-Named $PolicyToolDir @('RpaPolicy.exe') (Join-Path $stage 'runner')
Copy-Named (Join-Path $repo 'desktop\runner') @('policy.example.json') (Join-Path $stage 'runner')
foreach ($ui in 'v1', 'v2') {
  $target = Join-Path (Join-Path $stage 'erp-demo') $ui
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $ErpDemoDir $ui) -File | Where-Object { $_.Extension -ne '.pdb' } | Copy-Item -Destination $target
}

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
$browser = Join-Path $stage 'browser'
Copy-Named $nodeDir @('node.exe') $browser
Copy-Item -LiteralPath (Join-Path $nodeDir 'LICENSE') -Destination (Join-Path $browser 'LICENSE-node.txt')

Write-Host 'The browser host and the gate'
Copy-Named (Join-Path $browserSource 'host') @('host.mjs', 'run-server.mjs') (Join-Path $browser 'host')
Copy-Named (Join-Path $browserSource 'gate') @('gate.mjs', 'ecs.mjs', 'selfsigned.mjs') (Join-Path $browser 'gate')

Write-Host 'Playwright (npm ci from images\browser\server)'
# Neither a preload for Node nor another download server for the browser comes in from the environment.
foreach ($name in 'NODE_OPTIONS', 'PLAYWRIGHT_DOWNLOAD_HOST', 'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST', 'PLAYWRIGHT_FFMPEG_DOWNLOAD_HOST', 'PLAYWRIGHT_WINLDD_DOWNLOAD_HOST', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD') {
  if (Test-Path -LiteralPath ('Env:' + $name)) { Remove-Item -LiteralPath ('Env:' + $name) }
}
$server = Join-Path $work 'server'
Copy-Named (Join-Path $browserSource 'server') @('package.json', 'package-lock.json') $server
$npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
Invoke-Tool 'npm ci' $node @($npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', (Join-Path $work 'npm-cache')) $server
# The command shims in .bin start whatever "node" is found along PATH; the host does not use them.
$shims = Join-Path $server 'node_modules\.bin'
if (Test-Path -LiteralPath $shims) { [IO.Directory]::Delete($shims, $true) }
[IO.Directory]::Move((Join-Path $server 'node_modules'), (Join-Path $browser 'node_modules'))
$wanted = ((Get-Content -Raw -LiteralPath (Join-Path $server 'package.json') | ConvertFrom-Json).dependencies).playwright
$installed = (Get-Content -Raw -LiteralPath (Join-Path $browser 'node_modules\playwright\package.json') | ConvertFrom-Json).version
if ($installed -ne $wanted) { throw ('playwright {0} was installed, not {1}.' -f $installed, $wanted) }

Write-Host ('Chromium (playwright {0} install chromium)' -f $installed)
$browsers = Join-Path $browser 'ms-playwright'
$env:PLAYWRIGHT_BROWSERS_PATH = $browsers
try { Invoke-Tool 'playwright install chromium' $node @((Join-Path $browser 'node_modules\playwright\cli.js'), 'install', 'chromium') $browser }
finally { Remove-Item -LiteralPath Env:PLAYWRIGHT_BROWSERS_PATH }
# Playwright notes there which install uses the browsers: the path of this build, which is not the installed one.
$links = Join-Path $browsers '.links'
if (Test-Path -LiteralPath $links) { [IO.Directory]::Delete($links, $true) }
foreach ($kind in 'chromium-*', 'chromium_headless_shell-*') {
  if (-not (Get-ChildItem -LiteralPath $browsers -Directory -Filter $kind)) { throw ('{0} holds no {1} after the install.' -f $browsers, $kind) }
}

Write-Host 'The zip'
[IO.Directory]::Delete($work, $true)
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
$hash = Get-Sha256 $zip
[IO.File]::WriteAllText(($zip + '.sha256'), ('{0}  {1}.zip' -f $hash, $PackageName), [Text.Encoding]::ASCII)

$files = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host ('{0} {1}: {2} files, {3:N1} MB unpacked' -f $PackageName, $version, $files.Count, ($bytes / 1MB))
Write-Host ('{0}.zip: {1:N1} MB, SHA-256 {2}' -f $PackageName, ((Get-Item -LiteralPath $zip).Length / 1MB), $hash)
