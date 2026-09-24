# ============================================================
#  build-wrappers.ps1 - compiles the winmm sox/play wrappers
#  that replace sox.exe/play.exe for the opencode-voice plugin.
#
#  WHY: sox 14.4.2's waveaudio driver fails with
#  "no default audio device configured" on some Windows 10+ PCs
#  even when audio works fine (MME mapper lookup quirk, HDMI
#  endpoints lacking MME support). These C# wrappers use winmm
#  waveIn/waveOut directly and work everywhere.
#
#  Output: <LOCALAPPDATA>\voice-tools\wrappers\sox.exe + play.exe
#  Usage:  powershell -ExecutionPolicy Bypass -File build-wrappers.ps1
# ============================================================
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $env:LOCALAPPDATA "voice-tools\wrappers"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { Write-Host "[FAIL] csc.exe not found (.NET Framework missing?)" -ForegroundColor Red; exit 1 }

foreach ($name in "sox", "play") {
  $src = Join-Path $here "$name-wrapper.cs"
  $out = Join-Path $outDir "$name.exe"
  Write-Host "[....]  compiling $name.exe ..." -ForegroundColor Yellow
  & $csc /nologo /optimize /out:$out $src
  if (-not (Test-Path $out)) { Write-Host "[FAIL]  $name.exe did not compile" -ForegroundColor Red; exit 1 }
  Write-Host "[OK]    $out" -ForegroundColor Green
}

# put the wrappers FIRST on the user PATH so the plugin finds them before real sox
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ -and $_ -ne $outDir })
$newPath = (@($outDir) + $parts) -join ";"
[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
Write-Host "[OK]    wrappers dir put first on user PATH (new terminals required)" -ForegroundColor Green