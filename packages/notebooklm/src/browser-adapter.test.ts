import { describe, expect, it } from "vitest";

import { mapNotebookCards, parseNotebookHref } from "./browser-adapter";

describe("NotebookLmBrowserAdapter helpers", () => {
  it("maps observed card titles to real notebook IDs and URLs", () => {
    expect(
      mapNotebookCards(
        [
          { featured: true, href: "/notebook/featured-id", title: "精选示例" },
          { href: "/notebook/real-id-1", title: "  病理生理学  " },
          { href: "/notebook/real-id-2", title: "内科学" },
        ],
        "https://notebook.google.com/",
      ),
    ).toEqual([
      {
        id: "real-id-1",
        title: "病理生理学",
        url: "https://notebook.google.com/notebook/real-id-1",
      },
      {
        id: "real-id-2",
        title: "内科学",
        url: "https://notebook.google.com/notebook/real-id-2",
      },
    ]);
  });

  it("deduplicates IDs and ignores incomplete or untrusted cards", () => {
    const result = mapNotebookCards(
      [
        { href: "/notebook/same-id", title: "First" },
        { href: "/notebook/same-id", title: "Second" },
        { href: "https://example.com/notebook/foreign", title: "Foreign" },
        { href: "", title: "Missing URL" },
        { href: "/notebook/no-title", title: "" },
      ],
      "https://notebook.google.com/",
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("First");
  });

  it("supports every Notebook host observed by the inspector", () => {
    expect(
      parseNotebookHref("https://notebook.google.com/notebook/abc123", "https://notebook.google.com/")?.id,
    ).toBe("abc123");
    expect(
      parseNotebookHref("https://notebook.google/notebook/abc123", "https://notebook.google/"),
    ).toBeDefined();
    expect(
      parseNotebookHref("https://notebooklm.google.com/notebook/abc123", "https://notebooklm.google.com/"),
    ).toBeDefined();
  });
});
