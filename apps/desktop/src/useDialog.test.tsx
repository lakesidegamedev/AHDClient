/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useDialog } from "./useDialog.js";

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useDialog(ref, onClose);
  return (
    <section ref={ref} role="dialog" aria-modal="true" aria-label="Test">
      <button>First</button>
      <button>Last</button>
    </section>
  );
}

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <div id="root">
      <main>
        <button onClick={() => setOpen(true)}>Open</button>
      </main>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </div>
  );
}

afterEach(cleanup);

describe("useDialog", () => {
  it("focuses in, traps Tab, closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByText("Open");
    opener.focus();
    await user.click(opener);
    const first = screen.getByText("First");
    const last = screen.getByText("Last");
    expect(document.activeElement).toBe(first);
    expect(opener.closest("main")?.hasAttribute("inert")).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener.closest("main")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("calls the latest onClose without remounting", async () => {
    let closed = 0;
    const { rerender } = render(<Dialog onClose={() => { closed += 1; }} />);
    rerender(<Dialog onClose={() => { closed += 10; }} />);
    await act(async () => { await userEvent.keyboard("{Escape}"); });
    expect(closed).toBe(10);
  });
});
