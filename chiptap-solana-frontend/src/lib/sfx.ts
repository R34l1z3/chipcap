// ============================================================
// src/lib/sfx.ts — SEC-28: chiptune SFX, synthesised not sampled
// ============================================================
//
// Every sound here is generated with the Web Audio API at runtime.
// No .wav/.mp3 assets, deliberately:
//   • zero bytes added to the bundle (CLAUDE.md's perf note warns that
//     audio + sprite art could double it — this adds ~2 KB of code)
//   • no licensing or attribution to track
//   • square/pulse oscillators ARE the 8-bit sound, so synthesis is
//     more authentic here than a recorded sample would be
//
// MUTED BY DEFAULT.  Autoplaying audio at someone is hostile, and
// browsers block it before a user gesture anyway.  The preference
// lives in localStorage so it survives reloads.
// ============================================================

const LS_KEY = "chiptap_sfx_on";
const MASTER = 0.14;          // game SFX should sit under the UI, not over it

let ctx: AudioContext | null = null;
let enabled = false;
const listeners = new Set<(on: boolean) => void>();

try {
  enabled = localStorage.getItem(LS_KEY) === "1";
} catch { /* private mode — stay muted */ }

export function isSfxOn(): boolean { return enabled; }

export function setSfxOn(on: boolean): void {
  enabled = on;
  try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  // Turning it on IS the user gesture, so unlock the context here.
  if (on) void ensureCtx()?.resume().catch(() => {});
  listeners.forEach((l) => l(on));
}

export function subscribeSfx(l: (on: boolean) => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;                 // no Web Audio — silently no-op
  try { ctx = new AC(); } catch { return null; }
  return ctx;
}

/**
 * One note. `type` picks the timbre: "square" is the classic NES lead,
 * "triangle" the softer bass.  The gain envelope ramps from near-zero
 * rather than 0 because exponentialRamp can't touch zero, and a hard
 * start would click.
 */
function note(
  freq: number, startAt: number, dur: number,
  type: OscillatorType = "square", vol = 1,
): void {
  const c = ctx;
  if (!c) return;
  const osc  = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);

  const peak = MASTER * vol;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.012);       // fast attack
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);  // decay tail

  osc.connect(gain).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

/** A note that slides in pitch — used for the defeat sag. */
function bend(
  from: number, to: number, startAt: number, dur: number,
  type: OscillatorType = "square", vol = 1,
): void {
  const c = ctx;
  if (!c) return;
  const osc  = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, startAt);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, to), startAt + dur);

  const peak = MASTER * vol;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);

  osc.connect(gain).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

/**
 * Filtered white noise with a swept filter — the whoosh, snare and
 * crack that oscillators alone can't make.  One shared 1 s buffer,
 * looped; the randomness here is audio texture only.
 */
let noiseBuf: AudioBuffer | null = null;
function noise(
  startAt: number, dur: number, vol: number,
  fromHz: number, toHz: number,
  type: BiquadFilterType = "bandpass", q = 1.2,
): void {
  const c = ctx;
  if (!c) return;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(fromHz, startAt);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), startAt + dur);
  const gain = c.createGain();
  const peak = MASTER * vol;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + Math.min(0.02, dur / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  src.connect(filter).connect(gain).connect(c.destination);
  src.start(startAt);
  src.stop(startAt + dur + 0.05);
}

function begin(): number | null {
  if (!enabled) return null;
  const c = ensureCtx();
  if (!c) return null;
  if (c.state === "suspended") void c.resume().catch(() => {});
  return c.currentTime + 0.02;
}

/**
 * Audio must never be able to take down the battle screen.  Every
 * public sound goes through here, so an exotic Web Audio failure
 * (context in a bad state, node limit hit, autoplay policy edge) is
 * swallowed as silence rather than thrown into the React render path.
 */
function safe(fn: () => void): void {
  try { fn(); } catch { /* silence beats a broken screen */ }
}

// ---- the stings ----------------------------------------------------

/**
 * HEARTBEAT — "lub-dub" under the VRF wait.  The caller speeds it up as
 * the wait goes on; `intensity` 0..1 makes each beat heavier too.  Low
 * sine for the body plus a quiet triangle an octave up, so it still
 * reads on laptop speakers that can't reproduce 50 Hz.
 */
export function playHeartbeat(intensity = 0): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    const k = Math.max(0, Math.min(1, intensity));
    bend(95, 46, t,        0.17, "sine",     1.3 + k * 0.8);
    bend(190, 92, t,       0.12, "triangle", 0.25 + k * 0.2);
    bend(82, 40, t + 0.17, 0.15, "sine",     1.0 + k * 0.6);
    bend(164, 80, t + 0.17, 0.10, "triangle", 0.18 + k * 0.15);
  });
}

/**
 * SWING — one pull of the tug-of-war: an air whoosh plus a pitched hit.
 * Heard from the viewer's seat: a pull TOWARD you sweeps up and rings
 * bright (a major third on top), a pull away sweeps down and lands dull.
 * `towardYou` null = spectator, neutral.  `p` 0..1 through the run
 * raises everything a little, so the sequence tightens as it goes.
 */
export function playSwing(p: number, towardYou: boolean | null): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    const k = Math.max(0, Math.min(1, p));
    if (towardYou === true) {
      noise(t, 0.22, 0.9, 500, 3200);
      const f = 620 + k * 420;
      note(f,        t + 0.02, 0.09, "square",   0.55);
      note(f * 1.26, t + 0.06, 0.12, "triangle", 0.45);
    } else if (towardYou === false) {
      noise(t, 0.22, 0.8, 2600, 380);
      const f = 300 + k * 160;
      note(f,        t + 0.02, 0.10, "square",   0.45);
      note(f * 0.84, t + 0.06, 0.12, "triangle", 0.40);
    } else {
      noise(t, 0.18, 0.7, 900, 1800);
      note(420 + k * 520, t + 0.02, 0.07, "square", 0.45);
    }
  });
}

/**
 * DRUMROLL — the held breath before the deciding fall.  Snare hits that
 * accelerate and swell across `dur` seconds, over a rising tone.
 */
export function playDrumroll(dur: number): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    let at = 0, gap = 0.11;
    while (at < dur - 0.04) {
      const k = at / dur;
      noise(t + at, 0.05, 0.35 + k * 0.75, 2400, 1600, "highpass", 0.7);
      at += gap;
      gap = Math.max(0.032, gap * 0.9);
    }
    bend(180, 760, t, dur, "triangle", 0.35);
  });
}

/** FALL — the marker dropping onto the winning side. */
export function playFall(): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    noise(t, 0.42, 1.0, 3000, 240, "bandpass", 0.9);
  });
}

/**
 * IMPACT — the landing: a sub boom, a noise crack and a square crunch.
 * The loudest thing in the kit, used once per result.
 */
export function playImpact(): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    bend(150, 36, t, 0.6, "sine", 2.4);
    noise(t, 0.4, 1.6, 4200, 260, "lowpass", 0.8);
    note(72, t, 0.14, "square", 0.9);
  });
}

/**
 * TICK — one swing of the tug-of-war.  `p` is 0..1 through the
 * sequence and raises the pitch, so the run of ticks reads as a
 * ratchet tightening rather than a metronome.  Short and dry; the
 * tension comes from the rising interval, not from any one hit.
 */
export function playTick(p: number): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    const f = 420 + Math.max(0, Math.min(1, p)) * 620;   // 420 -> 1040 Hz
    note(f, t, 0.055, "square", 0.5);
    note(f / 2, t, 0.05, "triangle", 0.25);              // body underneath
  });
}

/**
 * VICTORY — rising major arpeggio (C-E-G) landing on a held octave C,
 * doubled a fifth up for a bit of shine.  Short, bright, celebratory.
 */
export function playWin(): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, G6 = 1568.0;
    const E6 = 1318.5, C7 = 2093.0;
    note(C5, t,        0.10);
    note(E5, t + 0.09, 0.10);
    note(G5, t + 0.18, 0.10);
    note(C6, t + 0.27, 0.55);
    note(G6, t + 0.27, 0.55, "triangle", 0.5);   // sparkle on top
    // Held major chord under a quick glitter run — the "fanfare" tail.
    note(E5, t + 0.27, 0.70, "triangle", 0.55);
    note(G5, t + 0.27, 0.70, "triangle", 0.45);
    note(E6, t + 0.52, 0.08, "square", 0.35);
    note(G6, t + 0.58, 0.08, "square", 0.35);
    note(C7, t + 0.64, 0.30, "square", 0.35);
  });
}

/**
 * DEFEAT — descending minor steps that slow down, then a pitch sag on
 * the last note: the classic "wah-wah" fall.  Triangle for the tail so
 * it reads as deflating rather than harsh.
 */
export function playLose(): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    const G4 = 392.0, Eb4 = 311.13, C4 = 261.63;
    note(G4,  t,        0.14);
    note(Eb4, t + 0.15, 0.16);
    note(C4,  t + 0.33, 0.20);
    bend(C4, 110, t + 0.55, 0.55, "triangle", 0.9);
  });
}
