import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { randomUUID } from "node:crypto";
import type { Session } from "electron";

import { log } from "./logger";

const SCHEME = "xjtu-media";

export class InternalMediaProtocol {
  private readonly sources = new Map<string, string>();

  constructor(private readonly session: Session) {}

  initialize(): void {
    if (this.session.protocol.isProtocolHandled(SCHEME)) return;
    this.session.protocol.handle(SCHEME, (request) => this.handle(request));
  }

  register(filePath: string): { url: string; token: string } {
    const token = randomUUID();
    this.sources.set(token, filePath);
    return { url: `${SCHEME}://job/${token}`, token };
  }

  revoke(token: string): void {
    this.sources.delete(token);
  }

  private async handle(request: GlobalRequest): Promise<GlobalResponse> {
    const url = new URL(request.url);
    const token = url.hostname === "job" ? url.pathname.replace(/^\//, "") : "";
    const filePath = this.sources.get(token);
    if (!filePath) return response("Media token not found", 404);

    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0) return response("Media file not found", 404);
    const range = parseRange(request.headers.get("range"), fileStat.size);
    log("CONVERT", "Internal media request", {
      method: request.method,
      requestedRange: request.headers.get("range") ?? "none",
    });
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: corsHeaders({ "Content-Range": `bytes */${fileStat.size}` }),
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? fileStat.size - 1;
    const headers = corsHeaders({
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(end - start + 1),
      "Content-Type": "video/mp4",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${fileStat.size}` } : {}),
    });
    if (request.method === "HEAD") {
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers,
    });
  }
}

function parseRange(
  value: string | null,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(value.trim());
  if (!match) return "invalid";
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(requestedEnd, size - 1);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  ) {
    return "invalid";
  }
  return { start, end };
}

function corsHeaders(values: Record<string, string>): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...values,
  });
}

function response(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: corsHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}
