# Starts the RPA desktop runner inside the signed-in rpa-runner session (the scheduled task \RPA\RPA Runner runs this at
# that user's logon) and starts it again whenever it exits. Until a runner is installed it checks every 30 seconds, so
# install-runner.ps1 needs no restart. Installed under Program Files by the first-boot setup: only administrators can
# change it.
#
# The runner gets its settings from the environment: RPA_RUNNER_TOKEN_FILE (the bearer token, a file only SYSTEM,
# Administrators and rpa-runner can read), RPA_RUNNER_POLICY_FILE and RPA_RUNNER_PORT. The token itself is never put in
# the environment, because the apps the runner launches would inherit it. Its output goes to
# %ProgramData%\RPA Runner\logs\runner.out.log and runner.err.log (the previous run's in runner.*.1.log), where
# desktop-testbed.sh fingerprint finds the certificate fingerprint it prints on start.
$ErrorActionPreference = 'Continue'
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $env:ProgramData 'RPA Runner'
$logDir = Join-Path $dataDir 'logs'
$config = Get-Content -Raw -Path (Join-Path $installDir 'runner.json') | ConvertFrom-Json
$exe = Join-Path $installDir $config.exe
$env:RPA_RUNNER_TOKEN_FILE = Join-Path $dataDir 'token'
$env:RPA_RUNNER_POLICY_FILE = Join-Path $dataDir 'policy.json'
$env:RPA_RUNNER_PORT = [string]$config.port

# Windows PowerShell 5.1 joins ArgumentList with spaces and no quoting, so quote what needs it, the way the C runtime
# parses a command line: backslashes before a quote (or before the closing quote) are doubled, and the quote escaped.
$arguments = @($config.args | Where-Object { $null -ne $_ } | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' } else { $_ }
  }) -join ' '

function Log([string]$message) {
  Add-Content -Path (Join-Path $logDir 'start-runner.log') -Value ('{0} {1}' -f (Get-Date -Format o), $message)
}

$waiting = $false
while ($true) {
  if (-not (Test-Path -LiteralPath $exe)) {
    if (-not $waiting) { Log "runner not installed at $exe; checking every 30 s"; $waiting = $true }
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
    WorkingDirectory       = $installDir
    NoNewWindow            = $true
    PassThru               = $true
    RedirectStandardOutput = Join-Path $logDir 'runner.out.log'
    RedirectStandardError  = Join-Path $logDir 'runner.err.log'
  }
  if ($arguments) { $start.ArgumentList = $arguments }
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
