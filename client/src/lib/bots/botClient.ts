import type { Profile } from "@/lib/profiles/profiles";
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";
import type { BotSummary, BotView, MemoryLine } from "@/lib/bots/botTypes";
import type { MascotChoice } from "@/lib/bots/mascot";

// The relay's `/bots` routes (see its `routes/bots.ts`).

export class BotRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BotRequestError";
  }
}

async function call<T>(profile: Profile, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const { host, port, token } = await resolveConnection(profile);
  const response = await fetch(`http://${host}:${String(port)}${path}`, {
    method: init?.method ?? "GET",
    headers: { ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }), ...authHeaders(token) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new BotRequestError(body.error ?? `request failed (${String(response.status)})`, response.status);
  return body;
}

const path = (id: string): string => `/bots/${encodeURIComponent(id)}`;

export interface CreateBotInput {
  name: string;
  soul: string;
  mascot?: MascotChoice;
  templateId?: string;
  schedules?: { name: string; cron: string; prompt: string; paused?: boolean }[];
  agentId?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  cwd?: string;
}

export async function createBot(profile: Profile, input: CreateBotInput): Promise<BotSummary> {
  return (await call<{ bot: BotSummary }>(profile, "/bots", { method: "POST", body: input })).bot;
}

export async function fetchBot(profile: Profile, id: string): Promise<{ bot: BotView; soul: string; memory: MemoryLine[] }> {
  return call(profile, path(id));
}

export async function patchBot(profile: Profile, id: string, input: { name?: string; mascot?: MascotChoice; paused?: boolean; soul?: string }): Promise<BotSummary> {
  return (await call<{ bot: BotSummary }>(profile, path(id), { method: "PATCH", body: input })).bot;
}

export async function deleteBot(profile: Profile, id: string): Promise<void> {
  await call(profile, path(id), { method: "DELETE" });
}

export async function editMemoryLine(profile: Profile, id: string, index: number, text: string | null): Promise<MemoryLine[]> {
  const result = await call<{ memory: MemoryLine[] }>(profile, `${path(id)}/memory/${String(index)}`, text === null ? { method: "DELETE" } : { method: "PATCH", body: { text } });
  return result.memory;
}

export async function answerTask(profile: Profile, id: string, n: number, answer: string): Promise<void> {
  await call(profile, `${path(id)}/tasks/${String(n)}/answer`, { method: "POST", body: { answer } });
}

export async function cancelTask(profile: Profile, id: string, n: number): Promise<void> {
  await call(profile, `${path(id)}/tasks/${String(n)}/cancel`, { method: "POST" });
}

export async function setSchedulePaused(profile: Profile, id: string, scheduleId: string, paused: boolean): Promise<void> {
  await call(profile, `${path(id)}/schedules/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: { paused } });
}

export async function removeSchedule(profile: Profile, id: string, scheduleId: string): Promise<void> {
  await call(profile, `${path(id)}/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
}

export async function runScheduleNow(profile: Profile, id: string, scheduleId: string): Promise<void> {
  await call(profile, `${path(id)}/schedules/${encodeURIComponent(scheduleId)}/run`, { method: "POST" });
}
