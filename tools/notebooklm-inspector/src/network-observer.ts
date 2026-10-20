import type { Page, Request, Response } from "playwright";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CALLS = 500;
const SAFE_QUERY_VALUES = new Set(["alt", "rpcids", "upload_protocol", "uploadType"]);
const SAFE_HEADER_VALUES = new Set([
  "content-length",
  "content-type",
  "x-goog-upload-command",
  "x-goog-upload-header-content-length",
  "x-goog-upload-header-content-type",
  "x-goog-upload-offset",
  "x-goog-upload-protocol",
  "x-goog-upload-status",
]);
const SECRET_NAME = /(auth|cookie|credential|session|signature|ticket|token|xsrf|csrf)/i;

export interface NotebookLmNetworkCall {
  method: string;
  requestBodyBytes?: number;
  requestBodyShape?: unknown;
  requestHeaders: Record<string, string>;
  requestResourceType: string;
  responseBodyBytes?: number;
  responseBodyShape?: unknown;
  responseContentType?: string;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
  urlPattern: string;
}

export class NotebookLmNetworkObserver {
  private readonly calls: NotebookLmNetworkCall[] = [];
  private readonly requests = new WeakMap<Request, NotebookLmNetworkCall>();
  private readonly pending = new Set<Promise<void>>();

  attach(page: Page): void {
    page.on("request", (request) => this.recordRequest(request));
    page.on("response", (response) => {
      const work = this.recordResponse(response).finally(() => this.pending.delete(work));
      this.pending.add(work);
    });
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  snapshot(): NotebookLmNetworkCall[] {
    return this.calls.map((call) => structuredClone(call));
  }

  private recordRequest(request: Request): void {
    if (this.calls.length >= MAX_CALLS || !shouldObserve(request)) return;
    const headers = request.headers();
    const contentType = headers["content-type"] ?? "";
    const body = request.postDataBuffer();
    const call: NotebookLmNetworkCall = {
      method: request.method(),
      requestHeaders: sanitizeHeaders(headers),
      requestResourceType: request.resourceType(),
      urlPattern: sanitizeNetworkUrl(request.url()),
    };
    if (body) {
      call.requestBodyBytes = body.byteLength;
      call.requestBodyShape = summarizePayload(body, contentType);
    }
    this.calls.push(call);
    this.requests.set(request, call);
  }

  private async recordResponse(response: Response): Promise<void> {
    const call = this.requests.get(response.request());
    if (!call) return;
    call.responseStatus = response.status();
    const headers: Record<string, string> = await response
      .allHeaders()
      .catch((): Record<string, string> => ({}));
    call.responseHeaders = sanitizeResponseHeaders(headers);
    const contentType = headers["content-type"] ?? "";
    if (contentType) call.responseContentType = sanitizeHeaderValue("content-type", contentType);
    const contentLength = Number(headers["content-length"] ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      call.responseBodyBytes = contentLength;
      call.responseBodyShape = "<body-too-large>";
      return;
    }
    if (!isTextLike(contentType)) return;
    const body = await response.body().catch(() => undefined);
    if (!body) return;
    call.responseBodyBytes = body.byteLength;
    call.responseBodyShape =
      body.byteLength > MAX_BODY_BYTES ? "<body-too-large>" : summarizePayload(body, contentType);
  }
}

export function sanitizeNetworkUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname
      .split("/")
      .map((segment, index, all) => sanitizePathSegment(segment, all[index - 1]))
      .join("/");
    const query = [...url.searchParams.entries()]
      .map(([name, rawValue]) => {
        const value = SAFE_QUERY_VALUES.has(name) && isSafeProtocolValue(rawValue) ? rawValue : "<redacted>";
        return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
      })
      .join("&");
    return `${url.origin}${path}${query ? `?${query}` : ""}`;
  } catch {
    return "[INVALID_URL]";
  }
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([rawName, rawValue]) => {
        const name = rawName.toLowerCase();
        return [name, sanitizeHeaderValue(name, rawValue)] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function summarizePayload(body: Buffer, contentType: string): unknown {
  if (!body.byteLength) return "<empty>";
  if (!isTextLike(contentType)) return "<binary>";
  const text = body.toString("utf8");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return summarizeForm(text);
  }
  return summarizeText(text);
}

function shouldObserve(request: Request): boolean {
  if (!new Set(["xhr", "fetch"]).has(request.resourceType())) return false;
  try {
    const hostname = new URL(request.url()).hostname.toLowerCase();
    return (
      hostname === "notebook.google" ||
      hostname === "notebook.google.com" ||
      hostname === "notebooklm.google.com" ||
      hostname.endsWith(".googleapis.com") ||
      hostname.endsWith(".googleusercontent.com")
    );
  } catch {
    return false;
  }
}

function sanitizePathSegment(segment: string, previous?: string): string {
  if (!segment) return segment;
  if (/^(notebook|notebooks|projects|sources)$/i.test(previous ?? "")) return `<${previous}-id>`;
  if (looksOpaque(segment)) return "<opaque-id>";
  return segment;
}

function sanitizeHeaderValue(name: string, value: string): string {
  if (SECRET_NAME.test(name) || !SAFE_HEADER_VALUES.has(name)) return "<redacted>";
  if (name.includes("length") || name === "x-goog-upload-offset") {
    return /^\d+$/.test(value) ? value : "<redacted>";
  }
  if (name === "content-type" || name === "x-goog-upload-header-content-type") {
    return value.split(";", 1)[0]?.trim().toLowerCase() || "<redacted>";
  }
  if (name === "x-goog-upload-command") {
    return /^(start|upload|finalize|upload,\s*finalize)$/i.test(value)
      ? value.replace(/\s+/g, " ").toLowerCase()
      : "<redacted>";
  }
  return isSafeProtocolValue(value) ? value : "<redacted>";
}

function summarizeForm(text: string): unknown {
  const normalized = text.trim();
  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    return summarizeText(normalized);
  }
  const result: Record<string, unknown> = {};
  for (const [name, value] of new URLSearchParams(text)) {
    if (SECRET_NAME.test(name) || name === "at") {
      result[name] = "<redacted>";
      continue;
    }
    result[name] = summarizeText(value);
  }
  return result;
}

function summarizeText(text: string): unknown {
  const normalized = text.replace(/^\)\]\}'\s*/, "").trim();
  if (!normalized) return "<empty>";
  try {
    return sanitizeValue(JSON.parse(normalized), 0);
  } catch {
    const framedJson = parseFramedJson(normalized);
    if (framedJson.length) return { framedJson };
    const rpcIds = [...normalized.matchAll(/\[\s*"wrb\.fr"\s*,\s*"([A-Za-z0-9_]+)"/g)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value));
    return rpcIds.length ? { framedRpcIds: [...new Set(rpcIds)] } : "<text>";
  }
}

function parseFramedJson(value: string): unknown[] {
  const frames: unknown[] = [];
  for (const line of value.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try {
      frames.push(sanitizeValue(JSON.parse(candidate), 0));
    } catch {
      // Length-prefixed batchexecute output can contain non-JSON bookkeeping lines.
    }
  }
  return frames;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= 12) return "<max-depth>";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= -100 && value <= 100 ? value : "<number>";
  }
  if (typeof value === "string") {
    if (value === "wrb.fr") return value;
    const nested = value.trim();
    if (nested.startsWith("{") || nested.startsWith("[")) {
      try {
        return { serializedJson: sanitizeValue(JSON.parse(nested), depth + 1) };
      } catch {
        // It only looked like JSON; keep applying the normal scalar redaction.
      }
    }
    if (/^[A-Za-z0-9_]{3,16}$/.test(value) && !looksOpaque(value)) return value;
    if (/^https?:\/\//i.test(value)) return sanitizeNetworkUrl(value);
    return looksOpaque(value) ? "<opaque-id>" : "<string>";
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, item]) => [sanitizeObjectKey(key), sanitizeValue(item, depth + 1)]),
    );
  }
  return `<${typeof value}>`;
}

function sanitizeObjectKey(value: string): string {
  if (SECRET_NAME.test(value)) return "<secret-key>";
  return /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : "<key>";
}

function isTextLike(contentType: string): boolean {
  return /(^text\/|json|javascript|x-www-form-urlencoded|xml)/i.test(contentType);
}

export function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name === "x-goog-upload-url") {
      selected[name] = "<dynamic-upload-url>";
      continue;
    }
    if (
      name === "content-type" ||
      name === "content-length" ||
      name === "x-goog-upload-status" ||
      name === "x-goog-upload-chunk-granularity"
    ) {
      selected[name] = sanitizeHeaderValue(name, rawValue);
    }
  }
  return selected;
}

function isSafeProtocolValue(value: string): boolean {
  return value.length <= 160 && /^[A-Za-z0-9_.,+:/-]+$/.test(value);
}

function looksOpaque(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9_-]+$/.test(value);
}
