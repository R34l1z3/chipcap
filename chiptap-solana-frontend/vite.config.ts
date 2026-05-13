import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Solana SDKs assume Node globals (Buffer, process).  The polyfills
// plugin patches them in for the browser bundle.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ globals: { Buffer: true, process: true } }),
  ],
  server: { port: 5173 },
  build:  { sourcemap: false, target: "es2020" },
});
