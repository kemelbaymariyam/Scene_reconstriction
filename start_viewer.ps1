param([int]$Port = 5173)
$ErrorActionPreference = "Stop"
$Viewer = Join-Path $PSScriptRoot "viewer"

Push-Location $Viewer
try {
    if (-not (Test-Path "node_modules")) {
        if (Test-Path "package-lock.json") { npm ci } else { npm install }
    }
    npm run dev -- --host 127.0.0.1 --port $Port
}
finally { Pop-Location }
