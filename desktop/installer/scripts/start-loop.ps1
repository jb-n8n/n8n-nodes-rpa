# The loop start-runner.ps1 and start-browser.ps1 share: starts one program inside the signed-in bot user's session and
# starts it again whenever it exits. The caller sets the program's environment first and passes what differs:
#
#   -Name              names the log files: logs\<Name>.out.log, <Name>.err.log (the previous run's in <Name>.*.1.log)
#                      and start-<Name>.log
#   -Label             what the program is called in start-<Name>.log
#   -Exe, -Arguments   the program and its command line arguments
#   -WorkingDirectory  where it runs
#   -Target            the file named in start-<Name>.log; the loop waits while it or -Exe is missing
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Arguments = '',
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$Target
)
$ErrorActionPreference = 'Continue'
$logDir = Join-Path (Join-Path $env:ProgramData 'RPA Runner') 'logs'

function Log([string]$message) {
  Add-Content -Path (Join-Path $logDir "start-$Name.log") -Value ('{0} {1}' -f (Get-Date -Format o), $message)
}

$waiting = $false
while ($true) {
  # An upgrade replaces the program files; until they are back, check every 30 seconds.
  if (-not ((Test-Path -LiteralPath $Exe) -and (Test-Path -LiteralPath $Target))) {
    if (-not $waiting) { Log "$Label not found at $Target; checking every 30 s"; $waiting = $true }
    Start-Sleep -Seconds 30
    continue
  }
  $waiting = $false
  foreach ($stream in 'out', 'err') {
    $current = Join-Path $logDir "$Name.$stream.log"
    if (Test-Path -LiteralPath $current) { Move-Item -Force -LiteralPath $current -Destination (Join-Path $logDir "$Name.$stream.1.log") }
  }
  $start = @{
    FilePath               = $Exe
    WorkingDirectory       = $WorkingDirectory
    NoNewWindow            = $true
    PassThru               = $true
    RedirectStandardOutput = Join-Path $logDir "$Name.out.log"
    RedirectStandardError  = Join-Path $logDir "$Name.err.log"
  }
  if ($Arguments) { $start.ArgumentList = $Arguments }
  Log "starting $Target"
  try {
    # WaitForExit, not -Wait: -Wait would also wait for what the program launched (apps, the browser). Reading Handle
    # first keeps ExitCode available after the process ends.
    $process = Start-Process @start
    $null = $process.Handle
    $process.WaitForExit()
    Log ('{0} exited with code {1}; starting it again in 10 s' -f $Label, $process.ExitCode)
  } catch {
    Log ('{0} failed to start: {1}; trying again in 10 s' -f $Label, $_.Exception.Message)
  }
  Start-Sleep -Seconds 10
}
