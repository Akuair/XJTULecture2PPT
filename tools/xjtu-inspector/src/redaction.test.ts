import { describe, expect, it } from "vitest";

import { redactBody, redactHeaders, redactJson, redactUrl } from "./redaction";

describe("Inspector secret redaction", () => {
  it("redacts signed URL query values while preserving media identity", () => {
    const result = redactUrl("https://media.example/video.m3u8?token=abc&quality=1080p&signature=xyz");
    expect(result).toContain("video.m3u8");
    expect(result).not.toContain("quality=1080p");
    expect(result).not.toContain("abc");
    expect(result).not.toContain("xyz");
  });

  it("redacts authentication headers", () => {
    const result = redactHeaders({
      authorization: "Bearer secret",
      cookie: "sid=secret",
      accept: "json",
      ":path": "/video.mp4?previewToken=secret",
    });
    expect(result.authorization).toBe("[REDACTED]");
    expect(result.cookie).toBe("[REDACTED]");
    expect(result.accept).toBe("json");
    expect(result[":path"]).toBe("/video.mp4?previewToken=%5BREDACTED%5D");
  });

  it("redacts identity and token fields in JSON without hiding course names", () => {
    const result = redactBody(
      JSON.stringify({ studentId: "123", realName: "Someone", token: "secret", courseName: "高等数学" }),
      "application/json",
    );
    expect(result).toEqual({
      studentId: "[REDACTED]",
      realName: "[REDACTED]",
      token: "[REDACTED]",
      courseName: "高等数学",
    });
  });

  it("redacts CAS form credentials", () => {
    const result = redactBody(
      "username=student&password=secret&rememberMe=true",
      "application/x-www-form-urlencoded",
    );
    expect(result).not.toContain("student");
    expect(result).not.toContain("secret");
    expect(result).toContain("rememberMe=true");
  });

  it("redacts people and nested signed media URLs", () => {
    const result = redactJson({
      courseName: "病理生理学",
      instructors: [{ id: 1, name: "Teacher", user_no: "123" }],
      download_url: "https://media.example/video.mp4?X-Amz-Signature=secret&X-Amz-Expires=10",
    });
    expect(result).toEqual({
      courseName: "病理生理学",
      instructors: [{ id: "[REDACTED]", name: "[REDACTED]", user_no: "[REDACTED]" }],
      download_url:
        "https://media.example/video.mp4?X-Amz-Signature=%5BREDACTED%5D&X-Amz-Expires=%5BREDACTED%5D",
    });
  });
});
