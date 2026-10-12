import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  listDevices,
  pruneExpired,
  removeDevice,
  removePushKeys,
  sanitizeLoaded,
  upsertDevice,
  type PushDevice,
  type PushDeviceInput,
  type PushDeviceListing,
} from "./pushDevices.js";

/** The registry on disk: one JSON file per profile, rewritten whole on every
 * change (a handful of entries, written when a client registers or a
 * gateway reports a dead key — nothing hot). The file holds capabilities,
 * so it is owner-only. */
export class PushStore {
  private devices: PushDevice[];

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.devices = this.load();
  }

  private load(): PushDevice[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    try {
      return pruneExpired(sanitizeLoaded(JSON.parse(raw)), this.now());
    } catch (error) {
      console.error(`[relay] ignoring unreadable push registry ${this.filePath}:`, error);
      return [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Rename over the old file so a crash mid-write leaves the previous
    // registry, not half of a new one.
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }

  /** Live entries — expired ones are dropped as a side effect of asking. */
  all(): readonly PushDevice[] {
    const live = pruneExpired(this.devices, this.now());
    if (live.length !== this.devices.length) {
      this.devices = live;
      this.persist();
    }
    return this.devices;
  }

  list(): PushDeviceListing[] {
    return listDevices(this.all());
  }

  put(deviceId: string, input: PushDeviceInput): void {
    this.devices = upsertDevice(pruneExpired(this.devices, this.now()), deviceId, input, this.now());
    this.persist();
  }

  /** `true` when there was something to remove. */
  delete(deviceId: string): boolean {
    const next = removeDevice(this.devices, deviceId);
    if (next.length === this.devices.length) return false;
    this.devices = next;
    this.persist();
    return true;
  }

  removeByPushKeys(pushKeys: readonly string[]): void {
    const next = removePushKeys(this.devices, pushKeys);
    if (next.length === this.devices.length) return;
    this.devices = next;
    this.persist();
  }
}
