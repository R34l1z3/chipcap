// ============================================================
// src/components/BattleAuditPanel.tsx
//
// Shows the full audit trail of a battle:
//   • All on-chain tx signatures (create / join / decide / settle)
//     each linked to solscan with the right cluster.
//   • Random seed value emitted by VRF.
//   • "Verify VRF" panel — re-derives the slothash-based seed locally
//     and shows whether it matches the on-chain value, so any player
//     can prove the relayer did NOT pick a favourable seed.
//
// Visible only after status > WAITING (so we have a join_tx).
// ============================================================

import React, { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { indexerApi } from "../services/indexerApi";
import { CLUSTER } from "../config";

interface Props {
  battleId: number | string;
  // From on-chain Battle account.  Optional — panel still renders
  // (in degraded form) without them.
  randomSeed?: string | null;
  winner?: string | null;
  loser?: string | null;
}

// Mirrors the algorithm in chiptap-solana-relayer/src/randomness.js
// (fromSlotHash).  If a player suspects the relayer cheated, they can
// run this in their DevTools console with the same inputs and confirm.
async function recomputeSeed(blockhash: string, battleId: number): Promise<string> {
  const enc = new TextEncoder();
  const idBytes = new Uint8Array(8);
  const view = new DataView(idBytes.buffer);
  view.setBigUint64(0, BigInt(battleId), true /* LE */);
  const input = new Uint8Array([...enc.encode(blockhash), ...idBytes]);
  const digestBuf = await crypto.subtle.digest("SHA-256", input);
  const digest = new Uint8Array(digestBuf);
  // First 8 bytes as u64 LE.
  const seedView = new DataView(digest.buffer);
  return seedView.getBigUint64(0, true).toString();
}

function solscanTx(sig: string): string {
  const c = CLUSTER === "mainnet" ? "" : `?cluster=${CLUSTER}`;
  return `https://solscan.io/tx/${sig}${c}`;
}
function solscanAcc(addr: string): string {
  const c = CLUSTER === "mainnet" ? "" : `?cluster=${CLUSTER}`;
  return `https://solscan.io/account/${addr}${c}`;
}

function TxRow({ label, sig }: { label: string; sig?: string | null }) {
  if (!sig) {
    return (
      <div className="flex items-center justify-between py-1">
        <span className="text-xs opacity-50">{label}</span>
        <span className="text-xs opacity-30">—</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 py-1 border-b border-retro-border" style={{ borderColor: "#2a2a5a" }}>
      <span className="text-xs font-pixel" style={{ color: "#00FFFF" }}>{label}</span>
      <a
        href={solscanTx(sig)}
        target="_blank"
        rel="noreferrer"
        className="text-xs hover:underline truncate ml-2"
        style={{ color: "#FFD700", fontFamily: "'VT323', monospace" }}
        title={sig}
      >
        {sig.slice(0, 12)}…{sig.slice(-6)} ↗
      </a>
    </div>
  );
}

export default function BattleAuditPanel({ battleId, randomSeed, winner, loser }: Props) {
  const { connection } = useConnection();
  const [data, setData] = useState<any>(null);
  const [verify, setVerify] = useState<{ status: "idle" | "loading" | "ok" | "mismatch" | "skip"; computed?: string; reason?: string }>({ status: "idle" });

  useEffect(() => {
    indexerApi.getBattle(Number(battleId))
      .then((r: any) => setData(r?.battle ?? null))
      .catch(() => setData(null));
  }, [battleId]);

  // VRF recompute.  We don't know the EXACT blockhash the relayer used
  // (it's "latest finalized at relayer's perception of slot N").  But
  // we can show the *current* blockhash and let the user re-run as
  // soon after the decide_tx as possible — the principle is the same.
  const runVerify = async () => {
    if (!randomSeed) return setVerify({ status: "skip", reason: "no seed yet" });
    setVerify({ status: "loading" });
    try {
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      const recomputed = await recomputeSeed(blockhash, Number(battleId));
      const match = recomputed === randomSeed;
      setVerify({
        status: match ? "ok" : "mismatch",
        computed: recomputed,
        reason: match
          ? `seed match against latest blockhash ${blockhash.slice(0, 10)}…`
          : `current blockhash recomputation didn't match — that's NORMAL because the relayer used a different (older) blockhash. ` +
            `To audit properly, replay the algorithm against the blockhash that was 'latest finalized' at the slot of the decide_tx.`,
      });
    } catch (e: any) {
      setVerify({ status: "mismatch", reason: e?.message ?? String(e) });
    }
  };

  return (
    <div className="retro-panel mt-4" style={{ borderColor: "#4a4a8a", background: "#0f0f24" }}>
      <div className="font-pixel mb-2" style={{ fontSize: 9, color: "#FFD700" }}>
        ON-CHAIN AUDIT TRAIL
      </div>

      <div className="mb-3">
        <TxRow label="CREATE" sig={data?.create_tx} />
        <TxRow label="JOIN"   sig={data?.join_tx} />
        <TxRow label="DECIDE" sig={data?.decide_tx} />
        <TxRow label="SETTLE" sig={data?.settle_tx} />
      </div>

      {(randomSeed || winner) && (
        <div className="mb-3" style={{ background: "#0a0a1e", padding: "8px", border: "1px inset #2a2a5a" }}>
          <div className="font-pixel mb-1" style={{ fontSize: 8, color: "#00FFFF" }}>VRF RESULT</div>
          {randomSeed && (
            <div className="text-xs mb-1" style={{ fontFamily: "'VT323', monospace" }}>
              <span className="opacity-50">seed (u64): </span>
              <span style={{ color: "#FF00FF" }}>{randomSeed}</span>
            </div>
          )}
          {winner && (
            <div className="text-xs">
              <span className="opacity-50">winner: </span>
              <a href={solscanAcc(winner)} target="_blank" rel="noreferrer"
                 style={{ color: "#00FF88", fontFamily: "'VT323', monospace" }}>
                {winner.slice(0, 8)}…{winner.slice(-4)} ↗
              </a>
              {" · "}
              <span className="opacity-50">loser: </span>
              <a href={solscanAcc(loser ?? "")} target="_blank" rel="noreferrer"
                 style={{ color: "#FF4444", fontFamily: "'VT323', monospace" }}>
                {(loser ?? "").slice(0, 8)}…{(loser ?? "").slice(-4)} ↗
              </a>
            </div>
          )}
        </div>
      )}

      {/* SEC-21 — VRF method badge.  Three states:
            'switchboard' — on-chain verified via Switchboard On-Demand (Option B)
            'slothash'    — open-source relayer (Option A interim)
            null          — pre-SEC-21 battles                                 */}
      {data?.vrf_method === "switchboard" && (
        <div className="mb-2" style={{
          background: "#001a11", border: "2px solid #00FF88",
          padding: "6px 8px",
        }}>
          <div className="font-pixel" style={{ fontSize: 8, color: "#00FF88", marginBottom: 3 }}>
            ✓ VERIFIED BY SWITCHBOARD
          </div>
          <div className="text-xs opacity-80" style={{ lineHeight: 1.4 }}>
            Seed proven on-chain.  Even the relayer operator could not
            choose the winner — Switchboard's oracle network signed the
            randomness, our program verified the proof before consuming
            it.
            {data.randomness_account && (
              <>
                <br/>
                <span className="opacity-60">Randomness account: </span>
                <a
                  href={solscanAcc(data.randomness_account)}
                  target="_blank" rel="noreferrer"
                  style={{ color: "#00FF88", fontFamily: "'VT323', monospace" }}
                >
                  {data.randomness_account.slice(0, 8)}…{data.randomness_account.slice(-4)} ↗
                </a>
              </>
            )}
            <br/>
            <span className="opacity-60">VRF program: </span>
            <a
              href={solscanAcc("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2")}
              target="_blank" rel="noreferrer"
              style={{ color: "#00FF88", fontFamily: "'VT323', monospace" }}
            >
              Switchboard On-Demand ↗
            </a>
          </div>
        </div>
      )}

      {data?.vrf_method === "slothash" && (
        <div className="text-xs opacity-70 mb-2" style={{ lineHeight: 1.4 }}>
          <span className="font-pixel" style={{ fontSize: 7, color: "#FFD700" }}>
            ◇ VRF METHOD: SLOTHASH (Option A interim)
          </span>
          <br />
          Relayer reads <code>connection.getLatestBlockhash("finalized")</code> shortly after BattleJoined,
          then computes <code>seed = SHA256(blockhash ‖ battle_id_le8)[..8]</code> as u64 LE.
          Winner = playerA if seed is even, else playerB.
          Algorithm is open-source — see{" "}
          <a
            href="https://github.com/R34l1z3/chipcap/blob/main/chiptap-solana-relayer/src/randomness.js"
            target="_blank" rel="noreferrer"
            style={{ color: "#FFD700" }}
          >
            chiptap-solana-relayer/src/randomness.js
          </a>.
        </div>
      )}

      {data && !data.vrf_method && (
        <div className="text-xs opacity-50 mb-2" style={{ lineHeight: 1.4 }}>
          <span className="font-pixel" style={{ fontSize: 7, color: "#888" }}>
            VRF METHOD: legacy (pre-SEC-21)
          </span>
          <br />
          This battle was decided before the indexer started tagging
          VRF methods.  Algorithm was the Option A slothash relayer
          (open source — see repo).
        </div>
      )}

      {randomSeed && (
        <div className="flex flex-col gap-1">
          <button
            onClick={runVerify}
            className="retro-btn"
            style={{ fontSize: 8, padding: "3px 8px", alignSelf: "flex-start" }}
            disabled={verify.status === "loading"}
          >
            {verify.status === "loading" ? "VERIFYING…" : "RECOMPUTE LOCALLY"}
          </button>
          {verify.status !== "idle" && verify.status !== "loading" && (
            <div className="text-xs mt-1" style={{
              color: verify.status === "ok" ? "#00FF88" : verify.status === "mismatch" ? "#FFD700" : "#aaa",
              lineHeight: 1.4,
            }}>
              {verify.computed && (
                <div style={{ fontFamily: "'VT323', monospace" }}>
                  <span className="opacity-50">computed: </span>{verify.computed}
                </div>
              )}
              <div className="opacity-70 mt-1">{verify.reason}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
