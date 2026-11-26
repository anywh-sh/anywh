import { describe, expect, it } from "vitest";
import type { ChoiceQuestion } from "@/lib/relay/relayClient";
import { INITIAL_CHOICE_FLOW, answersFor, confirmCurrent, effectiveSelection, goTo, setCustomText, toggleOption, type ChoiceFlow } from "./choiceFlow";

const single: ChoiceQuestion = { question: "Retry per test or per job?", options: [{ label: "Per test" }, { label: "Per job" }] };
const multi: ChoiceQuestion = { question: "Which platforms?", multiSelect: true, options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }] };
const free: ChoiceQuestion = { question: "Anything else?", options: [] };

function next(flow: ChoiceFlow, questions: ChoiceQuestion[], selection: string[]): ChoiceFlow {
  const outcome = confirmCurrent(flow, questions, selection);
  if (outcome.kind !== "next") throw new Error("expected the next question");
  return outcome.flow;
}

describe("choiceFlow", () => {
  it("starts on the first question with nothing chosen", () => {
    expect(INITIAL_CHOICE_FLOW.index).toBe(0);
    expect(effectiveSelection(INITIAL_CHOICE_FLOW)).toEqual([]);
  });

  describe("toggleOption", () => {
    it("holds at most one option on a single-select question, and a second tap unchecks it", () => {
      const one = toggleOption(INITIAL_CHOICE_FLOW, single, "Per test");
      expect(one.selected).toEqual(["Per test"]);
      expect(toggleOption(one, single, "Per job").selected).toEqual(["Per job"]);
      expect(toggleOption(one, single, "Per test").selected).toEqual([]);
    });

    it("adds and removes options independently on a multi-select question", () => {
      const two = toggleOption(toggleOption(INITIAL_CHOICE_FLOW, multi, "macOS"), multi, "Linux");
      expect(two.selected).toEqual(["macOS", "Linux"]);
      expect(toggleOption(two, multi, "macOS").selected).toEqual(["Linux"]);
    });

    it("drops the free text typed for this question", () => {
      const typed = setCustomText(INITIAL_CHOICE_FLOW, "Neither");
      const picked = toggleOption(typed, single, "Per job");
      expect(picked.customText).toBe("");
      expect(picked.customTexts.has(0)).toBe(false);
      expect(effectiveSelection(picked)).toEqual(["Per job"]);
    });
  });

  describe("setCustomText", () => {
    it("unchecks the options once there is text, and the text becomes the answer", () => {
      const picked = toggleOption(INITIAL_CHOICE_FLOW, single, "Per test");
      const typed = setCustomText(picked, "  Only flaky ones ");
      expect(typed.selected).toEqual([]);
      expect(effectiveSelection(typed)).toEqual(["Only flaky ones"]);
    });

    it("keeps the options while the text is only blank", () => {
      const picked = toggleOption(INITIAL_CHOICE_FLOW, single, "Per test");
      const blank = setCustomText(picked, "   ");
      expect(blank.selected).toEqual(["Per test"]);
      expect(effectiveSelection(blank)).toEqual(["Per test"]);
    });
  });

  describe("confirmCurrent", () => {
    it("finishes a one-question prompt with the selection", () => {
      expect(confirmCurrent(toggleOption(INITIAL_CHOICE_FLOW, single, "Per job"), [single], ["Per job"])).toEqual({
        kind: "done",
        answers: [{ question: single.question, selected: ["Per job"] }],
      });
    });

    it("steps to the next question, then answers all of them at once", () => {
      const questions = [single, multi, free];
      let flow = next(INITIAL_CHOICE_FLOW, questions, ["Per test"]);
      expect(flow.index).toBe(1);
      expect(flow.selected).toEqual([]);
      flow = next(flow, questions, ["Linux", "Windows"]);
      expect(confirmCurrent(flow, questions, ["Ship it"])).toEqual({
        kind: "done",
        answers: [
          { question: single.question, selected: ["Per test"] },
          { question: multi.question, selected: ["Linux", "Windows"] },
          { question: free.question, selected: ["Ship it"] },
        ],
      });
    });

    it("an empty selection is a skip: the question is answered with nothing", () => {
      const outcome = confirmCurrent(next(INITIAL_CHOICE_FLOW, [single, free], []), [single, free], []);
      expect(outcome).toEqual({
        kind: "done",
        answers: [
          { question: single.question, selected: [] },
          { question: free.question, selected: [] },
        ],
      });
    });
  });

  describe("goTo", () => {
    it("brings back what was confirmed and typed on a question when stepping back to it", () => {
      const questions = [free, single];
      const typed = setCustomText(INITIAL_CHOICE_FLOW, "Add a flag");
      const onSecond = next(typed, questions, effectiveSelection(typed));
      const back = goTo(onSecond, 0);
      expect(back.index).toBe(0);
      expect(back.customText).toBe("Add a flag");
      expect(effectiveSelection(back)).toEqual(["Add a flag"]);
    });

    it("brings back the selection of a question confirmed earlier when stepping forward again", () => {
      const questions = [single, multi];
      const onSecond = next(INITIAL_CHOICE_FLOW, questions, ["Per job"]);
      const picked = toggleOption(onSecond, multi, "macOS");
      const confirmedSecond = { ...picked, answers: new Map(picked.answers).set(1, ["macOS"]) };
      const forward = goTo(goTo(confirmedSecond, 0), 1);
      expect(forward.selected).toEqual(["macOS"]);
    });
  });

  it("answersFor fills every question never reached with an empty selection", () => {
    expect(answersFor([single, multi], new Map([[0, ["Per test"]]]))).toEqual([
      { question: single.question, selected: ["Per test"] },
      { question: multi.question, selected: [] },
    ]);
  });
});
