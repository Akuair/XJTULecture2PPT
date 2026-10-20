export type NotebookLmErrorCode =
  | "NOTEBOOKLM_AUTH_REQUIRED"
  | "NOTEBOOKLM_LOGIN_TIMEOUT"
  | "NOTEBOOKLM_UI_CHANGED"
  | "NOTEBOOKLM_INVALID_NOTEBOOK"
  | "NOTEBOOKLM_NOTEBOOK_READ_ONLY"
  | "NOTEBOOKLM_FILE_NOT_FOUND"
  | "NOTEBOOKLM_UNSUPPORTED_FILE"
  | "NOTEBOOKLM_DUPLICATE_SOURCE"
  | "NOTEBOOKLM_UPLOAD_FAILED"
  | "NOTEBOOKLM_UPLOAD_TIMEOUT"
  | "NOTEBOOKLM_PRIVATE_API_CHANGED"
  | "NOTEBOOKLM_PARTIAL_SOURCE";

export class NotebookLmError extends Error {
  readonly code: NotebookLmErrorCode;

  constructor(code: NotebookLmErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotebookLmError";
    this.code = code;
  }
}
