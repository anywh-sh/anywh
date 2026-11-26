import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n";
import { INITIAL_CHOICE_FLOW, goTo, setCustomText, toggleOption, type ChoiceFlow } from "@/lib/choice/choiceFlow";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";
import type { ChoiceQuestion } from "@/lib/relay/relayClient";
import { buildChoicePayload, choiceStepKey, type ChoiceModelInput } from "./nativeChoiceModel";
import fixture from "../../../src-tauri/plugins/tauri-plugin-native-chrome/tests/fixtures/choice_payload.json";

const en = getDictionary("en");
const pt = getDictionary("pt-BR");

const theme: NativeShellTheme = {
  background: "#111111",
  sidebar: "#161616",
  elevated: "#1c1c1c",
  card: "#202020",
  foreground: "#eeeeee",
  muted: "#999999",
  faint: "#666666",
  border: "#2a2a2a",
  primary: "#e0642a",
  primaryForeground: "#ffffff",
  destructive: "#dc6f5c",
  tint: "#eceae4",
  success: "#e0642a",
};

const retry: ChoiceQuestion = {
  header: "Retry",
  question: "Should the relay retry per test or the whole job?",
  options: [
    { label: "Per test, at most twice", description: "Hides only the flaky one." },
    { label: "The whole job", description: "A real failure can slip through." },
    { label: "No retry" },
  ],
};
const anythingElse: ChoiceQuestion = { question: "Anything else to change?", options: [] };
const approval: ChoiceQuestion = {
  question: "fallback",
  options: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
  approval: { tool: "Bash", detail: "rm -rf build" },
};

function build(over: Partial<ChoiceModelInput> = {}) {
  return buildChoicePayload({
    dict: en,
    theme,
    promptId: "prompt-1",
    kind: "choice",
    questions: [retry, anythingElse],
    flow: INITIAL_CHOICE_FLOW,
    fieldText: "",
    disabled: false,
    ...over,
  });
}

describe("buildChoicePayload", () => {
  it("is exactly the shared fixture the Rust side round-trips", () => {
    const flow: ChoiceFlow = toggleOption(INITIAL_CHOICE_FLOW, retry, "Per test, at most twice");
    expect({ choice: build({ flow }) }).toEqual(fixture);
  });

  describe("the step", () => {
    it("is keyed by prompt and question, so a new one resets the native field", () => {
      expect(build().stepKey).toBe("prompt-1:0");
      expect(build({ flow: goTo(INITIAL_CHOICE_FLOW, 1) }).stepKey).toBe("prompt-1:1");
      expect(build({ promptId: "prompt-2" }).stepKey).toBe("prompt-2:0");
      expect(build({ flow: goTo(INITIAL_CHOICE_FLOW, 1) }).stepKey).toBe(choiceStepKey("prompt-1", 1));
    });

    it("has a position and a way back only when there is more than one question", () => {
      expect(build({ questions: [retry] }).position).toBeNull();
      const second = build({ flow: goTo(INITIAL_CHOICE_FLOW, 1) });
      expect(second.position).toBe("2 of 2");
      expect(second.canGoBack).toBe(true);
      expect(build().canGoBack).toBe(false);
    });

    it("moves on with Next and sends on the last question", () => {
      expect(build().submitLabel).toBe(en.chat.choice.next);
      expect(build({ flow: goTo(INITIAL_CHOICE_FLOW, 1) }).submitLabel).toBe(en.common.send);
      expect(build({ questions: [retry] }).submitLabel).toBe(en.common.send);
    });
  });

  describe("the kicker and the composer row", () => {
    it("use the question's own header when it has one, else name the kind of prompt", () => {
      expect(build().kicker).toBe("Retry");
      expect(build({ flow: goTo(INITIAL_CHOICE_FLOW, 1) }).kicker).toBe(en.chat.choice.kickerQuestion);
      expect(build({ kind: "approval", questions: [approval] }).kicker).toBe(en.chat.choice.kickerApproval);
    });

    it("tell a pending approval from a pending question", () => {
      expect(build().banner.label).toBe(en.chat.choice.pending);
      expect(build({ kind: "approval", questions: [approval] }).banner.label).toBe(en.chat.choice.pendingApproval);
    });

    it("show the question on screen, in the user's language", () => {
      const payload = build({ dict: pt, kind: "approval", questions: [approval] });
      const sentence = pt.chat.approval.toolCall.replace("{tool}", "Bash").replace("{detail}", "rm -rf build");
      expect(payload.question).toBe(sentence);
      expect(payload.banner.text).toBe(sentence);
      expect(payload.banner.openLabel).toBe(pt.chat.choice.open);
    });
  });

  describe("options", () => {
    it("print the relay's own options from the dictionary and mark the selected one by its id", () => {
      const flow = toggleOption(INITIAL_CHOICE_FLOW, approval, "deny");
      const payload = build({ dict: pt, kind: "approval", questions: [approval], flow });
      expect(payload.options).toEqual([
        { label: pt.chat.approval.approve, description: null, selected: false },
        { label: pt.chat.approval.deny, description: null, selected: true },
      ]);
    });

    it("say whether more than one can be picked", () => {
      expect(build().multiSelect).toBe(false);
      expect(build({ questions: [{ ...retry, multiSelect: true }] }).multiSelect).toBe(true);
    });

    it("step back once free text is the answer", () => {
      expect(build().optionsDimmed).toBe(false);
      expect(build({ flow: setCustomText(INITIAL_CHOICE_FLOW, "Only on CI") }).optionsDimmed).toBe(true);
      expect(build({ flow: setCustomText(INITIAL_CHOICE_FLOW, "   ") }).optionsDimmed).toBe(false);
    });
  });

  describe("the free-text field", () => {
    it("is there for a choice prompt, opening with the text given for this question", () => {
      expect(build({ fieldText: "Only on CI" }).custom).toEqual({
        text: "Only on CI",
        placeholder: en.chat.choice.customPlaceholder,
        label: en.chat.choice.customLabel,
        secret: false,
      });
    });

    it("doesn't follow what is being typed, so typing doesn't change the payload", () => {
      const typing = build({ flow: setCustomText(INITIAL_CHOICE_FLOW, "Only on C"), fieldText: "" });
      const typed = build({ flow: setCustomText(INITIAL_CHOICE_FLOW, "Only on CI"), fieldText: "" });
      expect(typing.custom?.text).toBe("");
      expect(typed).toEqual(typing);
    });

    it("is not there for an approval with options to match against", () => {
      expect(build({ kind: "approval", questions: [approval] }).custom).toBeNull();
    });

    it("is there, masked, for an approval asking for a secret", () => {
      const secret: ChoiceQuestion = { question: "Token?", options: [], secret: true };
      expect(build({ kind: "approval", questions: [secret] }).custom?.secret).toBe(true);
    });
  });

  it("holds answering back while the relay can't be reached, and says why", () => {
    const offline = build({ disabled: true });
    expect(offline.canAnswer).toBe(false);
    expect(offline.status).toBe(en.chat.connection.sendBlocked);
    const online = build();
    expect(online.canAnswer).toBe(true);
    expect(online.status).toBeNull();
  });
});
