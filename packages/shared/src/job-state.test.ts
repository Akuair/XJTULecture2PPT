import { describe, expect, it } from "vitest";

import { canTransitionJobStatus, isTerminalJobStatus, transitionJobStatus } from "./job-state";

describe("job state machine", () => {
  it("accepts the verified download, conversion, write, and cleanup sequence", () => {
    const states = [
      "queued",
      "authenticating",
      "resolving-video",
      "downloading",
      "downloaded",
      "converting",
      "converting-pdf",
      "recognizing-text",
      "writing-output",
      "cleaning",
      "completed",
    ] as const;

    for (let index = 1; index < states.length; index += 1) {
      expect(transitionJobStatus(states[index - 1]!, states[index]!)).toBe(states[index]);
    }
  });

  it("rejects deletion before PDF and TXT writing", () => {
    expect(canTransitionJobStatus("downloading", "cleaning")).toBe(false);
    expect(() => transitionJobStatus("downloaded", "cleaning")).toThrow("downloaded -> cleaning");
  });

  it("keeps completed jobs terminal and allows failed jobs to retry safely", () => {
    expect(isTerminalJobStatus("completed")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
    expect(isTerminalJobStatus("cancelled")).toBe(true);
    expect(canTransitionJobStatus("completed", "queued")).toBe(false);
    expect(canTransitionJobStatus("failed", "converting")).toBe(true);
    expect(canTransitionJobStatus("failed", "cleaning")).toBe(true);
  });
});
