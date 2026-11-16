import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { agentName } from "@/components/chat/AgentModelEffortButton";
import { SettingsRow, SettingsSectionHeading } from "@/components/settings/SettingsRow";
import { AgentLoginDialog, type AgentLoginTarget } from "@/components/shell/AgentLoginDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDict } from "@/i18n";
import { fetchAgentsCatalog, signOutAgent, type AgentInfo } from "@/lib/install/agentsCatalog";
import { profileDataState, type ProfilePlanUsage } from "@/lib/planUsage/derive";
import { planUsageFor, subscribePlanUsage } from "@/lib/planUsage/signedOutAgents";
import type { Profile } from "@/lib/profiles/profiles";

type Load = { status: "loading" } | { status: "ready"; agents: AgentInfo[] } | { status: "unreachable" };

/** The last accounts each profile's relay reported, for this app run: the
 * section opens on them at once and re-reads in the background. */
const lastAccounts = new Map<string, AgentInfo[]>();

/** What the plan usage the app already reads says about each agent's
 * login, for a profile with nothing cached yet. It names no account and
 * can't tell whether the relay signs an agent in or out, so no button is
 * offered until the re-read says so. `null` when there is no live reading. */
export function accountsFromPlanUsage(usage: ProfilePlanUsage | undefined): AgentInfo[] | null {
  if (profileDataState(usage) !== "live" || !usage?.runtimes) return null;
  return usage.runtimes.map((entry) => ({
    id: entry.runtime,
    bin: entry.runtime,
    installed: true,
    version: null,
    loggedIn: entry.status === "signed_out" ? false : entry.status === "unknown" ? null : true,
    account: null,
    plan: entry.status === "signed_out" ? null : (entry.plan?.label ?? null),
    signIn: false,
    signOut: false,
    installUrl: null,
    docsUrl: null,
  }));
}

/** A cached list with each login as plan usage reads it now: the cache may
 * predate a sign-in or sign-out made elsewhere. */
export function withLiveLogins(agents: AgentInfo[], usage: ProfilePlanUsage | undefined): AgentInfo[] {
  if (profileDataState(usage) !== "live" || !usage?.runtimes) return agents;
  return agents.map((agent) => {
    const entry = usage.runtimes?.find((runtime) => runtime.runtime === agent.id);
    if (!entry || entry.status === "unknown") return agent;
    const loggedIn = entry.status !== "signed_out";
    return loggedIn === agent.loggedIn ? agent : { ...agent, loggedIn, account: loggedIn ? agent.account : null, plan: loggedIn ? agent.plan : null };
  });
}

/**
 * The profile's agent accounts: one row per installed agent, saying which
 * account it is signed in to on this profile's machine, with the button
 * that signs it in (or into another account). Every profile is its own
 * `$HOME`, so this is also where each of several accounts lives.
 */
export function AccountsSection({ profile }: { profile: Profile }) {
  const dict = useDict();
  const copy = dict.settings.profile.accounts;
  // What this relay answered since the section opened.
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const usage = useSyncExternalStore(subscribePlanUsage, () => planUsageFor(profile.id));
  const [signingIn, setSigningIn] = useState<AgentLoginTarget | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [signOutState, setSignOutState] = useState<"idle" | "working" | "failed">("idle");

  const refresh = useCallback(() => {
    let cancelled = false;
    fetchAgentsCatalog(profile).then(
      (catalog) => {
        if (cancelled) return;
        const agents = catalog.agents.filter((agent) => agent.installed);
        lastAccounts.set(profile.id, agents);
        setLoad({ status: "ready", agents });
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

  // Until this relay answers: the cached list (its logins as plan usage
  // reads them now), or what plan usage alone can say. Only a profile with
  // neither shows the loading line.
  const cached = lastAccounts.get(profile.id);
  const shown: Load =
    load.status === "ready"
      ? load
      : cached
        ? { status: "ready", agents: withLiveLogins(cached, usage) }
        : (() => {
            const fromUsage = accountsFromPlanUsage(usage);
            return fromUsage ? { status: "ready" as const, agents: fromUsage } : load;
          })();

  const signingOutName = signingOut ? agentName(dict.chat.composer.agentNames, signingOut) : "";

  async function disconnect(): Promise<void> {
    if (!signingOut) return;
    setSignOutState("working");
    try {
      await signOutAgent(profile, signingOut);
      setSigningOut(null);
      setSignOutState("idle");
      refresh();
    } catch {
      setSignOutState("failed");
    }
  }

  return (
    <>
      <SettingsSectionHeading>{dict.settings.profile.sections.accounts}</SettingsSectionHeading>
      <p className="pt-3 text-xs leading-relaxed text-muted-foreground">{copy.description}</p>

      {shown.status === "loading" && <p className="py-5 text-xs text-text-faint">{copy.loading}</p>}
      {shown.status === "unreachable" && <p className="py-5 text-xs text-text-faint">{copy.unreachable}</p>}
      {shown.status === "ready" && shown.agents.length === 0 && <p className="py-5 text-xs text-text-faint">{copy.none}</p>}

      {shown.status === "ready" &&
        shown.agents.map((agent) => (
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
            {agent.signOut && agent.loggedIn === true && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-destructive/60 text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  setSignOutState("idle");
                  setSigningOut(agent.id);
                }}
              >
                {copy.disconnect}
              </Button>
            )}
          </SettingsRow>
        ))}

      <Dialog
        open={signingOut !== null}
        onOpenChange={(open) => {
          if (!open && signOutState !== "working") setSigningOut(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{copy.disconnectTitle.split("{agent}").join(signingOutName)}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>{copy.disconnectBody.split("{agent}").join(signingOutName)}</DialogDescription>
            {signOutState === "failed" && (
              <p role="alert" className="text-sm text-destructive">
                {copy.disconnectFailed}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" disabled={signOutState === "working"} onClick={() => setSigningOut(null)}>
              {dict.common.cancel}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="min-w-[104px]"
              disabled={signOutState === "working"}
              aria-busy={signOutState === "working"}
              aria-label={copy.disconnect}
              onClick={() => void disconnect()}
            >
              {signOutState === "working" ? <Loader2 aria-hidden="true" className="animate-spin" /> : copy.disconnect}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
