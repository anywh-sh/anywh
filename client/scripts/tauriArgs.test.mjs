import { describe, expect, it } from "vitest";
import { withEnvConfig } from "./tauriArgs.mjs";

describe("withEnvConfig", () => {
  const identifier = '{"identifier":"sh.example.app"}';

  it("keeps TAURI_CONFIG when the build passes its own --config, merged last", () => {
    expect(withEnvConfig(["build", "--config", "src-tauri/tauri.relay.conf.json"], identifier)).toEqual([
      "build",
      "--config",
      "src-tauri/tauri.relay.conf.json",
      "--config",
      identifier,
    ]);
    expect(withEnvConfig(["build", "-c", "x.json"], identifier).at(-1)).toBe(identifier);
    expect(withEnvConfig(["build", "--config=x.json"], identifier).at(-1)).toBe(identifier);
    // What follows `--` is the runner's, not the CLI's.
    expect(withEnvConfig(["build", "--config", "x.json", "--", "--features", "foo"], identifier)).toEqual([
      "build",
      "--config",
      "x.json",
      "--config",
      identifier,
      "--",
      "--features",
      "foo",
    ]);
  });

  it("leaves the args alone otherwise: the CLI reads TAURI_CONFIG itself", () => {
    expect(withEnvConfig(["build", "--target", "aarch64-apple-darwin"], identifier)).toEqual(["build", "--target", "aarch64-apple-darwin"]);
    expect(withEnvConfig(["build", "--config", "x.json"], undefined)).toEqual(["build", "--config", "x.json"]);
  });
});
