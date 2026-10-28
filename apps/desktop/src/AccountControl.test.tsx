/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccountControl } from "./AccountControl.js";

const handlers = { onLink: vi.fn(), onProfile: vi.fn(), onManage: vi.fn(), onSignOut: vi.fn() };

describe("AccountControl", () => {
  afterEach(cleanup);

  it("shows a bounded picture for a trusted avatar URL", () => {
    render(
      <AccountControl
        checked
        linked
        displayName="Ada Lovelace"
        avatarUrl="https://ahousedividedgame.com/avatars/a.png"
        supporter
        {...handlers}
      />,
    );
    const img = document.querySelector("img.client-account-avatar");
    expect(img?.getAttribute("src")).toBe("https://ahousedividedgame.com/avatars/a.png");
    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(2);
  });

  it("falls back to an initial when the avatar URL is untrusted or absent", () => {
    const { rerender } = render(
      <AccountControl checked linked displayName="Ada Lovelace" avatarUrl="https://evil.com/a.png" supporter={false} {...handlers} />,
    );
    expect(document.querySelector("img.client-account-avatar")).toBeNull();
    expect(document.querySelector(".client-account-avatar")?.textContent).toBe("AL");
    rerender(
      <AccountControl checked linked displayName="Ada Lovelace" supporter={false} {...handlers} />,
    );
    expect(document.querySelector("img.client-account-avatar")).toBeNull();
  });

  it("offers sign out to a linked player and reports progress", () => {
    const onSignOut = vi.fn();
    const { rerender } = render(
      <AccountControl checked linked displayName="Ada Lovelace" supporter={false} {...handlers} onSignOut={onSignOut} />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    rerender(
      <AccountControl checked linked displayName="Ada Lovelace" supporter={false} {...handlers} onSignOut={onSignOut} signingOut />,
    );
    expect(screen.getByRole("menuitem", { name: "Signing out..." })).toHaveProperty("disabled", true);
  });

  it("shows no sign out before an account is linked", () => {
    render(<AccountControl checked linked={false} displayName={undefined} supporter={false} {...handlers} />);
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
    expect(screen.getByRole("button", { name: "Link account" })).toBeTruthy();
  });
  it("closes the menu on an outside tap and on Escape without letting Escape through", () => {
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    render(<AccountControl checked linked displayName="Ada" supporter={false} {...handlers} />);
    const menu = document.querySelector("details.client-account-menu") as HTMLDetailsElement;
    menu.open = true;
    fireEvent.pointerDown(document.body);
    expect(menu.open).toBe(false);
    menu.open = true;
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "View profile" }));
    expect(menu.open).toBe(true);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "View profile" }), { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(windowKeys).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowKeys);
  });
});
