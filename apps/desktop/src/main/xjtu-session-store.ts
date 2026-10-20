import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { app, safeStorage, type Cookie, type CookiesSetDetails, type Session } from "electron";

import { log } from "./logger";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE = "xjtu-session.bin";

interface CookieSnapshot {
  version: number;
  cookies: StoredCookie[];
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: Cookie["sameSite"];
  expirationDate?: number;
}

export class XjtuSessionStore {
  private readonly filePath = join(app.getPath("userData"), SNAPSHOT_FILE);

  async save(session: Session): Promise<boolean> {
    if (!safeStorage.isEncryptionAvailable()) {
      log("AUTH", "Windows secure storage is unavailable; XJTU session was not persisted");
      return false;
    }

    const cookies = (await session.cookies.get({}))
      .filter((cookie) => isXjtuDomain(cookie.domain))
      .map(toStoredCookie);
    if (!cookies.length) return false;

    const encrypted = safeStorage.encryptString(
      JSON.stringify({ version: SNAPSHOT_VERSION, cookies } satisfies CookieSnapshot),
    );
    await writeFile(this.filePath, encrypted, { mode: 0o600 });
    log("AUTH", "Encrypted XJTU session snapshot saved", { cookieCount: cookies.length });
    return true;
  }

  async restore(session: Session): Promise<boolean> {
    if (!safeStorage.isEncryptionAvailable()) return false;

    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("AUTH", "Unable to read encrypted XJTU session snapshot");
      }
      return false;
    }

    try {
      const snapshot = parseSnapshot(safeStorage.decryptString(encrypted));
      const now = Date.now() / 1000;
      let restored = 0;
      for (const cookie of snapshot.cookies) {
        if (cookie.expirationDate !== undefined && cookie.expirationDate <= now) continue;
        await session.cookies.set(toCookiesSetDetails(cookie));
        restored += 1;
      }
      await session.cookies.flushStore();
      log("AUTH", "Encrypted XJTU session snapshot restored", { cookieCount: restored });
      return restored > 0;
    } catch {
      log("AUTH", "Encrypted XJTU session snapshot is invalid and will be discarded");
      await this.clear();
      return false;
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

function toStoredCookie(cookie: Cookie): StoredCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    hostOnly: cookie.hostOnly ?? false,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}

function toCookiesSetDetails(cookie: StoredCookie): CookiesSetDetails {
  const hostname = cookie.domain.replace(/^\./, "");
  if (!isXjtuDomain(hostname)) throw new Error("Cookie domain is outside xjtu.edu.cn");
  const path = cookie.path.startsWith("/") ? cookie.path : `/${cookie.path}`;
  return {
    url: new URL(path, `https://${hostname}`).toString(),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}

function parseSnapshot(value: string): CookieSnapshot {
  const parsed = JSON.parse(value) as Partial<CookieSnapshot>;
  if (parsed.version !== SNAPSHOT_VERSION || !Array.isArray(parsed.cookies)) {
    throw new Error("Unsupported snapshot format");
  }
  for (const cookie of parsed.cookies) {
    if (
      !cookie ||
      typeof cookie !== "object" ||
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" ||
      !isXjtuDomain(cookie.domain)
    ) {
      throw new Error("Invalid cookie snapshot");
    }
  }
  return parsed as CookieSnapshot;
}

function isXjtuDomain(value?: string): boolean {
  const hostname = (value ?? "").replace(/^\./, "").toLowerCase();
  return hostname === "xjtu.edu.cn" || hostname.endsWith(".xjtu.edu.cn");
}
