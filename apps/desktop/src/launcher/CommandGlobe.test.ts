/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandGlobe, globeBackingSize } from "./CommandGlobe.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CommandGlobe resolution", () => {
  it("uses a sharp high-density backing store and caps pathological ratios", () => {
    expect(globeBackingSize(580, 2)).toBe(1160);
    expect(globeBackingSize(580, 3)).toBe(1740);
    expect(globeBackingSize(580, 4)).toBe(1740);
  });
});


it("paints the backdrop on mount and era or size changes without starting an idle frame loop", () => {
  let width = 320;
  vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  const draw = vi.fn();
  const noop = () => {};
  const context = {
    arc: noop, beginPath: noop, clearRect: draw, clip: noop, fill: noop,
    fillRect: noop, fillText: noop, lineTo: noop, moveTo: noop, restore: noop,
    save: noop, setTransform: noop, stroke: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const schedule = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  const { rerender, unmount } = render(createElement(CommandGlobe, { eraId: "1953" }));
  expect(draw).toHaveBeenCalledTimes(1);
  expect(schedule).not.toHaveBeenCalled();

  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("resize"));
  expect(schedule).toHaveBeenCalledTimes(1);
  schedule.mock.calls[0]![0](0);
  expect(draw).toHaveBeenCalledTimes(1);

  width = 390;
  window.dispatchEvent(new Event("resize"));
  schedule.mock.calls[1]![0](0);
  expect(draw).toHaveBeenCalledTimes(2);

  rerender(createElement(CommandGlobe, { eraId: "1979" }));
  expect(draw).toHaveBeenCalledTimes(3);
  unmount();
  window.dispatchEvent(new Event("resize"));
  expect(schedule).toHaveBeenCalledTimes(2);
});
