$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Viewer = Join-Path $Root "viewer"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install the current Node.js LTS release and reopen PowerShell."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found."
}
if (-not (Test-Path (Join-Path $Viewer "package.json"))) {
    throw "viewer/package.json was not found."
}

node (Join-Path $Root "verify_assets.mjs")
if ($LASTEXITCODE -ne 0) { throw "Asset verification failed. See docs/ASSETS.md." }

Push-Location $Viewer
try {
    if (Test-Path "package-lock.json") { npm ci } else { npm install }
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
}
finally { Pop-Location }

Write-Host "Setup complete. Run .\start_viewer.ps1" -ForegroundColor Green
