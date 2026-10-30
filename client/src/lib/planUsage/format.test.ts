import { describe, expect, it } from "vitest";

import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";
import { formatResetPhrase, formatResetTime, formatSpan, formatUpdatedAgo, formatWeekdayTime } from "@/lib/planUsage/format";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const TZ = "America/Sao_Paulo";
// Thursday 2026-10-29, 12:00 in São Paulo (UTC-3).
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
// Friday 2026-10-30, 14:00 in São Paulo.
const FRIDAY_2PM = Date.UTC(2026, 9, 30, 17, 0, 0);

describe("formatSpan", () => {
  it("uses seconds alone under a minute", () => {
    expect(formatSpan(0)).toBe("0s");
    expect(formatSpan(8 * S)).toBe("8s");
    expect(formatSpan(59.9 * S)).toBe("59s");
  });

  it("keeps padded seconds under ten minutes", () => {
    expect(formatSpan(4 * M + 4 * S)).toBe("4m 04s");
    expect(formatSpan(M)).toBe("1m 00s");
  });

  it("drops the seconds from ten minutes on", () => {
    expect(formatSpan(58 * M + 12 * S)).toBe("58m");
  });

  it("uses hours and padded minutes under a day, then days and hours", () => {
    expect(formatSpan(H + 12 * M)).toBe("1h 12m");
    expect(formatSpan(4 * H + 5 * M)).toBe("4h 05m");
    expect(formatSpan(2 * D + 5 * H + 30 * M)).toBe("2d 5h");
  });

  it("treats negative and unreadable spans as zero", () => {
    expect(formatSpan(-5 * S)).toBe("0s");
    expect(formatSpan(Number.NaN)).toBe("0s");
  });
});

describe("formatWeekdayTime", () => {
  it("speaks the interface's language without the joined form's punctuation", () => {
    expect(formatWeekdayTime(FRIDAY_2PM, "pt-BR", TZ)).toBe("sex 14:00");
    expect(formatWeekdayTime(FRIDAY_2PM, "en", TZ)).toMatch(/^Fri 2:00\sPM$/);
  });
});

describe("formatResetTime", () => {
  it("counts down within a day and names the day after that", () => {
    expect(formatResetTime(NOW + 58 * M, NOW, "pt-BR", TZ)).toEqual({ kind: "in", text: "58m" });
    expect(formatResetTime(NOW + D - 1, NOW, "pt-BR", TZ)?.kind).toBe("in");
    expect(formatResetTime(FRIDAY_2PM, NOW, "pt-BR", TZ)).toEqual({ kind: "on", text: "sex 14:00" });
  });

  it("gives the date when the reset is a week or more away", () => {
    const later = Date.UTC(2026, 10, 10, 17, 0, 0);
    expect(formatResetTime(later, NOW, "pt-BR", TZ)).toEqual({ kind: "on", text: "10/11" });
    expect(formatResetTime(later, NOW, "en", TZ)).toEqual({ kind: "on", text: "11/10" });
    expect(formatResetTime(NOW + 6 * D - 1, NOW, "pt-BR", TZ)?.text).toMatch(/^[a-zà-ú]{3} \d{2}:\d{2}$/);
  });

  it("has nothing to say once the reset is behind or unknown", () => {
    expect(formatResetTime(NOW, NOW, "en", TZ)).toBeNull();
    expect(formatResetTime(NOW - M, NOW, "en", TZ)).toBeNull();
    expect(formatResetTime(Number.NaN, NOW, "en", TZ)).toBeNull();
  });
});

describe("formatResetPhrase", () => {
  it("fills the dictionary's phrase in either language", () => {
    expect(formatResetPhrase(ptBr.shell.usage, NOW + 58 * M, NOW, "pt-BR", TZ)).toBe("volta em 58m");
    expect(formatResetPhrase(ptBr.shell.usage, FRIDAY_2PM, NOW, "pt-BR", TZ)).toBe("volta sex 14:00");
    expect(formatResetPhrase(en.shell.usage, NOW + H + 12 * M, NOW, "en", TZ)).toBe("back in 1h 12m");
    expect(formatResetPhrase(en.shell.usage, FRIDAY_2PM, NOW, "en", TZ)).toMatch(/^back Fri 2:00\sPM$/);
    expect(formatResetPhrase(en.shell.usage, NOW - M, NOW, "en", TZ)).toBeNull();
  });
});

describe("formatUpdatedAgo", () => {
  it("says how old the reading is", () => {
    expect(formatUpdatedAgo(ptBr.shell.usage, NOW - 12 * S, NOW)).toBe("há 12s");
    expect(formatUpdatedAgo(en.shell.usage, NOW - 4 * M - 4 * S, NOW)).toBe("4m 04s ago");
  });

  it("says now inside the first second and for a reading from the future", () => {
    expect(formatUpdatedAgo(ptBr.shell.usage, NOW - 400, NOW)).toBe("agora");
    expect(formatUpdatedAgo(en.shell.usage, NOW + 5 * S, NOW)).toBe("now");
  });
});
