// ============================================================
// src/hooks/useHeartbeat.ts — SEC-28
// ============================================================
//
// The heartbeat under a VRF wait (1v1 and Battle Royale).  Returns a
// counter that bumps once per beat — use it as a React key to restart a
// CSS pulse — and plays the thump on the same clock, so the glow and
// the sound never drift apart.
//
// Calm at the start, racing by HEAT_RAMP_S.  The wait has no known
// length (it is however long the relayer takes to land the VRF), so the
// tempo ramps and then saturates instead of aiming at a finish line.
// ============================================================

import { useEffect, useState } from "react";
import { playHeartbeat } from "../lib/sfx";

export const HEAT_RAMP_S  = 8;
const BEAT_SLOW_MS = 900;
const BEAT_FAST_MS = 430;

export function useHeartbeat(active: boolean): number {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const t0 = Date.now();
    const tick = () => {
      if (!alive) return;
      const h = Math.min(1, (Date.now() - t0) / 1000 / HEAT_RAMP_S);
      setBeat((b) => b + 1);
      playHeartbeat(h);
      timer = setTimeout(tick, BEAT_SLOW_MS - h * (BEAT_SLOW_MS - BEAT_FAST_MS));
    };
    timer = setTimeout(tick, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [active]);
  return beat;
}
