import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { listDirectories } from "@/lib/relay/fsBrowse";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Profile } from "@/lib/profiles/profiles";

vi.mock("@/lib/relay/fsBrowse", () => ({
  listDirectories: vi.fn(),
}));

afterEach(() => cleanup());

const profile: Profile = { id: "p1", label: "Perfil", host: "localhost", relayPort: 4317 };

function renderDialog() {
  return render(
    <TooltipProvider>
      <FolderPickerDialog
        open
        onOpenChange={() => {}}
        profile={profile}
        initialPath="/home/user"
        locked={false}
        onSelect={() => {}}
        onFocusComposer={() => {}}
      />
    </TooltipProvider>,
  );
}

describe("FolderPickerDialog", () => {
  it("lists the initial path with hidden folders filtered by default", async () => {
    vi.mocked(listDirectories).mockResolvedValue({
      path: "/home/user",
      entries: [{ name: "projects", path: "/home/user/projects" }],
    });

    renderDialog();

    await waitFor(() => expect(listDirectories).toHaveBeenCalledWith(profile, "/home/user", false));
    expect(await screen.findByText("projects")).toBeInTheDocument();
  });

  it("toggling the hidden-folders button re-lists the current folder with showHidden=true", async () => {
    vi.mocked(listDirectories).mockResolvedValue({ path: "/home/user", entries: [] });
    renderDialog();
    await waitFor(() => expect(listDirectories).toHaveBeenCalledWith(profile, "/home/user", false));

    const user = userEvent.setup();
    const toggle = await screen.findByLabelText("Show hidden folders");
    await user.click(toggle);

    await waitFor(() => expect(listDirectories).toHaveBeenCalledWith(profile, "/home/user", true));
    expect(await screen.findByLabelText("Hide hidden folders")).toBeInTheDocument();
  });
});
