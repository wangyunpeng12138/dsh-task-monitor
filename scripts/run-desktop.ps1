param(
  [switch]$Build
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# Be forgiving when Rust was installed by rustup but this shell has no cargo on PATH.
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  $cargoHome = $env:CARGO_HOME
  if (-not $cargoHome) {
    $cargoHome = Join-Path $env:USERPROFILE ".cargo"
  }
  if (Test-Path (Join-Path $cargoHome "bin\cargo.exe")) {
    $env:PATH = "$(Join-Path $cargoHome 'bin');$env:PATH"
  }
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw "cargo not found. Install Rust (rustup) or set CARGO_HOME so cargo is on PATH."
}

Push-Location $root
try {
  if ($Build) {
    pnpm --filter @dsh-monitor/desktop tauri build
  } else {
    pnpm --filter @dsh-monitor/desktop tauri dev
  }
} finally {
  Pop-Location
}
