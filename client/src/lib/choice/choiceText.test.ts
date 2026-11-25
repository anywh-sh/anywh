import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n";
import type { ChoiceQuestion } from "@/lib/relay/relayClient";
import { allowsCustomText, optionLabel, optionValue, questionText } from "./choiceText";

const en = getDictionary("en");
const pt = getDictionary("pt-BR");

describe("choiceText", () => {
  it("an option the relay wrote answers with its id; one the model wrote, with its label", () => {
    expect(optionValue({ id: "approve", label: "Approve" })).toBe("approve");
    expect(optionValue({ label: "Per test" })).toBe("Per test");
  });

  it("prints the relay's own options from the dictionary and the model's as written", () => {
    expect(optionLabel({ id: "deny", label: "Deny" }, pt)).toBe(pt.chat.approval.deny);
    expect(optionLabel({ id: "acceptForSession", label: "Accept for session" }, en)).toBe(en.chat.approval.codexAcceptForSession);
    expect(optionLabel({ label: "Por teste" }, en)).toBe("Por teste");
  });

  describe("questionText", () => {
    it("is the model's own question when it isn't an approval", () => {
      expect(questionText({ question: "Retry per test?", options: [] }, pt)).toBe("Retry per test?");
    });

    it("composes a tool approval in the user's language, with the reason when there is one", () => {
      const question: ChoiceQuestion = {
        question: "fallback",
        options: [],
        approval: { tool: "Bash", detail: "rm -rf build", reason: "cleaning" },
      };
      expect(questionText(question, en)).toBe(
        `${en.chat.approval.toolCall.replace("{tool}", "Bash").replace("{detail}", "rm -rf build")} ${en.chat.approval.reasonSuffix.replace("{reason}", "cleaning")}`,
      );
    });

    it("composes a Codex command approval with no reason suffix when none was given", () => {
      const question: ChoiceQuestion = { question: "fallback", options: [], approval: { tool: "command", detail: "npm test" } };
      expect(questionText(question, pt)).toBe(pt.chat.approval.codexCommand.replace("{detail}", "npm test"));
    });

    it("has its own sentence for leaving plan mode", () => {
      const question: ChoiceQuestion = { question: "fallback", options: [], approval: { tool: "ExitPlanMode", detail: "" } };
      expect(questionText(question, en)).toBe(en.chat.approval.exitPlanMode);
    });
  });

  describe("allowsCustomText", () => {
    const withOptions: ChoiceQuestion = { question: "q", options: [{ id: "approve", label: "Approve" }] };
    const withoutOptions: ChoiceQuestion = { question: "q", options: [] };

    it("always for a choice prompt", () => {
      expect(allowsCustomText("choice", withOptions)).toBe(true);
    });

    it("never for an approval with options to match against", () => {
      expect(allowsCustomText("approval", withOptions)).toBe(false);
    });

    it("for an approval with no options, which is asking for free text", () => {
      expect(allowsCustomText("approval", withoutOptions)).toBe(true);
    });
  });
});
