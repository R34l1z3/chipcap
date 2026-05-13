// ============================================================
// src/hooks/useBattles.ts
//
// Thin re-export of useIndexerBattles for backwards compatibility.
// All pages now use the unified indexer-backed hook.
// ============================================================

export { useIndexerBattles as useBattles } from "./useIndexerBattles";
export type { BattleData } from "./useIndexerBattles";
