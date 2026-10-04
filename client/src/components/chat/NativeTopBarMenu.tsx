import { useEffect, useMemo, useRef } from "react";
import { useDict } from "@/i18n";
import { catalogHasModel } from "@/lib/composer/modelCatalog";
import { effortsFor, effectiveModelOption } from "@/lib/composer/effortCatalog";
import { listenTopBarEffortSelect, listenTopBarModeSelect, listenTopBarModelSelect, setNativeTopBarMenu } from "@/lib/platform/nativeShell";
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
}

/** Headless: feeds the iOS top bar dropdown the session's models and
 * permission modes and applies the pick. Renders nothing. */
export function NativeTopBarMenu(props: NativeTopBarMenuProps) {
  const dict = useDict();
  const { catalog, model, locked, connected, permissionMode, permissionModes, effort } = props;
  const payload = useMemo(
    () =>
      buildTopBarMenuPayload({
        catalog,
        model,
        locked,
        connected,
        permissionMode,
        permissionModes,
        effort,
        effortCatalogOption: effectiveModelOption(catalog, model),
        dict,
      }),
    [catalog, model, locked, connected, permissionMode, permissionModes, effort, dict],
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
      void setNativeTopBarMenu({ model: null, mode: null, effort: null }).catch(() => {});
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
