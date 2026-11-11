/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlayingScreen } from "./PlayingScreen.js";
import { LanguageProvider } from "../i18n.js";

afterEach(cleanup);

function show(props: { hosted: boolean; lanUrl?: string | null }) {
  return render(
    <LanguageProvider language="en">
      <PlayingScreen world={null} lines={[]} hosted={props.hosted} port={4100} lanUrl={props.lanUrl} onResume={() => {}} onStop={() => {}} />
    </LanguageProvider>,
  );
}

describe("PlayingScreen hosting", () => {
  it("shows nothing about hosting when it is off", () => {
    show({ hosted: false });
    expect(screen.queryByText(/Private world hosting is on/)).toBeNull();
    expect(screen.queryByText(/incoming connections/)).toBeNull();
  });

  it("shows the real network address with a copy button and the firewall note", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show({ hosted: true, lanUrl: "http://192.168.1.20:4100" });
    expect(screen.getByText(/http:\/\/192\.168\.1\.20:4100/)).toBeTruthy();
    expect(screen.getByText(/incoming connections/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(writeText).toHaveBeenCalledWith("http://192.168.1.20:4100");
    expect(await screen.findByText(/Copied/)).toBeTruthy();
  });

  it("falls back to the placeholder with no copy button when no address is found", () => {
    show({ hosted: true, lanUrl: null });
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
    expect(screen.getByText(/this computer's address/)).toBeTruthy();
  });
});
