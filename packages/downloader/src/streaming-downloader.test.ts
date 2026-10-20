import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DownloadError } from "./errors";
import { downloadToFile } from "./streaming-downloader";

describe("downloadToFile", () => {
  let directory: string;
  let destination: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "xjtu-downloader-test-"));
    destination = join(directory, "source.mp4");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("streams an MP4 to disk and reports progress", async () => {
    const media = fakeMp4(96);
    const progress = vi.fn();
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=0-");
      return rangeResponse(media, 0);
    });

    const result = await downloadToFile(
      {
        destinationPath: destination,
        fetch,
        resolveSource: async () => ({ url: "https://media.example/source.mp4", streamType: "mp4" }),
      },
      progress,
    );

    expect(await readFile(destination)).toEqual(media);
    expect(result).toMatchObject({ downloadedBytes: media.length, totalBytes: media.length, attempts: 1 });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "completed", percent: 100 }));
  });

  it("resumes an existing partial file with Range", async () => {
    const media = fakeMp4(128);
    const offset = 37;
    await writeFile(`${destination}.part`, media.subarray(0, offset));
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("range")).toBe(`bytes=${offset}-`);
      return rangeResponse(media, offset);
    });

    const result = await downloadToFile({
      destinationPath: destination,
      fetch,
      resolveSource: async () => ({ url: "https://media.example/source.mp4" }),
    });

    expect(await readFile(destination)).toEqual(media);
    expect(result.resumed).toBe(true);
  });

  it("restarts from zero when the server ignores Range", async () => {
    const media = fakeMp4(80);
    await writeFile(`${destination}.part`, media.subarray(0, 21));

    const result = await downloadToFile({
      destinationPath: destination,
      fetch: async () =>
        new Response(Uint8Array.from(media), {
          status: 200,
          headers: { "content-length": String(media.length), "content-type": "video/mp4" },
        }),
      resolveSource: async () => ({ url: "https://media.example/source.mp4" }),
    });

    expect(await readFile(destination)).toEqual(media);
    expect(result.resumed).toBe(false);
  });

  it("re-resolves an expired signed URL before retrying", async () => {
    const media = fakeMp4(72);
    const resolvedAttempts: number[] = [];
    let requestCount = 0;
    const result = await downloadToFile({
      destinationPath: destination,
      maxRetries: 1,
      retryDelayMs: 0,
      resolveSource: async (attempt) => {
        resolvedAttempts.push(attempt);
        return { url: `https://media.example/signed-${attempt}.mp4` };
      },
      fetch: async () => {
        requestCount += 1;
        return requestCount === 1 ? new Response(null, { status: 403 }) : rangeResponse(media, 0);
      },
    });

    expect(result.attempts).toBe(2);
    expect(resolvedAttempts).toEqual([1, 2]);
    expect(await readFile(destination)).toEqual(media);
  });

  it("retries transient server errors", async () => {
    const media = fakeMp4(64);
    let requestCount = 0;
    await downloadToFile({
      destinationPath: destination,
      maxRetries: 1,
      retryDelayMs: 0,
      resolveSource: async () => ({ url: "https://media.example/source.mp4" }),
      fetch: async () => {
        requestCount += 1;
        return requestCount === 1 ? new Response(null, { status: 500 }) : rangeResponse(media, 0);
      },
    });
    expect(requestCount).toBe(2);
  });

  it("does not retry an expired login", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(
      downloadToFile({
        destinationPath: destination,
        maxRetries: 2,
        retryDelayMs: 0,
        fetch,
        resolveSource: async () => ({ url: "https://media.example/source.mp4" }),
      }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops before requesting HLS or DASH sources", async () => {
    const fetch = vi.fn();
    await expect(
      downloadToFile({
        destinationPath: destination,
        fetch,
        resolveSource: async () => ({ url: "https://media.example/master.m3u8", streamType: "hls" }),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HLS" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadToFile({
        destinationPath: destination,
        signal: controller.signal,
        fetch: vi.fn(),
        resolveSource: async () => ({ url: "https://media.example/source.mp4" }),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("converts an inactive request into a retryable timeout", async () => {
    await expect(
      downloadToFile({
        destinationPath: destination,
        timeoutMs: 20,
        maxRetries: 0,
        resolveSource: async () => ({ url: "https://media.example/source.mp4" }),
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          }),
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  it("does not overwrite an existing completed file", async () => {
    await writeFile(destination, fakeMp4(48));
    await expect(
      downloadToFile({
        destinationPath: destination,
        fetch: vi.fn(),
        resolveSource: async () => ({ url: "https://media.example/source.mp4" }),
      }),
    ).rejects.toBeInstanceOf(DownloadError);
  });
});

function fakeMp4(length: number): Buffer {
  const size = Math.max(length, 24);
  const media = Buffer.alloc(size, 0x5a);
  media.writeUInt32BE(24, 0);
  media.write("ftyp", 4, "ascii");
  media.write("isom", 8, "ascii");
  media.writeUInt32BE(0, 12);
  media.write("isom", 16, "ascii");
  return media;
}

function rangeResponse(media: Buffer, offset: number): Response {
  const body = media.subarray(offset);
  return new Response(Uint8Array.from(body), {
    status: 206,
    headers: {
      "accept-ranges": "bytes",
      "content-length": String(body.length),
      "content-range": `bytes ${offset}-${media.length - 1}/${media.length}`,
      "content-type": "video/mp4",
    },
  });
}
