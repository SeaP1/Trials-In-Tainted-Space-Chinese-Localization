param([switch]$NoSandbox)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $PSScriptRoot 'cn_runtime'
$Overlay = Join-Path $PSScriptRoot 'translated_app'

function Sync-Directory([string]$Source, [string]$Destination) {
    & robocopy $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "robocopy failed ($LASTEXITCODE): $Source" }
}

if (-not (Test-Path -LiteralPath (Join-Path $Root 'TiTS.exe'))) { throw "TiTS.exe missing: $Root" }
if (-not (Test-Path -LiteralPath $Overlay -PathType Container)) { throw "Translated app folder missing: $Overlay" }
$TranslatedFiles = @(Get-ChildItem -LiteralPath $Overlay -File -Filter '*.js')
if ($TranslatedFiles.Count -eq 0) { throw "No translated JavaScript files found: $Overlay" }
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
Get-ChildItem -LiteralPath $Root -File | Copy-Item -Destination $Runtime -Force
foreach ($Folder in @('locales', 'swiftshader', 'resources')) {
    Sync-Directory (Join-Path $Root $Folder) (Join-Path $Runtime $Folder)
}
$RuntimeApp = Join-Path $Runtime 'resources/app'
foreach ($File in $TranslatedFiles) {
    Copy-Item -LiteralPath $File.FullName -Destination (Join-Path $RuntimeApp $File.Name) -Force
}
$Launch = @{ FilePath = (Join-Path $Runtime 'TiTS.exe'); WorkingDirectory = $Runtime }
if ($NoSandbox) { $Launch.ArgumentList = '--no-sandbox' }
Start-Process @Launch
