import { beforeEach, describe, expect, it, vi } from "vitest";

const counted = vi.hoisted(() => [] as { name: string; props: Record<string, unknown> }[]);
vi.mock("@/lib/telemetry", () => {
  const record = (name: string, props: Record<string, unknown>) => {
    counted.push({ name, props });
    return "sent";
  };
  return { telemetry: { available: true, track: record, trackDaily: (_k: string, n: string, p: Record<string, unknown>) => record(n, p), trackOnce: (_k: string, n: string, p: Record<string, unknown>) => record(n, p) } };
});

const { closeNewBot, noteBotCreated, noteBotCreateFailed, noteBotCreateGated, openNewBot } = await import("@/lib/bots/newBotRequest");
const { validateEvent } = await import("@/lib/telemetry/events");

const named = (name: string) => counted.filter((event) => event.name === name).map((event) => event.props);

beforeEach(() => {
  closeNewBot();
  counted.length = 0;
});

describe("the bot creation funnel", () => {
  it("an opening that ends with a bot: where it came from, the template, the agent and the schedule", () => {
    openNewBot({ profileId: "p", templateId: "daily-summary", source: "templates" });
    noteBotCreateFailed("no_host");
    noteBotCreated("codex", true);
    closeNewBot();
    expect(named("bot_create_opened")).toEqual([{ source: "templates", template: "daily-summary" }]);
    expect(named("bot_create_ended")).toEqual([
      expect.objectContaining({ outcome: "created", template: "daily-summary", runtime: "codex", schedule_on: true, gated: false, failed_attempts: 1, last_failure: "no_host" }),
    ]);
    expect(named("error_shown")).toEqual([{ kind: "bot_create_failed" }]);
    for (const { name, props } of counted) expect(validateEvent(name, props), `${name} ${JSON.stringify(props)}`).not.toBeNull();
  });

  it("an opening closed without a bot is abandoned, saying the relay was too old when it was", () => {
    openNewBot({ profileId: "p" });
    noteBotCreateGated();
    closeNewBot();
    expect(named("bot_create_opened")).toEqual([{ source: "other", template: "blank" }]);
    expect(named("bot_create_ended")).toEqual([expect.objectContaining({ outcome: "abandoned", template: "blank", gated: true, failed_attempts: 0, schedule_on: false })]);
    expect(named("bot_create_ended")[0]).not.toHaveProperty("runtime");
  });

  it("going to the templates from the dialog and creating from one is one attempt, not an abandonment", () => {
    openNewBot({ profileId: "p", source: "sidebar" });
    closeNewBot({ toTemplates: true });
    openNewBot({ profileId: "p", templateId: "pr-review", source: "templates" });
    noteBotCreated("claude", false);
    closeNewBot();
    expect(named("bot_create_opened")).toEqual([{ source: "sidebar", template: "blank" }]);
    expect(named("bot_create_ended")).toEqual([expect.objectContaining({ outcome: "created", template: "pr-review" })]);
  });

  it("going to the templates and then opening the dialog some other way ends the first attempt", () => {
    openNewBot({ profileId: "p", source: "sidebar" });
    closeNewBot({ toTemplates: true });
    openNewBot({ profileId: "p", source: "first_card" });
    closeNewBot();
    expect(named("bot_create_ended").map((p) => p.outcome)).toEqual(["abandoned", "abandoned"]);
    expect(named("bot_create_opened").map((p) => p.source)).toEqual(["sidebar", "first_card"]);
  });

  it("opened again over itself, the earlier opening ends once; a second close counts nothing", () => {
    openNewBot({ profileId: "p", source: "sidebar" });
    openNewBot({ profileId: "p", templateId: "ci-check", source: "templates" });
    closeNewBot();
    closeNewBot();
    expect(named("bot_create_ended").map((p) => p.template)).toEqual(["blank", "ci-check"]);
  });
});
