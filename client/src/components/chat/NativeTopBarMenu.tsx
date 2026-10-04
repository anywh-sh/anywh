import { useEffect, useMemo, useRef } from "react";
import { useDict } from "@/i18n";
import { catalogHasModel } from "@/lib/composer/modelCatalog";
import { listenTopBarModeSelect, listenTopBarModelSelect, setNativeTopBarMenu } from "@/lib/platform/nativeShell";
import { buildTopBarMenuPayload } from "@/lib/platform/nativeTopBarMenuModel";
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
}

/** Headless: feeds the iOS top bar dropdown the session's models and
 * permission modes and applies the pick. Renders nothing. */
export function NativeTopBarMenu(props: NativeTopBarMenuProps) {
  const dict = useDict();
  const { catalog, model, locked, connected, permissionMode, permissionModes } = props;
  const payload = useMemo(() => buildTopBarMenuPayload({ catalog, model, locked, connected, permissionMode, permissionModes, dict }),
    [catalog, model, locked, connected, permissionMode, permissionModes, dict],);

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
      void setNativeTopBarMenu({ model: null, mode: null }).catch(() => {});
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
    return () => {
      disposed = true;
      for (const fn of unlisteners) fn();
    };
  }, []);

  return null;
}
