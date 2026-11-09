# Starts the RPA browser host inside the signed-in bot user's session (the scheduled task \RPA\RPA Browser runs this at
# that user's logon) and starts it again whenever it exits. The browser it serves opens its windows on that user's
# desktop. Installed under Program Files: only administrators can change it.
#
# The host gets its settings from the environment: RPA_BROWSER_DATA_DIR (where it reads browser-token, a file only
# SYSTEM, Administrators and the bot user can read, and keeps its certificate, browser-cert.pem and browser-key.pem,
# which it makes on its first start), RPA_BROWSER_PORT (from install.json) and PLAYWRIGHT_BROWSERS_PATH (the browser
# that came with the package). Its output goes to %ProgramData%\RPA Runner\logs\browser.out.log and browser.err.log
# (the previous run's in browser.*.1.log).
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:ProgramData 'RPA Runner'
$logDir = Join-Path $dataDir 'logs'
$install = Get-Content -Raw -LiteralPath (Join-Path $installDir 'install.json') -Encoding UTF8 | ConvertFrom-Json
# Installed with -NoBrowser: nothing to start.
if (-not $install.browser) { exit 0 }
$browserDir = Join-Path $installDir 'browser'
$exe = Join-Path $browserDir 'node.exe'
$hostScript = Join-Path (Join-Path $browserDir 'host') 'host.mjs'
$env:RPA_BROWSER_DATA_DIR = $dataDir
$env:RPA_BROWSER_PORT = [string]$install.browserPort
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $browserDir 'ms-playwright'
$ErrorActionPreference = 'Continue'

function Log([string]$message) {
  Add-Content -Path (Join-Path $logDir 'start-browser.log') -Value ('{0} {1}' -f (Get-Date -Format o), $message)
}

$waiting = $false
while ($true) {
  # An upgrade replaces the program files; until they are back, check every 30 seconds.
  if (-not ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $hostScript))) {
    if (-not $waiting) { Log "browser host not found at $hostScript; checking every 30 s"; $waiting = $true }
    Start-Sleep -Seconds 30
    continue
  }
  $waiting = $false
  foreach ($stream in 'out', 'err') {
    $current = Join-Path $logDir "browser.$stream.log"
    if (Test-Path -LiteralPath $current) { Move-Item -Force -LiteralPath $current -Destination (Join-Path $logDir "browser.$stream.1.log") }
  }
  $start = @{
    FilePath               = $exe
    # Windows PowerShell 5.1 passes ArgumentList without quoting, and the path holds spaces.
    ArgumentList           = '"{0}"' -f $hostScript
    WorkingDirectory       = $browserDir
    NoNewWindow            = $true
    PassThru               = $true
    RedirectStandardOutput = Join-Path $logDir 'browser.out.log'
    RedirectStandardError  = Join-Path $logDir 'browser.err.log'
  }
  Log "starting $hostScript"
  try {
    # WaitForExit, not -Wait: -Wait would also wait for the browser the host launched. Reading Handle first keeps
    # ExitCode available after the process ends.
    $process = Start-Process @start
    $null = $process.Handle
    $process.WaitForExit()
    Log ('browser host exited with code {0}; starting it again in 10 s' -f $process.ExitCode)
  } catch {
    Log ('browser host failed to start: {0}; trying again in 10 s' -f $_.Exception.Message)
  }
  Start-Sleep -Seconds 10
}
