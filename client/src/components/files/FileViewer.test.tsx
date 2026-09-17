import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

const { readFileMock, fetchRawFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  fetchRawFileMock: vi.fn(),
}));
vi.mock("@/lib/relay/filesClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay/filesClient")>()),
  readFile: readFileMock,
  fetchRawFile: fetchRawFileMock,
}));

import { FileViewer } from "@/components/files/FileViewer";

const directProfile: Profile = {
  id: "direct",
  label: "Direct",
  host: "192.168.0.10",
  relayPort: 8765,
};

const tailnetProfile: Profile = {
  id: "tailnet",
  label: "Tailnet",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  tailnetTarget: "100.64.0.1:8765",
};

const imageResult = { kind: "image" as const, path: "photo.png", size: 1024, mtimeMs: 1000, mime: "image/png" };

beforeEach(() => {
  readFileMock.mockReset().mockResolvedValue(imageResult);
  fetchRawFileMock.mockReset().mockResolvedValue(new Blob(["fake-bytes"], { type: "image/png" }));
  URL.createObjectURL = vi.fn(() => "blob:fake-object-url");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("FileViewer image preview", () => {
  it("uses the plain direct URL for a direct-mode profile, with no blob fetch at all", async () => {
    render(<FileViewer profile={directProfile} sessionId="s1" path="photo.png" changedFile={null} />);

    const img = await screen.findByAltText("photo.png");
    expect(img.getAttribute("src")).toBe("http://192.168.0.10:8765/files/raw?session=s1&path=photo.png&v=1000");
    expect(fetchRawFileMock).not.toHaveBeenCalled();
  });

  it("fetches the image as a blob and uses an object URL for a tailnet profile", async () => {
    render(<FileViewer profile={tailnetProfile} sessionId="s1" path="photo.png" changedFile={null} />);

    await waitFor(() => { expect(fetchRawFileMock).toHaveBeenCalledWith(tailnetProfile, "s1", "photo.png", 1000); });
    const img = await screen.findByAltText("photo.png");
    expect(img.getAttribute("src")).toBe("blob:fake-object-url");
  });

  it("revokes the object URL on unmount", async () => {
    const { unmount } = render(<FileViewer profile={tailnetProfile} sessionId="s1" path="photo.png" changedFile={null} />);
    await screen.findByAltText("photo.png");

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-object-url");
  });
});
