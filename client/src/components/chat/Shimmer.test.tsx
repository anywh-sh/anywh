import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Shimmer } from "@/components/chat/Shimmer";

afterEach(cleanup);

describe("Shimmer", () => {
  it("draws the label once for a screen reader: the sweeping copy is hidden from it", () => {
    const { container } = render(<Shimmer>Using 3 tools…</Shimmer>);
    const copies = container.querySelectorAll("[aria-hidden]");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toHaveTextContent("Using 3 tools…");
  });

  it("is a plain label, with no copy to animate, once it is not active", () => {
    const { container } = render(<Shimmer active={false}>Used 3 tools</Shimmer>);
    expect(container.querySelector("[aria-hidden]")).toBeNull();
    expect(container).toHaveTextContent("Used 3 tools");
  });
});
