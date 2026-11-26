import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { PendingChoice } from "@/hooks/relay/useRelayClient";
import type { NativeChoicePayload } from "@/lib/platform/nativeChoice";

// The native sheet is the boundary here: stand in for the plugin's IPC, keeping
// the handlers the component registers so a test can fire what native would.
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => void>(),
  payloads: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { payload: { choice: unknown } }) => {
    if (cmd === "plugin:native-chrome|set_choice") ipc.payloads.push(args.payload.choice);
    return Promise.resolve();
  },
  addPluginListener: (_plugin: string, event: string, cb: (event: unknown) => void) => {
    ipc.handlers.set(event, cb);
    return Promise.resolve({ unregister: () => Promise.resolve(ipc.handlers.delete(event)) });
  },
}));

import { NativeChoiceSheet } from "./NativeChoiceSheet";

const twoQuestions: PendingChoice = {
  promptId: "p1",
  kind: "choice",
  questions: [
    { question: "Retry per test or per job?", options: [{ label: "Per test" }, { label: "Per job" }] },
    { question: "Anything else?", options: [] },
  ],
};

function lastPayload(): NativeChoicePayload | null {
  return ipc.payloads[ipc.payloads.length - 1] as NativeChoicePayload | null;
}

async function mount(prompt: PendingChoice | null = twoQuestions) {
  const onAnswer = vi.fn();
  const view = render(<NativeChoiceSheet prompt={prompt} disabled={false} onAnswer={onAnswer} />);
  await waitFor(() => expect(ipc.handlers.has("choiceSubmit")).toBe(true));
  return { onAnswer, view };
}

function fire(event: string, data: Record<string, unknown>) {
  act(() => ipc.handlers.get(event)!(data));
}

afterEach(() => {
  cleanup();
  ipc.handlers.clear();
  ipc.payloads.length = 0;
});

describe("NativeChoiceSheet", () => {
  it("sends the question on screen, and takes it away when unmounted", async () => {
    const { view } = await mount();
    await waitFor(() => expect(lastPayload()?.stepKey).toBe("p1:0"));
    view.unmount();
    expect(lastPayload()).toBeNull();
  });

  it("steps through the questions and answers once at the end", async () => {
    const { onAnswer } = await mount();
    fire("choiceToggleOption", { stepKey: "p1:0", index: 1 });
    fire("choiceSubmit", { stepKey: "p1:0" });
    await waitFor(() => expect(lastPayload()?.stepKey).toBe("p1:1"));
    fire("choiceCustomTextChange", { stepKey: "p1:1", text: "Cache npm" });
    fire("choiceSubmit", { stepKey: "p1:1" });
    expect(onAnswer).toHaveBeenCalledWith([
      { question: "Retry per test or per job?", selected: ["Per job"] },
      { question: "Anything else?", selected: ["Cache npm"] },
    ]);
  });

  it("answers a prompt once, even when a second Send lands before the answer clears it", async () => {
    const { onAnswer } = await mount({ ...twoQuestions, questions: [twoQuestions.questions[0]] });
    fire("choiceToggleOption", { stepKey: "p1:0", index: 0 });
    fire("choiceSubmit", { stepKey: "p1:0" });
    fire("choiceSubmit", { stepKey: "p1:0" });
    fire("choiceSkip", { stepKey: "p1:0" });
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("drops a tap made on a question that is no longer on screen", async () => {
    const { onAnswer } = await mount();
    fire("choiceSubmit", { stepKey: "p1:0" });
    // The second tap of a double tap on Next, made while the first question
    // was still drawn: it must not skip the second one.
    fire("choiceSubmit", { stepKey: "p1:0" });
    fire("choiceToggleOption", { stepKey: "p1:0", index: 1 });
    expect(onAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(lastPayload()?.stepKey).toBe("p1:1"));
    fire("choicePrevious", { stepKey: "p1:1" });
    await waitFor(() => expect(lastPayload()?.stepKey).toBe("p1:0"));
    expect(lastPayload()?.options.map((option) => option.selected)).toEqual([false, false]);
  });

  it("doesn't resend the payload for every keystroke", async () => {
    await mount();
    fire("choiceCustomTextChange", { stepKey: "p1:0", text: "O" });
    await waitFor(() => expect(lastPayload()?.optionsDimmed).toBe(true));
    const sent = ipc.payloads.length;
    fire("choiceCustomTextChange", { stepKey: "p1:0", text: "On" });
    fire("choiceCustomTextChange", { stepKey: "p1:0", text: "Onl" });
    fire("choiceCustomTextChange", { stepKey: "p1:0", text: "Only" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ipc.payloads.length).toBe(sent);
    expect(lastPayload()?.custom?.text).toBe("");
  });

  it("brings the typed text back to the field when stepping back to its question", async () => {
    await mount();
    fire("choiceCustomTextChange", { stepKey: "p1:0", text: "Neither" });
    fire("choiceSubmit", { stepKey: "p1:0" });
    await waitFor(() => expect(lastPayload()?.stepKey).toBe("p1:1"));
    expect(lastPayload()?.custom?.text).toBe("");
    fire("choicePrevious", { stepKey: "p1:1" });
    await waitFor(() => expect(lastPayload()?.stepKey).toBe("p1:0"));
    expect(lastPayload()?.custom?.text).toBe("Neither");
  });

  it("starts over on a new prompt", async () => {
    const { view, onAnswer } = await mount();
    fire("choiceSubmit", { stepKey: "p1:0" });
    await waitFor(() => expect(lastPayload()?.stepKey).toBe("p1:1"));
    view.rerender(<NativeChoiceSheet prompt={{ ...twoQuestions, promptId: "p2" }} disabled={false} onAnswer={onAnswer} />);
    await waitFor(() => expect(lastPayload()?.stepKey).toBe("p2:0"));
  });
});
