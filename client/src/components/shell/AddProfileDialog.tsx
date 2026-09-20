import { useEffect, useState } from "react";
import { Bot, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useDict } from "@/i18n";
import type { KnownAgentId } from "@/i18n/dictionary";
import { addProfile, type Profile } from "@/lib/profiles/profiles";
import { getHostInfo } from "@/lib/relay/filesClient";
import {
  applyPortabilityBundle,
  createProfile,
  fetchPortabilityBundle,
  fetchPortabilitySnapshot,
  validateProfile,
  type PortabilitySnapshot,
} from "@/lib/relay/relayClient";
import { cn } from "@/lib/utils";

interface AddProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose relay hosts every call in here — the only machine the client
   * already knows how to reach. A new profile always lives on this same
   * host, just a different account/port, and the configuration offered
   * for copying is this same host's. */
  activeProfile: Profile;
}

const DEFAULT_RUNTIME_ID = "claude";

/**
 * Dialog opened from `ProfileSwitcher`'s "Adicionar perfil" item — creates a
 * brand new profile on the active host. Profiles that already exist on that
 * host (created from another device) no longer need importing here: they
 * show up in the switcher on their own via `useProfileSync`. Only rendered
 * when that hook reports the active host actually runs the control API —
 * see `ProfileSwitcher`.
 *
 * Three things happen in order, and the order is the design: pick the agent
 * (which decides whose login is checked and whose configuration is on
 * offer), check that agent is logged in under the config path, and only
 * then create — with the configuration written *before* the dialog closes,
 * so the profile is never usable for a turn that would run without the
 * instructions the user asked to bring.
 */
export function AddProfileDialog({ open, onOpenChange, activeProfile }: AddProfileDialogProps) {
  const dict = useDict();
  const copy = dict.shell.profiles.add;
  const agentNames = dict.chat.composer.agentNames;
  const [label, setLabel] = useState("");
  const [homePath, setHomePath] = useState("");
  const [runtimeId, setRuntimeId] = useState(DEFAULT_RUNTIME_ID);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ account?: string; plan?: string } | null>(null);
  const [snapshot, setSnapshot] = useState<PortabilitySnapshot | null>(null);
  const [copyConfig, setCopyConfig] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collidesWith, setCollidesWith] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel("");
    setHomePath("");
    setRuntimeId(DEFAULT_RUNTIME_ID);
    setValidation(null);
    setError(null);
    setCollidesWith(null);
    setCopyConfig(true);
  }, [open]);

  // Unlike the composer's picker, this one is shown even with a single
  // agent installed: the choice is what the login check and the copy offer
  // are *about*, so hiding it would leave both unexplained.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getHostInfo(activeProfile)
      .then((info) => {
        if (cancelled) return;
        const ids = (info.agents ?? []).map((agent) => agent.id);
        setAgentIds(ids);
        if (ids.length > 0 && !ids.includes(DEFAULT_RUNTIME_ID)) setRuntimeId(ids[0]);
      })
      .catch(() => {
        // An older relay has no `agents` list. Claude is what every relay
        // before this one drove, so the default stays right.
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeProfile]);

  // A field the user already validated changing again means "Criar" needs
  // another "Verificar" first — otherwise a typo fixed after a failed check
  // would silently reuse the previous (wrong) result. Picking a different
  // agent invalidates it for a sharper reason: the previous result is a
  // different CLI's answer.
  useEffect(() => {
    setValidation(null);
    setError(null);
    setCollidesWith(null);
  }, [homePath, runtimeId]);

  // What this host has for the chosen agent. Only meaningful with a config
  // path typed: an empty one means the new profile shares the machine's
  // default account, whose configuration is already the one being read —
  // there would be nothing to carry anywhere.
  useEffect(() => {
    if (!open || homePath.trim().length === 0) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    fetchPortabilitySnapshot(activeProfile.host, activeProfile.relayPort, runtimeId)
      .then((result) => {
        if (!cancelled) setSnapshot(result.found ? result : null);
      })
      .catch(() => {
        // Nothing configured, or a relay too old to answer. Both mean the
        // same thing here: no offer to make.
        if (!cancelled) setSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, homePath, runtimeId, activeProfile]);

  async function handleVerify(): Promise<void> {
    setValidating(true);
    setError(null);
    setCollidesWith(null);
    setValidation(null);
    try {
      const result = await validateProfile(activeProfile.host, activeProfile.relayPort, homePath.trim() || undefined, runtimeId);
      if (result.collidesWith) {
        setCollidesWith(result.collidesWith);
        return;
      }
      if (!result.loggedIn) {
        const homeForCommand = homePath.trim() || "<path>";
        setError(copy.notLoggedIn.replace("{path}", homeForCommand).replace("{agent}", runtimeId));
        return;
      }
      setValidation({ account: result.account, plan: result.plan });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }

  async function handleCreate(): Promise<void> {
    const trimmedLabel = label.trim();
    if (!trimmedLabel || !validation) return;
    const home = homePath.trim() || undefined;
    setCreating(true);
    try {
      const created = await createProfile(activeProfile.host, activeProfile.relayPort, trimmedLabel, home, runtimeId);
      // Before the dialog closes, never after: a profile that is already
      // in the switcher is a profile the user can send a message to, and
      // a turn that runs before the instructions land is a turn that runs
      // without them.
      if (copyConfig && snapshot && home) {
        setApplying(true);
        try {
          const bundle = await fetchPortabilityBundle(activeProfile.host, activeProfile.relayPort, runtimeId);
          await applyPortabilityBundle(activeProfile.host, activeProfile.relayPort, bundle, home);
        } catch (err) {
          // The profile itself exists and works — only the copy failed,
          // and it can be redone by hand. Saying so beats rolling back a
          // provisioned profile the user asked for.
          setApplying(false);
          setCreating(false);
          setError(copy.applyFailed.replace("{error}", err instanceof Error ? err.message : String(err)));
          return;
        }
      }
      addProfile({
        id: created.id,
        label: created.label,
        host: created.host,
        relayPort: created.port,
        colorIndex: created.colorIndex,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
      setCreating(false);
    }
  }

  const warningCount = snapshot?.warnings.filter((warning) => warning.kind === "absolute-path").length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <DialogDescription>{copy.description}</DialogDescription>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase" htmlFor="add-profile-label">
              {copy.nameLabel}
            </label>
            <Input
              id="add-profile-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={copy.namePlaceholder}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase">{copy.runtimeLabel}</span>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="w-full justify-start gap-1.5" aria-label={copy.runtimeLabel}>
                  <Bot className="size-3" />
                  <span className="flex-1 truncate text-left">{agentNames[runtimeId as KnownAgentId] ?? runtimeId}</span>
                  <ChevronDown className="size-2.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-40">
                {(agentIds.length > 0 ? agentIds : [DEFAULT_RUNTIME_ID]).map((id) => (
                  <DropdownMenuItem key={id} onSelect={() => setRuntimeId(id)} className="gap-3">
                    <span className="flex-1 truncate text-left">{agentNames[id as KnownAgentId] ?? id}</span>
                    <Check className={cn("size-3.5 text-primary!", id !== runtimeId && "opacity-0")} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase" htmlFor="add-profile-home">
              {copy.homeLabel}
            </label>
            <Input
              id="add-profile-home"
              value={homePath}
              onChange={(event) => setHomePath(event.target.value)}
              placeholder={copy.homePlaceholder}
              spellCheck={false}
            />
          </div>

          {snapshot && (
            <div className="flex flex-col gap-1.5 border border-border/60 p-3">
              <label className="flex items-center gap-2.5 text-sm text-foreground">
                <Checkbox checked={copyConfig} onCheckedChange={(checked) => setCopyConfig(checked === true)} />
                {copy.copyLabel}
              </label>
              <p className="text-xs text-text-faint">
                {copy.copySummary
                  .replace("{files}", String(snapshot.files.length))
                  .replace("{servers}", String(snapshot.mcpServers.length))}
              </p>
              {snapshot.mcpServers.length > 0 && <p className="text-xs text-text-faint">{copy.copyServersNote}</p>}
              {warningCount > 0 && <p className="text-xs text-text-faint">{copy.copyWarnings.replace("{count}", String(warningCount))}</p>}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          {collidesWith && (
            <p className="text-sm text-destructive">{copy.collides.replace("{profile}", collidesWith)}</p>
          )}
          {validation && (
            <p className="text-sm text-foreground">
              {copy.confirmed}
              {validation.account ? `: ${validation.account}` : ""}
              {validation.plan ? ` (${validation.plan})` : ""}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" disabled={validating} onClick={() => void handleVerify()}>
              {validating ? copy.verifying : copy.verify}
            </Button>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {dict.common.cancel}
          </Button>
          <Button type="button" size="sm" disabled={!validation || !label.trim() || creating} onClick={() => void handleCreate()}>
            {applying ? copy.applying : creating ? copy.creating : dict.common.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
