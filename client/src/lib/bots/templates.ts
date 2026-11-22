import type { Dictionary } from "@/i18n";
import type { MascotChoice } from "@/lib/bots/mascot";

// The templates a new bot can start from. Their words (name, soul, the
// schedule's name) are the person's language, from the dictionary; the
// schedule's prompt is an instruction to the agent, in English like every
// other text the relay sends a model. A template's schedule is created off:
// the person turns it on.

export type BotTemplateId = keyof Dictionary["bots"]["templates"];

export interface BotTemplate {
  id: BotTemplateId;
  /** The face a bot from it starts with; the person can pick another. */
  mascot: MascotChoice;
  cron: string;
  prompt: string;
}

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "ci-check",
    mascot: { character: "bip", tone: "areia" },
    cron: "0 9-18 * * 1-5",
    prompt:
      "Check the latest CI runs of the main branch of the repositories you watch (gh run list --branch main). If the latest run failed, read its log, decide whether it is a flaky test or a real failure, create a task for it and hand the fix to an agent on a branch. If you do not know yet which repositories to watch, ask the person.",
  },
  {
    id: "pr-review",
    mascot: { character: "oculos", tone: "giz" },
    cron: "0 9-18 * * 1-5",
    prompt:
      "List the open pull requests where the person's review is requested (gh search prs --review-requested=@me --state=open). For each one you have not looked at yet, read the diff and the discussion, create a task and write a short draft review in it. Do not comment on GitHub.",
  },
  {
    id: "issue-triage",
    mascot: { character: "visor", tone: "rosa" },
    cron: "0 9 * * 1-5",
    prompt: "Read the issues opened since your last triage in the repositories you watch. Suggest labels, point out duplicates and flag what is urgent. Change nothing on GitHub.",
  },
  {
    id: "daily-summary",
    mascot: { character: "fone", tone: "salvia" },
    cron: "0 9 * * 1-5",
    prompt:
      "Summarize what changed since the previous weekday in the repositories you watch: pull requests merged and still open, new issues, the state of CI. Five lines at most, the most important first.",
  },
  {
    id: "backlog-cleanup",
    mascot: { character: "capacete", tone: "pedra" },
    cron: "0 9 1 * *",
    prompt: "List the open issues untouched for 60 days, likely duplicates and ones that look already fixed. Propose which to close in a task and change nothing until the person confirms.",
  },
];
