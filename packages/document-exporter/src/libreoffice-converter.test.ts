import { describe, expect, it } from "vitest";

import { validatePdf } from "./libreoffice-converter";

describe("LibreOffice PDF validation", () => {
  it("accepts a PDF header and EOF marker", () => {
    expect(() => validatePdf(Buffer.from("%PDF-1.7\n1 0 obj\n%%EOF"))).not.toThrow();
  });

  it("rejects non-PDF output", () => {
    expect(() => validatePdf(Buffer.from("not a pdf"))).toThrow();
  });
});
