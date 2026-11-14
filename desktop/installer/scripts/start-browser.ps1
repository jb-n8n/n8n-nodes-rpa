# Starts the RPA browser host inside the signed-in bot user's session (the scheduled task \RPA\RPA Browser runs this at
# that user's logon) and starts it again whenever it exits. The browser it serves opens its windows on that user's
# desktop. Installed under Program Files: only administrators can change it.
#
# The host gets its settings from the environment: RPA_BROWSER_DATA_DIR (where it reads browser-token, a file only
# SYSTEM, Administrators and the bot user can read, and keeps its certificate, browser-cert.pem and browser-key.pem,
# which it makes on its first start), RPA_BROWSER_PORT (from install.json) and PLAYWRIGHT_BROWSERS_PATH (the browser
# that came with the package). In unattended mode (install.json's mode, from Install-Rpa.ps1 -Unattended) the RPA
# Supervisor listens on the browser's port and passes each connection on, so the host listens on 127.0.0.1 only
# (RPA_BROWSER_BIND), at browserInnerPort; this task then starts when the supervisor signs the bot user in. Its output
# goes to %ProgramData%\RPA Runner\logs\browser.out.log and browser.err.log (the previous run's in browser.*.1.log). The
# loop is start-loop.ps1.
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:ProgramData 'RPA Runner'
$install = Get-Content -Raw -LiteralPath (Join-Path $installDir 'install.json') -Encoding UTF8 | ConvertFrom-Json
# Installed without the browser: nothing to start.
if (-not $install.browser) { exit 0 }
$browserDir = Join-Path $installDir 'browser'
$exe = Join-Path $browserDir 'node.exe'
$hostScript = Join-Path (Join-Path $browserDir 'host') 'host.mjs'
$env:RPA_BROWSER_DATA_DIR = $dataDir
$env:RPA_BROWSER_PORT = [string]$install.browserPort
if ($install.mode -eq 'unattended') {
  $env:RPA_BROWSER_PORT = [string]$install.browserInnerPort
  $env:RPA_BROWSER_BIND = '127.0.0.1'
}
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $browserDir 'ms-playwright'

# Windows PowerShell 5.1 passes the argument list without quoting, and the path holds spaces.
& (Join-Path $PSScriptRoot 'start-loop.ps1') -Name 'browser' -Label 'browser host' -Exe $exe -Arguments ('"{0}"' -f $hostScript) -WorkingDirectory $browserDir -Target $hostScript
