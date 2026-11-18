import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { envForTarget } from "../host/agentConfigDirs.js";
import type { ChildTarget } from "../host/childEnv.js";
import { resolveProfileTarget } from "../host/profileRegistry.js";

/** Whose accounts a request acts on, as the routes that sign in, read or
 * seed an agent's config need it. `child` goes to `buildChildEnv`, `home` is
 * where the child starts, `env` is what `resolveAgentPath` reads the config
 * dirs from, and `key` names the accounts for "one login at a time". */
export interface RequestedProfile {
  readonly own: boolean;
  readonly child: ChildTarget;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly key: string;
}

export type RequestedProfileError = "bad-home" | "unknown-profile";

/**
 * Reads `?profile=<id>` (a profile or a draft on this machine) or the older
 * `?home=<absolute path>` (a legacy `$HOME` swap) off `url`; neither means
 * this relay's own profile.
 *
 * Anything other than this relay's own is spelled out as a target that sets
 * or removes every config-dir variable: a child inheriting this relay's
 * `CLAUDE_CONFIG_DIR` would sign in, read or write this relay's account
 * whatever `$HOME` it was given.
 */
export function readRequestedProfile(url: URL, homeOverride: string | undefined): RequestedProfile | { error: RequestedProfileError } {
  const relayHome = resolve(homeOverride ?? homedir());
  const profileId = url.searchParams.get("profile")?.trim();
  if (profileId) {
    const target = resolveProfileTarget(profileId);
    if (!target) return { error: "unknown-profile" };
    return { own: false, child: target, home: target.home ?? homedir(), env: envForTarget(process.env, target), key: `profile:${profileId}` };
  }
  const requestedHome = url.searchParams.get("home")?.trim();
  if (requestedHome) {
    if (!isAbsolute(requestedHome)) return { error: "bad-home" };
    // The same folder typed out is still this relay's own.
    if (resolve(requestedHome) !== relayHome) {
      const target = { home: requestedHome };
      return { own: false, child: target, home: requestedHome, env: envForTarget(process.env, target), key: `home:${resolve(requestedHome)}` };
    }
  }
  return { own: true, child: homeOverride, home: homeOverride ?? homedir(), env: process.env, key: `home:${relayHome}` };
}
