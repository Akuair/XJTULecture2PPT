import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redact-secrets";

describe("redactSecrets", () => {
  it("redacts nested credentials", () => {
    expect(redactSecrets({ headers: { cookie: "sid=secret", authorization: "Bearer abc" } })).toEqual({
      headers: { cookie: "[REDACTED]", authorization: "[REDACTED]" },
    });
  });

  it("redacts every query value on signed URLs", () => {
    const result = String(
      redactSecrets("https://media.example/video.mp4?X-Amz-Signature=secret&X-Amz-Expires=3600"),
    );
    expect(result).not.toContain("secret");
    expect(result).not.toContain("3600");
  });
});
