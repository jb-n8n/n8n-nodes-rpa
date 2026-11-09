# Starts the RPA desktop runner inside the signed-in bot user's session (the scheduled task \RPA\RPA Runner runs this at
# that user's logon) and starts it again whenever it exits, for example after RpaPolicy.exe ends it so that it reads a
# changed policy. Installed under Program Files: only administrators can change it.
#
# The runner gets its settings from the environment: RPA_RUNNER_TOKEN_FILE (the bearer token, a file only SYSTEM,
# Administrators and the bot user can read), RPA_RUNNER_POLICY_FILE and RPA_RUNNER_PORT (from install.json). The token
# itself is never put in the environment, because the apps the runner launches would inherit it. Its output goes to
# %ProgramData%\RPA Runner\logs\runner.out.log and runner.err.log (the previous run's in runner.*.1.log), where
# Show-RpaConnection.ps1 finds the certificate fingerprint the runner prints on start.
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:ProgramData 'RPA Runner'
$logDir = Join-Path $dataDir 'logs'
$install = Get-Content -Raw -LiteralPath (Join-Path $installDir 'install.json') -Encoding UTF8 | ConvertFrom-Json
$runnerDir = Join-Path $installDir 'runner'
$exe = Join-Path $runnerDir 'RpaRunner.exe'
$env:RPA_RUNNER_TOKEN_FILE = Join-Path $dataDir 'token'
$env:RPA_RUNNER_POLICY_FILE = Join-Path $dataDir 'policy.json'
$env:RPA_RUNNER_PORT = [string]$install.runnerPort
$ErrorActionPreference = 'Continue'

function Log([string]$message) {
  Add-Content -Path (Join-Path $logDir 'start-runner.log') -Value ('{0} {1}' -f (Get-Date -Format o), $message)
}

$waiting = $false
while ($true) {
  # An upgrade replaces the program files; until they are back, check every 30 seconds.
  if (-not (Test-Path -LiteralPath $exe)) {
    if (-not $waiting) { Log "runner not found at $exe; checking every 30 s"; $waiting = $true }
    Start-Sleep -Seconds 30
    continue
  }
  $waiting = $false
  foreach ($stream in 'out', 'err') {
    $current = Join-Path $logDir "runner.$stream.log"
    if (Test-Path -LiteralPath $current) { Move-Item -Force -LiteralPath $current -Destination (Join-Path $logDir "runner.$stream.1.log") }
  }
  $start = @{
    FilePath               = $exe
    WorkingDirectory       = $runnerDir
    NoNewWindow            = $true
    PassThru               = $true
    RedirectStandardOutput = Join-Path $logDir 'runner.out.log'
    RedirectStandardError  = Join-Path $logDir 'runner.err.log'
  }
  Log "starting $exe"
  try {
    # WaitForExit, not -Wait: -Wait would also wait for the apps the runner launched. Reading Handle first keeps
    # ExitCode available after the process ends.
    $process = Start-Process @start
    $null = $process.Handle
    $process.WaitForExit()
    Log ('runner exited with code {0}; starting it again in 10 s' -f $process.ExitCode)
  } catch {
    Log ('runner failed to start: {0}; trying again in 10 s' -f $_.Exception.Message)
  }
  Start-Sleep -Seconds 10
}
