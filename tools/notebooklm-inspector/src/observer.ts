import type { FileChooser, Page } from "playwright";

import { sanitizeAccessibleName, sanitizeInputAccept, sanitizeNotebookUrl } from "./redaction";
import { NotebookLmNetworkObserver, type NotebookLmNetworkCall } from "./network-observer";

const NOTEBOOK_HOSTS = new Set(["notebook.google.com", "notebook.google", "notebooklm.google.com"]);

export interface NotebookLmObservation {
  fileChooser: {
    accept: string;
    multiple: boolean;
    observed: boolean;
  };
  genericButtonNames: string[];
  genericLinkNames: string[];
  notebookCardCount: number;
  notebookUrlPatterns: string[];
  networkCalls: NotebookLmNetworkCall[];
  observedDialog: boolean;
  observedNotebookHome: boolean;
  observedNotebookPage: boolean;
  observedUploadInput: boolean;
}

export class NotebookLmObserver {
  private readonly network = new NotebookLmNetworkObserver();
  private readonly buttons = new Set<string>();
  private readonly links = new Set<string>();
  private readonly urlPatterns = new Set<string>();
  private notebookCardCount = 0;
  private observedDialog = false;
  private observedNotebookHome = false;
  private observedNotebookPage = false;
  private observedUploadInput = false;
  private fileChooser = { accept: "", multiple: false, observed: false };

  attach(page: Page): void {
    page.on("filechooser", (chooser) => void this.recordFileChooser(chooser));
    this.network.attach(page);
  }

  async drain(): Promise<void> {
    await this.network.drain();
  }

  async inspect(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const url = page.url();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (!NOTEBOOK_HOSTS.has(parsed.hostname)) return;

    const sanitizedUrl = sanitizeNotebookUrl(url);
    this.urlPatterns.add(sanitizedUrl);
    if (/\/notebook\/(?:<notebook-id>|<opaque-id>)/.test(sanitizedUrl)) {
      this.observedNotebookPage = true;
    } else {
      this.observedNotebookHome = true;
    }

    const [buttonNames, linkNames, notebookLinks, dialogs, fileInputs] = await Promise.all([
      page
        .locator("button:visible")
        .allInnerTexts()
        .catch(() => []),
      page
        .locator("a:visible")
        .allInnerTexts()
        .catch(() => []),
      page
        .locator('a[href*="/notebook/"]')
        .count()
        .catch(() => 0),
      page
        .getByRole("dialog")
        .count()
        .catch(() => 0),
      page
        .locator('input[type="file"]')
        .count()
        .catch(() => 0),
    ]);
    for (const value of buttonNames) {
      const safe = sanitizeAccessibleName(value);
      if (safe) this.buttons.add(safe);
    }
    for (const value of linkNames) {
      const safe = sanitizeAccessibleName(value);
      if (safe) this.links.add(safe);
    }
    this.notebookCardCount = Math.max(this.notebookCardCount, notebookLinks);
    this.observedDialog ||= dialogs > 0;
    this.observedUploadInput ||= fileInputs > 0;
  }

  snapshot(): NotebookLmObservation {
    return {
      fileChooser: { ...this.fileChooser },
      genericButtonNames: [...this.buttons].sort(),
      genericLinkNames: [...this.links].sort(),
      notebookCardCount: this.notebookCardCount,
      notebookUrlPatterns: [...this.urlPatterns].sort(),
      networkCalls: this.network.snapshot(),
      observedDialog: this.observedDialog,
      observedNotebookHome: this.observedNotebookHome,
      observedNotebookPage: this.observedNotebookPage,
      observedUploadInput: this.observedUploadInput,
    };
  }

  private async recordFileChooser(chooser: FileChooser): Promise<void> {
    const element = chooser.element();
    this.fileChooser = {
      observed: true,
      accept: sanitizeInputAccept((await element.getAttribute("accept")) ?? ""),
      multiple: (await element.getAttribute("multiple")) !== null,
    };
  }
}
