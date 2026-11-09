$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $root "apps\plugin"

$dshPath = $env:DSH_BIN
if (-not $dshPath) {
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($command) {
    $dshPath = $command.Source
  }
}
if (-not $dshPath) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"),
    (Join-Path $env:ProgramFiles "DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd")
  )
  $dshPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $dshPath) {
  throw "dsh not found. Add it to PATH or set DSH_BIN to the dsh CLI."
}

Write-Host "Installing $plugin into the desktop profile..."
& $dshPath plugin --profile desktop add "link:$plugin"
Write-Host ""
Write-Host "Next: restart DSH Desktop, then enable 'DSH Task Monitor bridge' in Settings -> Plugins."
Write-Host "The monitor will switch from file mode to live mode automatically."
