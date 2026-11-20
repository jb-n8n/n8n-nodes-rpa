# Starts the RPA desktop runner inside the signed-in bot user's session (the scheduled task \RPA\RPA Runner runs this at
# that user's logon) and starts it again whenever it exits, for example after RpaPolicy.exe ends it so that it reads a
# changed policy. Installed under Program Files: only administrators can change it.
#
# The runner gets its settings from the environment: RPA_RUNNER_TOKEN_FILE (the bearer token, a file only SYSTEM,
# Administrators and the bot user can read), RPA_RUNNER_POLICY_FILE and RPA_RUNNER_PORT (from install.json). The token
# itself is never put in the environment, because the apps the runner launches would inherit it. In unattended mode
# (install.json's mode, from Install-Rpa.ps1 -Unattended) the RPA Supervisor listens on the runner's port and passes
# each connection on, so the runner listens on 127.0.0.1 only (RPA_RUNNER_BIND), at runnerInnerPort; this task then
# starts when the supervisor signs the bot user in. Its output goes to
# %ProgramData%\RPA Runner\logs\runner.out.log and runner.err.log (the previous run's in runner.*.1.log), where
# Show-RpaConnection.ps1 finds the certificate fingerprint the runner prints on start. The loop is start-loop.ps1.
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:ProgramData 'RPA Runner'
$install = Get-Content -Raw -LiteralPath (Join-Path $installDir 'install.json') -Encoding UTF8 | ConvertFrom-Json
$runnerDir = Join-Path $installDir 'runner'
$exe = Join-Path $runnerDir 'RpaRunner.exe'
$env:RPA_RUNNER_TOKEN_FILE = Join-Path $dataDir 'token'
$env:RPA_RUNNER_POLICY_FILE = Join-Path $dataDir 'policy.json'
$env:RPA_RUNNER_PORT = [string]$install.runnerPort
if ($install.mode -eq 'unattended') {
  $env:RPA_RUNNER_PORT = [string]$install.runnerInnerPort
  $env:RPA_RUNNER_BIND = '127.0.0.1'
}

& (Join-Path $PSScriptRoot 'start-loop.ps1') -Name 'runner' -Label 'runner' -Exe $exe -WorkingDirectory $runnerDir -Target $exe
