// ============================================================
// src/App.tsx — shell + tab routing.
// Real page bodies will land in the next iteration; for now we
// stub them so the build is clean and you can wire wallets.
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import RetroHeader from "./components/RetroHeader";
import NotificationToast from "./components/NotificationToast";
import IndexerStatus from "./components/IndexerStatus";
import BootDiagnostics from "./components/BootDiagnostics";
import HelpModal, { HELP_SEEN_KEY } from "./components/HelpModal";

import MintPage from "./pages/MintPage";
import InventoryPage from "./pages/InventoryPage";
import BattlePage from "./pages/BattlePage";
import BattleRoyalePage from "./pages/BattleRoyalePage";
import TournamentPage from "./pages/TournamentPage";
import HistoryPage from "./pages/HistoryPage";
import LeaderboardPage from "./pages/LeaderboardPage";
import ProfilePage from "./pages/ProfilePage";

type Tab = "mint" | "inventory" | "battle" | "royale" | "tournament" | "history" | "leaderboard" | "profile";

export default function App() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("mint");
  const [viewedPlayer, setViewedPlayer] = useState<string | null>(null);
  // Deep-link from HistoryPage / LeaderboardPage row clicks into the
  // BattlePage's "watch" view.  Consumed once on mount of BattlePage.
  const [watchBattleId, setWatchBattleId] = useState<number | null>(null);
  // SEC-22 — analogous deep-link for Battle Royale page.
  const [watchRoyaleId, setWatchRoyaleId] = useState<number | null>(null);
  // SEC-23 — same for Tournaments.
  const [watchTournamentId, setWatchTournamentId] = useState<number | null>(null);

  // How-to-play modal.  Auto-opens once on a visitor's first ever load
  // (localStorage gate), and on demand from the header's "?" button.
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(HELP_SEEN_KEY) === "1"; } catch { /* private mode */ }
    if (!seen) {
      setHelpOpen(true);
      try { localStorage.setItem(HELP_SEEN_KEY, "1"); } catch { /* ignore */ }
    }
  }, []);

  const openProfile = useCallback((address: string | null) => {
    setViewedPlayer(address);
    setTab("profile");
  }, []);

  const goLeaderboard = useCallback(() => {
    setViewedPlayer(null);
    setTab("leaderboard");
  }, []);

  const openBattle = useCallback((id: number) => {
    setWatchBattleId(id);
    setTab("battle");
  }, []);

  const handleSetTab = useCallback((t: Tab) => {
    if (t !== "profile")    setViewedPlayer(null);
    if (t !== "battle")     setWatchBattleId(null);
    if (t !== "royale")     setWatchRoyaleId(null);
    if (t !== "tournament") setWatchTournamentId(null);
    setTab(t);
  }, []);

  return (
    <div className="flex flex-col h-screen stars-bg">
      <RetroHeader tab={tab} setTab={handleSetTab} onHelp={() => setHelpOpen(true)} />
      <BootDiagnostics />
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      <main className="flex-1 overflow-y-auto">
        {tab === "mint"        && <MintPage />}
        {tab === "inventory"   && <InventoryPage />}
        {tab === "battle"      && <BattlePage initialWatchId={watchBattleId} />}
        {tab === "royale"      && <BattleRoyalePage initialWatchId={watchRoyaleId} />}
        {tab === "tournament"  && <TournamentPage initialWatchId={watchTournamentId} />}
        {tab === "leaderboard" && <LeaderboardPage onViewPlayer={openProfile} />}
        {tab === "history"     && <HistoryPage onViewPlayer={openProfile} onWatchBattle={openBattle} />}
        {tab === "profile"     && (
          <ProfilePage viewedAddress={viewedPlayer} onViewLeaderboard={goLeaderboard} />
        )}
      </main>

      <NotificationToast />

      <footer
        className="flex items-center justify-between gap-2 px-2 sm:px-3 py-1 flex-shrink-0 font-pixel"
        style={{
          fontSize: 8,
          background: "#c0c0c0",
          color: "#000",
          borderTop: "2px outset #fff",
        }}
      >
        <span className="truncate">{t("footer.version")}</span>
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <IndexerStatus />
          <span className="hidden md:inline">{t("footer.poweredBy")}</span>
        </div>
        <span className="flex-shrink-0">{new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
