import React, { useEffect, useState } from "react";
import wsClient from "../services/wsClient";

export default function IndexerStatus() {
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setWsConnected(wsClient.isConnected), 2000);
    return () => clearInterval(id);
  }, []);

  const color = wsConnected ? "#00FF00" : "#FF8800";
  const label = wsConnected ? "LIVE" : "POLL";

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%", background: color,
        boxShadow: wsConnected ? `0 0 6px ${color}` : "none",
      }} />
      <span style={{
        fontFamily: "'Press Start 2P', monospace",
        fontSize: 7, color, letterSpacing: 1,
      }}>{label}</span>
    </div>
  );
}
