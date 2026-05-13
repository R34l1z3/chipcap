// ============================================================
// src/App.tsx — Main app shell
// ============================================================

import React, { useCallback, useState } from "react";
import RetroHeader from "./components/RetroHeader";
import MintPage from "./pages/MintPage";
import InventoryPage from "./pages/InventoryPage";
import BattlePage from "./pages/BattlePage";
import HistoryPage from "./pages/HistoryPage";
import LeaderboardPage from "./pages/LeaderboardPage";
import ProfilePage from "./pages/ProfilePage";
import NotificationToast from "./components/NotificationToast";
import IndexerStatus from "./components/IndexerStatus";

type Tab = "mint" | "inventory" | "battle" | "history" | "leaderboard" | "profile";

export default function App() {
  const [tab, setTab] = useState<Tab>("mint");
  // When a user clicks on an address from the leaderboard or history,
  // we route them to the profile page for that address.
  const [viewedPlayer, setViewedPlayer] = useState<string | null>(null);

  const openProfile = useCallback((address: string | null) => {
    setViewedPlayer(address ? address.toLowerCase() : null);
    setTab("profile");
  }, []);

  // Going back to the leaderboard should clear viewedPlayer so the
  // profile page re-defaults to "my profile" next time.
  const goLeaderboard = useCallback(() => {
    setViewedPlayer(null);
    setTab("leaderboard");
  }, []);

  // Tab switch from header — clear viewedPlayer when leaving profile.
  const handleSetTab = useCallback((t: Tab) => {
    if (t !== "profile") setViewedPlayer(null);
    setTab(t);
  }, []);

  return (
    <div className="flex flex-col h-screen stars-bg">
      <RetroHeader tab={tab} setTab={handleSetTab} />
      <main className="flex-1 overflow-y-auto">
        {tab === "mint" && <MintPage />}
        {tab === "inventory" && <InventoryPage />}
        {tab === "battle" && <BattlePage />}
        {tab === "leaderboard" && <LeaderboardPage onViewPlayer={openProfile} />}
        {tab === "history" && <HistoryPage onViewPlayer={openProfile} />}
        {tab === "profile" && (
          <ProfilePage viewedAddress={viewedPlayer} onViewLeaderboard={goLeaderboard} />
        )}
      </main>

      {/* Real-time WS notifications */}
      <NotificationToast />

      {/* Status bar — Windows 98 style */}
      <footer
        className="flex items-center justify-between gap-2 px-2 sm:px-3 py-1 flex-shrink-0 font-pixel"
        style={{
          fontSize: 8,
          background: "#c0c0c0",
          color: "#000",
          borderTop: "2px outset #fff",
        }}
      >
        <span className="truncate">ChipTap PvP v2.0</span>
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <IndexerStatus />
          <span className="hidden md:inline">Powered by Polygon + Chainlink VRF</span>
        </div>
        <span className="flex-shrink-0">{new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
