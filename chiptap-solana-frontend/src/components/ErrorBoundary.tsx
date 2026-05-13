// ============================================================
// src/components/ErrorBoundary.tsx
//
// Catches any render-time exception in the React tree and shows
// a retro CRT error panel instead of a blank white page.  Critical
// for wallet bring-up — config/PublicKey crashes used to silently
// kill the whole bundle.
// ============================================================

import React from "react";

type Props  = { children: React.ReactNode };
type State  = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the full stack visible in DevTools.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Friendlier label for the most common boot-time failure.
    const isConfigError = /\[config\]/.test(error.message);
    const title = isConfigError ? "CONFIG ERROR" : "RUNTIME ERROR";

    return (
      <div
        className="stars-bg"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          fontFamily: "'VT323', monospace",
          color: "#FF3333",
        }}
      >
        <div
          className="retro-panel"
          style={{ maxWidth: 720, width: "100%", borderColor: "#FF3333" }}
        >
          <div
            style={{
              fontFamily: "'Press Start 2P', monospace",
              color: "#FFD700",
              fontSize: 14,
              marginBottom: 12,
              letterSpacing: 1,
            }}
          >
            ! {title} !
          </div>

          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#0a0a1e",
              padding: 10,
              border: "2px inset #4a4a8a",
              fontSize: 14,
              color: "#FF8888",
              maxHeight: 240,
              overflow: "auto",
            }}
          >
            {error.message}
          </pre>

          {isConfigError && (
            <div style={{ marginTop: 12, fontSize: 16, color: "#00FFFF", lineHeight: 1.4 }}>
              <div>To fix:</div>
              <ol style={{ marginLeft: 18, marginTop: 6 }}>
                <li>cd chiptap-solana-frontend</li>
                <li>cp .env.example .env</li>
                <li>Paste the program IDs from <code>run-init.sh</code> output</li>
                <li>Restart <code>npm run dev</code> (clear <code>node_modules/.vite</code> if cached)</li>
              </ol>
            </div>
          )}

          <button
            className="retro-btn"
            style={{ marginTop: 16 }}
            onClick={() => window.location.reload()}
          >
            RELOAD
          </button>
        </div>
      </div>
    );
  }
}
