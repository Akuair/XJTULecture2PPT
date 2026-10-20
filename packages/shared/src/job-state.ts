export type JobStatus =
  | "queued"
  | "authenticating"
  | "resolving-video"
  | "downloading"
  | "downloaded"
  | "converting"
  | "converting-pdf"
  | "recognizing-text"
  | "writing-output"
  // Kept for restoring jobs persisted by versions that wrote PPTX directly.
  | "writing-ppt"
  | "cleaning"
  | "completed"
  | "failed"
  | "cancelled";

const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["authenticating", "resolving-video", "failed", "cancelled"],
  authenticating: ["resolving-video", "failed", "cancelled"],
  "resolving-video": ["downloading", "failed", "cancelled"],
  downloading: ["downloaded", "failed", "cancelled"],
  downloaded: ["converting", "failed", "cancelled"],
  converting: ["converting-pdf", "writing-ppt", "failed", "cancelled"],
  "converting-pdf": ["recognizing-text", "writing-output", "failed", "cancelled"],
  "recognizing-text": ["writing-output", "failed", "cancelled"],
  "writing-output": ["cleaning", "completed", "failed", "cancelled"],
  "writing-ppt": ["converting-pdf", "cleaning", "completed", "failed", "cancelled"],
  cleaning: ["completed", "failed"],
  completed: [],
  failed: ["queued", "converting", "cleaning", "cancelled"],
  cancelled: ["queued"],
};

export function canTransitionJobStatus(current: JobStatus, next: JobStatus): boolean {
  return current === next || ALLOWED_TRANSITIONS[current].includes(next);
}

export function transitionJobStatus(current: JobStatus, next: JobStatus): JobStatus {
  if (!canTransitionJobStatus(current, next)) {
    throw new Error(`Invalid job status transition: ${current} -> ${next}`);
  }
  return next;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
