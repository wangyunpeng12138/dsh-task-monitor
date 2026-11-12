<#
.SYNOPSIS
  One-click launcher for DSH Task Monitor.

.DESCRIPTION
  Starts the release executable when it exists. When it is missing, or when
  -Rebuild is supplied, the script builds the Tauri app first.

.PARAMETER Rebuild
  Force a release build before launching.

.PARAMETER Dev
  Run the Tauri development app instead of the release executable.

.EXAMPLE
  .\scripts\start-monitor.ps1

.EXAMPLE
  .\scripts\start-monitor.ps1 -Rebuild
#>
[CmdletBinding()]
param(
  [switch]$Rebuild,
  [switch]$Dev
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "apps\desktop\src-tauri\target\release\dsh-task-monitor.exe"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Ensure-Pnpm {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm was not found. Install Node.js 20+ and run: corepack enable"
  }
}

function Ensure-Cargo {
  if (Get-Command cargo -ErrorAction SilentlyContinue) {
    return
  }
  $candidates = @()
  foreach ($dir in @(
      (Join-Path $env:USERPROFILE ".cargo\bin"),
      $(if ($env:CARGO_HOME) { Join-Path $env:CARGO_HOME "bin" })
    )) {
    if ($dir -and (Test-Path (Join-Path $dir "cargo.exe"))) {
      $candidates += $dir
    }
  }

  if ($candidates.Count -gt 0) {
    $env:PATH = "$($candidates[0]);$env:PATH"
  }
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo was not found. Install the Rust stable toolchain (MSVC) and reopen the terminal."
  }
}

function Invoke-Tauri([string[]]$Arguments) {
  Push-Location $root
  try {
    & pnpm --filter @dsh-monitor/desktop tauri @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "tauri $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
}

if ($Dev) {
  Ensure-Pnpm
  Ensure-Cargo
  Write-Step "Starting development mode (Vite + Tauri)"
  Invoke-Tauri @("dev")
  exit 0
}

if ($Rebuild -or -not (Test-Path -LiteralPath $exe)) {
  Ensure-Pnpm
  Ensure-Cargo
  Write-Step "Building the release executable (first run may take a few minutes)"
  Invoke-Tauri @("build", "--no-bundle")
}

if (-not (Test-Path -LiteralPath $exe)) {
  throw "Build finished but the executable is missing: $exe"
}

$running = Get-Process dsh-task-monitor -ErrorAction SilentlyContinue
if ($running) {
  Write-Step "DSH Task Monitor is already running; opening the panel"
}
else {
  Write-Step "Starting DSH Task Monitor"
}

Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
Write-Host ""
Write-Host "DSH Task Monitor started." -ForegroundColor Green
Write-Host "Look for the transparent ring at the bottom-right of the screen."
Write-Host "Click the ring to open the panel. Hotkey: Ctrl+Alt+Shift+M (when free)."
