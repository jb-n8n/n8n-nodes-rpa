# What rpa.cmd in the install folder runs, with the arguments as they were typed:
#
#   rpa connection [-ShowTokens] [-Address <name or address>]   Show-RpaConnection.ps1: the connection lines and the
#                                                              values for the n8n credentials
#   rpa status                                                 Show-RpaConnection.ps1 -Status: the programs, the mode,
#                                                              the sessions and the supervisor, nothing for n8n
#   rpa policy apply <file>                                    runner\RpaPolicy.exe apply <file>: it shows the change
#                                                              and asks before it applies it
#
# Both programs are found beside this script, in the install folder, which only administrators can change. Each
# argument is handed on as one argument; none is read as a command.
param(
  [Parameter(Position = 0)][string]$Command,
  [Parameter(Position = 1)][string]$Action,
  [Parameter(Position = 2)][string]$File,
  [switch]$ShowTokens,
  [string]$Address
)
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
$show = Join-Path $PSScriptRoot 'Show-RpaConnection.ps1'
$given = @{}
if ($ShowTokens) { $given.ShowTokens = $true }
if ($Address) { $given.Address = $Address }

if ($Command -eq 'connection' -and -not $Action -and -not $File) {
  & $show @given
  exit $LASTEXITCODE
}
if ($Command -eq 'status' -and -not $Action -and -not $File -and $given.Count -eq 0) {
  & $show -Status
  exit $LASTEXITCODE
}
if ($Command -eq 'policy' -and $Action -eq 'apply' -and $File -and $given.Count -eq 0) {
  & (Join-Path (Join-Path $installDir 'runner') 'RpaPolicy.exe') apply $File
  exit $LASTEXITCODE
}
Write-Output 'Usage:'
Write-Output '  rpa connection [-ShowTokens] [-Address <name or address>]   the lines and values for the n8n credentials'
Write-Output '  rpa status                                                 the programs, the mode and the sessions'
Write-Output '  rpa policy apply <file>                                    RpaPolicy.exe apply <file>: shows the change and asks'
exit 1
