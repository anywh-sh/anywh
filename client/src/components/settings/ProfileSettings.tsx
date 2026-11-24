import { TextButton } from "@/components/ui/text-button";
import { AccountsSection } from "@/components/settings/AccountsSection";
import { useEffect, useState } from "react";
import { Folder, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderPickerDialog } from "@/components/chat/FolderPickerDialog";
import { DangerZone } from "@/components/settings/DangerZone";
import { SettingsRow, SettingsSectionHeading } from "@/components/settings/SettingsRow";
import { useDefaultPaths } from "@/hooks/useDefaultPaths";
import { useRevokedProfiles } from "@/hooks/profiles/useProfileRevoked";
import {
  DEFAULT_MODEL_PREFERENCE,
  useModelPreference,
  type ModelPreference,
  type ModelPreferenceMode,
} from "@/hooks/relay/useModelPreference";
import { useDict } from "@/i18n";
import { APP_VERSION } from "@/lib/install/appVersion";
import { useLegacyRelayUpgrade } from "@/hooks/relay/useLegacyRelayUpgrade";
import { RelayUpgradeAction } from "@/components/shell/RelayUpgradeBanner";
import { getModelCatalogs } from "@/lib/composer/modelCatalog";
import { agentName } from "@/components/chat/AgentModelEffortButton";
import { profileBadge } from "@/lib/profiles/profileBadge";
import {
  addProfile,
  findProfile,
  isTailnetProfile,
  PROFILE_COLOR_COUNT,
  profileColorClass,
  profileColorClassForIndex,
  type Profile,
} from "@/lib/profiles/profiles";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { updateProfileMeta } from "@/lib/relay/relayClient";
import { getHostInfo } from "@/lib/relay/filesClient";
import type { AgentPreference } from "@/lib/relay/relay-types";
import { cn } from "@/lib/utils";

/** Small square button, the shape every choice in this page uses: the
 * segmented control, the model list, the "change folder" action. Selected
 * takes the accent surface rather than the accent itself — a page can hold
 * several of these at once and only the accent border should shout. */
function ChoiceButton({
  selected,
  onClick,
  title,
  disabled,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        // Wraps a long label (a model's name, in Portuguese) instead of
        // overflowing the row, and keeps the pointer while disabled so the
        // title still says why.
        "h-auto px-2.5 py-1 text-[11.5px] font-normal whitespace-normal hover:bg-surface-hover disabled:pointer-events-auto disabled:cursor-not-allowed",
        selected && "border-primary bg-primary-soft text-primary-ink hover:border-primary hover:bg-primary-soft hover:text-primary-ink",
      )}
    >
      {children}
    </Button>
  );
}

function HomeFolderControl({ profile }: { profile: Profile }) {
  const dict = useDict();
  const { paths, setDefaultPath, clearDefaultPath } = useDefaultPaths();
  const [pickerOpen, setPickerOpen] = useState(false);
  const path = paths[profile.id];

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "max-w-[15rem] truncate border border-border bg-bg-chrome px-2.5 py-1 font-mono text-[11.5px]",
          path ? "text-muted-foreground" : "text-text-faint",
        )}
      >
        {path ?? dict.settings.profile.home.systemDefault}
      </span>
      {path && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={dict.settings.profile.home.useSystemDefault}
          onClick={() => clearDefaultPath(profile.id)}
        >
          <X className="size-3.5" />
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
        <Folder className="size-3.5" />
        {dict.settings.profile.home.change}
      </Button>

      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        profile={profile}
        initialPath={path ?? ""}
        locked={false}
        onSelect={(next) => setDefaultPath(profile.id, next)}
        onFocusComposer={() => {}}
      />
    </div>
  );
}

/** The mode first, then — only when the mode is "always the same" — which
 * model that is. Small buttons rather than selects: a list you can read at
 * a glance doesn't need to be opened first. One group per installed agent,
 * each labelled with the agent's CLI's own model names (`getModelCatalogs`)
 * — a fixed pick is one agent's model id, applied only to sessions running
 * that agent (`ChatPanel`), so which agent it belongs to has to be visible.
 * The agent heading is left out when there's only one. */
function ModelControl({
  preference,
  onChange,
}: {
  preference: ModelPreference;
  onChange: (preference: ModelPreference) => void;
}) {
  const dict = useDict();
  const agentNames = dict.chat.composer.agentNames;
  const catalogs = Object.entries(getModelCatalogs());
  const modes: { id: ModelPreferenceMode; label: string }[] = [
    { id: "lastUsed", label: dict.settings.profile.model.lastUsed },
    { id: "fixed", label: dict.settings.profile.model.fixed },
  ];

  return (
    <>
      <div className="flex gap-1.5">
        {modes.map((mode) => (
          <ChoiceButton
            key={mode.id}
            selected={preference.mode === mode.id}
            onClick={() => onChange({ ...preference, mode: mode.id })}
          >
            {mode.label}
          </ChoiceButton>
        ))}
      </div>
      {preference.mode === "fixed" && (
        <div className="flex max-w-[24rem] flex-col items-end gap-2">
          {catalogs.map(([agentId, catalog]) => (
            <div key={agentId} className="flex flex-col items-end gap-1">
              {catalogs.length > 1 && (
                <span className="text-[11px] text-muted-foreground">{agentName(agentNames, agentId)}</span>
              )}
              <div className="flex flex-wrap justify-end gap-1.5">
                {catalog.options.map((option) => (
                  <ChoiceButton
                    key={option.id}
                    selected={preference.fixedModel === option.id}
                    onClick={() => onChange({ ...preference, fixedModel: option.id })}
                    title={option.description}
                  >
                    {option.label}
                  </ChoiceButton>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** The profile's default agent, stored on its relay (so it follows the
 * profile to other devices): "last used", or "always" one of the agents the
 * host can run. Picking "always" pins the first agent right away, since a
 * fixed mode without an agent means nothing. A relay that predates the field
 * answers the PATCH with a 400: the control then turns off with a hint. */
function AgentControl({ profile }: { profile: Profile }) {
  const dict = useDict();
  const agentDict = dict.settings.profile.agent;
  const [agents, setAgents] = useState<string[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preference: AgentPreference = profile.agentPreference ?? { mode: "lastUsed" };

  useEffect(() => {
    let cancelled = false;
    getHostInfo(profile)
      .then((info) => {
        if (!cancelled) setAgents((info.agents ?? []).map((agent) => agent.id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile]);

  async function change(next: AgentPreference): Promise<void> {
    setError(null);
    try {
      const { host, port, token } = await resolveConnection(profile);
      const updated = await updateProfileMeta(host, port, profile.id, { agentPreference: next }, token);
      // The store's copy, not the one this render captured: a rename or a
      // color change that landed meanwhile must not be undone by this.
      addProfile({ ...(findProfile(profile.id) ?? profile), agentPreference: updated.agentPreference ?? next });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // What a relay that predates the preference answers; a current one
      // says "invalid profile patch" for a malformed one instead, which is
      // an error to show, not a missing feature.
      if (message.includes("label or colorIndex is required")) setUnsupported(true);
      else setError(message);
    }
  }

  const selectFixed = (fixedAgentId: string) => void change({ mode: "fixed", fixedAgentId });
  const firstAgent = agents[0];

  return (
    <>
      <div role="group" aria-label={agentDict.title} className="flex gap-1.5">
        <ChoiceButton
          selected={preference.mode === "lastUsed"}
          onClick={() => preference.mode !== "lastUsed" && void change({ mode: "lastUsed" })}
          title={unsupported ? agentDict.unsupported : undefined}
          disabled={unsupported}
        >
          {agentDict.lastUsed}
        </ChoiceButton>
        <ChoiceButton
          selected={preference.mode === "fixed"}
          onClick={() => firstAgent !== undefined && preference.mode !== "fixed" && selectFixed(firstAgent)}
          title={unsupported ? agentDict.unsupported : undefined}
          disabled={unsupported || firstAgent === undefined}
        >
          {agentDict.fixed}
        </ChoiceButton>
      </div>
      {preference.mode === "fixed" && (
        <div role="group" aria-label={agentDict.fixed} className="flex flex-wrap justify-end gap-1.5">
          {agents.map((agentId) => (
            <ChoiceButton
              key={agentId}
              selected={preference.fixedAgentId === agentId}
              onClick={() => selectFixed(agentId)}
              disabled={unsupported}
            >
              {agentName(dict.chat.composer.agentNames, agentId)}
            </ChoiceButton>
          ))}
        </div>
      )}
      {unsupported && <p className="max-w-[24rem] text-right text-[11px] text-muted-foreground">{agentDict.unsupported}</p>}
      {error && <p className="max-w-[24rem] text-right text-[11px] text-destructive">{error}</p>}
    </>
  );
}

/** Name and colour, both of which propagate to this profile's other
 * devices through a `PATCH`, and both failing the same way — hence one
 * component with one error line under them. The name saves on a button
 * rather than on every keystroke: each save is a request, and half-typed
 * names would reach the other devices. */
function IdentityRows({ profile, effectiveColorIndex }: { profile: Profile; effectiveColorIndex: number }) {
  const dict = useDict();
  const [label, setLabel] = useState(profile.label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLabel(profile.label);
    setError(null);
  }, [profile.id, profile.label]);

  async function applyPatch(patch: { label?: string; colorIndex?: number }): Promise<void> {
    setError(null);
    try {
      const { host, port, token } = await resolveConnection(profile);
      const updated = await updateProfileMeta(host, port, profile.id, patch, token);
      addProfile({ ...(findProfile(profile.id) ?? profile), label: updated.label, colorIndex: updated.colorIndex });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveLabel(): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed || trimmed === profile.label) return;
    setSaving(true);
    await applyPatch({ label: trimmed });
    setSaving(false);
  }

  return (
    <>
      <SettingsRow title={dict.settings.profile.name.title} description={dict.settings.profile.name.description}>
        <div className="flex items-center gap-2">
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="w-56"
            spellCheck={false}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={saving || !label.trim() || label.trim() === profile.label}
            onClick={() => void handleSaveLabel()}
          >
            {saving ? dict.settings.profile.name.saving : dict.common.save}
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow title={dict.settings.profile.color.title} description={dict.settings.profile.color.description}>
        <div className="flex items-center gap-1.5">
          {Array.from({ length: PROFILE_COLOR_COUNT }, (_, index) => (
            <TextButton
              key={index}
              tone="none"
              aria-label={dict.settings.profile.color.swatch.replace("{number}", String(index + 1))}
              onClick={() => void applyPatch({ colorIndex: index })}
              className={cn(
                "size-5 shrink-0 outline outline-offset-2",
                profileColorClassForIndex(index),
                effectiveColorIndex === index ? "outline-foreground" : "outline-transparent",
              )}
            />
          ))}
        </div>
      </SettingsRow>

      {error && <p className="pt-3 text-sm text-destructive">{error}</p>}
    </>
  );
}

/**
 * The profile's relay, when it is older than the app and cannot update
 * itself: the same one-button update the notice above the conversation
 * offers (useLegacyRelayUpgrade), shown here too because this is where
 * someone looking for it would look.
 */
function RelayDriftRow({ profile }: { profile: Profile }) {
  const dict = useDict().settings.profile.relay;
  const { state, relayVersion, start } = useLegacyRelayUpgrade(profile, { source: "settings" });
  if (state.phase === "hidden" || relayVersion === undefined) return null;
  return (
    <SettingsRow title={dict.title} description={dict.description.replace("{relayVersion}", relayVersion).replace("{appVersion}", APP_VERSION)}>
      <RelayUpgradeAction state={state} onUpdate={start} />
    </SettingsRow>
  );
}

/**
 * Everything that belongs to one profile, on one page: where its
 * conversations start, which model they open with, how it is named and
 * coloured everywhere else in the app, and how to get rid of it.
 */
export function ProfileSettings({
  profile,
  allProfiles,
  effectiveColorIndex,
  onProfileRemoved,
}: {
  profile: Profile;
  allProfiles: Profile[];
  effectiveColorIndex: number;
  onProfileRemoved: (removedId: string) => void;
}) {
  const dict = useDict();
  const revoked = useRevokedProfiles();
  const { preferences, setPreference } = useModelPreference();
  const badge = profileBadge(profile, revoked, dict);

  return (
    <div className="flex flex-col">
      <header className="flex items-center gap-2.5 pt-5 pb-1.5">
        <span className={cn("inline-block size-3 shrink-0", profileColorClass(profile.id))} />
        <h2 className="truncate font-display text-lg font-bold tracking-[-0.02em] text-foreground">
          {profile.label}
        </h2>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <div className="flex-1" />
        {/* A tailnet profile's `host` is the sidecar placeholder every one of
            them shares, so it would say the same thing for all of them —
            worse than saying nothing. */}
        {!isTailnetProfile(profile) && (
          <span className="font-mono text-[11px] text-text-faint">
            {profile.host}:{profile.relayPort}
          </span>
        )}
      </header>

      <SettingsSectionHeading>{dict.settings.profile.sections.general}</SettingsSectionHeading>

      <SettingsRow title={dict.settings.profile.home.title} description={dict.settings.profile.home.description}>
        <HomeFolderControl profile={profile} />
      </SettingsRow>

      <SettingsRow title={dict.settings.profile.model.title} description={dict.settings.profile.model.description}>
        <ModelControl
          preference={preferences[profile.id] ?? DEFAULT_MODEL_PREFERENCE}
          onChange={(preference) => setPreference(profile.id, preference)}
        />
      </SettingsRow>

      <SettingsRow title={dict.settings.profile.agent.title} description={dict.settings.profile.agent.description}>
        <AgentControl profile={profile} />
      </SettingsRow>

      <RelayDriftRow profile={profile} />

      <AccountsSection profile={profile} />

      <SettingsSectionHeading>{dict.settings.profile.sections.personalization}</SettingsSectionHeading>

      <IdentityRows profile={profile} effectiveColorIndex={effectiveColorIndex} />

      <DangerZone scopedProfile={profile} allProfiles={allProfiles} onProfileRemoved={onProfileRemoved} />
    </div>
  );
}
