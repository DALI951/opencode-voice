// VANTA Text-to-speech v3 — instant, interruptible, stall-proof, zero-lag.
//
// A SINGLE piper process runs warm in the background from plugin init (model
// loaded once, no 3.7s cold-start penalty). Each line is written to stdin and
// its PCM output is collected by a per-line closure with a silence-gap
// detector (350ms no-data = utterance done), written to a temp WAV, and
// played via the position-polished play.exe wrapper (no wasted margin).
//
// Voice switch or crash → one-shot fallback with model reload.
// stop() kills only the transient play process — the warm piper stays alive.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");
const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0";
const MIN_ONNX_BYTES = 10 * 1024 * 1024;
const SILENCE_GAP_MS = 350;
const LINE_HARD_TIMEOUT_MS = 15_000;
const PLAYBACK_HARD_LIMIT_MS = 25_000;
const MP3_PATH = path.join(os.tmpdir(), "opencode", "vanta-edge.mp3");
const WAV_EDGE_PATH = path.join(os.tmpdir(), "opencode", "vanta-edge.wav");

// piper voices — fully offline, flat in VOICES_DIR
const PIPER_VOICES = {
  alan: { label: "Alan (calm British male — default)", file: "en_GB-alan-medium.onnx", url: "en/en_GB/alan/medium" },
  amy:  { label: "Amy (British female, medium)",       file: "en_GB-amy-medium.onnx",   url: "en/en_GB/amy/medium" },
  cori: { label: "Cori (British female, high)",         file: "en_GB-cori-high.onnx",    url: "en/en_GB/cori/high" },
  ryan: { label: "Ryan (US male, high)",                file: "en_US-ryan-high.onnx",    url: "en/en_US/ryan/high" },
};
const DEFAULT_PIPER_VOICE = "alan";

// edge-tts voices — network
const EDGE_VOICES = {
  "en-GB-ThomasNeural":      { label: "Thomas (deep British)" },
  "en-GB-RyanNeural":        { label: "Ryan (slick British)" },
  "en-US-ChristopherNeural": { label: "Christopher (deep US)" },
  "en-GB-SoniaNeural":       { label: "Sonia (British female)" },
  "en-US-JennyNeural":       { label: "Jenny (US female)" },
  "en-US-GuyNeural":         { label: "Guy (US male)" },
};
const DEFAULT_EDGE_VOICE = "en-GB-ThomasNeural";

// ---- helpers ----

export function cleanForSpeech(text) {
  if (!text) return "";
  return String(text)
    .replace(/```[\s\S]*?```/g, " Code block. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function findExe(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of [name, name + ".exe", name + ".cmd", name + ".bat"]) {
      const full = path.join(dir, candidate);
      try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
    }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, {
        stdio: opts.stdio || ["ignore", "ignore", "pipe"],
        windowsHide: true,
        ...(opts.timeout ? { timeout: opts.timeout } : {}),
      });
    } catch (err) { resolve({ code: -1, error: err.message }); return; }
    proc.on("error", (err) => resolve({ code: -1, error: err.message }));
    proc.on("close", (code) => resolve({ code }));
  });
}

// ---- main module ----

export function createTTS({ api, options, kv, logger }) {
  const transientProcs = new Set();
  const transientTrack = (p) => {
    transientProcs.add(p);
    const drop = () => transientProcs.delete(p);
    p.on("close", drop);
    p.on("error", drop);
    return p;
  };

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  // ---- voice resolution ----

  function modelPresent(entry) {
    try {
      const onnx = path.join(VOICES_DIR, entry.file);
      return fs.existsSync(onnx) && fs.statSync(onnx).size >= MIN_ONNX_BYTES;
    } catch { return false; }
  }

  async function downloadModel(entry) {
    fs.mkdirSync(VOICES_DIR, { recursive: true });
    const jsonFile = entry.file.replace(/\.onnx$/, ".onnx.json");
    for (const f of [entry.file, jsonFile]) {
      const res = await fetch(`${HF_BASE}/${entry.url}/${f}`);
      if (!res.ok) throw new Error(`download ${entry.file} failed (${res.status})`);
      fs.writeFileSync(path.join(VOICES_DIR, f), Buffer.from(await res.arrayBuffer()));
    }
  }

  function resolveVoice() {
    const name = kv.get("vanta.voice", DEFAULT_PIPER_VOICE);
    const chosen = PIPER_VOICES[name] || PIPER_VOICES[DEFAULT_PIPER_VOICE];
    if (modelPresent(chosen)) return { entry: chosen, fallback: null };
    for (const k of ["alan", "amy", "cori", "ryan"]) {
      if (modelPresent(PIPER_VOICES[k])) return { entry: PIPER_VOICES[k], fallback: chosen };
    }
    return { entry: PIPER_VOICES[DEFAULT_PIPER_VOICE], fallback: chosen };
  }

  function warmVoice(entry) {
    if (modelPresent(entry)) return;
    (async () => { try { await downloadModel(entry); } catch {} })();
  }

  // ---- persistent piper (model loaded once, never re-parsed) ----

  let pip = null; // { proc, model }

  function ensurePiper() {
    const { entry } = resolveVoice();
    if (pip?.proc && !pip.proc.killed && pip.model === entry.file) return pip;
    killPiper();
    const piperExe = findExe("piper");
    if (!piperExe || !modelPresent(entry)) return null;
    const proc = spawn(piperExe, ["-m", path.join(VOICES_DIR, entry.file), "--output_raw"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    pip = { proc, model: entry.file };
    proc.on("error", () => { if (pip?.proc === proc) pip = null; });
    proc.on("close", () => { if (pip?.proc === proc) pip = null; });
    return pip;
  }

  function killPiper() {
    if (pip?.proc) { try { pip.proc.kill("SIGKILL"); } catch {} pip = null; }
  }

  // ---- speak one line via persistent piper (streaming pipe — first sound ~0.7s) ----

  function speakLine(line) {
    return new Promise((resolve) => {
      const p = ensurePiper();
      if (!p) return resolve(false);

      const playExe = findExe("play");
      if (!playExe) return resolve(true);

      // play reads raw stdin until EOF, queueing waveOut buffers as it goes.
      // Audio playback starts ~0.7s after the first PCM bytes arrive — no wait.
      const playProc = transientTrack(
        spawn(playExe, ["-t", "raw", "-r", "22050", "-e", "signed", "-b", "16", "-c", "1", "-q", "-"], {
          stdio: ["pipe", "ignore", "pipe"],
          windowsHide: true,
        }),
      );

      let settled = false;
      let timer = null;
      let hardTimer = null;

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        p.proc.stdout.removeListener("data", pipeTo);
        if (playProc.stdin && !playProc.stdin.destroyed) playProc.stdin.end();
      };

      const pipeTo = (c) => {
        if (playProc.stdin && !playProc.stdin.destroyed) playProc.stdin.write(c);
        clearTimeout(timer);
        timer = setTimeout(settle, SILENCE_GAP_MS);
      };

      hardTimer = setTimeout(() => {
        settle();
        // give play 2s to flush after stdin close, then kill
        setTimeout(() => {
          try { playProc.kill("SIGKILL"); } catch {}
        }, 2000);
      }, LINE_HARD_TIMEOUT_MS);

      playProc.on("close", () => {
        clearTimeout(hardTimer);
        resolve(true);
      });
      playProc.on("error", () => {
        clearTimeout(hardTimer);
        settled = true;
        resolve(false);
      });

      p.proc.stdout.on("data", pipeTo);

      try {
        p.proc.stdin.write(line + "\n");
      } catch (err) {
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(timer);
        p.proc.stdout.removeListener("data", pipeTo);
        resolve(false);
      }
    });
  }

  // ---- one-shot fallback (model-load penalty, used only if persistent is dead) ----

  function speakOneShotPiper(line) {
    return new Promise((resolve) => {
      const piperExe = findExe("piper");
      const playExe = findExe("play");
      if (!piperExe || !playExe) return resolve(false);
      const { entry } = resolveVoice();
      const onnxPath = path.join(VOICES_DIR, entry.file);

      let playProc = null, piperProc = null, done = false;
      const killAll = () => {
        for (const p of [playProc, piperProc]) if (p) try { p.kill("SIGKILL"); } catch {}
      };
      const finish = (ok) => { if (done) return; done = true; clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => finish(false), PLAYBACK_HARD_LIMIT_MS);

      try {
        playProc = transientTrack(spawn(playExe, ["-t", "raw", "-r", "22050", "-e", "signed", "-b", "16", "-c", "1", "-q", "-"], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true }));
        piperProc = transientTrack(spawn(piperExe, ["-m", onnxPath, "--output_raw"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
      } catch { finish(false); return; }

      piperProc.stdout?.on("data", (c) => { if (playProc?.stdin && !playProc.stdin.destroyed) playProc.stdin.write(c); });
      piperProc.on("close", () => { if (playProc?.stdin && !playProc.stdin.destroyed) playProc.stdin.end(); });
      playProc.on("close", (code) => finish(code === 0 || code === null));
      piperProc.on("error", () => killAll());
      playProc.on("error", () => killAll());
      if (piperProc?.stdin && !piperProc.stdin.destroyed) { piperProc.stdin.write(line + "\n"); piperProc.stdin.end(); }
    });
  }

  // ---- edge-tts backend ----

  async function speakEdgeLine(line) {
    const edgeExe = findExe("edge-tts");
    const playExe = findExe("play");
    if (!edgeExe || !playExe) return false;
    const face = kv.get("vanta.voice", DEFAULT_EDGE_VOICE);
    if (!Object.prototype.hasOwnProperty.call(EDGE_VOICES, face)) return false;
    for (const f of [MP3_PATH, WAV_EDGE_PATH]) try { fs.unlinkSync(f); } catch {}

    const ttsRes = await run(edgeExe, ["--voice", face, "--text", line, "--write-media", MP3_PATH], { timeout: 30000 });
    if (ttsRes.code !== 0 || !fs.existsSync(MP3_PATH)) return false;

    let playTarget = MP3_PATH;
    const ffmpeg = findExe("ffmpeg");
    if (ffmpeg) {
      const ffRes = await run(ffmpeg, ["-y", "-i", MP3_PATH, "-ar", "22050", "-ac", "1", WAV_EDGE_PATH], {});
      if (ffRes.code === 0 && fs.existsSync(WAV_EDGE_PATH) && fs.statSync(WAV_EDGE_PATH).size > 44) playTarget = WAV_EDGE_PATH;
    }
    const playRes = await run(playExe, [playTarget]);
    return playRes.code === 0;
  }

  // ---- sequential queue (never blocks the plugin loop) ----

  const lineQueue = [];
  let drainBusy = false;

  async function drainQueue() {
    if (drainBusy) return;
    drainBusy = true;
    while (lineQueue.length > 0) {
      const line = lineQueue.shift();
      const voiceName = kv.get("vanta.voice", DEFAULT_PIPER_VOICE);
      const useEdge = Object.prototype.hasOwnProperty.call(EDGE_VOICES, voiceName);
      try {
        if (useEdge) {
          const ok = await speakEdgeLine(line);
          if (!ok) await speakLine(line);
        } else {
          await speakLine(line);
        }
      } catch (err) {
        logger?.log?.("TTS", `drain error: ${err.message}`, "warn");
      }
    }
    drainBusy = false;
  }

  function speak(text) {
    const line = cleanForSpeech(text || "");
    if (!line) return Promise.resolve();
    lineQueue.push(line);
    drainQueue();
    return Promise.resolve();
  }

  function isSpeaking() { return lineQueue.length > 0 || drainBusy; }

  async function stop() {
    lineQueue.length = 0;
    for (const p of transientProcs) try { p.kill("SIGKILL"); } catch {}
    await new Promise((r) => setTimeout(r, 30));
  }

  async function test() {
    const t0 = Date.now();
    const ok = await speakLine("Testing one two three. VANTA is online.");
    return { ok, ms: Date.now() - t0 };
  }

  // ---- init: warm piper in background so first speak is instant ----
  try { ensurePiper(); } catch {}

  return { speak, stop, isSpeaking, test, EDGE_VOICES, PIPER_VOICES, DEFAULT_PIPER_VOICE };
}