export type XjtuErrorCode =
  "AUTH_REQUIRED" | "FORBIDDEN" | "SERVER_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE";

export class XjtuApiError extends Error {
  readonly code: XjtuErrorCode;
  readonly status?: number;

  constructor(code: XjtuErrorCode, message: string, status?: number) {
    super(message);
    this.name = "XjtuApiError";
    this.code = code;
    this.status = status;
  }
}
