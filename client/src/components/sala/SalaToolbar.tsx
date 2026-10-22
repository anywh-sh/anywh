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

/**
 * Icons only, centred on the bottom edge of the plane over the status bar's
 * line: border on top and sides, none underneath, so it reads as growing out
 * of the bar rather than floating over it.
 */
export function SalaToolbar(props: SalaToolbarProps) {
  const dict = useDict().sala.toolbar;
  const tool = (id: SalaTool, label: string, keys: readonly string[], icon: ReactNode) => (
    <Tip label={label} keys={keys}>
      <button type="button" className={cn("sala-tool", props.tool === id && "on")} aria-label={label} aria-pressed={props.tool === id} onClick={() => props.onTool(id)}>
        {icon}
      </button>
    </Tip>
  );
  return (
    <div className="sala-float sala-toolbar" data-float role="toolbar" aria-label={dict.label}>
      <div className="sala-toolbar-in">
        {tool("select", dict.select, ["V"], <SelectIcon />)}
        {tool("hand", dict.hand, ["H", dict.space], <HandIcon />)}
        <span className="sala-sep" aria-hidden="true" />
        <Tip label={dict.newAgent} keys={["A"]}>
          <button type="button" className={cn("sala-tool", props.newAgentOpen && "on")} aria-label={dict.newAgent} aria-pressed={props.newAgentOpen} onClick={props.onNewAgent}>
            <NewAgentIcon />
          </button>
        </Tip>
        <Tip label={dict.attach} keys={["U"]}>
          <button type="button" className="sala-tool" aria-label={dict.attach} onClick={props.onAttach}>
            <AttachIcon />
          </button>
        </Tip>
        {tool("text", dict.text, ["T"], <TextIcon />)}
        {tool("area", dict.area, ["R"], <AreaIcon />)}
        <span className="sala-sep" aria-hidden="true" />
        <Tip label={dict.zoomOut} keys={["−"]}>
          <button type="button" className="sala-tool" aria-label={dict.zoomOut} onClick={props.onZoomOut}>
            <MinusIcon />
          </button>
        </Tip>
        <Tip label={dict.zoomReset.replace("{percent}", props.zoomText)} keys={[shiftKeyLabel(), "0"]}>
          <button type="button" className="sala-tool zoom" aria-label={dict.zoomReset.replace("{percent}", props.zoomText)} onClick={props.onZoomReset}>
            <span ref={props.zoomLabelRef}>{props.zoomText}</span>
          </button>
        </Tip>
        <Tip label={dict.zoomIn} keys={["+"]}>
          <button type="button" className="sala-tool" aria-label={dict.zoomIn} onClick={props.onZoomIn}>
            <PlusIcon />
          </button>
        </Tip>
        <Tip label={dict.fit} keys={[shiftKeyLabel(), "1"]}>
          <button type="button" className="sala-tool" aria-label={dict.fit} onClick={props.onFit}>
            <FitIcon />
          </button>
        </Tip>
      </div>
    </div>
  );
}
