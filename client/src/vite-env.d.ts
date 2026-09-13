/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set only by `vite build --mode e2e` (.env.e2e) — see src/main.tsx. */
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
