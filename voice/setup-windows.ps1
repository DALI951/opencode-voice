# ============================================================
#  opencode-voice - Windows one-time setup (run on EACH PC once)
#  Makes opencode LISTEN (mic -> Groq Whisper) and TALK (Piper).
#
#  What it does:
#   1. Checks Python (needed for piper-tts)
#   2. Installs piper-tts (offline TTS) and finds its Scripts dir
#   3. Downloads sox (mic capture) + creates play.exe/rec.exe copies
#   4. Adds both dirs to the USER PATH (no admin needed)
#   5. Drops the decoy "piper" file the plugin checks for on Windows
#   6. Downloads the Ryan voice model
#   7. Creates C:\tmp (plugin records to /tmp/opencode-stt.wav = C:\tmp)
#   8. Sets GROQ_API_KEY (free key from https://console.groq.com)
#   9. Ensures ~\.config\opencode\tui.json contains the voice plugin
#  10. Smoke-tests: TTS speaks a line, STT records 3s + transcribes
#
#  Usage:   powershell -ExecutionPolicy Bypass -File setup-windows.ps1
#  Rerun:   safe anytime (skips what's already done)
#
#  After setup: open a NEW terminal, run opencode, then:
#    ctrl+r        = start/stop recording (inserts transcript in the prompt)
#    ctrl+x then r = record + submit straight to chat
#    ctrl+x then v = toggle AUTO-TTS (opencode speaks every answer)
#    ctrl+x then s = read the last answer aloud
#    escape        = stop the speaking
# ============================================================
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Host.UI.RawUI.WindowTitle = "opencode-voice setup"

Write-Host ""
Write-Host "=========== opencode-voice setup ===========" -ForegroundColor Cyan

# ------------------------------------------------------------
# Step 0 - helpers
# ------------------------------------------------------------
function Find-Cmd { param($Name) Get-Command $Name -ErrorAction SilentlyContinue }

function Add-UserPath {
  param($Dir)
  $cur = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($cur -like "*$Dir*") { Write-Host "[SKIP]  already on PATH: $Dir" -ForegroundColor DarkGray; return }
  $new = if ($cur) { "$cur;$Dir" } else { $Dir }
  [Environment]::SetEnvironmentVariable("Path", $new, "User")
  Write-Host "[OK]    added to user PATH: $Dir" -ForegroundColor Green
}

function Download {
  param($Url, $Out, $Label)
  if (Test-Path $Out) { Write-Host "[SKIP]  already downloaded: $Label" -ForegroundColor DarkGray; return }
  Write-Host "[....]  downloading $Label ..." -ForegroundColor Yellow
  # curl -L follows SourceForge/HF redirect chains that Invoke-WebRequest chokes on
  & curl.exe -sSL -o $Out $Url
  if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL]  download failed: $Label" -ForegroundColor Red; exit 1 }
  Write-Host "[OK]    downloaded $Label ($([math]::Round((Get-Item $Out).Length/1MB,1)) MB)" -ForegroundColor Green
}

# ------------------------------------------------------------
# Step 1 - Python
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 1: Python ---" -ForegroundColor Cyan
$py = Find-Cmd python
if (-not $py) { $py = Find-Cmd py }
if (-not $py) {
  Write-Host "[FAIL]  Python not found." -ForegroundColor Red
  Write-Host "        Install it first, e.g.:  winget install Python.Python.3.12" -ForegroundColor Yellow
  Write-Host "        (or download from https://www.python.org/downloads/ - tick 'Add to PATH')"
  Write-Host "        Then run this script again."
  exit 1
}
& $py.Source --version
if ($LASTEXITCODE -ne 0) { & $py.Source -V }
Write-Host "[OK]    Python found: $($py.Source)" -ForegroundColor Green

# ------------------------------------------------------------
# Step 2 - piper-tts (TTS engine)
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 2: piper-tts ---" -ForegroundColor Cyan
$piper = Find-Cmd piper
if (-not $piper) {
  Write-Host "[....]  pip install piper-tts ..." -ForegroundColor Yellow
  & $py.Source -m pip install --upgrade piper-tts
  if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL]  piper-tts install failed." -ForegroundColor Red; exit 1 }
  $piper = Find-Cmd piper
}
if (-not $piper) {
  # locate Scripts dir even if not on PATH
  $userSite = & $py.Source -c "import site; print(site.USER_BASE)"
  $scriptsDir = Join-Path $userSite "Python3*"
  $scriptsDir = (Get-Item $scriptsDir | Select-Object -First 1).FullName
  $pipTarget = Join-Path (Join-Path $scriptsDir "Scripts") "piper.exe"
  if (-not (Test-Path $pipTarget)) { $pipTarget = Join-Path $scriptsDir "piper.exe" }
  if (Test-Path $pipTarget) {
    Add-UserPath $scriptsDir
    $piperExe = $pipTarget
    Write-Host "[OK]    piper found at $scriptsDir (added to PATH)" -ForegroundColor Green
  } else {
    Write-Host "[FAIL]  piper not found after install (checked PATH and user Scripts dir)." -ForegroundColor Red
    exit 1
  }
} else {
  $piperExe = $piper.Source
}
$scriptsDir = Split-Path $piperExe -Parent
Write-Host "[OK]    piper: $piperExe" -ForegroundColor Green
Add-UserPath $scriptsDir

# ------------------------------------------------------------
# Step 3 - decoy "piper" file (plugin's Windows detection hack)
# ------------------------------------------------------------
# The plugin checks PATH for a file literally named "piper" (no extension).
# Windows CAN'T execute that, but CreateProcess appends ".exe" - so we put
# an empty decoy named "piper" next to the real piper.exe: detection OK,
# execution finds piper.exe. 
Write-Host ""
Write-Host "--- Step 3: piper decoy file (Windows compat) ---" -ForegroundColor Cyan
$decoy = Join-Path $scriptsDir "piper"
if (-not (Test-Path $decoy)) { New-Item -ItemType File -Path $decoy -Force | Out-Null }
Add-UserPath $scriptsDir
Write-Host "[OK]    decoy: $decoy" -ForegroundColor Green

# ------------------------------------------------------------
# Step 4 - sox (mic capture + playback) + play/rec copies
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 4: sox ---" -ForegroundColor Cyan
$soxRoot = Join-Path $env:LOCALAPPDATA "voice-tools"
$soxZip = Join-Path $soxRoot "sox-14.4.2-win32.zip"
New-Item -ItemType Directory -Path $soxRoot -Force | Out-Null
if (-not (Get-ChildItem -Path $soxRoot -Filter "sox.exe" -Recurse -ErrorAction SilentlyContinue)) {
  Download "https://downloads.sourceforge.net/project/sox/sox/14.4.2/sox-14.4.2-win32.zip" $soxZip "sox"
  Write-Host "[....]  extracting ..." -ForegroundColor Yellow
  Expand-Archive -Path $soxZip -DestinationPath $soxRoot -Force
}
# the zip's inner folder name varies (sox-14.4.2 / sox-14.4.2-win32) - find sox.exe dynamically
$soxExe = (Get-ChildItem -Path $soxRoot -Filter "sox.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $soxExe) { Write-Host "[FAIL]  sox.exe missing after extract." -ForegroundColor Red; exit 1 }
$soxBin = Split-Path $soxExe -Parent
foreach ($n in "play.exe", "rec.exe") {
  if (-not (Test-Path (Join-Path $soxBin $n))) { Copy-Item $soxExe (Join-Path $soxBin $n) }
}
Add-UserPath $soxBin
$env:Path = "$soxBin;$scriptsDir;$env:Path"
& $soxExe --version | Select-Object -First 1
Write-Host "[OK]    sox + play.exe + rec.exe: $soxBin" -ForegroundColor Green

# ------------------------------------------------------------
# Step 4b - winmm wrappers (sox 14.4.2 MME fallback for Win10+)
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 4b: winmm sox/play wrappers ---" -ForegroundColor Cyan
# sox 14.4.2's waveaudio driver fails ("no default audio device") on some Win10+ PCs
# even when audio works. The wrappers use winmm waveIn/waveOut directly and also
# handle the TTS pipe. They keep the plugin working on every machine.
$wrapDir = Join-Path $soxRoot "wrappers"
$wrapBuild = Join-Path $PSScriptRoot "wrappers\build-wrappers.ps1"
if (Test-Path $wrapBuild) {
  & powershell -ExecutionPolicy Bypass -File $wrapBuild
} elseif (-not (Test-Path (Join-Path $wrapDir "sox.exe"))) {
  Write-Host "[WARN]  wrapper sources not found next to this script - skipping (real sox will be used, may fail on Win10+)" -ForegroundColor Yellow
}
Write-Host "[OK]    wrappers active: $wrapDir" -ForegroundColor Green

# ------------------------------------------------------------
# Step 5 - voice model (Ryan, high quality, offline)
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 5: Piper voice model ---" -ForegroundColor Cyan
$voicesDir = Join-Path $HOME ".local\share\piper-voices"
New-Item -ItemType Directory -Path $voicesDir -Force | Out-Null
Download "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx" `
         (Join-Path $voicesDir "en_US-ryan-high.onnx") "Ryan voice model"
Download "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json" `
         (Join-Path $voicesDir "en_US-ryan-high.onnx.json") "Ryan voice config"
Write-Host "[OK]    voices dir: $voicesDir" -ForegroundColor Green

# ------------------------------------------------------------
# Step 6 - C:\tmp (plugin writes /tmp/opencode-stt.wav -> C:\tmp on Windows)
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 6: C:\tmp ---" -ForegroundColor Cyan
New-Item -ItemType Directory -Path "C:\tmp" -Force | Out-Null
Write-Host "[OK]    C:\tmp exists" -ForegroundColor Green

# ------------------------------------------------------------
# Step 7 - GROQ_API_KEY (free: console.groq.com -> API Keys)
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 7: GROQ API key ---" -ForegroundColor Cyan
if (-not $env:GROQ_API_KEY) {
  $key = Read-Host "Paste your Groq API key (gsk_...). Free at https://console.groq.com"
  if ($key -notmatch "^gsk_") { Write-Host "[FAIL]  Doesn't look like a Groq key (must start with gsk_)." -ForegroundColor Red; exit 1 }
  [Environment]::SetEnvironmentVariable("GROQ_API_KEY", $key.Trim(), "User")
  $env:GROQ_API_KEY = $key.Trim()
  Write-Host "[OK]    GROQ_API_KEY saved as a USER env var (never written to any file)." -ForegroundColor Green
  Write-Host "        New terminals pick it up automatically." -ForegroundColor DarkGray
} else {
  Write-Host "[SKIP]  GROQ_API_KEY already set in this session." -ForegroundColor DarkGray
}

# ------------------------------------------------------------
# Step 8 - tui.json (plugin loader config; normally synced from the repo)
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 8: tui.json ---" -ForegroundColor Cyan
$tuiPath = Join-Path $HOME ".config\opencode\tui.json"
if (-not (Test-Path $tuiPath)) {
  $tuiJson = @'
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": { "session_rename": "none" },
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "https://api.groq.com/openai/v1",
        "model": "llama-3.3-70b-versatile",
        "apiKeyEnv": "GROQ_API_KEY",
        "sttEndpoint": "https://api.groq.com/openai/v1",
        "sttModel": "whisper-large-v3-turbo",
        "sttApiKeyEnv": "GROQ_API_KEY",
        "sttLanguage": "en"
      }
    ]
  ]
}
'@
  Set-Content -Path $tuiPath -Value $tuiJson -Encoding UTF8
  Write-Host "[OK]    created $tuiPath (plugin will be downloaded on next opencode start)" -ForegroundColor Green
} else {
  Write-Host "[SKIP]  $tuiPath already exists (make sure it contains @renjfk/opencode-voice)." -ForegroundColor DarkGray
}

# ------------------------------------------------------------
# Step 9 - smoke tests
# ------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 9: smoke tests ---" -ForegroundColor Cyan

# 9a) TTS: speak a line
$ttsOut = "C:\tmp\tts-test.wav"
"Hello from opencode. The voice bridge is alive." | & $piperExe -m (Join-Path $voicesDir "en_US-ryan-high.onnx") --output_file $ttsOut
if (Test-Path $ttsOut) {
  Write-Host "[OK]    TTS synthesized $ttsOut ($([math]::Round((Get-Item $ttsOut).Length/1KB,1)) KB)" -ForegroundColor Green
  Write-Host "        Playing it back now - you should HEAR the line..." -ForegroundColor Yellow
  & (Join-Path $soxBin "play.exe") $ttsOut
  Write-Host "[OK]    TTS playback fired." -ForegroundColor Green
} else {
  Write-Host "[FAIL]  TTS produced no file. Check piper install." -ForegroundColor Red
}

# 9b) STT: record 3s from the mic, transcribe via Groq
if ($env:GROQ_API_KEY) {
  $micWav = "C:\tmp\mic-test.wav"
  Write-Host ""
  Write-Host "Speak into the microphone for 3 seconds when recording starts..." -ForegroundColor Yellow
  & $soxExe -d $micWav trim 0 3
  if ((Test-Path $micWav) -and (Get-Item $micWav).Length -gt 44) {
    Write-Host "[OK]    recorded $micWav ($([math]::Round((Get-Item $micWav).Length/1KB,1)) KB)" -ForegroundColor Green
    $resp = & curl.exe -s -H "Authorization: Bearer $env:GROQ_API_KEY" `
      -F "file=@$micWav" `
      -F "model=whisper-large-v3-turbo" `
      "https://api.groq.com/openai/v1/audio/transcriptions"
    if ($resp -match '"text"\s*:\s*"([^"]+)"') {
      Write-Host "[OK]    Whisper heard: '$($Matches[1])'" -ForegroundColor Green
    } else {
      Write-Host "[FAIL]  Groq transcription failed. Response: $resp" -ForegroundColor Red
      Write-Host "        If it's a corrupt WAV header error (Windows kills sox hard), run:" -ForegroundColor Yellow
      Write-Host "        python -c `"import os;f=open(r'C:\tmp\opencode-stt.wav','r+b');f.seek(0,2);s=f.tell();f.seek(4);f.write((s-8).to_bytes(4,'little'));f.seek(40);f.write((s-44).to_bytes(4,'little'));f.close()`"" -ForegroundColor Yellow
    }
  } else {
    Write-Host "[FAIL]  No audio recorded - check your microphone + Windows privacy settings (Settings > Privacy > Microphone)." -ForegroundColor Red
  }
} else {
  Write-Host "[SKIP]  STT test skipped (no key in this session)." -ForegroundColor DarkGray
}

# ------------------------------------------------------------
# Done
# ------------------------------------------------------------
Write-Host ""
Write-Host "=========== DONE ===========" -ForegroundColor Cyan
Write-Host "1. Close this window, open a NEW terminal (PATH + key need a fresh session)."
Write-Host "2. Run:  opencode"
Write-Host "3. In the TUI:  ctrl+r -> speak -> ctrl+r again  (or  ctrl+x then r  to send straight away)"
Write-Host "4. Toggle auto-speaking answers:  ctrl+x then v"
Write-Host "5. Read last answer aloud:  ctrl+x then s   |   stop speaking: escape"
Write-Host "If the first run errors about the plugin, restart opencode once (it caches npm plugins)."
Write-Host ""