import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProfiles, isBrokeredProfile, isTailnetProfile, markProfileVerified, removeProfile, setProfiles, syncProfilesForHost, type Profile } from "./profiles";
import type { RemoteProfile } from "@/lib/relay-types";

function remote(overrides: Partial<RemoteProfile> & Pick<RemoteProfile, "id" | "host">): RemoteProfile {
  return {
    label: overrides.id,
    colorIndex: 0,
    port: 8765,
    hasHomeOverride: false,
    running: true,
    ...overrides,
  };
}

// Real code path throughout — setProfiles/syncProfilesForHost are the
// production functions (profiles.ts), not stand-ins. Each test seeds a known
// starting list via setProfiles so it doesn't depend on whatever the
// previous test left behind.
beforeEach(() => {
  localStorage.clear();
});

describe("syncProfilesForHost", () => {
  it("regression: a loopback-registered ghost is dropped once a sync against a real host succeeds, even if the ghost's id isn't in that host's response", () => {
    // Reproduces the bug fixed 2026-09-07 (commit 2eff9a7): a stray
    // `npm run dev` self-registers as "default" on 127.0.0.1
    // (relay/src/profileRegistry.ts ensureSelfRegistered) and used to survive
    // forever because the old dedup only matched by host.
    const ghost: Profile = { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 };
    setProfiles([ghost]);

    syncProfilesForHost("100.64.0.1", [remote({ id: "pessoal", host: "100.64.0.1" })]);

    const ids = getProfiles().map((p) => p.id);
    expect(ids).toEqual(["pessoal"]);
  });

  it("keeps a tailnet profile whose loopback host is only the sidecar placeholder", () => {
    // `importProfile` stores `127.0.0.1:0` as a placeholder
    // for a brokered tailnet profile — `useRelayClient` swaps it for the
    // sidecar's real local address before dialing anything. That host looks
    // exactly like the `ensureSelfRegistered` ghost the test above drops,
    // but this one is a live profile the user just paired, and losing it
    // means losing its auth key/broker config for good (neither is
    // recoverable from any host's `/control/profiles`).
    const tailnet: Profile = {
      id: "9f1c-imported",
      label: "Sandbox",
      host: "127.0.0.1",
      relayPort: 0,
      tailnetAuthKey: "key",
      tailnetControlUrl: "https://headscale.test",
      brokerUrl: "https://api.test/v1/connect/w1",
      brokerNodeId: "node-1",
    };
    setProfiles([tailnet]);

    syncProfilesForHost("100.64.0.1", [remote({ id: "pessoal", host: "100.64.0.1" })]);

    const ids = getProfiles().map((p) => p.id).sort();
    expect(ids).toEqual(["9f1c-imported", "pessoal"]);

    // Same for a sync against a loopback host (a relay running on this very
    // machine): the placeholder shares that host without being one of its
    // profiles at all.
    setProfiles([tailnet]);
    syncProfilesForHost("127.0.0.1", [remote({ id: "default", host: "127.0.0.1" })]);
    expect(getProfiles().map((p) => p.id).sort()).toEqual(["9f1c-imported", "default"].sort());
  });

  it("dedups by id, not host: a stale local entry for an id also present in the remote response is replaced, not duplicated", () => {
    const staleLocal: Profile = { id: "trabalho", label: "Default", host: "127.0.0.1", relayPort: 8765 };
    setProfiles([staleLocal]);

    syncProfilesForHost("100.64.0.2", [remote({ id: "trabalho", host: "100.64.0.2", label: "Trabalho" })]);

    const trabalho = getProfiles().filter((p) => p.id === "trabalho");
    expect(trabalho).toHaveLength(1);
    expect(trabalho[0].host).toBe("100.64.0.2");
    expect(trabalho[0].label).toBe("Trabalho");
  });

  it("keeps profiles known from a different (non-loopback) host untouched", () => {
    const other: Profile = { id: "trabalho", label: "Trabalho", host: "100.64.0.2", relayPort: 8765 };
    setProfiles([other]);

    syncProfilesForHost("100.64.0.1", [remote({ id: "pessoal", host: "100.64.0.1" })]);

    const ids = getProfiles().map((p) => p.id).sort();
    expect(ids).toEqual(["pessoal", "trabalho"]);
  });

  it("never empties the list: an empty remote response for a host that would remove the last known profile is a no-op", () => {
    const only: Profile = { id: "pessoal", label: "Pessoal", host: "100.64.0.1", relayPort: 8765 };
    setProfiles([only]);

    syncProfilesForHost("100.64.0.1", []);

    expect(getProfiles()).toEqual([only]);
  });

  it("preserves a locally set connectToken across a sync that reports the same id — the host's own response never carries one", () => {
    const imported: Profile = { id: "paired", label: "Paired device", host: "1.2.3.4", relayPort: 8443, connectToken: "secret-token" };
    setProfiles([imported]);

    syncProfilesForHost("1.2.3.4", [remote({ id: "paired", host: "1.2.3.4", label: "Paired device" })]);

    const synced = getProfiles().find((p) => p.id === "paired");
    expect(synced?.connectToken).toBe("secret-token");
  });

  it("preserves locally set tailnet fields across a sync that reports the same id — same reasoning as connectToken above", () => {
    const imported: Profile = {
      id: "tailnet-paired",
      label: "Tailnet device",
      host: "127.0.0.1",
      relayPort: 8765,
      tailnetAuthKey: "tskey-auth-xyz",
      tailnetControlUrl: "https://headscale.example",
      tailnetTarget: "100.64.0.5:8765",
    };
    setProfiles([imported]);

    syncProfilesForHost("127.0.0.1", [remote({ id: "tailnet-paired", host: "127.0.0.1", label: "Tailnet device" })]);

    const synced = getProfiles().find((p) => p.id === "tailnet-paired");
    expect(synced?.tailnetAuthKey).toBe("tskey-auth-xyz");
    expect(synced?.tailnetControlUrl).toBe("https://headscale.example");
    expect(synced?.tailnetTarget).toBe("100.64.0.5:8765");
  });

  it("preserves locally set broker fields across a sync that reports the same id — same reasoning as tailnet fields above", () => {
    const imported: Profile = {
      id: "brokered",
      label: "Brokered device",
      host: "127.0.0.1",
      relayPort: 8765,
      tailnetAuthKey: "tskey-auth-xyz",
      tailnetControlUrl: "https://headscale.example",
      brokerUrl: "https://api.example/v1/connect/workspace-1",
      brokerNodeId: "node-1",
    };
    setProfiles([imported]);

    syncProfilesForHost("127.0.0.1", [remote({ id: "brokered", host: "127.0.0.1", label: "Brokered device" })]);

    const synced = getProfiles().find((p) => p.id === "brokered");
    expect(synced?.brokerUrl).toBe("https://api.example/v1/connect/workspace-1");
    expect(synced?.brokerNodeId).toBe("node-1");
  });

  it("regression: a sync that reports the same data back is a no-op on the array/object identity, not just the values", () => {
    // useForegroundSync (client/src/hooks/useForegroundSync.ts) reruns this
    // every 30s and on window focus. Before this fix, every successful sync
    // replaced the array and every Profile object with fresh identities even
    // when nothing changed, so anything keyed on `profile` (e.g. FileViewer's
    // fetch effect, client/src/components/files/FileViewer.tsx) re-ran and
    // flashed its loading state, dropping scroll position, on every poll.
    const existing: Profile = { id: "pessoal", label: "Pessoal", host: "100.64.0.1", relayPort: 8765, colorIndex: 2 };
    setProfiles([existing]);
    const listBefore = getProfiles();
    const profileBefore = listBefore[0];

    syncProfilesForHost("100.64.0.1", [remote({ id: "pessoal", host: "100.64.0.1", label: "Pessoal", colorIndex: 2, port: 8765 })]);

    expect(getProfiles()).toBe(listBefore);
    expect(getProfiles()[0]).toBe(profileBefore);
  });
});

describe("isTailnetProfile", () => {
  const base: Profile = { id: "p", label: "P", host: "127.0.0.1", relayPort: 8765 };

  it("is false when none of the tailnet fields are set", () => {
    expect(isTailnetProfile(base)).toBe(false);
  });

  it("is false when only some of the tailnet fields are set — never partially tailnet mode", () => {
    expect(isTailnetProfile({ ...base, tailnetAuthKey: "key" })).toBe(false);
    expect(isTailnetProfile({ ...base, tailnetAuthKey: "key", tailnetControlUrl: "https://hs.example" })).toBe(false);
  });

  it("is true once tailnetAuthKey/tailnetControlUrl/tailnetTarget are all set (F2's static, broker-less shape)", () => {
    expect(
      isTailnetProfile({
        ...base,
        tailnetAuthKey: "key",
        tailnetControlUrl: "https://hs.example",
        tailnetTarget: "100.64.0.5:8765",
      }),
    ).toBe(true);
  });

  it("a broker can stand in for the static tailnetTarget — authKey/controlUrl + brokerUrl/brokerNodeId is enough, no tailnetTarget needed", () => {
    expect(
      isTailnetProfile({
        ...base,
        tailnetAuthKey: "key",
        tailnetControlUrl: "https://hs.example",
        brokerUrl: "https://api.example/v1/connect/workspace-1",
        brokerNodeId: "node-1",
      }),
    ).toBe(true);
  });

  it("a broker alone, with no way to join the tailnet, is still not tailnet mode", () => {
    expect(
      isTailnetProfile({ ...base, brokerUrl: "https://api.example/v1/connect/workspace-1", brokerNodeId: "node-1" }),
    ).toBe(false);
  });
});

describe("isBrokeredProfile", () => {
  const base: Profile = { id: "p", label: "P", host: "127.0.0.1", relayPort: 8765 };

  it("is false when neither brokerUrl nor brokerNodeId is set", () => {
    expect(isBrokeredProfile(base)).toBe(false);
  });

  it("is false when only one of brokerUrl/brokerNodeId is set — never partially brokered", () => {
    expect(isBrokeredProfile({ ...base, brokerUrl: "https://api.example/v1/connect/workspace-1" })).toBe(false);
    expect(isBrokeredProfile({ ...base, brokerNodeId: "node-1" })).toBe(false);
  });

  it("is true once both are set", () => {
    expect(
      isBrokeredProfile({ ...base, brokerUrl: "https://api.example/v1/connect/workspace-1", brokerNodeId: "node-1" }),
    ).toBe(true);
  });
});

/** The reader and the migration run once, at import — so each case gets a
 * fresh module against the storage it just seeded. The static import at the
 * top of this file keeps pointing at the original instance, which is fine:
 * these cases only ever read through the fresh one. */
async function freshProfilesModule(): Promise<typeof import("./profiles")> {
  vi.resetModules();
  return import("./profiles");
}

describe("stored list", () => {
  it("reads an absent key as no profiles at all — nothing is seeded", async () => {
    const fresh = await freshProfilesModule();
    expect(fresh.getProfiles()).toEqual([]);
  });

  it("reads an empty array as empty rather than falling back to a seed", async () => {
    localStorage.setItem("anywh:profiles", "[]");
    const fresh = await freshProfilesModule();
    expect(fresh.getProfiles()).toEqual([]);
  });

  it("reads unreadable storage as empty without overwriting the key", async () => {
    // Whatever is in there may still be recoverable by hand; the first
    // real write (a profile added from the first run) replaces it anyway.
    localStorage.setItem("anywh:profiles", "{not json");
    const fresh = await freshProfilesModule();
    expect(fresh.getProfiles()).toEqual([]);
    expect(localStorage.getItem("anywh:profiles")).toBe("{not json");
  });

  it("lets removeProfile empty the list — an empty list is what shows the first run", () => {
    const only: Profile = { id: "only", label: "Only", host: "100.64.0.1", relayPort: 8765 };
    setProfiles([only]);

    expect(removeProfile("only")).toBe(true);

    expect(getProfiles()).toEqual([]);
    expect(localStorage.getItem("anywh:profiles")).toBe("[]");
  });

  it("removeProfile reports false for an id it doesn't know", () => {
    setProfiles([{ id: "a", label: "A", host: "100.64.0.1", relayPort: 8765 }]);
    expect(removeProfile("nope")).toBe(false);
  });
});

describe("seeded-ghost migration", () => {
  const ghost: Profile = { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 };
  const MIGRATION_KEY = "anywh:migrations:drop-loopback-default";

  function store(list: Profile[]): void {
    localStorage.setItem("anywh:profiles", JSON.stringify(list));
  }

  it("drops the old seed when it is the only entry, on loopback, and never synced", async () => {
    // The pre-first-run install: `DEFAULT_PROFILES` planted this on every
    // device whether or not a relay listened there. Left in place, it
    // would keep the first-run screen from ever showing after the upgrade.
    store([ghost]);
    const fresh = await freshProfilesModule();

    expect(fresh.getProfiles()).toEqual([]);
    expect(localStorage.getItem("anywh:profiles")).toBe("[]");
    expect(localStorage.getItem(MIGRATION_KEY)).not.toBeNull();
  });

  it("keeps a loopback 'default' this device has actually synced sessions for — that's a real relay", async () => {
    store([ghost]);
    localStorage.setItem("anywh:session-list-cache", JSON.stringify({ default: { sessions: [], syncedAt: 1_700_000_000_000 } }));
    const fresh = await freshProfilesModule();
    expect(fresh.getProfiles()).toEqual([ghost]);
  });

  it("keeps it when a second profile exists — that device has been through pairing", async () => {
    const other: Profile = { id: "trabalho", label: "Trabalho", host: "100.64.0.2", relayPort: 8765 };
    store([ghost, other]);
    const fresh = await freshProfilesModule();
    expect(fresh.getProfiles()).toEqual([ghost, other]);
  });

  it("keeps a sole 'default' on a real (non-loopback) host", async () => {
    const real: Profile = { ...ghost, host: "192.168.0.10" };
    store([real]);
    const fresh = await freshProfilesModule();
    expect(fresh.getProfiles()).toEqual([real]);
  });

  it("keeps a sole loopback profile under any other id", async () => {
    const renamed: Profile = { ...ghost, id: "home" };
    store([renamed]);
    const fresh = await freshProfilesModule();
    expect(fresh.getProfiles()).toEqual([renamed]);
  });

  it("runs once: a loopback 'default' created after the migration survives", async () => {
    localStorage.setItem(MIGRATION_KEY, "1");
    store([ghost]);
    const fresh = await freshProfilesModule();
    expect(fresh.getProfiles()).toEqual([ghost]);
  });
});

describe("unverified", () => {
  it("survives a host sync that reports the same id — the field-by-field merge would otherwise erase it", () => {
    // The sync runs every 30 s in the background; a mark it doesn't carry
    // over is a mark that never gets to trigger anything.
    const saved: Profile = { id: "paired", label: "Paired", host: "1.2.3.4", relayPort: 8443, unverified: true };
    setProfiles([saved]);

    syncProfilesForHost("1.2.3.4", [remote({ id: "paired", host: "1.2.3.4", label: "Paired", port: 8443 })]);

    expect(getProfiles().find((p) => p.id === "paired")?.unverified).toBe(true);
  });

  it("markProfileVerified clears the mark and persists it", () => {
    setProfiles([{ id: "paired", label: "Paired", host: "1.2.3.4", relayPort: 8443, unverified: true }]);

    markProfileVerified("paired");

    expect(getProfiles()[0].unverified).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("anywh:profiles") ?? "[]")[0].unverified).toBeUndefined();
  });

  it("markProfileVerified is a no-op on an already verified profile — the session sync calls it constantly", () => {
    setProfiles([{ id: "paired", label: "Paired", host: "1.2.3.4", relayPort: 8443 }]);
    const before = getProfiles();

    markProfileVerified("paired");
    markProfileVerified("nobody");

    expect(getProfiles()).toBe(before);
  });
});

describe("localRelay", () => {
  it("keeps a loopback profile the in-app install created here across a sync against a remote host", () => {
    // Without the flag this is exactly the `ensureSelfRegistered` ghost the
    // loopback cleanup exists to drop — the mark is what tells the two apart.
    const local: Profile = { id: "studio", label: "Studio", host: "127.0.0.1", relayPort: 8766, localRelay: true };
    setProfiles([local]);

    syncProfilesForHost("100.64.0.1", [remote({ id: "pessoal", host: "100.64.0.1" })]);

    expect(getProfiles().map((p) => p.id).sort()).toEqual(["pessoal", "studio"]);
    expect(getProfiles().find((p) => p.id === "studio")?.localRelay).toBe(true);
  });

  it("is inherited when the local relay's own registry reports the profile back", () => {
    const local: Profile = { id: "studio", label: "Studio", host: "127.0.0.1", relayPort: 8766, localRelay: true };
    setProfiles([local]);

    syncProfilesForHost("127.0.0.1", [remote({ id: "studio", host: "127.0.0.1", label: "Studio", port: 8766 })]);

    expect(getProfiles()).toHaveLength(1);
    expect(getProfiles()[0].localRelay).toBe(true);
  });
});
