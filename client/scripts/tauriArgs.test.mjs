import { describe, expect, it } from "vitest";
import { applyIdentifier } from "./tauriArgs.mjs";

const ID = "sh.example.app";
const ID_JSON = JSON.stringify({ identifier: ID });

describe("applyIdentifier", () => {
  it("passes everything through with neither ANYWH_APP_IDENTIFIER nor TAURI_CONFIG", () => {
    const env = { PATH: "/bin" };
    expect(applyIdentifier(["build", "--config", "x.json"], env)).toEqual({ args: ["build", "--config", "x.json"], env });
  });

  it("hands the identifier to the bundler as --config on a build with no config of its own (Intel, Linux, Windows legs)", () => {
    const out = applyIdentifier(["build", "--target", "x86_64-apple-darwin"], { ANYWH_APP_IDENTIFIER: ID });
    expect(out).toEqual({
      args: ["build", "--target", "x86_64-apple-darwin", "--config", ID_JSON],
      env: { ANYWH_APP_IDENTIFIER: ID, TAURI_CONFIG: ID_JSON },
    });
  });

  it("keeps the identifier next to the build's own --config, merged last (Apple Silicon leg)", () => {
    const out = applyIdentifier(["build", "--target", "aarch64-apple-darwin", "--config", "src-tauri/tauri.relay.conf.json"], {
      ANYWH_APP_IDENTIFIER: ID,
    });
    expect("args" in out && out.args).toEqual([
      "build",
      "--target",
      "aarch64-apple-darwin",
      "--config",
      "src-tauri/tauri.relay.conf.json",
      "--config",
      ID_JSON,
    ]);
  });

  it("stops at `--`: what follows is the runner's, not the CLI's", () => {
    const out = applyIdentifier(["build", "-c", "x.json", "--", "--features", "foo"], { ANYWH_APP_IDENTIFIER: ID });
    expect("args" in out && out.args).toEqual(["build", "-c", "x.json", "--config", ID_JSON, "--", "--features", "foo"]);
  });

  it("merges the identifier over an inherited TAURI_CONFIG", () => {
    const out = applyIdentifier(["dev"], {
      ANYWH_APP_IDENTIFIER: ID,
      TAURI_CONFIG: JSON.stringify({ productName: "x", identifier: "old.id" }),
    });
    const json = JSON.stringify({ productName: "x", identifier: ID });
    expect(out).toEqual({ args: ["dev", "--config", json], env: { ANYWH_APP_IDENTIFIER: ID, TAURI_CONFIG: json } });
  });

  it("forwards a TAURI_CONFIG set on its own, which the CLI would otherwise ignore", () => {
    const env = { TAURI_CONFIG: ID_JSON };
    expect(applyIdentifier(["build", "--config", "x.json"], env)).toEqual({
      args: ["build", "--config", "x.json", "--config", ID_JSON],
      env,
    });
  });

  it("injects after the mobile subcommand", () => {
    const out = applyIdentifier(["ios", "init", "--ci"], { ANYWH_APP_IDENTIFIER: ID });
    expect("args" in out && out.args).toEqual(["ios", "init", "--ci", "--config", ID_JSON]);
  });

  it("leaves commands without --config alone but still sets TAURI_CONFIG", () => {
    const out = applyIdentifier(["ios", "xcode-script", "-v"], { ANYWH_APP_IDENTIFIER: ID });
    expect(out).toEqual({ args: ["ios", "xcode-script", "-v"], env: { ANYWH_APP_IDENTIFIER: ID, TAURI_CONFIG: ID_JSON } });
    expect(applyIdentifier(["info"], { ANYWH_APP_IDENTIFIER: ID })).toMatchObject({ args: ["info"] });
  });

  it("rejects a malformed identifier or TAURI_CONFIG", () => {
    expect(applyIdentifier(["build"], { ANYWH_APP_IDENTIFIER: "not an id" })).toHaveProperty("error");
    expect(applyIdentifier(["build"], { ANYWH_APP_IDENTIFIER: ID, TAURI_CONFIG: "{" })).toHaveProperty("error");
  });
});
