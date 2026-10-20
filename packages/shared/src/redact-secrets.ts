const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(authorization|cookie|csrf|xsrf|password|passwd|secret|token|ticket|signature|signed|session|credential|api[-_]?key)/i;
const SENSITIVE_QUERY =
  /(auth|credential|password|previewtoken|secret|session|sig|signature|signed|ticket|token|x-amz-)/i;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(child, depth + 1),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (/^https?:\/\//i.test(value)) return redactUrl(value);
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:ST|TGT)-[A-Za-z0-9._~-]+\b/g, REDACTED);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const isSigned = [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key));
    for (const key of [...url.searchParams.keys()]) {
      if (isSigned || SENSITIVE_QUERY.test(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return REDACTED;
  }
}
