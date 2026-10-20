import { describe, expect, it } from "vitest";

import { sanitizeAccessibleName, sanitizeInputAccept, sanitizeNotebookUrl } from "./redaction";

describe("NotebookLM inspector redaction", () => {
  it("removes notebook IDs and query parameters from URLs", () => {
    expect(
      sanitizeNotebookUrl("https://notebook.google.com/notebook/abcdef1234567890?token=secret#sources"),
    ).toBe("https://notebook.google.com/notebook/<notebook-id>");
  });

  it("keeps only known generic control names", () => {
    expect(sanitizeAccessibleName("Add source")).toBe("Add source");
    expect(sanitizeAccessibleName("upload上传文件")).toBe("upload上传文件");
    expect(sanitizeAccessibleName("My private notebook title")).toBeUndefined();
    expect(sanitizeAccessibleName("example@gmail.com")).toBeUndefined();
  });

  it("keeps only safe file accept syntax", () => {
    expect(sanitizeInputAccept(".pptx, application/pdf, text/plain")).toBe(
      ".pptx,application/pdf,text/plain",
    );
  });
});
