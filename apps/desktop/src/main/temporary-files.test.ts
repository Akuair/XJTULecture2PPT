import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupJobTemporaryFiles, cleanupOrphanedJobDirectories } from "./temporary-files";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cleanupJobTemporaryFiles", () => {
  it("deletes the downloaded video, intermediate PPTX, partial files, and frame directory", async () => {
    const root = join(tmpdir(), `xjtu-l2p-cleanup-${crypto.randomUUID()}`);
    const jobId = crypto.randomUUID();
    const jobDirectory = join(root, jobId);
    roots.push(root);
    await mkdir(join(jobDirectory, "frames"), { recursive: true });
    await writeFile(join(jobDirectory, "source.mp4"), Buffer.alloc(128));
    await writeFile(join(jobDirectory, "source.mp4.part"), Buffer.alloc(32));
    await writeFile(join(jobDirectory, "intermediate.pptx"), Buffer.alloc(64));
    await writeFile(join(jobDirectory, "frames", "frame-1.jpg"), Buffer.alloc(16));
    await writeFile(join(jobDirectory, "metadata.json"), "{}", "utf8");

    await expect(cleanupJobTemporaryFiles(root, jobId)).resolves.toEqual({
      sourceBytes: 128,
      framesRemoved: true,
    });
    await expect(stat(join(jobDirectory, "source.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(jobDirectory, "source.mp4.part"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(jobDirectory, "intermediate.pptx"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(jobDirectory, "frames"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(jobDirectory, "metadata.json"))).resolves.toMatchObject({ size: 2 });
  });

  it("rejects an invalid job ID before touching the filesystem", async () => {
    const root = join(tmpdir(), `xjtu-l2p-cleanup-${crypto.randomUUID()}`);
    roots.push(root);
    await expect(cleanupJobTemporaryFiles(root, "..\\outside")).rejects.toThrow("任务 ID");
  });

  it("does not report success when the source video is already missing", async () => {
    const root = join(tmpdir(), `xjtu-l2p-cleanup-${crypto.randomUUID()}`);
    const jobId = crypto.randomUUID();
    roots.push(root);
    await mkdir(join(root, jobId), { recursive: true });
    await expect(cleanupJobTemporaryFiles(root, jobId)).rejects.toThrow("不存在或为空");
  });

  it("removes old orphan directories but retains failed jobs when configured", async () => {
    const root = join(tmpdir(), `xjtu-l2p-cleanup-${crypto.randomUUID()}`);
    const removableId = crypto.randomUUID();
    const retainedId = crypto.randomUUID();
    roots.push(root);
    await mkdir(join(root, removableId), { recursive: true });
    await mkdir(join(root, retainedId), { recursive: true });
    await writeFile(
      join(root, removableId, "metadata.json"),
      JSON.stringify({ status: "cleaned", updatedAt: "2020-01-01T00:00:00.000Z" }),
      "utf8",
    );
    await writeFile(
      join(root, retainedId, "metadata.json"),
      JSON.stringify({ status: "failed", updatedAt: "2020-01-01T00:00:00.000Z" }),
      "utf8",
    );

    await expect(
      cleanupOrphanedJobDirectories(root, {
        olderThan: new Date("2021-01-01T00:00:00.000Z"),
        retainFailedTemporaryFiles: true,
      }),
    ).resolves.toMatchObject({ removedDirectories: 1 });
    await expect(stat(join(root, removableId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, retainedId))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});
