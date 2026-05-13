/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_INDEXER_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
