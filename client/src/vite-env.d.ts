/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set only by `vite build --mode e2e` (.env.e2e) — see src/main.tsx. */
  readonly VITE_E2E?: string;
  /** The analytics project key of an official build, injected by the
   * release workflow. Absent in a fork or a local build, and then the
   * telemetry module sends nothing and never loads its SDK. */
  readonly VITE_POSTHOG_KEY?: string;
  /** Ingestion host for that key; US cloud when absent. */
  readonly VITE_POSTHOG_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
