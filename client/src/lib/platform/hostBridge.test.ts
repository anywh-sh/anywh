import { afterEach, describe, expect, it, vi } from "vitest";
import { installHostBridge } from "./hostBridge";
import { getPushAddressProvider, setPushAddressProvider, type PushAddressProvider } from "./pushAddress";

const provider: PushAddressProvider = { getAddress: async () => null, subscribe: () => () => {} };

afterEach(() => {
  delete window.__anywhHostInit;
  setPushAddressProvider(null);
});

describe("installHostBridge", () => {
  it("does nothing when no host is embedding the client", () => {
    expect(() => installHostBridge()).not.toThrow();
    expect(getPushAddressProvider()).toBeNull();
  });

  it("lets the host install a push address provider", () => {
    window.__anywhHostInit = (api) => api.setPushAddressProvider(provider);
    installHostBridge();
    expect(getPushAddressProvider()).toBe(provider);
  });

  it("lets the host remove it again", () => {
    window.__anywhHostInit = (api) => {
      api.setPushAddressProvider(provider);
      api.setPushAddressProvider(null);
    };
    installHostBridge();
    expect(getPushAddressProvider()).toBeNull();
  });

  it("keeps the client running when the host throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    window.__anywhHostInit = () => {
      throw new Error("boom");
    };
    expect(() => installHostBridge()).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
