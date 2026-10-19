import { cn } from "@/lib/utils";
import { useDict } from "@/i18n";

interface SkeletonRow {
  align: "left" | "right";
  widths: string[];
}

const ROWS: SkeletonRow[] = [
  { align: "left", widths: ["w-56", "w-40"] },
  { align: "right", widths: ["w-32"] },
  { align: "left", widths: ["w-64", "w-48", "w-56"] },
  { align: "right", widths: ["w-40"] },
  { align: "left", widths: ["w-48"] },
];

/**
 * Stands in for the log while the tab hasn't received the relay's
 * `caught_up` marker yet — rebuilding history from the `.jsonl`
 * introduced a real wait that didn't exist before (the log always arrived
 * empty right away). Without this the screen looks stuck: composer
 * disabled, empty log, until the whole replay finishes arriving.
 */
export function MessageLogSkeleton() {
  const dict = useDict();
  return (
    <div className="flex flex-1 flex-col overflow-hidden px-4 py-3" role="status" aria-label={dict.chat.log.loading}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {ROWS.map((row, i) => (
          <div key={i} className={cn("flex", row.align === "right" ? "justify-end" : "justify-start")} aria-hidden="true">
            <div className={cn("flex flex-col gap-1.5", row.align === "right" && "items-end")}>
              {row.widths.map((width, j) => (
                <div key={j} className={cn("h-3 animate-pulse bg-border", width)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
