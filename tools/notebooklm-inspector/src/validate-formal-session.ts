import { chromium } from "playwright";

import { NotebookLmBrowserAdapter } from "../../../packages/notebooklm/src/index";

const endpoint = process.argv.find((argument) => /^http:\/\/127\.0\.0\.1:\d+$/.test(argument));
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) {
  throw new Error("Usage: validate-formal-session <http://127.0.0.1:port>");
}

const browser = await chromium.connectOverCDP(endpoint, {
  isLocal: true,
  noDefaults: true,
  timeout: 10_000,
});
const context = browser.contexts()[0];
const page = context?.pages().find((candidate) => {
  try {
    return ["notebook.google.com", "notebook.google", "notebooklm.google.com"].includes(
      new URL(candidate.url()).hostname,
    );
  } catch {
    return false;
  }
});
if (!page) throw new Error("Gemini Notebook product page was not found");

const adapter = new NotebookLmBrowserAdapter(async () => page);
const authenticated = await adapter.isAuthenticated();
const notebooks = authenticated ? await adapter.listNotebooks() : [];

console.log(
  JSON.stringify({
    authenticated,
    count: notebooks.length,
    uniqueIds: new Set(notebooks.map((item) => item.id)).size,
    allTitlesNonEmpty: notebooks.every((item) => item.title.trim().length > 0),
    allUrlsPresent: notebooks.every((item) => Boolean(item.url)),
  }),
);
process.exit(0);
