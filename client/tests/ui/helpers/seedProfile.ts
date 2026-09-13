import { setProfiles, type Profile } from "@/lib/profiles";

/**
 * The one profile the shell-tier tests run against. Nothing seeds a
 * profile anymore — an empty list puts the first-run screen on the window
 * (see `App`), which is the right behaviour for a fresh install and the
 * wrong starting point for a test of the shell. Same shape the app used to
 * plant on its own, so specs that name it ("Default", `/control/profiles/
 * default`) still read the same. Tests of the first run itself start from
 * `setProfiles([])` instead and never call this.
 */
export const SHELL_TEST_PROFILE: Profile = { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 };

export function seedShellProfile(): void {
  setProfiles([SHELL_TEST_PROFILE]);
}
