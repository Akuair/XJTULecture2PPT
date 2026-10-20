import { createWriteStream, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";

import type { Request, Response } from "playwright";

import { redactBody, redactHeaders, redactText, redactUrl } from "./redaction";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const INTERESTING_RESOURCE_TYPES = new Set(["document", "fetch", "media", "xhr"]);
const MEDIA_OR_DATA_PATH = /\.(?:json|m3u8|mp4|mpd)(?:$|[?#])/i;

export interface EndpointSummary {
  contentTypes: string[];
  count: number;
  endpoint: string;
  methods: string[];
  resourceTypes: string[];
  statuses: number[];
}

interface NetworkEvent {
  body?: unknown;
  bodyOmitted?: string;
  contentType?: string;
  headers: Record<string, string>;
  kind: "request" | "response";
  method: string;
  redirectedFrom?: string;
  resourceType: string;
  status?: number;
  timestamp: string;
  url: string;
}

interface MutableSummary {
  contentTypes: Set<string>;
  count: number;
  endpoint: string;
  methods: Set<string>;
  resourceTypes: Set<string>;
  statuses: Set<number>;
}

export class NetworkRecorder {
  private captureErrors = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly stream: WriteStream;
  private readonly summaries = new Map<string, MutableSummary>();

  constructor(logPath: string) {
    this.stream = createWriteStream(logPath, { encoding: "utf8", flags: "wx" });
  }

  track(task: Promise<void>): void {
    const guarded = task.catch(() => {
      this.captureErrors += 1;
    });
    this.pending.add(guarded);
    void guarded.finally(() => this.pending.delete(guarded));
  }

  async recordRequest(request: Request): Promise<void> {
    if (!isInteresting(request)) return;
    const headers = await request.allHeaders();
    const contentType = headers["content-type"] ?? "";
    const postData = request.postData();
    const event: NetworkEvent = {
      kind: "request",
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType: request.resourceType(),
      headers: redactHeaders(headers),
      contentType,
    };

    const redirectedFrom = request.redirectedFrom();
    if (redirectedFrom) event.redirectedFrom = redactUrl(redirectedFrom.url());
    if (postData) {
      event.body = postData.length <= MAX_JSON_BODY_BYTES ? redactBody(postData, contentType) : undefined;
      if (!event.body) event.bodyOmitted = `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`;
    }
    this.write(event);
  }

  async recordResponse(response: Response): Promise<void> {
    const request = response.request();
    if (!isInteresting(request)) return;
    const headers = await response.allHeaders();
    const contentType = headers["content-type"] ?? "";
    const event: NetworkEvent = {
      kind: "response",
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: redactUrl(response.url()),
      resourceType: request.resourceType(),
      headers: redactHeaders(headers),
      contentType,
      status: response.status(),
    };

    if (/json/i.test(contentType) && ["fetch", "xhr"].includes(request.resourceType())) {
      const declaredLength = Number(headers["content-length"] ?? 0);
      if (declaredLength > MAX_JSON_BODY_BYTES) {
        event.bodyOmitted = `JSON response exceeds ${MAX_JSON_BODY_BYTES} bytes`;
      } else {
        try {
          const body = await response.body();
          if (body.byteLength <= MAX_JSON_BODY_BYTES) {
            event.body = redactBody(body.toString("utf8"), contentType);
          } else {
            event.bodyOmitted = `JSON response exceeds ${MAX_JSON_BODY_BYTES} bytes`;
          }
        } catch (error) {
          event.bodyOmitted = `response body unavailable: ${redactText(String(error))}`;
        }
      }
    }

    this.updateSummary(event);
    this.write(event);
  }

  getSummaries(): EndpointSummary[] {
    return [...this.summaries.values()]
      .map((summary) => ({
        endpoint: summary.endpoint,
        count: summary.count,
        methods: [...summary.methods].sort(),
        resourceTypes: [...summary.resourceTypes].sort(),
        statuses: [...summary.statuses].sort((left, right) => left - right),
        contentTypes: [...summary.contentTypes].filter(Boolean).sort(),
      }))
      .sort((left, right) => left.endpoint.localeCompare(right.endpoint));
  }

  getCaptureErrorCount(): number {
    return this.captureErrors;
  }

  async finish(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    this.stream.end();
    await finished(this.stream);
  }

  private updateSummary(event: NetworkEvent): void {
    let endpoint = event.url;
    try {
      const url = new URL(event.url);
      endpoint = `${url.origin}${url.pathname}`;
    } catch {
      // Keep the already-redacted URL when parsing fails.
    }
    const summary = this.summaries.get(endpoint) ?? {
      endpoint,
      count: 0,
      methods: new Set<string>(),
      resourceTypes: new Set<string>(),
      statuses: new Set<number>(),
      contentTypes: new Set<string>(),
    };
    summary.count += 1;
    summary.methods.add(event.method);
    summary.resourceTypes.add(event.resourceType);
    if (event.status !== undefined) summary.statuses.add(event.status);
    if (event.contentType) summary.contentTypes.add(event.contentType.split(";", 1)[0] ?? event.contentType);
    this.summaries.set(endpoint, summary);
  }

  private write(event: NetworkEvent): void {
    this.stream.write(`${JSON.stringify(event)}\n`);
  }
}

function isInteresting(request: Request): boolean {
  return INTERESTING_RESOURCE_TYPES.has(request.resourceType()) || MEDIA_OR_DATA_PATH.test(request.url());
}
