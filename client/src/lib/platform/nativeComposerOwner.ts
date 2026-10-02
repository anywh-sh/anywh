export interface NativeComposerOwner {
  claim: (id: string) => void;
  release: (id: string) => void;
}

/**
 * Tracks which `NativeComposer` instance currently owns the single native
 * composer. When the owner lets go, `onHide` fires one tick later — and only
 * if nobody claimed it meanwhile. On a session switch the outgoing panel's
 * cleanup runs before the incoming one's effect, so hiding right away would
 * flash the composer off and on. A `release` from something that isn't the
 * owner is ignored.
 */
export function createNativeComposerOwner(
  onHide: () => void,
  defer: (run: () => void) => void = (run) => void setTimeout(run, 0),
): NativeComposerOwner {
  let owner: string | null = null;
  return {
    claim(id) {
      owner = id;
    },
    release(id) {
      if (owner !== id) return;
      owner = null;
      defer(() => {
        if (owner === null) onHide();
      });
    },
  };
}
