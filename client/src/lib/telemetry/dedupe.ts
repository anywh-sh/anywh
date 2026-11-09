/**
 * Once-a-day and once-ever markers, kept in `localStorage`: the adoption
 * events count installations, not how hard each one clicks, so a feature is
 * reported the first time it is used on a given local day and `app_active`
 * once per day the app is open.
 */

const STORAGE_KEY = "anywh:telemetry-marks";

interface Marks {
  /** Local day (`YYYY-MM-DD`) each daily key last fired on. */
  daily: Record<string, string>;
  /** Keys that fired once and never again. */
  once: Record<string, true>;
  /** When this installation first opened, ms since the epoch. */
  firstOpenAt?: number;
  /** The version the app last booted as, for `update_installed`. */
  lastBootVersion?: string;
}

function read(): Marks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = parsed as Partial<Marks>;
      return {
        daily: typeof candidate.daily === "object" && candidate.daily !== null ? candidate.daily : {},
        once: typeof candidate.once === "object" && candidate.once !== null ? candidate.once : {},
        firstOpenAt: typeof candidate.firstOpenAt === "number" ? candidate.firstOpenAt : undefined,
        lastBootVersion: typeof candidate.lastBootVersion === "string" ? candidate.lastBootVersion : undefined,
      };
    }
  } catch {
    // Unreadable marks count as none: a repeat event is the worst outcome.
  }
  return { daily: {}, once: {} };
}

function write(marks: Marks): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  } catch {
    // Storage full or blocked: the marks are best-effort.
  }
}

/** The user's calendar day, not UTC's — "once a day" is the day they live. */
export function localDay(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export function dailyDue(key: string, now: number): boolean {
  return read().daily[key] !== localDay(now);
}

export function markDaily(key: string, now: number): void {
  const marks = read();
  marks.daily[key] = localDay(now);
  write(marks);
}

export function onceDue(key: string): boolean {
  return read().once[key] !== true;
}

export function markOnce(key: string): void {
  const marks = read();
  marks.once[key] = true;
  write(marks);
}

/** The first time this installation opened, recorded on the first call. */
export function firstOpenAt(now: number): number {
  const marks = read();
  if (marks.firstOpenAt !== undefined) return marks.firstOpenAt;
  marks.firstOpenAt = now;
  write(marks);
  return now;
}

/** Records the version this boot runs as and returns the one before it
 * (`undefined` on the first boot ever). */
export function swapBootVersion(version: string): string | undefined {
  const marks = read();
  const previous = marks.lastBootVersion;
  if (previous !== version) {
    marks.lastBootVersion = version;
    write(marks);
  }
  return previous;
}
