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
//   1 -> 2 transition   — one-shot clash: the chips lunge, the panel
//                         shakes, sparks burst, then the real VRF seed
//                         snaps into place and the winner pops
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

import React, { useEffect, useRef, useState } from "react";
import { playWin, playLose } from "../lib/sfx";

type Phase = "idle" | "rolling" | "impact" | "result";

const IMPACT_MS = 1500;
const SPARKS = 10;

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
}

/** Scrambling digits while randomness is pending. */
function useScramble(active: boolean) {
  const [val, setVal] = useState("00000000");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      let s = "";
      for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 10);
      setVal(s);
    }, 80);
    return () => clearInterval(id);
  }, [active]);
  return val;
}

export default function BattleClash({
  status, winnerSide, left, right, vsLabel, rollingLabel, seed,
  outcome = "neutral",
}: BattleClashProps) {
  const prevStatus = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>(() =>
    status === 1 ? "rolling" : status >= 2 ? "result" : "idle",
  );
  // True only when this component watched the roll resolve, which is
  // what gates the winner/loser flourish.
  const [witnessed, setWitnessed] = useState(false);

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (status === 1) { setPhase("rolling"); return; }

    // The one moment worth animating: a roll we were watching resolved.
    if (prev === 1 && status >= 2) {
      setWitnessed(true);
      setPhase("impact");
      const id = setTimeout(() => {
        setPhase("result");
        // Sting lands with the reveal, not with the punch — the seed
        // settling is the emotional beat.  No-op while SFX are muted,
        // which is the default.
        if (outcome === "win")  playWin();
        if (outcome === "lose") playLose();
      }, IMPACT_MS);
      return () => clearTimeout(id);
    }

    setPhase(status >= 2 ? "result" : "idle");
    // `outcome` is intentionally not a dependency: it is read only at
    // the moment of transition, and re-running this on an outcome
    // change would replay the sting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const rolling = phase === "rolling";
  const impact  = phase === "impact";
  const scramble = useScramble(rolling || impact);

  const sideClass = (side: "a" | "b") => {
    if (rolling) return side === "a" ? "clash-tremble-a" : "clash-tremble-b";
    if (impact)  return side === "a" ? "clash-lunge-a"   : "clash-lunge-b";
    if (phase === "result" && witnessed && winnerSide) {
      return side === winnerSide ? "clash-victor" : "clash-fallen";
    }
    return "";
  };

  const centreColor =
    rolling || impact ? "#FF00FF" :
    status >= 2       ? "#FFD700" : "#4a4a8a";

  return (
    <div className={`clash-stage ${impact ? "clash-shake" : ""}`}>
      <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4">
        <div className={`text-center min-w-0 ${sideClass("a")}`}>{left}</div>

        <div className="flex flex-col items-center flex-shrink-0 relative">
          {/* Spark burst — only exists during the impact beat. */}
          {impact && (
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
            className={`font-pixel animate-glow ${impact ? "clash-vs-hit" : ""}`}
            style={{ fontSize: 20, color: centreColor }}
          >
            {vsLabel}
          </div>

          {rolling && (
            <>
              <div className="animate-blink text-retro-magenta mt-1 text-center" style={{ fontSize: 11 }}>
                {rollingLabel}
              </div>
              {/* The die: a spinning square whose digits keep changing,
                  so the VRF wait reads as "randomness in flight". */}
              <div className="clash-die mt-1" aria-hidden="true">
                <span className="clash-die-face">{scramble.slice(0, 4)}</span>
              </div>
            </>
          )}

          {/* Seed reveal: scrambled during the hit, real value after. */}
          {(impact || (phase === "result" && witnessed && seed)) && (
            <div
              className="mt-1 text-center clash-seed"
              style={{ fontSize: 9, color: impact ? "#FF00FF" : "#00FF88" }}
            >
              {impact ? scramble : String(seed).slice(0, 12)}
            </div>
          )}
        </div>

        <div className={`text-center min-w-0 ${sideClass("b")}`}>{right}</div>
      </div>
    </div>
  );
}
