import React from "react";
import { useWsNotifications, type Notification } from "../hooks/useWsNotifications";

const COLORS: Record<string, { border: string; text: string; bg: string }> = {
  win:     { border: "#00FF88", text: "#00FF88", bg: "#003322" },
  loss:    { border: "#FF4444", text: "#FF4444", bg: "#330011" },
  joined:  { border: "#FF00FF", text: "#FF00FF", bg: "#220033" },
  settled: { border: "#FFD700", text: "#FFD700", bg: "#332200" },
  created: { border: "#00FFFF", text: "#00FFFF", bg: "#002233" },
  info:    { border: "#4a4a8a", text: "#00FFFF", bg: "#1a1a4e" },
  error:   { border: "#FF8800", text: "#FFAA44", bg: "#331a00" },
};

function Toast({ notif, onDismiss }: { notif: Notification; onDismiss: () => void }) {
  const c = COLORS[notif.type] || COLORS.info;
  return (
    <div
      onClick={onDismiss}
      className="cursor-pointer w-full sm:max-w-[360px]"
      style={{
        background: c.bg, border: `2px solid ${c.border}`,
        padding: "8px 14px", marginBottom: 6,
        fontFamily: "'VT323', monospace", fontSize: 16,
        color: c.text, boxShadow: `0 0 10px ${c.border}33`,
        animation: "slideIn 0.3s ease-out",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ wordBreak: "break-word" }}>{notif.message}</span>
        <span style={{ opacity: 0.4, fontSize: 12, flexShrink: 0 }}>x</span>
      </div>
    </div>
  );
}

export default function NotificationToast() {
  const { notifications, dismissNotif } = useWsNotifications();
  if (notifications.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
      <div
        className="left-2 right-2 sm:left-auto sm:right-3 flex flex-col items-stretch sm:items-end"
        style={{ position: "fixed", top: 60, zIndex: 9000, pointerEvents: "none" }}
      >
        {notifications.map((n) => (
          <Toast key={n.id} notif={n} onDismiss={() => dismissNotif(n.id)} />
        ))}
      </div>
    </>
  );
}
