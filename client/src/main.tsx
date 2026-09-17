import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider } from "@/i18n";
import App from "./App";
import { applyFontSize, readFontSize } from "@/lib/fontSize";
import { applyCachedTheme } from "@/lib/theme/themeApply";
import "./index.css";

// Before the first render, never inside a component: the profile's theme
// lives on the relay, so without a local cache every cold start would paint
// the built-in theme, mount, sync, and repaint.
applyCachedTheme();
// Font size is device-local (no relay round trip), but still applied here
// rather than in a component's effect — otherwise the first frame paints at
// the default size and snaps to the stored one a tick later.
applyFontSize(readFontSize());

// The WebdriverIO Tauri stack has three halves that all have to match: the
// `tauri-plugin-wdio` crate (gated behind the `e2e` Cargo feature), the
// `@wdio/tauri-service` test-side service, and this frontend plugin, whose
// only job is to snapshot `window.__TAURI__.core` into
// `window.__wdio_original_core__` before anything can wrap it in a Proxy.
// Only the first two were ever wired up, and the missing third one is not
// inert: the service's per-command focus probe invokes
// `plugin:wdio|get_window_states` through that global, so every single
// element lookup a spec made waited out a 5s timeout (~10s once nested) and
// then gave up. Two lookups still fit inside mocha's 60s budget, which is
// why the smoke test kept passing while any richer spec died of a bare
// "Error: Timeout" that pointed at nothing.
//
// Gated on a Vite mode rather than a shell env var so it works the same on
// Windows and macOS: `import.meta.env.VITE_E2E` is set only by
// `vite build --mode e2e` (.env.e2e), so for a normal dev/build this is a
// statically false branch that Vite drops, import and all.
//
// Deliberately not awaited: the service polls for the global every 10ms for
// up to 5s, so it does not need to exist before the first paint — and
// blocking startup on a test-only dynamic import would distort the very
// boot behaviour this tier is here to exercise.
if (import.meta.env.VITE_E2E) {
  void import("@wdio/tauri-plugin").then(({ init }) => init());
}

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("#app not found in index.html");
}

createRoot(root).render(
  <StrictMode>
    <LocaleProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </LocaleProvider>
  </StrictMode>,
);
