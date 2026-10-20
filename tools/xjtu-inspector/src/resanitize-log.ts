import { createReadStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

import { resanitizeNetworkEvent } from "./redaction";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: tsx src/resanitize-log.ts <jsonl-path>");
const temporaryPath = `${inputPath}.sanitizing`;
const input = createInterface({
  input: createReadStream(inputPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
const output = createWriteStream(temporaryPath, { encoding: "utf8", flags: "wx" });
let sanitizedLines = 0;
let invalidLines = 0;

for await (const line of input) {
  if (!line.trim()) continue;
  try {
    output.write(`${JSON.stringify(resanitizeNetworkEvent(JSON.parse(line)))}\n`);
    sanitizedLines += 1;
  } catch {
    invalidLines += 1;
  }
}

output.end();
await finished(output);
await unlink(inputPath);
await rename(temporaryPath, inputPath);
console.log(JSON.stringify({ sanitizedLines, invalidLines }));
