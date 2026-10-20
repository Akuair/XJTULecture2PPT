export interface NotebookInfo {
  id: string;
  title: string;
  url?: string;
}

export type NotebookLmUploadStage =
  | "opening-notebook"
  | "opening-source-dialog"
  | "choosing-file"
  | "registering-source"
  | "starting-upload"
  | "uploading"
  | "verifying-source"
  | "completed";

export interface NotebookLmUploadProgress {
  currentFile?: number;
  fileName?: string;
  stage: NotebookLmUploadStage;
  message: string;
  totalFiles?: number;
}

export type NotebookLmUploadProgressListener = (progress: NotebookLmUploadProgress) => void;

export interface NotebookLmAdapter {
  isAuthenticated(): Promise<boolean>;
  login(): Promise<void>;
  listNotebooks(): Promise<NotebookInfo[]>;
  uploadFile(
    notebook: NotebookInfo,
    filePath: string,
    onProgress?: NotebookLmUploadProgressListener,
  ): Promise<void>;
}
