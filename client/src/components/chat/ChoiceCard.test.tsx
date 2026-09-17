import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceCard } from "./ChoiceCard";
import type { ChoiceQuestion } from "@/lib/relay/relayClient";
import { en } from "@/i18n/en";

afterEach(() => cleanup());

function question(overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion {
  return { question: "Qual abordagem?", options: [{ label: "A" }, { label: "B" }], ...overrides };
}

describe("ChoiceCard", () => {
  it("offers a free-text field as the last option for a `choice` prompt", () => {
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={vi.fn()} />);
    expect(screen.getByLabelText(en.chat.choice.customLabel)).toBeInTheDocument();
  });

  it("does not offer the free-text field for an `approval` prompt with real options (its answer must match a fixed label)", () => {
    render(
      <ChoiceCard
        promptId="p1"
        questions={[question({ options: [{ label: "Aprovar" }, { label: "Recusar" }] })]}
        kind="approval"
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(en.chat.choice.customLabel)).toBeNull();
  });

  it("offers the free-text field for an `approval` prompt with NO options — a native user-input question asking for free text", () => {
    render(<ChoiceCard promptId="p1" questions={[question({ options: [] })]} kind="approval" onAnswer={vi.fn()} />);
    expect(screen.getByLabelText(en.chat.choice.customLabel)).toBeInTheDocument();
  });

  it("masks the free-text field for a question marked secret", () => {
    render(<ChoiceCard promptId="p1" questions={[question({ options: [], secret: true })]} kind="approval" onAnswer={vi.fn()} />);
    expect(screen.getByLabelText(en.chat.choice.customLabel)).toHaveAttribute("type", "password");
  });

  it("sends the typed text as the answer instead of any checked option", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={onAnswer} />);

    await user.type(screen.getByLabelText(en.chat.choice.customLabel), "faz do jeito B mas só pra esse caso");
    await user.click(screen.getByRole("button", { name: en.chat.choice.submit }));

    expect(onAnswer).toHaveBeenCalledWith([{ question: "Qual abordagem?", selected: ["faz do jeito B mas só pra esse caso"] }]);
  });

  it("typing custom text clears an already-checked option, and vice versa", async () => {
    const user = userEvent.setup();
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={vi.fn()} />);

    await user.click(screen.getByText("A"));
    expect(screen.getByText(en.chat.choice.selectedCount.replace("{count}", "1"))).toBeInTheDocument();

    const input = screen.getByLabelText(en.chat.choice.customLabel);
    await user.type(input, "outra coisa");
    expect(screen.getByText(en.chat.choice.customAnswer)).toBeInTheDocument();

    await user.click(screen.getByText("B"));
    expect(input).toHaveValue("");
    expect(screen.getByText(en.chat.choice.selectedCount.replace("{count}", "1"))).toBeInTheDocument();
  });

  it("submits on Enter inside the free-text field", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={onAnswer} />);

    await user.type(screen.getByLabelText(en.chat.choice.customLabel), "resposta rápida{Enter}");

    expect(onAnswer).toHaveBeenCalledWith([{ question: "Qual abordagem?", selected: ["resposta rápida"] }]);
  });

  it("keeps custom text per question when navigating back and forth", async () => {
    const user = userEvent.setup();
    const questions = [question({ question: "Pergunta 1" }), question({ question: "Pergunta 2" })];
    render(<ChoiceCard promptId="p1" questions={questions} kind="choice" onAnswer={vi.fn()} />);

    await user.type(screen.getByLabelText(en.chat.choice.customLabel), "resposta da 1");
    // Two buttons share this label when there's more than one question and this
    // isn't the last one (the header's nav chevron and the footer's confirm
    // arrow) — the header chevron is the one that renders first in the DOM.
    await user.click(screen.getAllByRole("button", { name: en.chat.choice.nextQuestion })[0]);
    expect(screen.getByLabelText(en.chat.choice.customLabel)).toHaveValue("");

    await user.click(screen.getByRole("button", { name: en.chat.choice.previousQuestion }));
    expect(screen.getByLabelText(en.chat.choice.customLabel)).toHaveValue("resposta da 1");
  });

  it("collapses a `choice` prompt to a reopenable indicator instead of discarding it", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={onAnswer} />);

    await user.click(screen.getByText("A"));
    await user.click(screen.getByRole("button", { name: en.chat.choice.collapse }));

    expect(screen.queryByText("A")).toBeNull();
    expect(screen.getByText(en.chat.choice.pending)).toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: en.chat.choice.reopen }));
    expect(screen.getByText(en.chat.choice.selectedCount.replace("{count}", "1"))).toBeInTheDocument();
  });

  it("an `approval` prompt has no collapse button — closing it answers instead", () => {
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="approval" onAnswer={vi.fn()} />);
    expect(screen.queryByRole("button", { name: en.chat.choice.collapse })).toBeNull();
    expect(screen.getByRole("button", { name: en.chat.choice.closeAnswering })).toBeInTheDocument();
  });

  it("renders Codex's fixed decision ids with their own localized labels, not the wire's English fallback", () => {
    render(
      <ChoiceCard
        promptId="p1"
        questions={[
          question({
            options: [
              { id: "accept", label: "Accept" },
              { id: "acceptForSession", label: "Accept for this session" },
              { id: "decline", label: "Decline" },
              { id: "cancel", label: "Cancel" },
            ],
          }),
        ]}
        kind="approval"
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByText(en.chat.approval.codexAccept)).toBeInTheDocument();
    expect(screen.getByText(en.chat.approval.codexAcceptForSession)).toBeInTheDocument();
    expect(screen.getByText(en.chat.approval.codexDecline)).toBeInTheDocument();
    expect(screen.getByText(en.chat.approval.codexCancel)).toBeInTheDocument();
  });

  it("composes a Codex command approval's question from its structured parts, including the reason", () => {
    render(
      <ChoiceCard
        promptId="p1"
        questions={[question({ approval: { tool: "command", detail: "rm -rf build", reason: "cleanup" } })]}
        kind="approval"
        onAnswer={vi.fn()}
      />,
    );
    const expected = `${en.chat.approval.codexCommand.replace("{detail}", "rm -rf build")} ${en.chat.approval.reasonSuffix.replace("{reason}", "cleanup")}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("composes a Codex file-change approval's question, with no reason suffix when the engine gave none", () => {
    render(
      <ChoiceCard
        promptId="p1"
        questions={[question({ approval: { tool: "fileChange", detail: "/tmp/project/build" } })]}
        kind="approval"
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByText(en.chat.approval.codexFileChange.replace("{detail}", "/tmp/project/build"))).toBeInTheDocument();
  });

  it("ArrowDown/ArrowUp move focus between options", async () => {
    const user = userEvent.setup();
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={vi.fn()} />);

    const optionA = screen.getByText("A").closest("button");
    const optionB = screen.getByText("B").closest("button");
    optionA?.focus();

    await user.keyboard("{ArrowDown}");
    expect(optionB).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(optionA).toHaveFocus();
  });
});
