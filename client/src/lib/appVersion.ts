/**
 * The app's own version, as the status bar prints it.
 *
 * A literal rather than a build-time `define` or a call to Tauri's
 * `getVersion()`: the define would have to be repeated in three configs
 * (`vite.config.ts` and both vitest ones) and go missing from whichever is
 * added next, and `getVersion()` is an IPC call that needs its own capability
 * and answers nothing outside a Tauri window — neither the unit tier nor a
 * browser `vite dev` would have a version to show. The cost is a third place
 * to bump on release, which `appVersion.test.ts` guards against forgetting.
 */
export const APP_VERSION = "0.1.3";
