import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { redactSecrets } from "@xjtu-lecture2ppt/shared";
import { app } from "electron";

let writeQueue = Promise.resolve();
let logDirectoryReady: Promise<void> | undefined;

export function log(scope: string, message: string, metadata?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    scope,
    message,
    ...(metadata === undefined ? {} : { metadata: redactSecrets(metadata) }),
  };
  const line = `${JSON.stringify(entry)}\n`;
  writeQueue = writeQueue.then(() => writeLine(line)).catch(() => undefined);
}

async function writeLine(line: string): Promise<void> {
  const directory = join(app.getPath("userData"), "logs");
  logDirectoryReady ??= mkdir(directory, { recursive: true }).then(() => undefined);
  await logDirectoryReady;
  await appendFile(join(directory, "app.log"), line, "utf8");
}
