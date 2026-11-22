import { type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Mascot } from "@/components/bots/Mascot";
import { useDict } from "@/i18n";
import { defaultChoice, MASCOT_ORDER, MASCOT_TONE_ORDER, MASCOT_TONES, type MascotChoice } from "@/lib/bots/mascot";

/** The dot grid behind a mascot's frame: the room canvas's grid token. */
export const MASCOT_FRAME_STYLE = {
  backgroundImage: "radial-gradient(circle, var(--canvas-grid) 1px, transparent 1.5px)",
  backgroundSize: "16px 16px",
  backgroundPosition: "8px 8px",
} as const;

interface MascotPickerProps {
  value: MascotChoice;
  onChange: (next: MascotChoice) => void;
  /** What opens it (the mascot's frame, a "change" link): rendered as is. */
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Picking a bot's face: the characters in a carousel (the one before and
 * after shown faded) and the eight tones under it. Each character brings its
 * own tone; the person can then change the tone of the one picked. Closes on
 * a click outside or Escape; the arrow keys walk the characters.
 */
export function MascotPicker({ value, onChange, children, open, onOpenChange }: MascotPickerProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[360px]" data-testid="mascot-picker">
        <MascotPickerPanel value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

/** The picker's content, on its own for the stories. */
export function MascotPickerPanel({ value, onChange }: { value: MascotChoice; onChange: (next: MascotChoice) => void }) {
  const dict = useDict();
  const copy = dict.bots.mascot;
  const index = MASCOT_ORDER.indexOf(value.character);
  const at = (offset: number) => MASCOT_ORDER[(index + offset + MASCOT_ORDER.length) % MASCOT_ORDER.length];
  const step = (offset: number): void => onChange(defaultChoice(at(offset)));
  return (
    <div
      className="flex flex-col items-center gap-3 px-4 pt-4 pb-4"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          step(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Button variant="quiet" size="icon-sm" aria-label={copy.previous} onClick={() => step(-1)}>
          <ChevronLeft />
        </Button>
        <span className="opacity-40" aria-hidden>
          <Mascot mascot={defaultChoice(at(-1))} size={48} />
        </span>
        <span className="flex size-32 items-center justify-center border border-muted-foreground bg-bg-chrome" style={MASCOT_FRAME_STYLE}>
          <Mascot mascot={value} size={96} title={copy.characters[value.character]} />
        </span>
        <span className="opacity-40" aria-hidden>
          <Mascot mascot={defaultChoice(at(1))} size={48} />
        </span>
        <Button variant="quiet" size="icon-sm" aria-label={copy.next} onClick={() => step(1)}>
          <ChevronRight />
        </Button>
      </div>
      <span className="text-[13px] font-medium text-foreground" aria-live="polite">
        {copy.characters[value.character]}
      </span>
      <div className="flex items-center gap-2" role="radiogroup" aria-label={copy.tone}>
        {MASCOT_TONE_ORDER.map((tone) => {
          const selected = tone === value.tone;
          return (
            <Button
              key={tone}
              variant="quiet"
              size="inline"
              role="radio"
              aria-checked={selected}
              aria-label={copy.tones[tone]}
              title={copy.tones[tone]}
              onClick={() => onChange({ character: value.character, tone })}
              className="size-[22px] p-0"
              // The ring around the tone picked: the panel's color, then a line.
              style={{ background: MASCOT_TONES[tone], boxShadow: selected ? "0 0 0 2px var(--background), 0 0 0 3px var(--foreground)" : undefined }}
            />
          );
        })}
      </div>
    </div>
  );
}

/** "Bip · sand · change": the mascot as words, the last one opening the picker. */
export function mascotSummary(dict: ReturnType<typeof useDict>, value: MascotChoice): string {
  return `${dict.bots.mascot.characters[value.character]} · ${dict.bots.mascot.tones[value.tone]}`;
}
