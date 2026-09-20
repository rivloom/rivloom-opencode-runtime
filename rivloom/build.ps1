[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipSmoke,
    [switch]$RequireClean,
    [string]$OutputDirectory = 'rivloom/dist/windows-x64'
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw | ConvertFrom-Json
if ($env:OS -ne 'Windows_NT' -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This build profile requires Windows x64.'
}
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v$($config.nodeVersion)") {
    throw "Install Node.js $($config.nodeVersion) first (found $nodeVersion)."
}
$toolDir = Join-Path $PSScriptRoot ".tools/bun-$($config.bun.version)"
$bunExe = Join-Path $toolDir 'bun-windows-x64-baseline/bun.exe'
for ($checkPath = $toolDir; $checkPath; $checkPath = Split-Path -Parent $checkPath) {
    if ((Test-Path -LiteralPath $checkPath) -and ((Get-Item -LiteralPath $checkPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing linked tool directory: $checkPath"
    }
}
if ((Test-Path -LiteralPath $toolDir) -and (Get-ChildItem -LiteralPath $toolDir -Force -Recurse -Attributes ReparsePoint | Select-Object -First 1)) {
    throw 'Refusing links inside the tool directory.'
}
$archive = Join-Path $toolDir 'bun.zip'
if (-not (Test-Path -LiteralPath $archive)) {
    New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
    Invoke-WebRequest -Uri $config.bun.url -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.bun.sha256) {
    throw 'Bun archive SHA256 mismatch; do not use this cached download.'
}
if (-not (Test-Path -LiteralPath $bunExe)) {
    Expand-Archive -LiteralPath $archive -DestinationPath $toolDir -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
    $entry = $zip.GetEntry('bun-windows-x64-baseline/bun.exe')
    if (-not $entry) { throw 'Pinned Bun archive does not contain the expected executable.' }
    $stream = $entry.Open()
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $expectedExeHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
    if ((Get-FileHash -LiteralPath $bunExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedExeHash) {
        throw 'Cached Bun executable differs from the pinned archive.'
    }
} finally { $zip.Dispose() }
if ((& $bunExe --version) -ne $config.bun.version) { throw 'Unexpected Bun version.' }
$savedEnv = @{}
$settings = @{
    PATH = "$(Split-Path -Parent $bunExe);$env:PATH"
    BUN_INSTALL_CACHE_DIR = (Join-Path $PSScriptRoot '.cache/bun')
    HUSKY = '0'
    ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
}
foreach ($key in $settings.Keys) {
    $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
}
Push-Location $runtimeRoot
try {
    if (-not $SkipInstall) {
        & $bunExe install --frozen-lockfile --linker hoisted --filter opencode
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    $buildArgs = @('rivloom/build.mjs', '--out', $OutputDirectory)
    if ($RequireClean) { $buildArgs += '--require-clean' }
    & node @buildArgs
    if ($LASTEXITCODE -ne 0) { throw 'Runtime compilation failed.' }
    if (-not $SkipSmoke) {
        & node rivloom/smoke.mjs --artifact $OutputDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Runtime smoke checks failed.' }
    }
} finally {
    Pop-Location
    foreach ($key in $savedEnv.Keys) {
        [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process')
    }
}
