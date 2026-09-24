// VANTA 2 — always-on voice assistant for opencode. Jarvis flow.
//
// Hands-free conversation:
//   /vanta            -> toggle VANTA on/off (speaks "VANTA online." on boot)
//   /vanta-tts        -> toggle spoken replies on/off
//   /vanta-voice      -> pick the voice (alan = offline default, Thomas = edge)
//   /vanta-mode       -> narrate (streams while working) | brief (LLM 1-liner) | off
//   /vanta-wake       -> wake word required (vanta/jarvis) before it submits
//   /vanta-sens       -> mic sensitivity
//   /vanta-test       -> instant voice check: "Testing one two three..."
//   /vanta-status     -> show state
//
// Jarvis flow:
//   1. You talk -> VANTA acknowledges instantly ("On it.")
//   2. opencode thinks -> VANTA READS THE REPLY WHILE IT IS STILL BEING TYPED
//      (narrate mode): speaks chunks as they stream; never waits for the end.
//   3. opencode goes idle -> VANTA says any remaining tail
//   4. You can TALK OVER VANTA at any time (barge-in) to shut it up
//   5. Watchdog kills any stuck speech after 25s — voice can NEVER permanently stall
//
// Keybinds: <leader>v (ctrl+x then v) — toggle VANTA on/off
//
// v3.1 hardening (2026-09-13):
//   - session busy is grounded in api.state.session.status() — the loop can
//     NEVER stay stuck in "busy" or listen while the agent is still working
//   - adaptive barge-in: VANTA builds an ambient mic floor while speaking so
//     its OWN voice can never trigger a self-stop (this was "it stops suddenly")
//   - the conversation loop is armored: any internal error is logged+recovered,
//     and a watchdog restarts the loop if it ever dies
//   - live status file (vanta-state.txt in the temp dir) shown in the TUI
//     status line: VANTA: listening / capturing / thinking / speaking / offline

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "./lib/llm.js";
import { createLogger } from "./lib/logger.js";
import { createSTT } from "./lib/stt.js";
import { createTTS, cleanForSpeech } from "./lib/tts.js";

const BRIEF_SYSTEM_PROMPT = `You are the voice of VANTA, a calm British AI assistant (think Jarvis). Summarize the assistant's reply into ONE short spoken sentence (max 2 short sentences), as if you just did the work. Rules: Lead with the outcome ("Done. All tests pass."), never read code or paths aloud, end with "details are on screen" when there's detail. Output ONLY the spoken text.`;

const ACKS = ["On it.", "Right away.", "Working on that.", "Give me a moment.", "On it, boss."];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  id: "vanta",
  tui: async (api, options) => {
    const { kv } = api;
    const client = api.client;
    const logger = createLogger(client);
    const { complete } = createClient(options, logger);

    const tmpDir = options?.tmpDir || path.join(os.tmpdir(), "opencode");
    const STATE_FILE = path.join(tmpDir, "vanta-state.txt");

    const stt = createSTT({ api, options, kv, logger, complete });
    const tts = createTTS({ api, options, kv, logger });

    const state = {
      on: false,
      busy: false,
      busySince: 0,
      loopRunning: false,
      pollerRunning: false,
      lastSpokenMessageID: null,
      voicedByMsg: new Map(),
      spokeAt: 0, // timestamp speech started — watchdog
      visual: "offline",
    };

    /** Live TUI status (status-line file + the label itself). */
    function setVisual(label) {
      state.visual = label;
      try {
        fs.writeFileSync(STATE_FILE, `VANTA: ${label}\n`);
      } catch {}
    }

    function toast(message, variant = "info") {
      api.ui.toast({ message, variant, duration: 3000 });
    }

    // ---- assistant message helpers ----

    function currentSessionID() {
      const route = api.route?.current;
      return route?.name === "session" ? route.params.sessionID : null;
    }

    async function lastAssistantID(sessionID) {
      const msgs = api.state.session.messages(sessionID);
      if (!msgs) return null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") return msgs[i].id;
      }
      return null;
    }

    async function assistantText(sessionID, messageID) {
      if (!sessionID || !messageID) return "";
      try {
        const fullMsg = await client.session
          .message({ sessionID, messageID }, { throwOnError: true })
          .then((r) => r.data);
        return (fullMsg?.parts || [])
          .filter((p) => p.type === "text")
          .map((p) => p.text || "")
          .join("\n\n")
          .trim();
      } catch {
        return "";
      }
    }

    async function readLastAssistantText() {
      const sessionID = currentSessionID();
      if (!sessionID) return null;
      const msgs = api.state.session.messages(sessionID);
      if (!msgs || msgs.length === 0) return null;
      const ids = [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") break;
        if (msgs[i].role === "assistant") ids.unshift(msgs[i].id);
      }
      if (ids.length === 0) return null;
      const parts = [];
      for (const id of ids) {
        const t = await assistantText(sessionID, id);
        if (t) parts.push(t);
      }
      if (parts.length === 0) return null;
      return { lastMessageID: ids[ids.length - 1], text: parts.join("\n\n") };
    }

    // ---- speaking / mode ----

    function mode() {
      return kv.get("vanta.mode", "narrate");
    }

    function ttsOn() {
      return kv.get("vanta.tts", "on") === "on";
    }

    function wakeOn() {
      return kv.get("vanta.wake", "off") === "on";
    }

    /** Live session status from opencode's own state (ground truth). */
    function safeSessionStatus() {
      try {
        const sid = currentSessionID();
        if (!sid || !api.state?.session?.status) return null;
        return api.state.session.status(sid) || null;
      } catch {
        return null;
      }
    }

    /** While session is busy, poll the growing reply and speak deltas. */
    async function pollReplyStream(sessionID) {
      if (state.pollerRunning) return;
      state.pollerRunning = true;
      try {
        setVisual("thinking");
        while (state.on && state.busy && ttsOn() && mode() === "narrate") {
          const msgId = await lastAssistantID(sessionID);
          if (msgId) {
            const text = await assistantText(sessionID, msgId);
            const voiced = state.voicedByMsg.get(msgId) || "";
            if (text && text.length > voiced.length + 60) {
              const delta = text.slice(voiced.length);
              if (cleanForSpeech(delta).length > 0) {
                state.voicedByMsg.set(msgId, text);
                await tts.speak(delta);
              }
            }
          }
          await sleep(1200);
        }
      } catch {
        // best-effort: idle handler always speaks the final remainder
      } finally {
        state.pollerRunning = false;
      }
    }

    async function speakLastReply() {
      if (!state.on) return;
      const result = await readLastAssistantText();
      if (!result?.text) return;
      if (result.lastMessageID === state.lastSpokenMessageID) return;
      state.lastSpokenMessageID = result.lastMessageID;

      const voiced = state.voicedByMsg.get(result.lastMessageID) || "";
      const m = mode();
      let toSpeak = "";

      if (m === "off") {
        // silent
      } else if (m === "brief") {
        try {
          const short = await complete({
            system: BRIEF_SYSTEM_PROMPT,
            prompt: `Summarize for speech:\n\n${result.text}`,
            config: { maxTokens: 128 },
          });
          if (short?.text) toSpeak = short.text;
        } catch {}
      }

      if (!toSpeak) {
        toSpeak = result.text.slice(voiced.length);
      }

      if (cleanForSpeech(toSpeak).length === 0) return;
      state.voicedByMsg.set(result.lastMessageID, result.text);
      await tts.speak(toSpeak);
    }

    // ---- session events ----

    api.event.on("session.status", (event) => {
      if (!state.on) return;
      const sid = event.properties?.sessionID;
      if (sid && currentSessionID() && sid !== currentSessionID()) return;
      const type = event.properties?.status?.type;
      if (type === "busy") {
        state.busy = true;
        state.busySince = Date.now();
        setVisual("thinking");
        if (sid) pollReplyStream(sid);
      } else if (type === "idle") {
        // ground truth: session is really done working
        state.busy = false;
        setVisual("listening");
        if (ttsOn()) speakLastReply();
      }
    });

    api.event.on("session.idle", () => {
      // deprecated compat event — only trust it outside the fresh-submit race
      if (!state.busy || Date.now() - state.busySince > 2000) {
        state.busy = false;
      }
      if (!state.on || !ttsOn()) return;
      speakLastReply();
    });

    api.event.on("permission.asked", () => {
      if (state.on && ttsOn()) tts.speak("Permission requested. Check your screen.");
    });

    api.event.on("question.asked", () => {
      if (state.on && ttsOn()) tts.speak("A question needs your answer.");
    });

    // ---- conversation loop ----

    async function conversationLoop() {
      if (state.loopRunning) return;
      state.loopRunning = true;
      let prevSpeaking = false;

      while (state.on) {
        try {
          // ---- busy: opencode working; narration speaks, barge-in still allowed ----
          if (state.busy) {
            if (tts.isSpeaking()) {
              const c = await stt.listenChunk();
              if (c?.loud) await tts.stop();
            }

            // ground truth: if the session says idle (and the fresh-submit race
            // is over) the agent is REALLY done — resume listening.
            const st = safeSessionStatus();
            if (st && st.type === "idle" && Date.now() - state.busySince > 3000) {
              state.busy = false;
              setVisual("listening");
              if (ttsOn() && mode() !== "off") speakLastReply();
            }
            prevSpeaking = false;
            await sleep(400);
            continue;
          }

          // ---- speaking: barge-in monitor (single mic owner) ----
          if (tts.isSpeaking()) {
            if (!prevSpeaking) state.spokeAt = Date.now();
            prevSpeaking = true;
            setVisual("speaking");

            // watchdog: force-stop stuck speech after 25s
            if (Date.now() - state.spokeAt > 25_000) {
              logger?.log?.("VANTA", "watchdog: speech exceeded 25s, force-stopping", "warn");
              await tts.stop();
              prevSpeaking = false;
              continue;
            }

            const c = await stt.listenChunk();
            if (c?.loud) {
              logger?.log?.("VANTA", "barge-in detected, stopping speech", "debug");
              await tts.stop();
            }
            continue;
          }

          prevSpeaking = false;

          // quiet settle
          await sleep(600);
          if (!state.on) break;

          // Only listen when the session is genuinely idle — otherwise a voice
          // prompt typed while the agent is mid-reply would go nowhere.
          const st = safeSessionStatus();
          if (st && st.type !== "idle") {
            state.busy = true;
            state.busySince = Date.now();
            await sleep(400);
            continue;
          }

          // listen
          try {
            setVisual("listening");
            const res = await stt.processTurn({
              onStatus: setVisual,
              onSubmitted: () => {
                setVisual("thinking");
                if (ttsOn() && mode() !== "off") {
                  tts.speak(ACKS[Math.floor(Math.random() * ACKS.length)]);
                }
              },
              markBusy: () => {
                state.busy = true;
                state.busySince = Date.now();
                setVisual("thinking");
              },
              wakeOn: wakeOn(),
            });
            if (res?.submitted) await sleep(1500);
          } catch (err) {
            logger?.log?.("VANTA", `turn error: ${err.message}`, "error");
            toast(`VANTA error: ${err.message}`, "error");
            await sleep(1500);
          }

          await sleep(400);
        } catch (err) {
          // armor: a single failure must NEVER kill the loop silently
          logger?.log?.("VANTA", `loop error (recovered): ${err?.message || err}`, "error");
          toast("VANTA recovered from an internal error", "error");
          await sleep(800);
        }
      }
      state.loopRunning = false;
      setVisual("offline");
    }

    function toggleVanta() {
      state.on = !state.on;
      if (state.on) {
        // Boot chime: instant voice proof + VANTA online announcement
        setVisual("online");
        if (ttsOn()) tts.speak("VANTA online.");
        toast("VANTA online — just talk");
        conversationLoop();
      } else {
        state.busy = false;
        stt.kill();
        tts.stop();
        setVisual("offline");
        toast("VANTA offline");
      }
    }

    // ---- commands ----

    const commands = [
      {
        title: "VANTA: toggle hands-free mode",
        value: "vanta.toggle",
        description: "Start/stop always-on voice conversation",
        keybind: "<leader>v",
        slash: { name: "vanta" },
        onSelect() {
          toggleVanta();
        },
      },
      {
        title: "VANTA: toggle spoken replies",
        value: "vanta.tts",
        description: "Turn auto text-to-speech on/off",
        slash: { name: "vanta-tts" },
        onSelect() {
          const current = kv.get("vanta.tts", "on");
          const next = current === "on" ? "off" : "on";
          kv.set("vanta.tts", next);
          toast(next === "on" ? "VANTA replies: on" : "VANTA replies: off");
        },
      },
      {
        title: "VANTA: select voice",
        value: "vanta.voice",
        description: "alan (offline, instant) by default; Thomas & co are online",
        slash: { name: "vanta-voice" },
        onSelect() {
          const current = kv.get("vanta.voice", tts.DEFAULT_PIPER_VOICE);
          const pick = (value, label) => {
            kv.set("vanta.voice", value);
            toast(`VANTA voice: ${label}`);
            api.ui.dialog.clear();
          };
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select VANTA voice",
              current,
              options: [
                { title: "--- offline (instant, local) ---", value: "___", onSelect() {} },
                ...Object.entries(tts.PIPER_VOICES).map(([key, v]) => ({
                  title: v.label,
                  value: key,
                  onSelect() {
                    pick(key, v.label);
                  },
                })),
                { title: "--- online (edge-tts, richer) ---", value: "___", onSelect() {} },
                ...Object.entries(tts.EDGE_VOICES).map(([key, v]) => ({
                  title: v.label,
                  value: key,
                  onSelect() {
                    pick(key, v.label);
                  },
                })),
              ],
            }),
          );
        },
      },
      {
        title: "VANTA: reply mode",
        value: "vanta.mode",
        description: "narrate = talks while working, brief = one-line summary",
        slash: { name: "vanta-mode" },
        onSelect() {
          const current = kv.get("vanta.mode", "narrate");
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "VANTA reply mode",
              current,
              options: [
                {
                  title: "narrate — talks while working (streams the reply)",
                  value: "narrate",
                  onSelect() {
                    kv.set("vanta.mode", "narrate");
                    toast("VANTA mode: narrate");
                    api.ui.dialog.clear();
                  },
                },
                {
                  title: "brief — one punchy Jarvis line after done",
                  value: "brief",
                  onSelect() {
                    kv.set("vanta.mode", "brief");
                    toast("VANTA mode: brief (one-line)");
                    api.ui.dialog.clear();
                  },
                },
                {
                  title: "off — replies silent",
                  value: "off",
                  onSelect() {
                    kv.set("vanta.mode", "off");
                    toast("VANTA mode: off");
                    api.ui.dialog.clear();
                  },
                },
              ],
            }),
          );
        },
      },
      {
        title: "VANTA: wake word",
        value: "vanta.wake",
        description: "Require 'vanta'/'jarvis' prefix before it listens",
        slash: { name: "vanta-wake" },
        onSelect() {
          const current = kv.get("vanta.wake", "off");
          const next = current === "on" ? "off" : "on";
          kv.set("vanta.wake", next);
          toast(next === "on" ? "Wake word required (say 'vanta' or 'jarvis' first)" : "Wake word: off (always listening)");
        },
      },
      {
        title: "VANTA: test voice",
        value: "vanta.test",
        description: "Instantly speak a test line to confirm voice works",
        slash: { name: "vanta-test" },
        onSelect() {
          toast("VANTA: speaking test...");
          tts.test().then((r) => {
            toast(`VANTA: ${r.ok ? "voice OK" : "voice FAILED"} (${r.ms}ms)`, r.ok ? "info" : "error");
          });
        },
      },
      {
        title: "VANTA: sensitivity",
        value: "vanta.sens",
        description: "Mic sensitivity: 1 = loud/near-mic, 5 = whisper-friendly",
        slash: { name: "vanta-sens" },
        onSelect() {
          const current = kv.get("vanta.sens", "3");
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select VANTA mic sensitivity",
              current,
              options: [
                { title: "1 - loud / near-mic", value: "1", onSelect() { kv.set("vanta.sens", "1"); toast("Sensitivity: 1 (loud)"); api.ui.dialog.clear(); } },
                { title: "2", value: "2", onSelect() { kv.set("vanta.sens", "2"); toast("Sensitivity: 2"); api.ui.dialog.clear(); } },
                { title: "3 - default", value: "3", onSelect() { kv.set("vanta.sens", "3"); toast("Sensitivity: 3 (default)"); api.ui.dialog.clear(); } },
                { title: "4", value: "4", onSelect() { kv.set("vanta.sens", "4"); toast("Sensitivity: 4"); api.ui.dialog.clear(); } },
                { title: "5 - whisper-friendly", value: "5", onSelect() { kv.set("vanta.sens", "5"); toast("Sensitivity: 5 (whisper)"); api.ui.dialog.clear(); } },
              ],
            }),
          );
        },
      },
      {
        title: "VANTA: status",
        value: "vanta.status",
        description: "Show current VANTA state",
        slash: { name: "vanta-status" },
        onSelect() {
          const status = [
            state.on ? "ONLINE" : "offline",
            "replies: " + kv.get("vanta.tts", "on"),
            "mode: " + kv.get("vanta.mode", "narrate"),
            "voice: " + kv.get("vanta.voice", tts.DEFAULT_PIPER_VOICE),
            "wake: " + kv.get("vanta.wake", "off"),
          ].join(" | ");
          toast(`VANTA ${status}`);
        },
      },
    ];

    api.command.register(() => commands);

    // Loop watchdog: if the conversation loop ever dies while VANTA is on,
    // restart it instead of silently going deaf.
    setInterval(() => {
      if (state.on && !state.loopRunning) {
        logger?.log?.("VANTA", "loop watchdog: conversation loop died, restarting", "warn");
        conversationLoop();
      }
    }, 10_000);

    logger.log("VANTA", "plugin initialized (v3.1 jarvis flow)", "debug");
  },
};