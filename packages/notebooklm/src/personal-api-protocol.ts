const RPC_PATH = "/_/LabsTailwindUi/data/batchexecute";

export const ADD_SOURCE_FILE_RPC = "o4cbdc";
export const GET_NOTEBOOK_RPC = "rLM1Ne";

const REQUEST_OPTIONS = [
  2,
  null,
  [1],
  [1, null, null, null, null, null, null, null, null, null, [1, 3]],
] as const;

export interface NotebookLmRpcRuntime {
  at: string;
  authUser: string;
  templateUrl: string;
}

export function buildRegisterFileParams(fileName: string, notebookId: string): unknown[] {
  return [[[fileName]], notebookId, cloneRequestOptions()];
}

export function buildGetNotebookParams(notebookId: string): unknown[] {
  return [notebookId, null, cloneRequestOptions(), null, 1, [[null, null, []]]];
}

export function buildBatchExecuteRequest(
  runtime: NotebookLmRpcRuntime,
  rpcId: string,
  params: unknown[],
  notebookId: string,
): { body: string; url: string } {
  const url = new URL(runtime.templateUrl);
  if (url.pathname !== RPC_PATH) throw new Error("Unexpected Notebook RPC path");
  url.searchParams.set("rpcids", rpcId);
  url.searchParams.set("source-path", `/notebook/${notebookId}`);
  const body = new URLSearchParams({
    "f.req": JSON.stringify([[[rpcId, JSON.stringify(params), null, "generic"]]]),
    at: runtime.at,
  }).toString();
  return { body, url: url.toString() };
}

export function decodeBatchExecutePayload(text: string, rpcId: string): unknown {
  const frames = parseFramedJson(text);
  const rpcFrame = findRpcFrame(frames, rpcId);
  if (!rpcFrame || typeof rpcFrame[2] !== "string") {
    throw new Error(`Notebook RPC ${rpcId} response shape changed`);
  }
  try {
    return JSON.parse(rpcFrame[2]) as unknown;
  } catch (error) {
    throw new Error(`Notebook RPC ${rpcId} payload is not JSON`, { cause: error });
  }
}

export function extractFirstOpaqueId(value: unknown): string | undefined {
  if (typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = extractFirstOpaqueId(item);
      if (match) return match;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const match = extractFirstOpaqueId(item);
      if (match) return match;
    }
  }
  return undefined;
}

export function containsOpaqueId(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsOpaqueId(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => containsOpaqueId(item, expected));
  }
  return false;
}

export function validateDynamicUploadUrl(value: string | undefined, expectedOrigin: string): string {
  if (!value) throw new Error("Notebook upload session URL is missing");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    url.pathname !== "/upload/_/" ||
    !url.searchParams.has("upload_id") ||
    url.searchParams.get("upload_protocol") !== "resumable"
  ) {
    throw new Error("Notebook upload session URL shape changed");
  }
  return url.toString();
}

function cloneRequestOptions(): unknown[] {
  return structuredClone(REQUEST_OPTIONS) as unknown as unknown[];
}

function parseFramedJson(text: string): unknown[] {
  const normalized = text.replace(/^\)\]\}'\s*/, "").trim();
  const frames: unknown[] = [];
  for (const line of normalized.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try {
      frames.push(JSON.parse(candidate) as unknown);
    } catch {
      // batchexecute uses decimal byte-count lines between JSON frames.
    }
  }
  if (frames.length === 0) {
    try {
      frames.push(JSON.parse(normalized) as unknown);
    } catch {
      throw new Error("Notebook batchexecute response did not contain a JSON frame");
    }
  }
  return frames;
}

function findRpcFrame(value: unknown, rpcId: string): unknown[] | undefined {
  if (Array.isArray(value)) {
    if (value[0] === "wrb.fr" && value[1] === rpcId) return value;
    for (const item of value) {
      const match = findRpcFrame(item, rpcId);
      if (match) return match;
    }
  }
  return undefined;
}
