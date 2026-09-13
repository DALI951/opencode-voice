# opencode-voice

Make **opencode talk and listen** — voice in, voice out, right in the opencode TUI.

- **LISTEN:** press `ctrl+r`, speak, press `ctrl+r` again → your words are transcribed and inserted into the prompt (or sent straight to chat).
- **TALK:** toggle auto-voice → opencode reads every answer aloud. Or press a key to read the last answer.

Powered by [@renjfk/opencode-voice](https://github.com/renjfk/opencode-voice) (TUI plugin) +
[Groq](https://console.groq.com) (free-tier Whisper STT + LLM normalization) +
[Piper](https://github.com/rhasspy/piper) (100% offline TTS).

> Built for **Windows** (the community plugin documents macOS/Linux only; this repo adds
> the Windows compatibility layer). Works on any Windows 10/11 machine — even Tiny10
> stripped-down installs.

## Requirements

| Thing | Why | Cost |
|---|---|---|
| Windows 10/11 PC | target | — |
| Python 3.11+ | runs the Piper TTS engine | — |
| Free Groq API key | speech-to-text + text cleanup | $0 (sign up at [console.groq.com](https://console.groq.com)) |
| Internet | Groq calls (TTS is offline) | your ISP |

## Install (one-time, per PC)

1. **Download** `setup-windows.ps1` from the [latest release](https://github.com/DALI951/opencode-voice/releases/latest).
2. Open PowerShell in that folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
```

The script does everything and prints `[OK]`/`[FAIL]` per step:
checks Python → installs `piper-tts` → downloads `sox` (mic capture) + `play.exe` shim →
drops the Windows `piper` decoy file → downloads the Ryan voice model → creates `C:\tmp` →
asks for your Groq key (saved as a user env var, never written to a file) →
ensures `~\.config\opencode\tui.json` has the plugin → **smoke-tests both directions**
(it speaks a line out loud, then records 3 seconds of your voice and transcribes it).

3. **Close the PowerShell window, open a NEW terminal** (PATH + key need a fresh session), run `opencode`.
4. First launch downloads + caches the plugin (needs internet once). If opencode complains, just restart it once.

> No Python on the machine? Install it first:
> `winget install Python.Python.3.12` (or python.org — tick **Add to PATH**), then rerun step 2.

## Usage (in the opencode TUI)

| Keys | Action |
|---|---|
| `ctrl+r` | Start / stop recording → transcript inserted into your prompt |
| `ctrl+x` then `r` | Record and **submit straight to chat** |
| `ctrl+x` then `v` | Toggle **auto-TTS** (opencode speaks every answer) |
| `ctrl+x` then `s` | Read the last answer aloud |
| `escape` | Stop the speaking |
| `/voice` settings | `/stt-mic`, `/stt-model`, `/tts-voice`, `/stt-language` … type `/` to see all |

Recommended flow: hit `ctrl+x v` once to turn auto-TTS on, then just talk.
`ctrl+x r` = speak → opencode answers → speaks back. Repeat.

## How it works

```
YOU ──mic──> sox ──wav──> Groq Whisper (STT) ──text──> LLM cleanup ──> your prompt
                                                                        │
opencode answers ──> LLM speech-normalization ──> Piper (offline TTS) ──> speakers ─┘
```

- Hear/clean step: `whisper-large-v3-turbo` + `llama-3.3-70b-versatile` (Groq free tier, keys never leave your machine).
- Speak step: **Piper runs locally** — zero cloud, zero cost, works offline.

## Configuration

The setup script writes the plugin entry into `~\.config\opencode\tui.json`:

```json
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
```

Change `sttLanguage` to your spoken language (`ar` for Arabic, `fr`, …) and restart opencode.

## Windows compatibility notes (what this repo fixes)

The upstream plugin was only tested on macOS/Linux. Reading its source, Windows breaks at 5 points —
all handled by the setup script:

1. **`/tmp/opencode-stt.wav`** — hardcoded path resolves to `C:\tmp\...` on Windows → script creates `C:\tmp`.
2. **`sox` / `play` spawning** — script downloads sox to `%LOCALAPPDATA%\voice-tools` and copies `sox.exe` → `play.exe` (sox switches capture/play mode by its own file name).
3. **`piper` detection** — the plugin checks for a file literally named `piper` (no extension). Windows can't run that, but panic not: the script puts an **empty decoy `piper` file** next to the real `piper.exe`. Detection passes, Windows appends `.exe` at execution time, the real binary runs.
4. **`pkill` / `system_profiler`** — Unix commands that crash on Windows; the plugin already swallows those errors, so they're no-ops.
5. **Killed-sox WAV header** — Windows "SIGINT" = hard process kill, so the recorded WAV header can stay zeroed. Whisper usually still decodes it; the setup's STT smoke test detects the problem on day one and prints a one-line fix.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "sox: No such file or directory" at record time | Open a **new** terminal, or add `%LOCALAPPDATA%\voice-tools\sox-14.4.2-win32` to your user PATH |
| "Piper binary not found on PATH" toast | Same — new terminal; check `where piper` |
| Recording is silent | Windows **Settings → Privacy → Microphone**: enable mic access for desktop apps; check the mic isn't muted in sound settings |
| Plugin errors on first opencode start | Restart opencode once (first run downloads + caches the npm plugin) |
| STT says the WAV is corrupt | Run the python one-liner printed by the setup script to repair the header |
| Still plugin cached old version | `Remove-Item -Recurse "$env:USERPROFILE\.cache\opencode\packages\@renjfk"` + restart |

## License

MIT — plugin by [renjfk](https://github.com/renjfk/opencode-voice) (MIT), packaging by DALI951.