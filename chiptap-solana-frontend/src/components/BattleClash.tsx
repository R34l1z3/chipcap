// ============================================================
// src/components/BattleClash.tsx — SEC-28
//
// The fight scene for a 1v1 battle.  Wraps the two chip cards and
// owns the motion between them:
//
//   status 0 (WAITING)  — static VS, nothing moving
//   status 1 (ROLLING)  — chips tremble, a VRF die spins and scrambles
//                         digits: the wait for randomness becomes the
//                         suspense beat instead of dead air
//   1 -> 2 transition   — tug-of-war reveal: the seed is unfolded into
//                         a run of swings (see pathFromSeed), the last
//                         one lands on the real winner, then the seed
//                         is shown and the sting plays
//   status >= 2 on mount — result state with NO replay
//
// That last rule matters: opening a finished battle from history must
// not stage a fight that already happened.  We only animate a
// transition this component actually witnessed, tracked via prevStatus.
//
// Deliberately zero assets — pure CSS/SVG, so the bundle stays flat.
// CLAUDE.md's perf note warns that sprite art could double it; the
// retro look is cheaper to draw than to download anyway.
//
// Motion is fully disabled under `prefers-reduced-motion` (see
// index.css) — the end state stays correct, only the movement stops.
// ============================================================

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { playWin, playLose, playSuspense, playTick } from "../lib/sfx";

type Phase = "idle" | "rolling" | "reveal" | "result";

const SPARKS = 10;

/**
 * Step schedules for the reveal, in ms.  All three read the SAME path
 * out of the seed — only the pacing differs, so switching profile
 * changes how the moment feels without changing what is shown.
 *
 * The last gap in each is deliberately the longest: the beat of
 * stillness before the deciding swing is where the tension sits.
 */
export const REVEAL_PROFILES = {
  /** Quick and clean — 4 swings, ~1.7 s. */
  short: [420, 360, 320, 620],
  /** Accelerating, one held beat — 6 swings, ~2.7 s. */
  build: [520, 440, 380, 330, 300, 700],
  /** Drawn out, two pauses — 8 swings, ~4.2 s. */
  long:  [560, 500, 440, 400, 700, 320, 300, 900],
} as const;

export type RevealProfile = keyof typeof REVEAL_PROFILES;

const SETTLE_MS = 900;
/**
 * Seconds for the roll to reach full intensity.  The wait is NOT a
 * fixed length — it depends on how fast the relayer gets the VRF back —
 * so the build-up ramps and then SATURATES instead of targeting a
 * finish line it cannot know.  A 4-second wait feels snappy, a
 * 40-second one stays at a boil rather than looking stuck.
 */
const HEAT_RAMP_S = 8;

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
 * This is the honest way to make a coin flip feel like a contest.  The
 * program decides the winner with the LOWEST bit (`seed % 2`), so that
 * bit — and only that bit — sets the final position.  The intermediate
 * swings are read off HIGHER bits, which decide nothing on chain.  So
 * every "you were ahead" moment on screen is a real property of the
 * real random number, recomputable by anyone holding the seed.
 *
 * What this is NOT: a slot-machine near-miss, where the reel is
 * weighted to stop just short of a win.  Nothing here is engineered to
 * land close; the path simply is what the bits say.  For a game whose
 * whole pitch is provable fairness, that distinction is the product.
 */
export function pathFromSeed(seed: string | null | undefined, steps: number): number[] {
  let s: bigint;
  try { s = BigInt(seed ?? "0"); } catch { s = 0n; }
  if (s < 0n) s = -s;

  const finalLeansB = (s & 1n) === 1n;
  const path: number[] = [];

  for (let i = 0; i < steps - 1; i++) {
    // 5 fresh bits per step, taken above the deciding bit.
    const chunk = Number((s >> BigInt(1 + i * 5)) & 31n);      // 0..31
    const lean  = Math.round(((chunk / 31) * 2 - 1) * 82);     // -82..82
    path.push(lean);
  }
  // The deciding bit lands last, and it lands all the way.
  path.push(finalLeansB ? 100 : -100);
  return path;
}

/**
 * 0..1 build-up while rolling.  Drives every motion parameter through a
 * single CSS custom property, so the whole scene tightens together
 * rather than each element having its own unrelated tempo.
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
  outcome = "neutral", profile = "build", onRevealChange,
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
  const pathRef = useRef<number[]>([]);

  // Layout effects throughout: the reveal must start — and the page must
  // hear about it — before the first paint of the decided state, or the
  // result banner flashes for a frame.
  useLayoutEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (status === 1) { setPhase("rolling"); return; }

    // The one moment worth animating: a roll we were watching resolved.
    //
    // Instead of collapsing the answer into a single frame, the seed is
    // unfolded step by step.  The marker really does swing to your side
    // and back — that is the seed's own bits, not theatre — and the
    // long beat before the last swing is where the tension sits.
    if (prev === 1 && status >= 2) {
      setWitnessed(true);
      setPhase("reveal");

      const schedule = REVEAL_PROFILES[profile] ?? REVEAL_PROFILES.build;
      const path = pathFromSeed(seed, schedule.length);
      pathRef.current = path;
      setStep(-1);

      const timers: ReturnType<typeof setTimeout>[] = [];
      let at = 0;
      path.forEach((_, i) => {
        at += schedule[i] ?? 350;
        timers.push(setTimeout(() => {
          setStep(i);
          // Pitch climbs with each swing; the final one is the payoff.
          if (i < path.length - 1) playTick(i / (path.length - 1));
          else playSuspense();
        }, at));
      });

      timers.push(setTimeout(() => {
        setPhase("result");
        if (outcome === "win")  playWin();
        if (outcome === "lose") playLose();
      }, at + SETTLE_MS));

      return () => timers.forEach(clearTimeout);
    }

    setPhase(status >= 2 ? "result" : "idle");
    // `outcome` is intentionally not a dependency: it is read only at
    // the moment of transition, and re-running this on an outcome
    // change would replay the sting.
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
  const scramble = useScramble(rolling, heat);

  // Marker position, -100 (A) .. +100 (B).  Dead centre until the seed
  // exists — before that nothing is known, and pretending otherwise
  // would be the one dishonest thing available here.
  const lean =
    reveal && step >= 0 ? (pathRef.current[step] ?? 0)
    : phase === "result" && witnessed && winnerSide ? (winnerSide === "a" ? -100 : 100)
    : 0;
  const settled = phase === "result" && witnessed && winnerSide !== null;
  // Which side the marker is leaning toward RIGHT NOW — drives the
  // "you're ahead" flare that makes the swing feel like a contest.
  const leading: "a" | "b" | null = lean < -12 ? "a" : lean > 12 ? "b" : null;

  const sideClass = (side: "a" | "b") => {
    if (rolling) return side === "a" ? "clash-tremble-a" : "clash-tremble-b";
    // Near the centre nobody is ahead, so nobody is dimmed either.
    if (reveal)  return leading === null ? "" : leading === side ? "clash-ahead" : "clash-behind";
    if (settled) return side === winnerSide ? "clash-victor" : "clash-fallen";
    return "";
  };

  const centreColor =
    rolling ? "#FF00FF" :
    reveal  ? "#FFD700" :
    status >= 2 ? "#FFD700" : "#4a4a8a";

  const lastStep = reveal && step === pathRef.current.length - 1;

  return (
    <div
      className={`clash-stage ${lastStep ? "clash-shake" : ""}`}
      // Every rolling animation reads its tempo and amplitude from this
      // one value, so the whole scene tightens together.
      style={{ ["--heat" as string]: heat.toFixed(3) }}
    >
      <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4">
        <div className={`text-center min-w-0 clash-side ${sideClass("a")}`}>{left}</div>

        <div className="flex flex-col items-center flex-shrink-0 relative">
          {/* Sparks only on the final swing — the one that decides. */}
          {lastStep && (
            <div className="clash-sparks" aria-hidden="true">
              {Array.from({ length: SPARKS }).map((_, i) => (
                <span
                  key={i}
                  className="clash-spark"
                  style={{ ["--a" as string]: `${(360 / SPARKS) * i}deg` }}
                />
              ))}
            </div>
          )}

          <div
            className={`font-pixel animate-glow ${lastStep ? "clash-vs-hit" : ""}`}
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
            <div className="clash-tug mt-2" aria-hidden="true">
              <span className="clash-tug-mid" />
              <span
                className={`clash-tug-mark ${lastStep || settled ? "clash-tug-lock" : ""}`}
                style={{ ["--lean" as string]: String(lean) }}
              />
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
