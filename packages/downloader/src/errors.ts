export type DownloadErrorCode =
  | "CANCELLED"
  | "TIMEOUT"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "UNSUPPORTED_HLS"
  | "UNSUPPORTED_DASH"
  | "DRM_PROTECTED"
  | "HTTP_ERROR"
  | "INVALID_MEDIA_RESPONSE"
  | "INCOMPLETE_DOWNLOAD"
  | "DESTINATION_EXISTS"
  | "IO_ERROR";

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: DownloadErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DownloadError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
