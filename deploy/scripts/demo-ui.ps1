# Test bed only: puts ERP Demo v1 or v2 in the folder the runner's policy allows ErpDemo.exe from, as an in-place
# upgrade (or a downgrade back), and re-pins the policy entry's sha256 with the policy tool, which restarts the runner.
# desktop-testbed.sh demo-ui sends this file through SSM with $Ui set ('v1' or 'v2') in front of it. Runs as SYSTEM.
# The first time it keeps a copy of both builds the package installed (erp-demo\v1, erp-demo\v2) under
# ProgramData\RPA Runner\demo-ui, so the allowed folder can be overwritten and put back. It never changes another
# policy entry, and stops while a run is using the app.
$ErrorActionPreference = 'Stop'
if ($Ui -notin @('v1', 'v2')) { throw "demo-ui takes v1 or v2" }
$inst = 'C:\Program Files\RPA Runner'
$data = 'C:\ProgramData\RPA Runner'
$policyFile = Join-Path $data 'policy.json'
$tool = Join-Path $inst 'runner\RpaPolicy.exe'
$keep = Join-Path $data 'demo-ui'

$policy = Get-Content -Raw -LiteralPath $policyFile | ConvertFrom-Json
$entries = @($policy.allowedApps | Where-Object { $_.exe -ieq 'ErpDemo.exe' })
if ($entries.Count -ne 1) { throw "the policy allows ErpDemo.exe $($entries.Count) times; demo-ui needs exactly one entry" }
$entry = $entries[0]
$allowed = Split-Path -Parent $entry.path
if (Get-Process -Name ErpDemo -ErrorAction SilentlyContinue) { throw 'ErpDemo.exe is running (a run is using it): try again when it ends' }

# Pristine copies of both builds, taken once, before the allowed folder is ever overwritten.
foreach ($v in 'v1', 'v2') {
  $from = Join-Path $inst "erp-demo\$v"
  $to = Join-Path $keep $v
  if (-not (Test-Path (Join-Path $to 'ErpDemo.exe'))) {
    New-Item -ItemType Directory -Force $to | Out-Null
    Copy-Item -Path (Join-Path $from '*') -Destination $to -Recurse -Force
  }
}

Copy-Item -Path (Join-Path (Join-Path $keep $Ui) '*') -Destination $allowed -Recurse -Force
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.path).Hash
"ERP Demo $Ui is now at the allowed path; sha256 $sha"

# Re-pin through the policy tool (an entry with the same exe and path only changes its pin), which restarts the runner.
$change = Join-Path $env:TEMP "erp-demo-$Ui.policy-change.json"
@{ allowedApps = @(@{ exe = $entry.exe; path = $entry.path; sha256 = $sha }) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $change -Encoding UTF8
$out = & $tool apply $change --yes 2>&1
$code = $LASTEXITCODE
$out | ForEach-Object { "  policy| $_" }
if ($code -ne 0) { throw "the policy tool ended with $code" }
$now = (Get-Content -Raw -LiteralPath $policyFile | ConvertFrom-Json).allowedApps | Where-Object { $_.exe -ieq 'ErpDemo.exe' }
if ($now.sha256 -and $now.sha256 -ne $sha) { throw 'the policy still pins the other build' }
"done: the runner allows ErpDemo.exe $Ui"
