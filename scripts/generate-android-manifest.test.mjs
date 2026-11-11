import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_PAGE,
  androidVersionCode,
  buildAndroidManifest,
} from "./generate-android-manifest.mjs";

describe("android update manifest", () => {
  it("derives versionCode the way Tauri does", () => {
    expect(androidVersionCode("2.11.0")).toBe(2011000);
    expect(androidVersionCode("2.4.13")).toBe(2004013);
  });

  it("rejects versions Tauri could not encode", () => {
    expect(() => androidVersionCode("2.11")).toThrow();
    expect(() => androidVersionCode("2.11.0-beta")).toThrow();
    expect(() => androidVersionCode("2.1000.0")).toThrow();
  });

  it("carries the version and the download page", () => {
    expect(buildAndroidManifest("2.11.0")).toEqual({
      versionCode: 2011000,
      versionName: "2.11.0",
      pageUrl: DOWNLOAD_PAGE,
    });
    expect(() => buildAndroidManifest("2.11.0", "http://example.test/")).toThrow();
  });
});
