const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(authorization|cookie|csrf|xsrf|password|passwd|secret|token|ticket|signature|signed|session|credential|api[-_]?key|access[-_]?key)/i;
const PERSONAL_KEY =
  /^(account|email|full[-_]?name|login[-_]?name|mobile|phone|real[-_]?name|staff[-_]?(id|name|no|number)|student([-_]?(id|name|no|number))?|teacher[-_]?(id|name|no|number)|instructor[-_]?(id|name|no|number)|user([-_]?(id|name|no|number|account))?|uid|xh|xm)$/i;
const SENSITIVE_QUERY_KEY =
  /(auth|code|credential|key|password|previewtoken|secret|session|sig|signature|signed|ticket|token|x-amz-)/i;
const PERSON_CONTAINER = /(instructor|teacher|student|profile|current[-_]?user|person)/i;

export function redactUrl(rawUrl: string): string {
  try {
    const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(rawUrl);
    const url = new URL(rawUrl, "https://redaction.invalid");
    const isSignedUrl = [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key));
    for (const key of [...url.searchParams.keys()]) {
      if (isSignedUrl || SENSITIVE_QUERY_KEY.test(key) || PERSONAL_KEY.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return isAbsolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return redactText(rawUrl);
  }
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (SENSITIVE_KEY.test(key) || PERSONAL_KEY.test(key)) return [key, REDACTED];
      if (/^(referer|location|:path)$/i.test(key)) return [key, redactUrl(value)];
      return [key, redactText(value)];
    }),
  );
}

export function redactJson(value: unknown, depth = 0, path: string[] = []): unknown {
  if (depth > 20) return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.map((item) => redactJson(item, depth + 1, path));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const isPersonField =
          path.some((segment) => PERSON_CONTAINER.test(segment)) &&
          /^(avatar.*|email|id|name|portfolio_url|user_no|username)$/i.test(key);
        return [
          key,
          SENSITIVE_KEY.test(key) || PERSONAL_KEY.test(key) || isPersonField
            ? REDACTED
            : redactJson(child, depth + 1, [...path, key]),
        ];
      }),
    );
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return redactUrl(value);
  return typeof value === "string" ? redactText(value) : value;
}

export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(?:ST|TGT)-[A-Za-z0-9._~-]+\b/g, REDACTED)
    .replace(/\b(password|passwd|username|account|studentId|student_no)=([^&\s]*)/gi, `$1=${REDACTED}`);
}

export function redactBody(body: string, contentType = ""): unknown {
  if (/json/i.test(contentType)) {
    try {
      return redactJson(JSON.parse(body));
    } catch {
      return redactText(body);
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType)) {
    const parameters = new URLSearchParams(body);
    for (const key of [...parameters.keys()]) {
      if (SENSITIVE_KEY.test(key) || PERSONAL_KEY.test(key) || /^(execution|lt)$/i.test(key)) {
        parameters.set(key, REDACTED);
      }
    }
    return parameters.toString();
  }
  return redactText(body);
}

export function resanitizeNetworkEvent(value: unknown): unknown {
  const sanitized = redactJson(value);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return sanitized;
  const event = sanitized as Record<string, unknown>;
  if (event.headers && typeof event.headers === "object" && !Array.isArray(event.headers)) {
    const stringHeaders = Object.fromEntries(
      Object.entries(event.headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    event.headers = redactHeaders(stringHeaders);
  }
  if (typeof event.body === "string") {
    event.body = redactBody(event.body, typeof event.contentType === "string" ? event.contentType : "");
  }
  return event;
}
