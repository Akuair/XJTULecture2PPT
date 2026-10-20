import { describe, expect, it } from "vitest";

import { sanitizeWindowsFileName } from "./filename";

describe("sanitizeWindowsFileName", () => {
  it("replaces Windows-invalid characters", () => {
    expect(sanitizeWindowsFileName("病理:第05讲/教师*视角?.pptx")).toBe("病理_第05讲_教师_视角_.pptx");
  });

  it("rejects reserved device names", () => {
    expect(sanitizeWindowsFileName("CON")).toBe("lecture");
  });

  it("removes trailing dots and spaces", () => {
    expect(sanitizeWindowsFileName("lecture...   ")).toBe("lecture");
  });
});
