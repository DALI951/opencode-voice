# opencode-voice

VANTA — always-on voice assistant for opencode (Jarvis-style flow).

Removed from Dali's main opencode config (2026-09-24) and parked here as a
separate project. The main config runs text-only now.

## What's inside

- `plugin/` — the VANTA opencode plugin:
  - always-on speech: STT (sox wrapper, wake-word optional) + TTS (Piper
    offline or edge-tts) + voice conversation loop (`/vanta-talk`)
  - `/vanta-voice` — pick a voice (Piper: alan/amy/cori/ryan, edge: Thomas/
    Ryan/Christopher/Sonia/Jenny/Guy)
  - `/vanta-mode` — narrate / brief / off
  - `/vanta-test`, `/vanta-status`, `/vanta-wake`, `/vanta-sens`
  - warm-piper architecture (model loaded once, ~0.7s first sound),
    interruptible playback, stall watchdog
- `voice/` — Windows one-time setup:
  - `setup-windows.ps1` — installs Piper + the voice model, sox-wrapper +
    play-wrapper (built from `wrappers/*.cs` via `build-wrappers.ps1`),
    registers the plugin in `tui.json`, and writes the `GROQ_API_KEY`
  - `wrappers/` — C# sources for `play.exe` (position-polished playback) and
    `sox.exe` (custom winmm waveIn mic capture)

## Re-enable in opencode

Add the plugin entry to `~/.config/opencode/opencode.jsonc` (and
`tui.json`):

```jsonc
["C:/Users/Dali/.config/opencode/plugins/vanta", {
  "endpoint": "https://api.groq.com/openai/v1",
  "model": "llama-3.3-70b-versatile",
  "apiKeyEnv": "GROQ_API_KEY",
  "sttEndpoint": "https://api.groq.com/openai/v1",
  "sttModel": "whisper-large-v3-turbo",
  "sttApiKeyEnv": "GROQ_API_KEY",
  "sttLanguage": "en",
  "tmpDir": "C:/Users/Dali/AppData/Local/Temp/opencode"
}]
```

then run `voice/setup-windows.ps1` once, and restart opencode.