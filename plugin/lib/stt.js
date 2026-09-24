// VANTA Speech-to-text: hands-free VAD recording + Groq Whisper API.
//
// The Windows sox wrapper (custom winmm waveIn, see voice/wrappers/sox-wrapper.cs)
// does NOT implement VAD ("silence" effects are ignored) — it only records for a
// fixed duration via `trim 0 N`. So VANTA does voice-activity detection itself:
//
//   1. record 2-second chunks (`sox -d ... trim 0 2`)
//   2. decode PCM, compute RMS energy per chunk
//   3. while chunks are loud -> keep appending to the clip
//   4. quiet chunks after speech -> finalize, stitch chunks into one WAV
//   5. Groq whispers the clip, LLM normalizes, prompt is submitted
//
// No keys needed. Just talk.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getActiveSessionTitle } from "./session.js";

const CHUNK_SECS = 2; // seconds per recording chunk
// VAD gate: a chunk is "speech" if it has BOTH a strong transient (peak) and
// sustained energy (RMS). Peak alone catches clicks/pops; RMS alone misses
// quiet dictation. Base thresholds scale DOWN with sensitivity (sens 3 default).
const SPEECH_PEAK_BASE = 7500;
const SPEECH_RMS_BASE = 900;
const QUIET_CHUNKS_TO_END = 2; // quiet (2s each) chunks after speech before finalizing — Dali pauses mid-sentence, 1 chunk cut him off
const MAX_CHUNKS = 30; // hard cap (~60s of speech)
const MAX_RECORD_FAILS = 5; // consecutive record errors before a toast

// wake-word gate (used by processTurn when wake mode is on)
const WAKE_RE = /^(?:hey\s+|ok(?:ay)?\s+)?(?:vanta|jarvis)[,!.:\s]/i;

const STT_SYSTEM_PROMPT = `You are a speech-to-text normalizer for a hands-free coding assistant CLI.

Clean up the raw speech transcription into a clear, well-punctuated prompt. Rules:
- Fix punctuation, capitalization, and grammar
- Remove filler words (um, uh, like, you know, etc.)
- Keep technical terms, file names, and code references exact
- If the user is dictating code, format it appropriately
- Output ONLY the cleaned text, nothing else
- Do not add any commentary or explanation

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "dock" / "talker" -> "docker"
- "cash" -> "cache"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound like programming terminology.`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find an executable on PATH, handling Windows .exe extensions. */
function findExe(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of [name, name + ".exe", name + ".cmd", name + ".bat"]) {
      try {
        fs.accessSync(path.join(dir, candidate), fs.constants.X_OK);
        return path.join(dir, candidate);
      } catch {}
    }
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: -1 });
      return;
    }
    proc.on("error", () => resolve({ code: -1 }));
    proc.on("close", (code) => resolve({ code }));
  });
}

/** RMS + peak of a 16-bit PCM mono WAV buffer. */
function wavStats(buf) {
  if (!buf || buf.length < 44) return { rms: 0, peak: 0, samples: 0 };
  const n = Math.min(buf.readUInt32LE(40), buf.length - 44);
  const samples = n >> 1;
  let sum2 = 0;
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(44 + i * 2);
    sum2 += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return { rms: samples ? Math.sqrt(sum2 / samples) : 0, peak, samples };
}

/** Stitch WAV chunks (16-bit PCM mono 16 kHz) into a single valid WAV buffer. */
function buildWav(chunks) {
  const dataSize = chunks.reduce((n, c) => n + (c.length - 44), 0);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0, "ascii");
  hdr.writeUInt32LE(36 + dataSize, 4);
  hdr.write("WAVE", 8, "ascii");
  hdr.write("fmt ", 12, "ascii");
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); // PCM
  hdr.writeUInt16LE(1, 22); // mono
  hdr.writeUInt32LE(16000, 24);
  hdr.writeUInt32LE(32000, 28); // 16000 * 1 * 2
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36, "ascii");
  hdr.writeUInt32LE(dataSize, 40);
  const parts = chunks.map((c) => c.subarray(44));
  return Buffer.concat([hdr, ...parts], 44 + dataSize);
}

export function createSTT({ api, options, kv, logger, complete }) {
  const client = api.client;
  const tmpDir = options?.tmpDir || path.join(os.tmpdir(), "opencode");
  const sttEndpoint = options?.sttEndpoint || options?.endpoint || null;
  const sttModel = options?.sttModel || "whisper-large-v3-turbo";
  const sttApiKeyEnv = options?.sttApiKeyEnv || options?.apiKeyEnv || null;
  const sttLanguage = options?.sttLanguage || "en";

  const sox = findExe("sox");
  let currentProc = null;
  let aborted = false;
  let chunkCounter = 0;

  // Feed the orb's waveform bars (vanta-mic.txt, same file the standalone brain used).
  const MIC_FILE = path.join(tmpDir, "vanta-mic.txt");
  function writeMic(rms, peak) {
    try {
      fs.writeFileSync(MIC_FILE, `${rms} ${peak}`);
    } catch {}
  }

  // Adaptive barge-in floor (EWMA of mic RMS while VANTA speaks) + warmup.
  // Warmup: the first 3 chunks (~6s) fold EVERYTHING into the floor quickly
  // (that's when VANTA's own voice arrives and would otherwise look like a
  // spike). After arming, only non-loud chunks drift the floor — so VANTA's
  // own steady voice stays under it and Dali's closer, louder voice barges.
  let bargeBase = 0;
  let bargeArmed = false;
  let warmChunks = 0;

  const onStatus = opts?.onStatus || (() => {});

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  function kill() {
    aborted = true;
    if (currentProc) {
      try {
        currentProc.kill("SIGKILL");
      } catch {}
      currentProc = null;
    }
  }

  /** Record one fixed-duration chunk; returns the raw WAV Buffer or null. */
  async function recordChunk() {
    if (aborted || !sox) return null;
    const file = path.join(tmpDir, `vanta-chunk-${chunkCounter++}.wav`);
    try {
      fs.unlinkSync(file);
    } catch {}

    currentProc = spawn(
      sox,
      ["-d", "-r", "16000", "-c", "1", "-b", "16", file, "trim", "0", String(CHUNK_SECS)],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );

    const code = await new Promise((resolve) => {
      if (!currentProc) return resolve(-1);
      currentProc.on("error", () => resolve(-1));
      currentProc.on("close", (c) => resolve(c));
    });
    currentProc = null;

    if (aborted) return null;
    if (code !== 0) return null;
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size <= 44) return null;
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  /**
   * One 2s mic chunk with its gate stats — used by the barge-in monitor so
   * VANTA can be talked over while it is speaking.
   * Returns null on record failure, else { peak, rms, loud }.
   * loud = clearly above the speech gate (2x) AND ~2.8x above the ambient
   * floor, which includes VANTA's own voice -> no self-barge-in.
   */
  async function listenChunk() {
    const chunk = await recordChunk();
    if (!chunk) return null;
    const { peak, rms } = wavStats(chunk);
    writeMic(rms, peak);
    const sens = Number(kv.get("vanta.sens", "3")) || 3;
    const hardPeak = (SPEECH_PEAK_BASE * 2) / sens;
    const hardRms = (SPEECH_RMS_BASE * 2) / sens;
    const passesHard = peak > hardPeak && rms > hardRms;

    if (!bargeArmed) {
      // warmup: fold EVERYTHING fast — own-voice onset must not barge in
      warmChunks++;
      bargeBase = bargeBase === 0 ? rms : bargeBase * 0.5 + rms * 0.5;
      if (warmChunks >= 3) bargeArmed = true;
      return { peak, rms, loud: false };
    }

    if (passesHard) {
      const loud = rms > Math.max(hardRms, bargeBase * 2.8);
      if (!loud) bargeBase = bargeBase * 0.7 + rms * 0.3; // own-voice drift
      return { peak, rms, loud };
    }
    // quiet room between words — floor stays where it is (fast sink => spikes)
    return { peak, rms, loud: false };
  }

  /**
   * Hands-free listen: resolves with a WAV Buffer of your speech, or null.
   * Blocks until speech happens and then stops 2-3s after you go quiet.
   */
  async function listenOnce() {
    aborted = false;
    const speechChunks = [];
    let hadSpeech = false;
    let quietChunks = 0;
    let failCount = 0;
    let warnedMic = false;

    while (!aborted) {
      const chunk = await recordChunk();
      if (chunk === null) {
        if (aborted) return null;
        failCount++;
        if (failCount >= MAX_RECORD_FAILS && !warnedMic) {
          warnedMic = true;
          toast("VANTA: microphone unavailable", "error");
        }
        await sleep(800);
        continue;
      }
      failCount = 0;

      const { peak, rms } = wavStats(chunk);
      writeMic(rms, peak);
      if (aborted) return null;

      // sensitivity: 1 = loud/near-mic, 5 = whisper-friendly (scales thresholds down)
      const sens = Number(kv.get("vanta.sens", "3")) || 3;
      const gate = SPEECH_PEAK_BASE / sens < peak && SPEECH_RMS_BASE / sens < rms;

      if (gate) {
        if (!hadSpeech) {
          hadSpeech = true;
          onStatus("capturing");
          toast("VANTA got it — thinking");
        }
        quietChunks = 0;
        speechChunks.push(chunk);
        if (speechChunks.length >= MAX_CHUNKS) return buildWav(speechChunks);
      } else if (hadSpeech) {
        quietChunks++;
        if (quietChunks >= QUIET_CHUNKS_TO_END) {
          return speechChunks.length ? buildWav(speechChunks) : null;
        }
      }
      // never any speech: keep listening silently (always-on)
      if (!hadSpeech && chunkCounter % 10 === 0) {
        logger?.log?.("STT", "no speech yet, still listening", "debug");
      }
    }
    return null;
  }

  async function transcribeApi(audioBuffer) {
    if (!sttEndpoint) return { error: "STT endpoint not configured" };
    if (!audioBuffer || audioBuffer.length <= 44) return { error: "No speech detected" };
    const apiKey = sttApiKeyEnv ? process.env[sttApiKeyEnv] : null;

    const url = sttEndpoint.replace(/\/+$/, "") + "/audio/transcriptions";
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
    form.append("model", sttModel);
    form.append("response_format", "json");
    if (sttLanguage) form.append("language", sttLanguage);

    const headers = apiKey ? { Authorization: "Bearer " + apiKey } : {};

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) {
        let msg = `STT error ${resp.status}`;
        try {
          const err = await resp.json();
          msg = err?.error?.message || msg;
        } catch {}
        return { error: msg };
      }
      const data = await resp.json();
      const text = (data.text || "").trim();
      return text ? { text } : { error: "No speech detected" };
    } catch (err) {
      return { error: `STT API request failed: ${err.message}` };
    }
  }

  async function normalize(text, sessionTitle) {
    const system = `${STT_SYSTEM_PROMPT}\nThe user is currently working on: "${sessionTitle || "unknown"}"`;
    const result = await complete({
      system,
      prompt: `Clean up this speech-to-text transcription:\n\n${text}`,
      config: { maxTokens: 1024 },
    });
    if (!result.text) {
      logger?.log("STT", `normalization failed, using raw: ${result.error}`, "warn");
      return text;
    }
    return result.text;
  }

  async function submitPrompt(text) {
    let result = await client.tui.appendPrompt({ body: { text } });
    if (result?.error?.data?.message === "Expected object, got undefined") {
      result = await client.tui.appendPrompt({ text });
    }
    if (result?.error) {
      throw new Error(`appendPrompt failed: ${result.error.data?.message || result.error.name}`);
    }
    await client.tui.submitPrompt();
  }

  /**
   * One full voice turn: listen -> transcribe -> normalize -> submit.
   * opts.wakeOn: if true, transcript must start with "vanta"/"jarvis" or it's ignored.
   * opts.onSubmitted: called right after the prompt is submitted (for instant ack).
   * opts.markBusy: called after onSubmitted to signal the session is now busy.
   */
  async function processTurn(opts) {
    onStatus("listening");
    const buf = await listenOnce();
    if (!buf) return { submitted: false };

    onStatus("transcribing");
    toast("Transcribing\u2026");
    const res = await transcribeApi(buf);
    if (res.error) {
      toast(`VANTA: ${res.error}`, "error");
      return { submitted: false };
    }

    // Wake-word gate: if wake mode is on, the raw transcript must start with
    // "vanta" / "jarvis" / "hey vanta" / "okay jarvis" etc. The wake prefix
    // is stripped before normalizing so the model never sees it.
    let text = res.text;
    if (opts?.wakeOn && text && !WAKE_RE.test(text)) {
      toast("VANTA: say \"VANTA\" or \"JARVIS\" first", "warning");
      return { submitted: false };
    }
    if (opts?.wakeOn) text = text.replace(WAKE_RE, "").trim();
    if (!text) return { submitted: false };

    toast("Submitting\u2026");
    onStatus("submitting");
    const sessionTitle = await getActiveSessionTitle(client);
    try {
      text = await normalize(text, sessionTitle);
    } catch {}
    if (!text) return { submitted: false };

    await submitPrompt(text);
    opts?.onSubmitted?.();
    opts?.markBusy?.();
    return { submitted: true };
  }

  return { processTurn, kill, listenChunk };
}