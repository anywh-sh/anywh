import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";

/**
 * The onboarding's words, as a test. "relay" is an implementation detail the
 * reader meets only where they opted into the details: the advanced options
 * and the preparing screen's raw output (the installer's own lines, which
 * never leave Details — see Preparing). Everywhere else the product is
 * "anywh". And `anywh.sh` is the wordmark, drawn by the lockup and the window
 * title — never a word in a sentence.
 */

/** Every string under `node`, with its dotted path. */
function strings(node: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof node === "string") out.push([path, node]);
  else if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) strings(value, `${path}.${key}`, out);
  return out;
}

/** Exact keys, not prefixes: a new string under the advanced options has
 * to be added here on purpose before it may name the relay. */
const ALLOWS_RELAY = new Set([
  "firstRun.advanced.body",
  "firstRun.advanced.address.label",
  "firstRun.advanced.address.customPlaceholder",
  "firstRun.advanced.app.hint",
]);

describe.each([
  ["en", en],
  ["pt-BR", ptBr],
])("onboarding vocabulary (%s)", (_name, dict) => {
  const all = strings(dict.firstRun, "firstRun");

  it("never says relay outside the advanced options and the details", () => {
    const hits = all.filter(([path, text]) => /relay/i.test(text) && !ALLOWS_RELAY.has(path));
    expect(hits).toEqual([]);
  });

  it("keeps anywh.sh to the window title", () => {
    const hits = all.filter(([path, text]) => text.includes("anywh.sh") && path !== "firstRun.windowTitle");
    expect(hits).toEqual([]);
  });
});
