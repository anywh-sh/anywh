import { useEffect, useMemo, useRef } from "react";
import { useDict } from "@/i18n";
import { catalogHasModel } from "@/lib/composer/modelCatalog";
import { listenTopBarModelSelect, setNativeTopBarMenu } from "@/lib/platform/nativeShell";
import { buildTopBarMenuPayload } from "@/lib/platform/nativeTopBarMenuModel";
import type { ModelCatalog, ModelChoice } from "@/lib/relay/relay-types";

interface NativeModelMenuProps {
  catalog: ModelCatalog | null | undefined;
  model: ModelChoice | null;
  locked: boolean;
  connected: boolean;
  onChangeModel: (model: ModelChoice) => void;
}

/** Headless: feeds the iOS top bar dropdown the session's models and applies
 * the pick. Renders nothing. */
export function NativeModelMenu(props: NativeModelMenuProps) {
  const dict = useDict();
  const { catalog, model, locked, connected } = props;
  const payload = useMemo(() => buildTopBarMenuPayload({ catalog, model, locked, connected, dict }), [catalog, model, locked, connected, dict]);

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
      void setNativeTopBarMenu({ model: null }).catch(() => {});
    },
    [],
  );

  const propsRef = useRef(props);
  propsRef.current = props;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenTopBarModelSelect(({ modelId }) => {
      const current = propsRef.current;
      if (current.locked || !catalogHasModel(current.catalog, modelId)) return;
      current.onChangeModel(modelId);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
