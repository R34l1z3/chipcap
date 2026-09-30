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
 * SUSPENSE — the deciding swing: the last tug-of-war step in a 1v1,
 * the last elimination in a royale.
 *
 * A tone that rises while getting quieter: the ear tracks the pitch
 * climbing toward something and then the answer arrives.  Deliberately
 * short (450 ms) — a riser that outstays the beat turns tension into
 * annoyance.
 */
export function playSuspense(): void {
  safe(() => {
    const t = begin();
    if (t === null) return;
    bend(330, 1180, t, 0.45, "square", 0.55);
    bend(165, 590,  t, 0.45, "triangle", 0.35);   // an octave below, for body
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
    note(C5, t,        0.10);
    note(E5, t + 0.09, 0.10);
    note(G5, t + 0.18, 0.10);
    note(C6, t + 0.27, 0.38);
    note(G6, t + 0.27, 0.38, "triangle", 0.5);   // sparkle on top
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
