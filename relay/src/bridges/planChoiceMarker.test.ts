import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPlanChoiceAnswerText, parsePlanChoiceMarkers } from "./planChoiceMarker.js";

test("no marker present: empty list, doesn't false-positive on ordinary prose", () => {
  const text = "Aqui está o plano:\n1. Fazer X\n2. Fazer Y\n\nQuer que eu prossiga?";
  assert.deepEqual(parsePlanChoiceMarkers(text), []);
});

test("single marker: parses question and options, ignores surrounding prose", () => {
  const text =
    "Vou precisar decidir uma coisa antes de continuar o plano.\n\n" +
    ">>>QUESTION: JWT ou sessão de servidor?\n" +
    "- JWT\n" +
    "- Sessão de servidor\n" +
    ">>>END\n\n" +
    "Aguardando sua resposta.";
  assert.deepEqual(parsePlanChoiceMarkers(text), [
    { question: "JWT ou sessão de servidor?", options: [{ label: "JWT" }, { label: "Sessão de servidor" }] },
  ]);
});

test("multiple markers in one response: one ChoiceQuestion per block, in order", () => {
  const text =
    ">>>QUESTION: Primeira pergunta?\n" +
    "- A\n" +
    "- B\n" +
    ">>>END\n" +
    "texto no meio\n" +
    ">>>QUESTION: Segunda pergunta?\n" +
    "- C\n" +
    "- D\n" +
    ">>>END\n";
  assert.deepEqual(parsePlanChoiceMarkers(text), [
    { question: "Primeira pergunta?", options: [{ label: "A" }, { label: "B" }] },
    { question: "Segunda pergunta?", options: [{ label: "C" }, { label: "D" }] },
  ]);
});

test("marker with no options: dropped, nothing sensible to render", () => {
  const text = ">>>QUESTION: Pergunta sem opções?\n>>>END\n";
  assert.deepEqual(parsePlanChoiceMarkers(text), []);
});

test("formatPlanChoiceAnswerText: single question uses just the selected labels", () => {
  assert.equal(formatPlanChoiceAnswerText([{ question: "JWT ou sessão?", selected: ["JWT"] }]), "JWT");
});

test("formatPlanChoiceAnswerText: multiple questions are prefixed with the question text", () => {
  const text = formatPlanChoiceAnswerText([
    { question: "Primeira?", selected: ["A"] },
    { question: "Segunda?", selected: ["C", "D"] },
  ]);
  assert.equal(text, "Primeira?: A\nSegunda?: C, D");
});

test("formatPlanChoiceAnswerText: empty selection (skipped question) still produces text", () => {
  assert.equal(formatPlanChoiceAnswerText([{ question: "Pulada?", selected: [] }]), "(nenhuma opção selecionada)");
});
