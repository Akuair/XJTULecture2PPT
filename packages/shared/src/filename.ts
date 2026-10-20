const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function sanitizeWindowsFileName(value: string, fallback = "lecture"): string {
  const withoutControlCharacters = Array.from(value, (character) =>
    character.charCodeAt(0) <= 31 ? "_" : character,
  ).join("");
  const sanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[ .]+$/g, "")
    .trim();

  if (!sanitized || WINDOWS_RESERVED_NAMES.test(sanitized)) return fallback;
  return sanitized.slice(0, 180);
}
