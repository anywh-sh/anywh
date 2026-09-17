/** Outside Tauri (e.g. `npm run dev` opened in a regular browser for
 * inspection via Playwright) Tauri's APIs blow up, because they
 * read `window.__TAURI_INTERNALS__`. Checking this first makes those paths
 * no-op in that case. */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
