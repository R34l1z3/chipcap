// ============================================================
// src/components/BattleClash.tsx — SEC-28
//
// The fight scene for a 1v1 battle.  Wraps the two chip cards and
// owns the motion between them:
//
//   status 0 (WAITING)  — static VS, nothing moving
//   status 1 (ROLLING)  — a heartbeat that quickens, chips trembling,
//                         a VRF die scrambling: the wait for randomness
//                         becomes the suspense beat instead of dead air
//   1 -> 2 transition   — tug-of-war reveal unfolded from the seed
//                         (see pathFromSeed): swings, then the marker
//                         hangs in the middle to a drumroll, then falls
//                         onto the real winner — impact, flash, stamp
//   status >= 2 on mount — result state with NO replay
//
// That last rule matters: opening a finished battle from history must
// not stage a fight that already happened.  We only animate a
// transition this component actually witnessed, tracked via prevStatus.
//
// Deliberately zero assets — pure CSS + Web Audio, so the bundle stays
// flat.  Motion is disabled under `prefers-reduced-motion` (index.css);
// the end state stays correct, only the movement stops.
// ============================================================

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  playWin, playLose, playSwing, playDrumroll, playFall, playImpact,
} from "../lib/sfx";
import { useHeartbeat, HEAT_RAMP_S } from "../hooks/useHeartbeat";

type Phase = "idle" | "rolling" | "reveal" | "result";

const SPARKS = 16;
const CONFETTI = 28;

/**
 * Step schedules for the reveal, in ms: entry i is the wait before step
 * i.  All three read the SAME path out of the seed — only the rhythm
 * differs.  The last entry is the hang: how long the marker hovers in
 * the middle, to a drumroll, before the deciding fall.
 */
export const REVEAL_PROFILES = {
  /** Quick — 3 swings + hang, ~2.3 s. */
  short: [400, 340, 300, 280, 1000],
  /** Accelerating — 5 swings + hang, ~3.5 s. */
  build: [480, 420, 360, 320, 290, 270, 1400],
  /** Drawn out — 7 swings, one pause, hang, ~5 s. */
  long:  [520, 470, 420, 380, 650, 320, 290, 270, 1700],
} as const;

export type RevealProfile = keyof typeof REVEAL_PROFILES;

/** Marker travel time for the final fall — the impact lands after it. */
const FALL_MS = 450;
/** Impact → sting → settled result. */
const STING_AFTER_IMPACT_MS = 380;
const SETTLE_AFTER_IMPACT_MS = 1300;
export interface BattleClashProps {
  status: number;
  /** Which side won, once known. */
  winnerSide: "a" | "b" | null;
  /** Label + ChipCard block for each player, rendered by the parent. */
  left: React.ReactNode;
  right: React.ReactNode;
  vsLabel: string;
  rollingLabel: string;
  /** Real VRF seed, revealed when the clash lands. */
  seed?: string | null;
  /**
   * The outcome FROM THE VIEWER'S SEAT, which is what the sting plays
   * for.  Spectators get "neutral" and hear nothing — firing a defeat
   * sound at someone who wasn't even playing would be nonsense.
   */
  outcome?: "win" | "lose" | "neutral";
  /** The viewer's side, if they are playing — makes the swings personal. */
  mySide?: "a" | "b" | null;
  /** Short "you" label for the viewer's end of the bar. */
  youLabel?: string;
  /** Stamp texts slammed onto the stage at impact. */
  winText?: string;
  loseText?: string;
  /** Pacing of the reveal — see REVEAL_PROFILES. */
  profile?: RevealProfile;
  /**
   * True while the reveal is playing.  The page must hold back anything
   * that names the winner (banner, claim button, audit panel) until it
   * goes false — otherwise the answer sits right under the suspense.
   */
  onRevealChange?: (revealing: boolean) => void;
}

/**
 * Scrambling digits while randomness is pending.  `speed` 0..1 tightens
 * the interval, so the numbers visibly churn faster as tension builds.
 */
function useScramble(active: boolean, speed = 0) {
  const [val, setVal] = useState("00000000");
  useEffect(() => {
    if (!active) return;
    const ms = Math.round(110 - speed * 65);   // 110ms -> 45ms
    const id = setInterval(() => {
      let s = "";
      for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 10);
      setVal(s);
    }, ms);
    return () => clearInterval(id);
  }, [active, speed]);
  return val;
}

/**
 * Unfold the VRF seed into a tug-of-war path in [-100, 100], where
 * negative leans to player A and positive to player B.
 *
 * The program decides the winner with the LOWEST bit (`seed % 2`, even →
 * A), so that bit — and only that bit — sets the final position.  The
 * swings before it are read off HIGHER bits, which decide nothing on
 * chain, and the second-to-last step is always a hang near the centre
 * (±10), for BOTH outcomes.  So:
 *   • every position on screen is a function of the seed, recomputable
 *     by anyone holding it;
 *   • nothing depends on who is watching or on who wins — the hang is
 *     not steered toward the loser, the swings are not weighted to land
 *     "just short".  That is the line between suspense and a slot
 *     machine's engineered near-miss, and for a game sold on provable
 *     fairness it is the product.
 */
export function pathFromSeed(seed: string | null | undefined, steps: number): number[] {
  let s: bigint;
  try { s = BigInt(seed ?? "0"); } catch { s = 0n; }
  if (s < 0n) s = -s;

  const finalLeansB = (s & 1n) === 1n;
  const path: number[] = [];
  const chunk = (i: number) => Number((s >> BigInt(1 + i * 5)) & 31n);   // 0..31, above the deciding bit

  for (let i = 0; i < steps - 2; i++) {
    path.push(Math.round(((chunk(i) / 31) * 2 - 1) * 82));             // swings: -82..82
  }
  if (steps >= 2) path.push(Math.round(((chunk(steps - 2) / 31) * 2 - 1) * 10));   // the hang: -10..10
  path.push(finalLeansB ? 100 : -100);   // the deciding bit lands last, and all the way
  return path;
}

/**
 * 0..1 build-up while rolling.  Drives every motion parameter through a
 * single CSS custom property, so the whole scene tightens together.
 */
function useHeat(active: boolean) {
  const [heat, setHeat] = useState(0);
  useEffect(() => {
    if (!active) { setHeat(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => {
      setHeat(Math.min(1, (Date.now() - t0) / 1000 / HEAT_RAMP_S));
    }, 200);
    return () => clearInterval(id);
  }, [active]);
  return heat;
}

export default function BattleClash({
  status, winnerSide, left, right, vsLabel, rollingLabel, seed,
  outcome = "neutral", mySide = null, youLabel, winText, loseText,
  profile = "build", onRevealChange,
}: BattleClashProps) {
  const prevStatus = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>(() =>
    status === 1 ? "rolling" : status >= 2 ? "result" : "idle",
  );
  // True only when this component watched the roll resolve, which is
  // what gates the winner/loser flourish.
  const [witnessed, setWitnessed] = useState(false);
  // Index into the seed-derived tug-of-war path; -1 = not started.
  const [step, setStep] = useState(-1);
  // The moment the falling marker lands — flash, ring, sparks, stamp.
  const [impact, setImpact] = useState(false);
  const pathRef = useRef<number[]>([]);

  // Layout effects throughout: the reveal must start — and the page must
  // hear about it — before the first paint of the decided state, or the
  // result banner flashes for a frame.
  useLayoutEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (status === 1) { setPhase("rolling"); return; }

    // The one moment worth animating: a roll we were watching resolved.
    if (prev === 1 && status >= 2) {
      setWitnessed(true);
      setPhase("reveal");
      setImpact(false);

      const schedule = REVEAL_PROFILES[profile] ?? REVEAL_PROFILES.build;
      const n = schedule.length;
      const path = pathFromSeed(seed, n);
      pathRef.current = path;
      setStep(-1);

      const towardMe = (lean: number) =>
        mySide === "a" ? lean < 0 : mySide === "b" ? lean > 0 : null;

      const timers: ReturnType<typeof setTimeout>[] = [];
      let at = 0;
      path.forEach((lean, i) => {
        at += schedule[i] ?? 350;
        const isHang = i === n - 2, isFinal = i === n - 1;
        timers.push(setTimeout(() => {
          setStep(i);
          if (isFinal) playFall();
          else if (isHang) playDrumroll((schedule[n - 1] ?? 1200) / 1000);
          else playSwing(i / Math.max(1, n - 1), towardMe(lean));
        }, at));
      });

      const impactAt = at + FALL_MS;
      timers.push(setTimeout(() => { setImpact(true); playImpact(); }, impactAt));
      timers.push(setTimeout(() => {
        if (outcome === "win")  playWin();
        if (outcome === "lose") playLose();
      }, impactAt + STING_AFTER_IMPACT_MS));
      timers.push(setTimeout(() => setPhase("result"), impactAt + SETTLE_AFTER_IMPACT_MS));

      return () => timers.forEach(clearTimeout);
    }

    setPhase(status >= 2 ? "result" : "idle");
    // `outcome`/`mySide` are intentionally not dependencies: they are
    // read at the moment of transition, and re-running this on a change
    // would replay the reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const onRevealRef = useRef(onRevealChange);
  onRevealRef.current = onRevealChange;
  useLayoutEffect(() => {
    const revealing = phase === "reveal";
    onRevealRef.current?.(revealing);
    // Unmounting mid-reveal must release the page, not leave it gated.
    return revealing ? () => onRevealRef.current?.(false) : undefined;
  }, [phase]);

  const rolling = phase === "rolling";
  const reveal  = phase === "reveal";
  const heat    = useHeat(rolling);
  const beat    = useHeartbeat(rolling);
  const scramble = useScramble(rolling, heat);

  const n = pathRef.current.length;
  const hanging = reveal && step === n - 2;
  const falling = reveal && step === n - 1;

  // Marker position, -100 (A) .. +100 (B).  Dead centre until the seed
  // exists — before that nothing is known.
  const lean =
    reveal && step >= 0 ? (pathRef.current[step] ?? 0)
    : phase === "result" && witnessed && winnerSide ? (winnerSide === "a" ? -100 : 100)
    : 0;
  const settled = phase === "result" && witnessed && winnerSide !== null;
  const landed = (reveal && impact) || settled;
  // Which side the marker is leaning toward RIGHT NOW.
  const leading: "a" | "b" | null = lean < -12 ? "a" : lean > 12 ? "b" : null;

  const sideClass = (side: "a" | "b") => {
    if (rolling) return side === "a" ? "clash-tremble-a" : "clash-tremble-b";
    if (reveal && impact) return side === winnerSide ? "clash-victor" : "clash-fallen";
    if (hanging || falling) return "clash-brace";
    // Near the centre nobody is ahead, so nobody is dimmed either.
    if (reveal) return leading === null ? "" : leading === side ? "clash-ahead" : "clash-behind";
    if (settled) return side === winnerSide ? "clash-victor" : "clash-fallen";
    return "";
  };

  // Colour of the moment: gold for the viewer's win, red for their
  // loss, gold for a spectator.
  const hitColor = outcome === "lose" ? "#FF3355" : "#FFD700";

  const centreColor =
    rolling ? "#FF00FF" :
    hanging ? "#FFFFFF" :
    reveal || status >= 2 ? "#FFD700" : "#4a4a8a";

  const stamp = outcome === "win" ? winText : outcome === "lose" ? loseText : undefined;
  const cleanStamp = stamp?.replace(/\*/g, "").trim();

  return (
    <div
      className={`clash-stage ${impact && reveal ? "clash-shake" : ""} ${hanging ? "clash-holding" : ""}`}
      // Every rolling animation reads its tempo and amplitude from this
      // one value, so the whole scene tightens together.
      style={{ ["--heat" as string]: heat.toFixed(3), ["--hit" as string]: hitColor }}
    >
      {/* Heartbeat glow — restarted on every beat by the key. */}
      {rolling && <span key={beat} className="clash-beat" aria-hidden="true" />}

      {/* Impact layers: one flash, one shockwave, confetti on a win. */}
      {reveal && impact && (
        <>
          <span className="clash-flash" aria-hidden="true" />
          {outcome === "win" && (
            <div className="clash-confetti" aria-hidden="true">
              {Array.from({ length: CONFETTI }).map((_, i) => (
                <span
                  key={i}
                  style={{
                    ["--x" as string]: `${(i * 37) % 100}%`,
                    ["--d" as string]: `${(i % 7) * 0.06}s`,
                    ["--c" as string]: ["#FFD700", "#00FF88", "#FF00FF", "#00FFFF"][i % 4],
                    ["--r" as string]: `${(i * 53) % 360}deg`,
                  }}
                />
              ))}
            </div>
          )}
          {cleanStamp && <div className="clash-stamp font-pixel">{cleanStamp}</div>}
        </>
      )}

      <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4 relative">
        <div className={`text-center min-w-0 clash-side ${sideClass("a")}`}>{left}</div>

        <div className="flex flex-col items-center flex-shrink-0 relative">
          {reveal && impact && (
            <>
              <span className="clash-ring" aria-hidden="true" />
              <div className="clash-sparks" aria-hidden="true">
                {Array.from({ length: SPARKS }).map((_, i) => (
                  <span
                    key={i}
                    className="clash-spark"
                    style={{ ["--a" as string]: `${(360 / SPARKS) * i}deg` }}
                  />
                ))}
              </div>
            </>
          )}

          <div
            key={rolling ? `vs-${beat}` : "vs"}
            className={`font-pixel animate-glow ${rolling ? "clash-vs-beat" : ""} ${reveal && impact ? "clash-vs-hit" : ""}`}
            style={{ fontSize: 20, color: centreColor }}
          >
            {vsLabel}
          </div>

          {rolling && (
            <>
              <div className="animate-blink text-retro-magenta mt-1 text-center" style={{ fontSize: 11 }}>
                {rollingLabel}
              </div>
              <div className="clash-die mt-1" aria-hidden="true">
                <span className="clash-die-face">{scramble.slice(0, 4)}</span>
              </div>
            </>
          )}

          {/* The tug-of-war.  Every position on this bar comes from the
              seed's own bits, so a swing to your side is a real fact
              about the random number — not a staged tease. */}
          {(reveal || settled) && (
            <div className="mt-2 flex flex-col items-center">
              <div className={`clash-tug ${hanging ? "clash-tug-hot" : ""}`} aria-hidden="true">
                <span className="clash-tug-mid" />
                <span
                  className={`clash-tug-mark ${hanging ? "clash-tug-hover" : ""} ${falling || settled ? "clash-tug-lock" : ""} ${landed ? "clash-tug-landed" : ""}`}
                  style={{
                    ["--lean" as string]: String(lean),
                    ["--mark" as string]:
                      leading && mySide ? (leading === mySide ? "#FFD700" : "#00CCFF") : "#FFD700",
                  }}
                />
              </div>
              {mySide && youLabel && (
                <div className="clash-tug-labels" aria-hidden="true">
                  <span style={{ visibility: mySide === "a" ? "visible" : "hidden" }}>{youLabel}</span>
                  <span style={{ visibility: mySide === "b" ? "visible" : "hidden" }}>{youLabel}</span>
                </div>
              )}
            </div>
          )}

          {settled && seed && (
            <div className="mt-1 text-center clash-seed" style={{ fontSize: 9, color: "#00FF88" }}>
              {String(seed).slice(0, 12)}
            </div>
          )}
        </div>

        <div className={`text-center min-w-0 clash-side ${sideClass("b")}`}>{right}</div>
      </div>
    </div>
  );
}
