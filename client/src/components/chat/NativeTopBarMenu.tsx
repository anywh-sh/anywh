import { useEffect, useMemo, useRef } from "react";
import { useDict } from "@/i18n";
import { catalogHasModel } from "@/lib/composer/modelCatalog";
import { effortsFor, effectiveModelOption } from "@/lib/composer/effortCatalog";
import { listenTopBarAgentSelect, listenTopBarEffortSelect, listenTopBarModeSelect, listenTopBarModelSelect, setNativeTopBarMenu } from "@/lib/platform/nativeShell";
import { buildTopBarMenuPayload, EFFORT_DEFAULT_ROW_ID } from "@/lib/platform/nativeTopBarMenuModel";
import type { ModelCatalog, ModelChoice, PermissionMode, PermissionModeOption } from "@/lib/relay/relay-types";

interface NativeTopBarMenuProps {
  catalog: ModelCatalog | null | undefined;
  model: ModelChoice | null;
  locked: boolean;
  connected: boolean;
  onChangeModel: (model: ModelChoice) => void;
  permissionMode: PermissionMode | null;
  permissionModes: PermissionModeOption[];
  onChangePermissionMode: (mode: PermissionMode) => void;
  effort: string | null;
  onChangeEffort: (effort: string | null) => void;
  /** The session's agent, for a mode whose copy is the agent's own. */
  agentId?: string | null;
  /** Ids of the agents the relay can run; the agent entry needs two or more. */
  agents?: string[];
  onChangeAgent?: (agentId: string) => void;
  /** The conversation's folder, shown at the top once it is fixed. */
  cwd?: string | null;
  /** The relay's home folder, to show `cwd` from `~`. */
  home?: string | null;
}

/** Headless: feeds the iOS top bar dropdown the session's agents, models,
 * permission modes and efforts, and its folder once fixed, and applies the
 * pick. Renders nothing. */
export function NativeTopBarMenu(props: NativeTopBarMenuProps) {
  const dict = useDict();
  const { catalog, model, locked, connected, permissionMode, permissionModes, effort, agentId, agents, cwd, home } = props;
  const payload = useMemo(
    () =>
      buildTopBarMenuPayload({
        catalog,
        model,
        locked,
        connected,
        permissionMode,
        permissionModes,
        agentId,
        agents,
        effort,
        effortCatalogOption: effectiveModelOption(catalog, model),
        cwd,
        home,
        dict,
      }),
    [catalog, model, locked, connected, permissionMode, permissionModes, agentId, agents, effort, cwd, home, dict],
  );

  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    const serialized = JSON.stringify(payload);
    if (serialized === lastSentRef.current) return;
    lastSentRef.current = serialized;
    void setNativeTopBarMenu(payload).catch(() => {});
  }, [payload]);

  // The menu belongs to this panel: leaving takes it away.
  useEffect(
    () => () => {
      lastSentRef.current = null;
      void setNativeTopBarMenu({ model: null, mode: null, effort: null, agent: null, cwd: null }).catch(() => {});
    },
    [],
  );

  const propsRef = useRef(props);
  propsRef.current = props;
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (pending: Promise<() => void>) =>
      pending
        .then((fn) => {
          if (disposed) fn();
          else unlisteners.push(fn);
        })
        .catch(() => {});
    void track(
      listenTopBarModelSelect(({ modelId }) => {
        const current = propsRef.current;
        if (current.locked || !catalogHasModel(current.catalog, modelId)) return;
        current.onChangeModel(modelId);
      }),
    );
    void track(
      listenTopBarAgentSelect(({ agentId: picked }) => {
        const current = propsRef.current;
        // Fixed with the model after the first turn; the current agent is a no-op.
        if (current.locked || picked === current.agentId || !(current.agents ?? []).includes(picked)) return;
        current.onChangeAgent?.(picked);
      }),
    );
    void track(
      listenTopBarModeSelect(({ modeId }) => {
        const current = propsRef.current;
        if (!current.permissionModes.some((option) => option.id === modeId)) return;
        current.onChangePermissionMode(modeId);
      }),
    );
    void track(
      listenTopBarEffortSelect(({ effortId }) => {
        const current = propsRef.current;
        const levels = effortsFor(current.catalog, current.model);
        if (effortId === EFFORT_DEFAULT_ROW_ID) {
          // Only a model that reports no default of its own has that row.
          if (effectiveModelOption(current.catalog, current.model)?.defaultEffort === undefined && levels.length > 0) current.onChangeEffort(null);
          return;
        }
        if (levels.some((level) => level.id === effortId)) current.onChangeEffort(effortId);
      }),
    );
    return () => {
      disposed = true;
      for (const fn of unlisteners) fn();
    };
  }, []);

  return null;
}
