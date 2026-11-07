import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useDict } from "@/i18n";
import type { IntegrationProvider, IntegrationsClientMessage, McpRuntimeId } from "@/lib/integrations/model";
import type { Profile } from "@/lib/profiles/profiles";
import { getHostInfo } from "@/lib/relay/filesClient";

/** Every CLI an integration can be added to, in the order offered. */
const MCP_RUNTIMES: readonly McpRuntimeId[] = ["claude", "codex"];

interface IntegrationAddDialogProps {
  provider: IntegrationProvider | null;
  profile: Profile;
  onOpenChange: (open: boolean) => void;
  send: (message: IntegrationsClientMessage) => boolean;
}

/**
 * The "+" → provider dialog: which of the profile's agents get the provider's
 * MCP server, all of them by default. Adding sends `integration_add`; the
 * relay declares the server in each CLI and starts their sign-ins.
 */
export function IntegrationAddDialog({ provider, profile, onOpenChange, send }: IntegrationAddDialogProps) {
  const dict = useDict();
  const copy = dict.integrations.add;
  const open = provider !== null;
  const [available, setAvailable] = useState<McpRuntimeId[]>([...MCP_RUNTIMES]);
  const [picked, setPicked] = useState<Set<McpRuntimeId>>(new Set(MCP_RUNTIMES));
  const [unreachable, setUnreachable] = useState(false);

  // The agents installed on the machine; both when it cannot say.
  useEffect(() => {
    if (!open) return;
    setUnreachable(false);
    setAvailable([...MCP_RUNTIMES]);
    setPicked(new Set(MCP_RUNTIMES));
    let cancelled = false;
    getHostInfo(profile)
      .then((info) => {
        if (cancelled) return;
        const installed = new Set((info.agents ?? []).map((agent) => agent.id));
        const ids = MCP_RUNTIMES.filter((id) => installed.has(id));
        if (ids.length === 0) return;
        setAvailable(ids);
        setPicked(new Set(ids));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, profile]);

  if (!provider) return null;
  const name = dict.integrations.providers[provider];

  const toggle = (id: McpRuntimeId, checked: boolean): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const submit = (): void => {
    const runtimes = available.filter((id) => picked.has(id));
    if (!send({ type: "integration_add", id: provider, provider, runtimes })) {
      setUnreachable(true);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IntegrationIcon provider={provider} />
            {copy.title.replace("{name}", name)}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>{copy.description.replace("{name}", name)}</DialogDescription>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase">{copy.agentsLabel}</legend>
            {available.map((id) => (
              <label key={id} className="flex items-center gap-2.5 text-sm text-foreground">
                <Checkbox checked={picked.has(id)} onCheckedChange={(checked) => toggle(id, checked === true)} />
                {dict.chat.composer.agentNames[id]}
              </label>
            ))}
          </fieldset>
          {unreachable && <p className="text-xs text-destructive">{copy.unreachable}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {copy.cancel}
          </Button>
          <Button type="button" size="sm" disabled={picked.size === 0} onClick={submit}>
            {copy.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
