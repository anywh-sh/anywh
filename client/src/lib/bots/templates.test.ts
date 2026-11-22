import { describe, expect, it } from "vitest";
import { withPickedMascot } from "@/lib/bots/templates";

describe("withPickedMascot", () => {
  it("keeps a picked character and tone as they are", () => {
    const bot = { mascot: { character: "screen", tone: "rose" }, templateId: "issue-triage" };
    expect(withPickedMascot(bot)).toBe(bot);
  });

  it("gives a bot an older relay stored with a seed its template's face, or Bip without a template", () => {
    expect(withPickedMascot({ mascot: { seed: "Issue triage" }, templateId: "issue-triage" }).mascot).toEqual({ character: "visor", tone: "rose" });
    expect(withPickedMascot({ mascot: { seed: "Mine" } }).mascot).toEqual({ character: "bip", tone: "sand" });
  });

  it("keeps a pick saved under the earlier Portuguese ids, renamed", () => {
    expect(withPickedMascot({ mascot: { character: "tela", tone: "pedra" }, templateId: "issue-triage" }).mascot).toEqual({ character: "screen", tone: "stone" });
  });
});
