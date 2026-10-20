const SAFE_UI_PATTERNS = [
  /^(add source|添加来源)$/i,
  /^(upload|上传)$/i,
  /^(upload\s*)?上传文件$/i,
  /^(upload files?|上传文件)$/i,
  /^(upload a source|上传来源)$/i,
  /^(new notebook|create new notebook|新建笔记本)$/i,
  /^(close|cancel|关闭|取消)$/i,
  /^(sources?|来源)$/i,
  /^(notebook guide|笔记本指南)$/i,
];

export function sanitizeNotebookUrl(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").map((part, index, all) => {
      const previous = all[index - 1]?.toLowerCase();
      if (previous === "notebook" || previous === "notebooks") return "<notebook-id>";
      return looksLikeOpaqueId(part) ? "<opaque-id>" : part;
    });
    return `${url.origin}${parts.join("/")}`;
  } catch {
    return "[INVALID_URL]";
  }
}

export function sanitizeAccessibleName(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (SAFE_UI_PATTERNS.some((pattern) => pattern.test(normalized))) return normalized;
  return undefined;
}

export function sanitizeInputAccept(value: string): string {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^\.?[a-z0-9*+/-]+$/.test(item))
    .join(",");
}

function looksLikeOpaqueId(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9_-]+$/.test(value);
}
