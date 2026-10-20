import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app } from "electron";

import type { PersistedPipelineJob } from "../shared/pipeline-contract";

export interface PipelinePersistence {
  load(): Promise<PersistedPipelineJob[]>;
  save(jobs: PersistedPipelineJob[]): Promise<void>;
}

export class PipelineStore implements PipelinePersistence {
  async load(): Promise<PersistedPipelineJob[]> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return Array.isArray(value) ? (value as PersistedPipelineJob[]) : [];
    } catch {
      return [];
    }
  }

  async save(jobs: PersistedPipelineJob[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.part`;
    await writeFile(temporaryPath, JSON.stringify(jobs, null, 2), "utf8");
    await rename(temporaryPath, this.path);
  }

  private get path(): string {
    return join(app.getPath("userData"), "state", "pipeline-jobs.json");
  }
}
