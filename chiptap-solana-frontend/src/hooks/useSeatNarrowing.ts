// ============================================================
// src/hooks/useSeatNarrowing.ts — SEC-28, Battle Royale reveal
// ============================================================
//
// A Battle Royale is decided by ONE number: winner = players[seed % n].
// On chain that is instantaneous, so the most dramatic moment in the
// game — being one of the last seats standing — never actually gets
// shown to anyone.
//
// This unfolds the same result as an elimination: seats go dark one by
// one until the real winner is the last lit. Unlike a 1v1 coin flip,
// the tension here is NOT manufactured — with 8 seats you genuinely
// survive several eliminations before losing, and "I was in the last
// two" is a true statement about a real multi-seat draw.
//
// The ORDER is a deterministic function of the seed (a Fisher-Yates
// shuffle driven by its bits), so anyone holding the seed can recompute
// the exact sequence they watched. The ordering never touches who wins:
// the survivor is always the real winner, whatever the bits say.
// ============================================================

import { useLayoutEffect, useRef, useState } from "react";
import { playTick, playSuspense } from "../lib/sfx";

/** Pause before the FINAL elimination — the last-two beat. */
const FINAL_GAP_MS = 1200;
const FIRST_GAP_MS = 700;
const MIN_GAP_MS   = 300;
const SETTLE_MS    = 700;

/**
 * Deterministic elimination order for every seat except the winner.
 * Same seed in, same order out — that is what makes it checkable
 * rather than theatre.
 */
export function eliminationOrder(
  seed: string | null | undefined,
  winnerSlot: number,
  seatCount: number,
): number[] {
  const pool: number[] = [];
  for (let i = 0; i < seatCount; i++) if (i !== winnerSlot) pool.push(i);

  let s: bigint;
  try { s = BigInt(seed ?? "0"); } catch { s = 0n; }
  if (s < 0n) s = -s;
  if (s === 0n) return pool;                    // no seed yet: stable order

  for (let i = pool.length - 1; i > 0; i--) {
    const chunk = Number((s >> BigInt(3 + i * 4)) & 15n);
    const j = chunk % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export interface SeatNarrowing {
  /** Seats already knocked out, in play order. */
  eliminated: Set<number>;
  /** True while the sequence is running — the page holds back anything
   *  that names the winner until this goes false. */
  running: boolean;
  /** True once it has played to the end this session. */
  played: boolean;
}

export function useSeatNarrowing(
  /** Royale status, or null while the account can't be read. */
  status: number | null,
  seed: string | null | undefined,
  winnerSlot: number | null,
  seatCount: number,
): SeatNarrowing {
  const prevStatus = useRef<number | null>(null);
  const [eliminated, setEliminated] = useState<number[]>([]);
  const [running, setRunning] = useState(false);
  const [played, setPlayed] = useState(false);

  // Read at the moment of transition only.  Keeping them out of the
  // effect's deps means a re-derived value mid-sequence can't cancel it.
  const inputs = useRef({ seed, winnerSlot, seatCount });
  inputs.current = { seed, winnerSlot, seatCount };

  // Layout effect: `running` must be true before the first paint of the
  // decided state, or the winner banner flashes for a frame.
  useLayoutEffect(() => {
    // An unreadable account is "unknown", not a new status — ignore it
    // rather than let it look like (or interrupt) a transition.
    if (status == null) return;
    const prev = prevStatus.current;
    prevStatus.current = status;

    // Only for a resolution this component actually watched — opening a
    // finished royale from history must not stage an elimination that
    // already happened.
    if (!(prev === 1 && status >= 2)) return;
    const { seed: s, winnerSlot: w, seatCount: n } = inputs.current;
    if (w == null || n < 2) return;

    const order = eliminationOrder(s, w, n);
    setEliminated([]);
    setRunning(true);

    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    order.forEach((slot, i) => {
      const isLast = i === order.length - 1;
      // Quickens as the field thins, then holds before the last one:
      // the moment when only you and one other are lit.
      at += isLast
        ? FINAL_GAP_MS
        : Math.max(MIN_GAP_MS, FIRST_GAP_MS - i * 70);
      timers.push(setTimeout(() => {
        setEliminated((prevE) => [...prevE, slot]);
        if (isLast) playSuspense();
        else playTick(i / Math.max(1, order.length - 1));
      }, at));
    });

    timers.push(setTimeout(() => {
      setRunning(false);
      setPlayed(true);
    }, at + SETTLE_MS));

    return () => {
      timers.forEach(clearTimeout);
      // Interrupted (status moved on — e.g. SETTLED after a prize claim —
      // or unmount): land on the end state instead of freezing half-way.
      setEliminated(order);
      setRunning(false);
      setPlayed(true);
    };
  }, [status]);

  return { eliminated: new Set(eliminated), running, played };
}
