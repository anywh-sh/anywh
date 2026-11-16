import { useCallback, useEffect, useState } from "react";
import { agentName } from "@/components/chat/AgentModelEffortButton";
import { SettingsRow, SettingsSectionHeading } from "@/components/settings/SettingsRow";
import { AgentLoginDialog, type AgentLoginTarget } from "@/components/shell/AgentLoginDialog";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import { fetchAgentsCatalog, type AgentInfo } from "@/lib/install/agentsCatalog";
import type { Profile } from "@/lib/profiles/profiles";

type Load = { status: "loading" } | { status: "ready"; agents: AgentInfo[] } | { status: "unreachable" };

/**
 * The profile's agent accounts: one row per installed agent, saying which
 * account it is signed in to on this profile's machine, with the button
 * that signs it in (or into another account). Every profile is its own
 * `$HOME`, so this is also where each of several accounts lives.
 */
export function AccountsSection({ profile }: { profile: Profile }) {
  const dict = useDict();
  const copy = dict.settings.profile.accounts;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [signingIn, setSigningIn] = useState<AgentLoginTarget | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    fetchAgentsCatalog(profile).then(
      (catalog) => {
        if (!cancelled) setLoad({ status: "ready", agents: catalog.agents.filter((agent) => agent.installed) });
      },
      () => {
        if (!cancelled) setLoad({ status: "unreachable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [profile]);

  useEffect(() => {
    setLoad({ status: "loading" });
    return refresh();
  }, [refresh]);

  return (
    <>
      <SettingsSectionHeading>{dict.settings.profile.sections.accounts}</SettingsSectionHeading>
      <p className="pt-3 text-xs leading-relaxed text-muted-foreground">{copy.description}</p>

      {load.status === "loading" && <p className="py-5 text-xs text-text-faint">{copy.loading}</p>}
      {load.status === "unreachable" && <p className="py-5 text-xs text-text-faint">{copy.unreachable}</p>}
      {load.status === "ready" && load.agents.length === 0 && <p className="py-5 text-xs text-text-faint">{copy.none}</p>}

      {load.status === "ready" &&
        load.agents.map((agent) => (
          <SettingsRow key={agent.id} title={agentName(dict.chat.composer.agentNames, agent.id)} description={accountLine(agent, copy)}>
            {agent.signIn && (
              <Button
                type="button"
                size="sm"
                variant={agent.loggedIn === false ? "default" : "outline"}
                onClick={() => setSigningIn({ profile, runtimeId: agent.id })}
              >
                {agent.loggedIn === true ? copy.switchAccount : copy.connect}
              </Button>
            )}
          </SettingsRow>
        ))}

      <AgentLoginDialog
        open={signingIn !== null}
        onOpenChange={(open) => {
          if (!open) setSigningIn(null);
        }}
        target={signingIn}
        onSignedIn={() => {
          refresh();
        }}
      />
    </>
  );
}

function accountLine(agent: AgentInfo, copy: ReturnType<typeof useDict>["settings"]["profile"]["accounts"]): string {
  if (agent.loggedIn === false) return copy.signedOut;
  if (agent.loggedIn === null) return copy.unknown;
  const who = agent.account ? copy.signedInAs.replace("{account}", agent.account) : copy.signedIn;
  return agent.plan ? `${who} · ${agent.plan}` : who;
}
