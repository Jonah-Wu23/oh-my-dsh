$ErrorActionPreference = 'Stop'

$desktopRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $desktopRoot
$nodeSource = (Get-Command node.exe).Source
$nodeTarget = Join-Path $desktopRoot 'node.exe'
$runtimeModules = Join-Path $desktopRoot 'runtime\node_modules'
$msysSource = Join-Path $repoRoot 'msys64'
$msysStage = Join-Path $desktopRoot 'resources\msys64'
$msysArchive = Join-Path $desktopRoot 'resources\msys64.zip'
$msysBash = Join-Path $msysSource 'usr\bin\bash.exe'

if (-not (Test-Path -LiteralPath $nodeSource)) { throw "Node.js executable not found: $nodeSource" }
if (-not (Test-Path -LiteralPath $runtimeModules)) { throw "DeepSeek Harness dependencies are missing. Run npm install in desktop\runtime first." }
if (-not (Test-Path -LiteralPath $msysBash)) { throw "MSYS2 Bash is missing: $msysBash" }

Copy-Item -LiteralPath $nodeSource -Destination $nodeTarget -Force
if (Test-Path -LiteralPath $msysStage) {
  Remove-Item -LiteralPath $msysStage -Recurse -Force
}
if (Test-Path -LiteralPath $msysArchive) {
  Remove-Item -LiteralPath $msysArchive -Force
}
New-Item -ItemType Directory -Force -Path $msysStage | Out-Null
$robocopyArgs = @(
  $msysSource,
  $msysStage,
  '/E',
  '/COPY:DAT',
  '/DCOPY:DAT',
  '/R:1',
  '/W:1',
  '/XD',
  (Join-Path $msysSource 'etc\pacman.d\gnupg'),
  (Join-Path $msysSource 'etc\pki')
)
& robocopy @robocopyArgs | Out-Host
if ($LASTEXITCODE -gt 7) { throw "MSYS2 staging failed with robocopy exit code $LASTEXITCODE" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $msysStage,
  $msysArchive,
  [System.IO.Compression.CompressionLevel]::NoCompression,
  $false
)
Remove-Item -LiteralPath $msysStage -Recurse -Force

Write-Output "Node resource: $nodeTarget"
Write-Output "Harness runtime: $runtimeModules"
Write-Output "MSYS2 Bash: $msysBash"
Write-Output "MSYS2 archive: $msysArchive"
