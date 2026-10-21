import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Layers } from "lucide-react";
import { AgentModelEffortButton } from "@/components/chat/AgentModelEffortButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDict } from "@/i18n";
import { effectiveModel, getModelCatalogs } from "@/lib/composer/modelCatalog";
import type { LaunchAgentInput, RoomAgent } from "@/lib/relay/roomClient";
import { AgentLogo } from "@/components/chat/AgentLogo";
import type { Profile } from "@/lib/profiles/profiles";

export type LaunchOutcome = { ok: true } | { ok: false; reason: "full" | "failed" };

interface NewAgentLauncherProps {
  profile: Profile;
  agents: readonly RoomAgent[];
  /** Who delegates the new agent: the principal, or the agent the person picked. */
  parentId: string;
  contextCount: number;
  onParent: (agentId: string) => void;
  onLaunch: (input: LaunchAgentInput) => Promise<LaunchOutcome>;
  onClose: () => void;
}

/**
 * The launcher over the toolbar: what the new agent should do, which agent
 * and model run it, who delegates it. Enter starts it; the card is born near
 * its siblings. No "can modify" switch: an agent the person starts has the
 * permission mode its parent has.
 */
export function NewAgentLauncher({ profile, agents, parentId, contextCount, onParent, onLaunch, onClose }: NewAgentLauncherProps) {
  const dict = useDict();
  const text = dict.sala.launcher;
  const principal = agents.find((a) => a.role === "principal");
  const parent = agents.find((a) => a.agentId === parentId) ?? principal;
  const [task, setTask] = useState("");
  const [runtime, setRuntime] = useState(parent?.runtime ?? "claude");
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const catalog = getModelCatalogs()[runtime] ?? null;
  const candidates = useMemo(() => agents.filter((a) => a.state !== "stopped"), [agents]);

  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  async function submit(): Promise<void> {
    const value = task.trim();
    if (value === "" || busy) return;
    setBusy(true);
    setError(null);
    // The relay wants a model for any agent but the principal's own: what the
    // menu shows as the default is sent as the choice it stands for.
    const chosen = effectiveModel(catalog, model);
    const outcome = await onLaunch({
      task: value,
      agentId: runtime,
      ...(chosen !== null ? { model: chosen } : {}),
      ...(effort !== null ? { effort } : {}),
      parentId: parent?.agentId ?? parentId,
    });
    setBusy(false);
    if (outcome.ok) onClose();
    else setError(outcome.reason === "full" ? text.full : text.failed);
  }

  return (
    <div className="sala-float sala-launcher" data-float role="dialog" aria-label={text.label}>
      <textarea
        ref={boxRef}
        className="sala-launcher-box scrollbar-thin"
        value={task}
        placeholder={text.placeholder}
        aria-label={text.placeholder}
        rows={2}
        onChange={(event) => setTask(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="sala-launcher-bar">
        <AgentModelEffortButton
          profile={profile}
          agentId={runtime}
          onChangeAgent={(next) => {
            setRuntime(next);
            setModel(null);
            setEffort(null);
          }}
          model={model}
          catalog={catalog}
          onChangeModel={setModel}
          effort={effort}
          onChangeEffort={setEffort}
          disabled={busy}
          locked={false}
        />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="sala-launcher-parent" aria-label={text.pickParent}>
              {parent ? <AgentLogo agentId={parent.runtime} className="sala-logo" /> : <span aria-hidden="true">—</span>}
              <span className="trunc">{text.delegatedBy.replace("{title}", parent?.role === "principal" ? dict.sala.panel.agent.principal : (parent?.title ?? dict.sala.card.untitled))}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-56">
            {candidates.map((a) => (
              <DropdownMenuItem key={a.agentId} onSelect={() => onParent(a.agentId)}>
                <AgentLogo agentId={a.runtime} className="sala-logo" />
                <span className="trunc">{a.role === "principal" ? dict.sala.panel.agent.principal : (a.title ?? dict.sala.card.untitled)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="grow" />
        <button type="button" className="sala-send" onClick={() => void submit()} disabled={task.trim() === "" || busy} aria-label={text.send} title={text.send}>
          <ArrowUp size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="sala-launcher-foot">
        <Layers size={13} aria-hidden="true" />
        <span className="grow">{error ?? text.inherits.replace("{count}", String(contextCount))}</span>
        <kbd className="sala-kbd">{text.escape}</kbd>
      </div>
    </div>
  );
}
