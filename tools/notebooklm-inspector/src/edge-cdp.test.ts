import { describe, expect, it } from "vitest";

import { buildEdgeArguments } from "./edge-cdp";

describe("Edge CDP launcher", () => {
  it("uses only the dedicated profile, CDP port and target URL", () => {
    const arguments_ = buildEdgeArguments("C:\\safe-profile", 9222, "https://notebook.google.com/");

    expect(arguments_).toEqual([
      "--remote-debugging-port=9222",
      "--user-data-dir=C:\\safe-profile",
      "https://notebook.google.com/",
    ]);
    expect(arguments_).not.toContain("--no-sandbox");
    expect(arguments_).not.toContain("--enable-automation");
  });
});
