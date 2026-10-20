import { describe, expect, it } from "vitest";

import { buildEdgeArguments } from "./edge-session";

describe("EdgeNotebookLmSession", () => {
  it("launches Edge without sandbox or automation bypass flags", () => {
    const arguments_ = buildEdgeArguments("C:\\profile", 9222, "https://notebook.google.com/");

    expect(arguments_).toEqual([
      "--remote-debugging-port=9222",
      "--user-data-dir=C:\\profile",
      "https://notebook.google.com/",
    ]);
    expect(arguments_).not.toContain("--no-sandbox");
    expect(arguments_).not.toContain("--enable-automation");
  });
});
