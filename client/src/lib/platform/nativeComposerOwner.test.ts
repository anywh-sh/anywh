import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeComposerOwner } from "./nativeComposerOwner";

describe("createNativeComposerOwner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("doesn't hide when a session switch claims before the tick ends", () => {
    const onHide = vi.fn();
    const owner = createNativeComposerOwner(onHide);
    owner.claim("a");
    owner.release("a");
    owner.claim("b");
    vi.runAllTimers();
    expect(onHide).not.toHaveBeenCalled();
  });

  it("hides when the owner releases and nobody claims", () => {
    const onHide = vi.fn();
    const owner = createNativeComposerOwner(onHide);
    owner.claim("a");
    owner.release("a");
    expect(onHide).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("ignores a release from something that isn't the owner", () => {
    const onHide = vi.fn();
    const owner = createNativeComposerOwner(onHide);
    owner.claim("b");
    owner.release("a");
    vi.runAllTimers();
    expect(onHide).not.toHaveBeenCalled();
  });

  it("the old owner's late release doesn't hide the new one", () => {
    const onHide = vi.fn();
    const owner = createNativeComposerOwner(onHide);
    owner.claim("a");
    owner.claim("b");
    owner.release("a");
    vi.runAllTimers();
    expect(onHide).not.toHaveBeenCalled();
  });
});
