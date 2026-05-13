// Cached read of the singleton ArenaConfig PDA — pool prices, fee bps, etc.
import { useCallback, useEffect, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useArenaProgram } from "./useArenaProgram";
import * as pda from "../lib/pda";

export interface ArenaConfigView {
  feeBps:           number;
  paused:           boolean;
  poolAmounts:      BN[];
  decisionTimeout:  number;
  joinTimeout:      number;
  vrfTimeout:       number;
  nextBattleId:     BN;
}

export function useArenaConfig() {
  const program = useArenaProgram();
  const [data, setData] = useState<ArenaConfigView | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!program) { setData(null); return; }
    setLoading(true);
    try {
      const acc = await (program.account as any).arenaConfig.fetchNullable(pda.arenaConfig());
      if (acc) {
        setData({
          feeBps:           acc.feeBps,
          paused:           acc.paused,
          poolAmounts:      acc.poolAmounts as BN[],
          decisionTimeout:  Number(acc.decisionTimeout?.toString?.() ?? acc.decisionTimeout),
          joinTimeout:      Number(acc.joinTimeout?.toString?.() ?? acc.joinTimeout),
          vrfTimeout:       Number(acc.vrfTimeout?.toString?.() ?? acc.vrfTimeout),
          nextBattleId:     acc.nextBattleId,
        });
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => { refetch(); }, [refetch]);

  return { data, loading, refetch };
}
