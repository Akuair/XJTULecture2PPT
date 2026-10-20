export interface AppSettings {
  outputDirectory: string;
  defaultSemesterId?: string;
  downloadConcurrency: 1 | 2;
  conversionConcurrency: 1;
  autoDeleteSource: boolean;
  retainFailedTemporaryFiles: boolean;
  orphanRetentionDays: number;
}

export interface UpdateAppSettings {
  outputDirectory?: string;
  defaultSemesterId?: string;
  downloadConcurrency?: 1 | 2;
  autoDeleteSource?: boolean;
  retainFailedTemporaryFiles?: boolean;
  orphanRetentionDays?: number;
}

export interface PptLibraryItem {
  path: string;
  fileName: string;
  pdfPath?: string;
  textPath?: string;
  pdfSize?: number;
  textSize?: number;
  course?: string;
  lectureDate?: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface CleanupSummary {
  removedDirectories: number;
  reclaimedBytes: number;
}
