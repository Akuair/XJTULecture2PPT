import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: tsx src/verify-log.ts <jsonl-path>");

const violations = new Map<string, number>();
const input = createInterface({
  input: createReadStream(inputPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
let parsedLines = 0;
let invalidLines = 0;

for await (const line of input) {
  try {
    inspect(JSON.parse(line), []);
    parsedLines += 1;
  } catch {
    invalidLines += 1;
  }
}

console.log(
  JSON.stringify({
    parsedLines,
    invalidLines,
    violations: [...violations.entries()].map(([path, count]) => ({ path, count })),
  }),
);

function inspect(value: unknown, path: string[]): void {
  if (typeof value === "string") {
    for (const pattern of [
      /X-Amz-Signature=([^&"\\]+)/g,
      /previewToken=([^&"\\]+)/g,
      /(?:password|username)=([^&"\\]+)/g,
    ]) {
      for (const match of value.matchAll(pattern)) {
        if (!(match[1] ?? "").includes("REDACTED")) {
          const pathKey = path.join(".") || "<root>";
          violations.set(pathKey, (violations.get(pathKey) ?? 0) + 1);
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => inspect(child, [...path, `[${index}]`]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) inspect(child, [...path, key]);
  }
}
