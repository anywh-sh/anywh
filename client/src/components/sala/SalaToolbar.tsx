import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { useDict } from "@/i18n";
import { shiftKeyLabel } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";
import { AreaIcon, AttachIcon, FitIcon, HandIcon, MinusIcon, NewAgentIcon, PlusIcon, SelectIcon, TextIcon } from "@/components/sala/SalaIcons";

export type SalaTool = "select" | "hand" | "area" | "text";

interface SalaToolbarProps {
  tool: SalaTool;
  zoomText: string;
  zoomLabelRef: React.RefObject<HTMLSpanElement | null>;
  onTool: (tool: SalaTool) => void;
  /** The launcher for a new agent is open. */
  newAgentOpen: boolean;
  onNewAgent: () => void;
  onAttach: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomReset: () => void;
  onFit: () => void;
}

function Tip({ label, keys, children }: { label: string; keys?: readonly string[]; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="whitespace-nowrap">
        {label}
        {keys?.map((key) => <TooltipShortcut key={key}>{key}</TooltipShortcut>)}
      </TooltipContent>
    </Tooltip>
  );
}

/** A tool: an icon in a 34px square, raised while it is the one in hand. */
const TOOL =
  "h-[34px] w-auto min-w-[34px] gap-[7px] border-0 px-[9px] font-sans text-[13px] text-text-faint aria-pressed:bg-bg-elevated aria-pressed:hover:bg-surface-hover";

/**
 * Icons only, centred on the bottom edge of the plane over the status bar's
 * line: border on top and sides, none underneath, so it reads as growing out
 * of the bar rather than floating over it.
 */
export function SalaToolbar(props: SalaToolbarProps) {
  const dict = useDict().sala.toolbar;
  const tool = (id: SalaTool, label: string, keys: readonly string[], icon: ReactNode) => (
    <Tip label={label} keys={keys}>
      <Button variant="chrome" size="icon" className={TOOL} aria-label={label} aria-pressed={props.tool === id} onClick={() => props.onTool(id)}>
        {icon}
      </Button>
    </Tip>
  );
  return (
    <div className="sala-float sala-toolbar" data-float role="toolbar" aria-label={dict.label}>
      <div className="sala-toolbar-in">
        {tool("select", dict.select, ["V"], <SelectIcon />)}
        {tool("hand", dict.hand, ["H", dict.space], <HandIcon />)}
        <span className="sala-sep" aria-hidden="true" />
        <Tip label={dict.newAgent} keys={["A"]}>
          <Button variant="chrome" size="icon" className={TOOL} aria-label={dict.newAgent} aria-pressed={props.newAgentOpen} onClick={props.onNewAgent}>
            <NewAgentIcon />
          </Button>
        </Tip>
        <Tip label={dict.attach} keys={["U"]}>
          <Button variant="chrome" size="icon" className={TOOL} aria-label={dict.attach} onClick={props.onAttach}>
            <AttachIcon />
          </Button>
        </Tip>
        {tool("text", dict.text, ["T"], <TextIcon />)}
        {tool("area", dict.area, ["R"], <AreaIcon />)}
        <span className="sala-sep" aria-hidden="true" />
        <Tip label={dict.zoomOut} keys={["−"]}>
          <Button variant="chrome" size="icon" className={TOOL} aria-label={dict.zoomOut} onClick={props.onZoomOut}>
            <MinusIcon />
          </Button>
        </Tip>
        <Tip label={dict.zoomReset.replace("{percent}", props.zoomText)} keys={[shiftKeyLabel(), "0"]}>
          <Button
            variant="chrome"
            size="icon"
            className={cn(TOOL, "min-w-[54px] px-1.5 font-mono text-[12px] font-medium text-muted-foreground")}
            aria-label={dict.zoomReset.replace("{percent}", props.zoomText)}
            onClick={props.onZoomReset}
          >
            <span ref={props.zoomLabelRef}>{props.zoomText}</span>
          </Button>
        </Tip>
        <Tip label={dict.zoomIn} keys={["+"]}>
          <Button variant="chrome" size="icon" className={TOOL} aria-label={dict.zoomIn} onClick={props.onZoomIn}>
            <PlusIcon />
          </Button>
        </Tip>
        <Tip label={dict.fit} keys={[shiftKeyLabel(), "1"]}>
          <Button variant="chrome" size="icon" className={TOOL} aria-label={dict.fit} onClick={props.onFit}>
            <FitIcon />
          </Button>
        </Tip>
      </div>
    </div>
  );
}
