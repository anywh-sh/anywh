import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceCard } from "./ChoiceCard";
import type { ChoiceQuestion } from "@/lib/relayClient";
import { en } from "@/i18n/en";

afterEach(() => cleanup());

function question(overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion {
  return { question: "Qual abordagem?", options: [{ label: "A" }, { label: "B" }], ...overrides };
}

describe("ChoiceCard", () => {
  it("offers a free-text field as the last option for a `choice` prompt", () => {
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText(en.chat.choice.customLabel)).toBeInTheDocument();
  });

  it("does not offer the free-text field for an `approval` prompt (its answer must match a fixed label)", () => {
    render(
      <ChoiceCard
        promptId="p1"
        questions={[question({ options: [{ label: "Aprovar" }, { label: "Recusar" }] })]}
        kind="approval"
        onAnswer={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(en.chat.choice.customLabel)).toBeNull();
  });

  it("sends the typed text as the answer instead of any checked option", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={onAnswer} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(en.chat.choice.customLabel), "faz do jeito B mas só pra esse caso");
    await user.click(screen.getByRole("button", { name: en.chat.choice.submit }));

    expect(onAnswer).toHaveBeenCalledWith([{ question: "Qual abordagem?", selected: ["faz do jeito B mas só pra esse caso"] }]);
  });

  it("typing custom text clears an already-checked option, and vice versa", async () => {
    const user = userEvent.setup();
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={vi.fn()} onClose={vi.fn()} />);

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
    render(<ChoiceCard promptId="p1" questions={[question()]} kind="choice" onAnswer={onAnswer} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(en.chat.choice.customLabel), "resposta rápida{Enter}");

    expect(onAnswer).toHaveBeenCalledWith([{ question: "Qual abordagem?", selected: ["resposta rápida"] }]);
  });

  it("keeps custom text per question when navigating back and forth", async () => {
    const user = userEvent.setup();
    const questions = [question({ question: "Pergunta 1" }), question({ question: "Pergunta 2" })];
    render(<ChoiceCard promptId="p1" questions={questions} kind="choice" onAnswer={vi.fn()} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(en.chat.choice.customLabel), "resposta da 1");
    // Two buttons share this label when there's more than one question and this
    // isn't the last one (the header's nav chevron and the footer's confirm
    // arrow) — the header chevron is the one that renders first in the DOM.
    await user.click(screen.getAllByRole("button", { name: en.chat.choice.nextQuestion })[0]);
    expect(screen.getByLabelText(en.chat.choice.customLabel)).toHaveValue("");

    await user.click(screen.getByRole("button", { name: en.chat.choice.previousQuestion }));
    expect(screen.getByLabelText(en.chat.choice.customLabel)).toHaveValue("resposta da 1");
  });
});
