import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { AgentLogo } from "@/components/chat/AgentLogo";
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
import { Segmented } from "@/components/ui/segmented";
import { TextButton } from "@/components/ui/text-button";
import { useDict } from "@/i18n";
import type { KnownAgentId } from "@/i18n/dictionary";
import { AgentLoginDialog } from "@/components/shell/AgentLoginDialog";
import type { McpSignInTarget } from "@/components/shell/McpSignInDialog";
import { addProfile, type Profile } from "@/lib/profiles/profiles";
import { getHostInfo } from "@/lib/relay/filesClient";
import {
  applyPortabilityBundle,
  createProfile,
  createProfileDraft,
  discardProfileDraft,
  fetchPortabilityBundle,
  fetchPortabilitySnapshot,
  validateProfile,
  type NewProfileAccount,
  type PortabilitySnapshot,
  type ProfileSharing,
  type SharingMode,
} from "@/lib/relay/relayClient";
import { cn } from "@/lib/utils";

interface AddProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a copy that carried MCP servers, with everything needed
   * to sign in to them *under the new profile's home*. Only the custom-home
   * path copies that way; a profile with its own config folders gets its
   * servers from the sharing choices instead. */
  onMcpSignInNeeded?: (target: McpSignInTarget) => void;
  /** Whose relay hosts every call in here — the only machine the client
   * already knows how to reach. A new profile always lives on this same
   * host, just a different account/port. */
  activeProfile: Profile;
}

const DEFAULT_RUNTIME_ID = "claude";

const SEPARATE_EVERYTHING: ProfileSharing = { instructions: "separate", preferences: "separate", mcp: "separate" };
const SHARING_CATEGORIES = ["instructions", "preferences", "mcp"] as const;
const SHARING_MODES: readonly SharingMode[] = ["separate", "shared", "copy"];

type Step = "setup" | "account";

/**
 * Dialog opened from `ProfileSwitcher`'s "Add profile" item — creates a new
 * profile on the active host. Only rendered when the active host runs the
 * control API (see `ProfileSwitcher`).
 *
 * A new profile is a new account, not a folder to type: by default the
 * relay gives it its own config folder per agent CLI (a draft, reserved
 * first so the agent can be signed in straight into it), and the person
 * only picks a name, the agent to sign in now, and what to keep from this
 * machine's own configuration. A custom `$HOME` is still there, under
 * Advanced, for the setups that predate this.
 *
 * Two steps, in order: set up, then sign in. Creating comes last, so the
 * profile is never in the switcher before its agent can answer.
 */
export function AddProfileDialog({ open, onOpenChange, activeProfile, onMcpSignInNeeded }: AddProfileDialogProps) {
  const dict = useDict();
  const copy = dict.shell.profiles.add;
  const agentNames = dict.chat.composer.agentNames;
  const [step, setStep] = useState<Step>("setup");
  const [label, setLabel] = useState("");
  const [runtimeId, setRuntimeId] = useState(DEFAULT_RUNTIME_ID);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [sharing, setSharing] = useState<ProfileSharing>(SEPARATE_EVERYTHING);
  const [advanced, setAdvanced] = useState(false);
  const [homePath, setHomePath] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ account?: string; plan?: string } | null>(null);
  const [snapshot, setSnapshot] = useState<PortabilitySnapshot | null>(null);
  const [copyConfig, setCopyConfig] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collidesWith, setCollidesWith] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [creating, setCreating] = useState(false);
  const [applying, setApplying] = useState(false);

  const customHome = homePath.trim();
  const account: NewProfileAccount = customHome ? { home: customHome } : draftId ? { draftId } : {};

  // The draft this dialog reserved and hasn't turned into a profile: dropped
  // when the dialog goes away without creating, so walking away leaves no
  // half-signed-in account on the host.
  const pendingDraft = useRef<string | null>(null);
  const hostRef = useRef(activeProfile);
  hostRef.current = activeProfile;
  function dropPendingDraft(): void {
    const id = pendingDraft.current;
    pendingDraft.current = null;
    if (id) void discardProfileDraft(hostRef.current.host, hostRef.current.relayPort, id);
  }

  useEffect(() => {
    if (!open) {
      dropPendingDraft();
      return;
    }
    setStep("setup");
    setLabel("");
    setRuntimeId(DEFAULT_RUNTIME_ID);
    setSharing(SEPARATE_EVERYTHING);
    setAdvanced(false);
    setHomePath("");
    setDraftId(null);
    setValidation(null);
    setError(null);
    setCollidesWith(null);
    setSignedOut(false);
    setCopyConfig(true);
  }, [open]);

  useEffect(() => dropPendingDraft, []);

  // Shown even with a single agent installed: the choice is what the
  // sign-in is about, so hiding it would leave that unexplained.
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

  // Only the custom-home path offers the old one-shot copy: a profile with
  // its own folders gets the same through the sharing choices.
  useEffect(() => {
    if (!open || !customHome) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    fetchPortabilitySnapshot(activeProfile.host, activeProfile.relayPort, runtimeId)
      .then((result) => {
        if (!cancelled) setSnapshot(result.found ? result : null);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, customHome, runtimeId, activeProfile]);

  async function verify(target: NewProfileAccount): Promise<void> {
    setValidating(true);
    setError(null);
    setCollidesWith(null);
    setValidation(null);
    setSignedOut(false);
    try {
      const result = await validateProfile(activeProfile.host, activeProfile.relayPort, target, runtimeId);
      if (result.collidesWith) {
        setCollidesWith(result.collidesWith);
        return;
      }
      if (!result.loggedIn) {
        setSignedOut(true);
        return;
      }
      setValidation({ account: result.account, plan: result.plan });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }

  async function handleContinue(): Promise<void> {
    if (!label.trim()) return;
    setError(null);
    let target: NewProfileAccount;
    if (customHome) {
      target = { home: customHome };
    } else if (draftId) {
      target = { draftId };
    } else {
      setValidating(true);
      try {
        const draft = await createProfileDraft(activeProfile.host, activeProfile.relayPort, label.trim());
        pendingDraft.current = draft.id;
        setDraftId(draft.id);
        target = { draftId: draft.id };
      } catch (err) {
        setValidating(false);
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setStep("account");
    await verify(target);
  }

  async function handleCreate(): Promise<void> {
    const trimmedLabel = label.trim();
    if (!trimmedLabel || !validation) return;
    let signInTarget: McpSignInTarget | null = null;
    setCreating(true);
    try {
      const created = await createProfile(activeProfile.host, activeProfile.relayPort, trimmedLabel, { ...account, sharing }, runtimeId);
      // It is a profile now: closing the dialog must not drop its folders.
      // A draft left over from before switching to a custom home still goes.
      if (account.draftId && pendingDraft.current === account.draftId) pendingDraft.current = null;
      else dropPendingDraft();
      // Before the dialog closes, never after: a profile in the switcher is
      // one the user can send a message to, and a turn that runs before the
      // instructions land runs without them.
      if (copyConfig && snapshot && customHome) {
        setApplying(true);
        try {
          const bundle = await fetchPortabilityBundle(activeProfile.host, activeProfile.relayPort, runtimeId);
          await applyPortabilityBundle(activeProfile.host, activeProfile.relayPort, bundle, customHome);
          if (bundle.mcpServers.length > 0) {
            signInTarget = { host: activeProfile.host, port: activeProfile.relayPort, runtimeId, home: customHome, servers: bundle.mcpServers };
          }
        } catch (err) {
          // The profile itself exists and works — only the copy failed,
          // and it can be redone by hand.
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
      if (signInTarget) onMcpSignInNeeded?.(signInTarget);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
      setCreating(false);
    }
  }

  const agentName = agentNames[runtimeId as KnownAgentId] ?? runtimeId;
  const warningCount = snapshot?.warnings.filter((warning) => warning.kind === "absolute-path").length ?? 0;
  const modeLabels: Record<SharingMode, string> = { separate: copy.sharing.separate, shared: copy.sharing.shared, copy: copy.sharing.copy };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        {step === "setup" ? (
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
                  <Button type="button" variant="outline" size="sm" className="w-full justify-start gap-2" aria-label={copy.runtimeLabel}>
                    <AgentLogo agentId={runtimeId} className="size-3.5" />
                    <span className="flex-1 truncate text-left">{agentName}</span>
                    <ChevronDown className="size-2.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-40">
                  {(agentIds.length > 0 ? agentIds : [DEFAULT_RUNTIME_ID]).map((id) => (
                    <DropdownMenuItem key={id} onSelect={() => setRuntimeId(id)} className="gap-2">
                      <AgentLogo agentId={id} className="size-3.5" />
                      <span className="flex-1 truncate text-left">{agentNames[id as KnownAgentId] ?? id}</span>
                      <Check className={cn("size-3.5 text-primary!", id !== runtimeId && "opacity-0")} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="text-xs text-text-faint">{copy.runtimeHint}</p>
            </div>

            {!customHome && (
              <div data-add-profile-sharing className="flex flex-col gap-2.5 border border-border/60 p-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground">{copy.sharing.title}</span>
                  <p className="text-xs text-text-faint">{copy.sharing.description}</p>
                </div>
                {SHARING_CATEGORIES.map((category) => (
                  <div key={category} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 text-sm text-foreground">{copy.sharing.categories[category]}</span>
                    <Segmented
                      id={`add-profile-sharing-${category}`}
                      kind="radio"
                      label={copy.sharing.categories[category]}
                      value={sharing[category]}
                      options={SHARING_MODES.map((mode) => ({ value: mode, label: modeLabels[mode] }))}
                      onChange={(mode) => setSharing((current) => ({ ...current, [category]: mode }))}
                    />
                  </div>
                ))}
                <p className="text-xs text-text-faint">{copy.sharing.agentNotes}</p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <TextButton className="self-start text-xs" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>
                {copy.advanced}
              </TextButton>
              {advanced && (
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
                  <p className="text-xs text-text-faint">{copy.homeHint}</p>
                </div>
              )}
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
          </DialogBody>
        ) : (
          <DialogBody>
            <DialogDescription>{copy.accountDescription.split("{agent}").join(agentName)}</DialogDescription>

            {validating && <p className="text-sm text-text-faint">{copy.verifying}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {signedOut && (
              <div data-add-profile-signed-out className="flex items-center gap-3">
                <p className="min-w-0 flex-1 text-sm text-foreground">{copy.notLoggedIn.split("{agent}").join(agentName)}</p>
                <Button type="button" size="sm" onClick={() => setSigningIn(true)}>
                  {copy.connect}
                </Button>
              </div>
            )}
            {collidesWith && <p className="text-sm text-destructive">{copy.collides.replace("{profile}", collidesWith)}</p>}
            {validation && (
              <p className="text-sm text-foreground">
                {copy.confirmed}
                {validation.account ? `: ${validation.account}` : ""}
                {validation.plan ? ` (${validation.plan})` : ""}
              </p>
            )}
          </DialogBody>
        )}

        <DialogFooter>
          {step === "setup" ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                {dict.common.cancel}
              </Button>
              <Button type="button" size="sm" disabled={!label.trim()} loading={validating} onClick={() => void handleContinue()}>
                {copy.continue}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" disabled={creating} onClick={() => setStep("setup")}>
                {copy.back}
              </Button>
              <Button type="button" size="sm" disabled={!validation || creating} onClick={() => void handleCreate()}>
                {applying ? copy.applying : creating ? copy.creating : dict.common.create}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
      <AgentLoginDialog
        open={signingIn}
        onOpenChange={setSigningIn}
        target={signingIn ? { profile: activeProfile, runtimeId, ...(account.draftId ? { draftId: account.draftId } : {}), ...(account.home ? { home: account.home } : {}) } : null}
        onSignedIn={() => {
          setSignedOut(false);
          void verify(account);
        }}
      />
    </Dialog>
  );
}
